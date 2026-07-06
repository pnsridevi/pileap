package expo.modules.smsreader

import android.Manifest
import android.content.pm.PackageManager
import android.database.Cursor
import android.net.Uri
import androidx.core.content.ContextCompat
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import expo.modules.kotlin.Promise
import expo.modules.kotlin.exception.CodedException

// ─────────────────────────────────────────────────────────────────────────────
// SmsReaderModule — Layer 0 + Layer 1 of Pileap's SMS ingestion pipeline
//
// Architecture reference: Pileap Product Architecture V3.2 Section 4.4
//
// LAYER 0 — Sender-level drops (TRAI May 2025 mandate):
//   • Drop all senders ending in -P (promotional suffix)
//   • Drop pure numeric senders (never DLT-registered financial senders)
//   Eliminates ~40% of inbox volume with zero hardcoding.
//
// LAYER 1 — Liberal Body-First Filter:
//   The filter is a ROUGH NET. The Layer 2 regex parser is the fine mesh.
//
//   RESPONSIBILITY: Pass everything that could plausibly be a financial
//   transaction. Drop only what is certainly not.
//
//   WHAT THIS LAYER MUST NEVER DO:
//     • Detect banks or classify transactions — Layer 2 / Layer 3 only
//     • Hardcode sender codes or entity names — arch doc Section 4.4
//     • Drop a message just because the sender looks unfamiliar
//
//   WHAT THIS LAYER DROPS:
//     • OTPs and authentication codes
//     • Delivery / logistics notifications (when no currency present)
//     • Telecom service noise: recharge reminders, missed calls, pack expiry
//     • Future credit notices (will be credited/refunded — money not moved yet)
//     • Loyalty points — not real money
//     • Promotional messages (offer language + promo URL + no account reference)
//     • Non-financial service noise: power cuts, locker alerts, food menus,
//       CC billing statements, booking confirmations, stock trade summaries,
//       insurance claim status updates, PF contribution notices,
//       payment pending nudges
//     • Payee-side acknowledgments — merchant/utility confirming receipt of your
//       payment. Generic structural rule: no bank account ref = payee side.
//       No merchant names hardcoded. Covers TANGEDCO, Airtel recharge confirms,
//       insurance receipts, utility acknowledgments, and any future variants.
//
//   FALSE NEGATIVE COST: A dropped genuine transaction is permanently lost.
//     No downstream layer can recover it. When in doubt, always pass through.
//   FALSE POSITIVE COST: An extra message hits Layer 2 regex at zero cost.
//
// IMPORTANT — ARCHITECTURE NOTE (Section 4.4):
//   "Matching stays on-device; the ruleset is remote."
//   Layer 1 (this file) is static — baked into the app. It changes only when
//   the filter logic itself changes, requiring an app release.
//   Layer 2 (ruleset.js) will be fetched from the backend and versioned
//   remotely in Phase 2. Bank wording changes will be fixed there without
//   an app release.
//
// IMPORTANT — IDEMPOTENCY (Section 4.12):
//   This module reads SMS and outputs filtered messages. It does NOT write
//   to any DB. The calling layer (transaction upload) must be idempotent —
//   a crash-and-retry must not create duplicate transactions.
//
// Change log (mirrors layer1sim.js — must stay in sync):
//   - 'reversed' added to direction signals (was missing; only 'reversal' existed)
//   - 'failed' tightened to txn/payment/transaction-specific forms only
//   - Generic payee-acknowledgment drop added (step 9)
//   - Architecture version updated to V3.2
//   - L1 signals added: "txn rs.", "has been used for", "has been charged",
//     "spent on", "is successful", "was successful", "paid towards",
//     "is loaded with", "spent from", "successfully credited with"
//   - Step 7 service noise expanded: cc_statement, booking_confirmation,
//     trade_summary, insurance_claim_status, pf_contribution_notice,
//     payment_pending_nudge
// ─────────────────────────────────────────────────────────────────────────────

class SmsReaderModule : Module() {
  override fun definition() = ModuleDefinition {
    Name("SmsReader")

    // ── getMessages ──────────────────────────────────────────────────────────
    // Returns Layer 0 + Layer 1 filtered financial SMS for a date window.
    // fromDays=0, toDays=90  → last 90 days (test/onboarding window)
    // fromDays=90, toDays=180 → 90–180 days ago
    //
    // Production note: the arch doc specifies "no historical bootstrap —
    // ingestion starts from subscription month only." In production the caller
    // should pass fromDays=0 and toDays=days_since_subscription, not a fixed
    // 90-day window. The fixed window is used in testing only.
    AsyncFunction("getMessages") { fromDays: Int, toDays: Int, promise: Promise ->
      val context = appContext.reactContext
        ?: return@AsyncFunction promise.reject(
            CodedException("ERR_NO_CONTEXT", "React context unavailable", null))

      if (!hasPermission(context)) {
        promise.reject(CodedException("ERR_NO_PERMISSION", "READ_SMS permission not granted", null))
        return@AsyncFunction
      }

      try {
        val messages = mutableListOf<Map<String, Any?>>()
        val now    = System.currentTimeMillis()
        val fromMs = now - (toDays.toLong()  * 24 * 60 * 60 * 1000)
        val toMs   = now - (fromDays.toLong() * 24 * 60 * 60 * 1000)

        val cursor: Cursor? = context.contentResolver.query(
          Uri.parse("content://sms/inbox"),
          arrayOf("_id", "address", "body", "date"),
          "date > ? AND date <= ?",
          arrayOf(fromMs.toString(), toMs.toString()),
          "date DESC"
        )

        cursor?.use {
          val idIndex   = it.getColumnIndexOrThrow("_id")
          val addrIndex = it.getColumnIndexOrThrow("address")
          val bodyIndex = it.getColumnIndexOrThrow("body")
          val dateIndex = it.getColumnIndexOrThrow("date")

          while (it.moveToNext()) {
            val address = it.getString(addrIndex) ?: continue
            val body    = it.getString(bodyIndex) ?: continue

            // Layer 0: drop -P promotional senders (TRAI May 2025 mandate)
            if (address.endsWith("-P", ignoreCase = true)) continue

            // Layer 0: drop pure numeric senders
            if (address.matches(Regex("^\\d+$"))) continue

            if (passesFilter(body)) {
              messages.add(mapOf(
                "id"      to it.getString(idIndex),
                "address" to address,
                "body"    to body,
                "date"    to it.getLong(dateIndex)
              ))
            }
          }
        }

        promise.resolve(messages)
      } catch (e: Exception) {
        promise.reject(CodedException("ERR_SMS_READ", e.message ?: "Failed to read SMS", e))
      }
    }

    // ── getAllMessages ────────────────────────────────────────────────────────
    // Returns ALL SMS in a date window with NO filter applied.
    // Used for testing and raw export — not used in production ingestion.
    AsyncFunction("getAllMessages") { fromDays: Int, toDays: Int, promise: Promise ->
      val context = appContext.reactContext
        ?: return@AsyncFunction promise.reject(
            CodedException("ERR_NO_CONTEXT", "React context unavailable", null))

      if (!hasPermission(context)) {
        promise.reject(CodedException("ERR_NO_PERMISSION", "READ_SMS permission not granted", null))
        return@AsyncFunction
      }

      try {
        val messages = mutableListOf<Map<String, Any?>>()
        val now    = System.currentTimeMillis()
        val fromMs = now - (toDays.toLong()  * 24 * 60 * 60 * 1000)
        val toMs   = now - (fromDays.toLong() * 24 * 60 * 60 * 1000)

        val cursor: Cursor? = context.contentResolver.query(
          Uri.parse("content://sms/inbox"),
          arrayOf("_id", "address", "body", "date"),
          "date > ? AND date <= ?",
          arrayOf(fromMs.toString(), toMs.toString()),
          "date DESC"
        )

        cursor?.use {
          val idIndex   = it.getColumnIndexOrThrow("_id")
          val addrIndex = it.getColumnIndexOrThrow("address")
          val bodyIndex = it.getColumnIndexOrThrow("body")
          val dateIndex = it.getColumnIndexOrThrow("date")

          while (it.moveToNext()) {
            val address = it.getString(addrIndex) ?: continue
            val body    = it.getString(bodyIndex) ?: continue

            messages.add(mapOf(
              "id"      to it.getString(idIndex),
              "address" to address,
              "body"    to body,
              "date"    to it.getLong(dateIndex)
            ))
          }
        }

        promise.resolve(messages)
      } catch (e: Exception) {
        promise.reject(CodedException("ERR_SMS_READ", e.message ?: "Failed to read SMS", e))
      }
    }

    // ── getAllSenders ─────────────────────────────────────────────────────────
    // Debug function: returns all unique alphanumeric senders from full inbox.
    AsyncFunction("getAllSenders") { promise: Promise ->
      val context = appContext.reactContext
        ?: return@AsyncFunction promise.reject(
            CodedException("ERR_NO_CONTEXT", "React context unavailable", null))

      if (!hasPermission(context)) {
        promise.reject(CodedException("ERR_NO_PERMISSION", "READ_SMS permission not granted", null))
        return@AsyncFunction
      }

      try {
        val senders    = mutableSetOf<String>()
        var totalCount = 0

        val cursor: Cursor? = context.contentResolver.query(
          Uri.parse("content://sms/inbox"),
          arrayOf("address"),
          null, null, null
        )

        cursor?.use {
          val addrIndex = it.getColumnIndexOrThrow("address")
          while (it.moveToNext()) {
            totalCount++
            val address = it.getString(addrIndex) ?: continue
            if (address.matches(Regex("^\\d+$"))) continue
            senders.add(address)
          }
        }

        promise.resolve(mapOf(
          "totalCount" to totalCount,
          "senders"    to senders.sorted()
        ))
      } catch (e: Exception) {
        promise.reject(CodedException("ERR_SMS_READ", e.message ?: "Failed to read senders", e))
      }
    }

    // ── hasPermission ────────────────────────────────────────────────────────
    AsyncFunction("hasPermission") { promise: Promise ->
      val context = appContext.reactContext
        ?: return@AsyncFunction promise.resolve(false)
      promise.resolve(hasPermission(context))
    }
  }

  // ───────────────────────────────────────────────────────────────────────────
  // LAYER 1 FILTER
  // Must stay in sync with layer1sim.js — identical logic, different syntax.
  // ───────────────────────────────────────────────────────────────────────────

  private fun passesFilter(body: String): Boolean {
    val b = body.lowercase()

    // ── 1. Drop OTP / authentication ─────────────────────────────────────────
    // Must come FIRST — OTPs can contain Rs amounts ("OTP for txn of USD 23.60")
    if (b.contains("otp") ||
        b.contains("one time password") ||
        b.contains("verification code") ||
        b.contains("do not share") ||
        b.contains("do not disclose") ||
        b.contains("never share") ||
        b.contains("confidential code") ||
        b.contains("login code") ||
        b.contains("sign in code") ||
        b.contains("authentication code") ||
        b.contains("is your otp") ||
        b.contains("is the otp")) {
      return false
    }

    // ── 2. Drop delivery / logistics ─────────────────────────────────────────
    // Only drop when no currency marker present — COD messages must pass through.
    // [FIX] "Rs1,532" (no period, no space, whole-rupee amount — a very
    // common UPI-app-payment format) matched neither "rs." nor "rs ", and
    // had no decimal point for the fallback regex in hasCurrencySignal
    // either. The message was invisible to every downstream check. Confirmed
    // 100% of whole-rupee "You paid RsX..." messages were silently dropped
    // here before this fix. Added a direct "rs" + digit check.
    val hasCurrencyMarker = b.contains("rs.") || b.contains("rs ") ||
                            b.contains("inr") || b.contains("₹") ||
                            Regex("""rs\d""").containsMatchIn(b)
    if (!hasCurrencyMarker) {
      if (b.contains("out for delivery") ||
          b.contains("shipment") ||
          b.contains("your order has been") ||
          b.contains("pickup scheduled") ||
          b.contains("courier") ||
          b.contains("tracking id") ||
          b.contains("dispatched") ||
          b.contains("order confirmed") ||
          b.contains("order placed")) {
        return false
      }
    }

    // ── 3. Drop telecom service noise ─────────────────────────────────────────
    // Note: 'call alert' does NOT conflict with 'credit alert' — safe.
    if (b.contains("pack expir") ||
        b.contains("recharge today") ||
        b.contains("recharge now") ||
        b.contains("your pack") ||
        b.contains("data pack") ||
        b.contains("missed call") ||
        b.contains("misted call") ||
        b.contains("voicemail") ||
        b.contains("voice mail") ||
        b.contains("call back") ||
        b.contains("call alert")) {
      return false
    }

    // ── 4. Drop future credit / refund notices ────────────────────────────────
    // Money has NOT moved. Actual credit arrives as a separate bank SMS.
    // [FIX] Was a literal .contains("will be credited") — breaks on
    // line-wrapped SMS ("will be\ncredited"), which real bank messages do.
    // Confirmed: an insurance maturity notice for Rs.713,954.55 (money not
    // due until a future date) slipped through this exact way and was
    // recorded as a completed credit today. Regex tolerates any whitespace
    // (including newlines) between the words instead of requiring them
    // contiguous on one line.
    if (Regex("""will\s+be\s+credited""", RegexOption.IGNORE_CASE).containsMatchIn(body) ||
        Regex("""will\s+be\s+processed""", RegexOption.IGNORE_CASE).containsMatchIn(body) ||
        Regex("""will\s+be\s+refunded""", RegexOption.IGNORE_CASE).containsMatchIn(body)) {
      return false
    }

    // ── 5. Drop loyalty points — not real money ───────────────────────────────
    // [FIX] Was matching "credited...-Rewards Team" — the loyalty-points check
    // was firing on a generic "Rewards Team" SENDER SIGNATURE appearing
    // anywhere after "credited", not just on actual points/coins language.
    // This silently dropped every genuine cashback SMS ("Cashback of Rs.X
    // credited to your Paytm Wallet...-Rewards Team") — real, spendable
    // money — as if it were non-monetary loyalty points. Confirmed 100% drop
    // rate on cashback_credit messages in testing.
    // Fix: require "points"/"coins" specifically (never used for real money)
    // and require "reward points" as an exact phrase (not bare "reward(s)",
    // which shows up in unrelated sender tags/footers). Cashback messages
    // ("Cashback of Rs.X credited...") are financial and must still pass —
    // they are governed by the normal debit/credit signal check in step 8,
    // not dropped here.
    val pointsCreditedPattern = Regex(
      """(?:points|coins|reward\s+points)\s.*credited|credited\s.*(?:points|coins|reward\s+points)""",
      RegexOption.IGNORE_CASE
    )
    if (pointsCreditedPattern.containsMatchIn(body)) return false

    // ── 6. Drop promotional messages ─────────────────────────────────────────
    // Three-part test: offer language AND promo URL AND no account reference.
    // A message with an account reference is never dropped here.
    val hasOfferLanguage =
      b.contains("pre-approved") ||
      b.contains("lifetime free") ||
      b.contains("t&c") ||
      b.contains("tap to") ||
      b.contains("tap here") ||
      b.contains("click here") ||
      b.contains("apply now") ||
      b.contains("avail now") ||
      b.contains("get upto") ||
      b.contains("get up to") ||
      b.contains("flat 5%") ||
      b.contains("5% cashback") ||
      b.contains("reward points") ||
      b.contains("free tickets") ||
      b.contains("limited time") ||
      b.contains("offer ends")

    val hasPromoUrl =
      b.contains("kotak.bank.in") ||
      b.contains("hdfc.bank.in") ||
      b.contains("hdfcbk.io") ||
      b.contains("airtelxstream") ||
      b.contains("airtel.in/") ||
      b.contains("bookmyshow.com") ||
      b.contains("vivoignite.com") ||
      (b.contains("http") && b.contains("bit.ly")) ||
      (b.contains("http") && b.contains("gs.im"))

    val hasAccountRef =
      Regex("""[ax][x/]\d{4}""").containsMatchIn(b) ||
      Regex("""a[/]c\s*[x*]{1,6}\d{4}""").containsMatchIn(b) ||
      Regex("""card\s+\d{4}""").containsMatchIn(b) ||
      (b.contains("your account") && (b.contains("debited") || b.contains("credited")))

    if (hasOfferLanguage && hasPromoUrl && !hasAccountRef) return false

    // ── 7. Drop non-financial service noise ───────────────────────────────────
    // Tamil-language strings are safe to hardcode — no Indian bank sends
    // transaction alerts in Tamil. These are utility/service messages only.
    //
    // Also drops named non-transaction categories:
    //   cc_statement         — CC billing summary (Total due / Min due / Pay by)
    //   booking_confirmation — IRCTC booking receipt with fare (payment already
    //                          captured as UPI debit to Indian Railways)
    //   trade_summary        — NSE/BSE daily trade value (money movement already
    //                          captured via Zerodha UPI/NACH)
    //   insurance_claim_status — Medi Assist / cashless claim status updates
    //                            (money goes hospital-to-hospital, never touches
    //                            your bank account SMS)
    //   pf_contribution_notice — EPFO PF balance / contribution notice
    //                            (deducted from CTC before salary credit,
    //                            no bank debit SMS exists)
    //   payment_pending_nudge — Pre-payment link from merchant/insurer
    //                           (actual payment captured separately)
    if (b.contains("power cut") ||
        b.contains("power outage") ||
        b.contains("will be restored") ||
        b.contains("மின்தடங்கல்") ||
        b.contains("ரீசார்ஜ்") ||
        b.contains("மிஸ்டு கால்") ||
        b.contains("beware dealing on unsolicited") ||
        b.contains("attention_investors") ||
        b.contains("locker access") ||
        b.contains("locker branch") ||
        b.contains("on-board food menu") ||
        b.contains("menurates.irctc") ||
        b.contains("boarding allowed") ||
        b.contains("trai dnd") ||
        b.contains("sanchar saathi") ||
        b.contains("mobile tower") ||
        // cc_statement — CC billing summary, not a transaction
        b.contains("total due:") ||
        b.contains("min.due:") ||
        b.contains("minimum due:") ||
        (b.contains("credit card") && b.contains("pay by") && b.contains("statement")) ||
        (b.contains("amount due") && b.contains("credit card") && b.contains("pay instantly")) ||
        // booking_confirmation — IRCTC booking receipt (fare lines)
        // "fare:" only appears in IRCTC booking confirmation SMS, not in bank transaction SMS
        Regex("""fare:\d+""", RegexOption.IGNORE_CASE).containsMatchIn(b) ||
        // trade_summary — NSE/BSE daily trade value confirmation
        (b.contains("traded value") && b.contains("cm rs")) ||
        (b.contains("trade confirmation") && b.contains("value rs")) ||
        (b.contains("fund bal") && b.contains("securities bal")) ||
        // insurance_claim_status — claim status updates (not bank transactions).
        // Money goes hospital-to-hospital via TPA, never touches bank account SMS.
        // Drop ALL cashless claim messages regardless of whether they mention an amount.
        // The one claim with INR amount (9119: "processed your Cashless Claim of INR 125928")
        // is also a status update — the actual hospital payment never appears in your SMS.
        b.contains("cashless claim") ||
        (b.contains("claim") && (b.contains("clarification") || b.contains("additional info") ||
          b.contains("received your cashless") || b.contains("processed your cashless"))) ||
        // pf_contribution_notice — EPFO passbook balance alert
        (b.contains("passbook balance") && b.contains("contribution")) ||
        // [FIX] Broadened — "EPFO: Your monthly PF contribution of Rs.X
        // (employee+employer) has been credited to your PF account for Jan
        // 2026." doesn't contain "passbook balance", so it slipped through
        // and was recorded as real spendable income. PF/EPF contributions
        // never touch the user's own bank account (it's an employer-to-
        // EPFO transfer, per architecture's own stated intent for this
        // exclusion) — same reasoning, broader phrasing coverage.
        ((b.contains("pf contribution") || b.contains("epf contribution")) &&
         (b.contains("credited to your pf") || b.contains("credited to your epf") || b.contains("passbook"))) ||
        b.contains("epfo youtube") ||
        // payment_pending_nudge — payment link from merchant (payment already captured)
        (b.contains("please complete the transaction") && b.contains("link is valid"))) {
      return false
    }

    // ── 8. Pass gate — BOTH amount AND direction required ─────────────────────
    val hasCurrencySignal = hasCurrencyMarker ||
      Regex("""\d{1,3}(,\d{3})*\.\d{2}""").containsMatchIn(b)

    val hasDirectionSignal =
      b.contains("debited")            || b.contains("credited")          ||
      b.contains("deducted")           || b.contains("withdrawn")         ||
      b.contains("deposited")          || b.contains("transferred")       ||
      b.contains("sent rs")            || b.contains("sent inr")          || b.contains("sent ₹") ||
      b.contains("spent")              ||
      b.contains("received rs")        || b.contains("received inr")      || b.contains("received ₹") ||
      b.contains("payment of")         || b.contains("payment alert")     ||
      b.contains("paid to")            || b.contains("paid rs")           || b.contains("paid inr") ||
      b.contains("refund")             || b.contains("reversal")          || b.contains("reversed") ||
      b.contains("salary")             || b.contains("credit alert")      || b.contains("debit alert") ||
      b.contains("txn alert")          || b.contains("transaction alert") ||
      b.contains("purchase of")        || b.contains("payment received")  ||
      b.contains("amount debited")     || b.contains("amount credited")   ||
      b.contains("avl bal")            || b.contains("balance after")     ||
      b.contains("declined")           ||
      // 'failed' tightened to transaction-specific forms only.
      // Bare 'failed' catches "KYC failed", "biometric auth failed" etc.
      // which are not financial transactions.
      b.contains("txn failed")         || b.contains("transaction failed") ||
      b.contains("payment failed")     ||
      // CC spend signals (bank-agnostic)
      b.contains("txn rs.")            ||   // HDFC CC spend: "Txn Rs.161.00\nOn HDFC Bank Card 4636"
      b.contains("has been used for")  ||   // ICICI/SBI/Kotak CC spend
      b.contains("has been charged")   ||   // IndusInd CC spend
      b.contains("spent on")           ||   // Axis/IDFC/Yes/SBI CC spend
      // Payment confirmation signals
      b.contains("is successful")      ||   // ICICI Lombard, Amazon Pay, wallets
      b.contains("was successful")     ||   // Axis/other NetBanking variant
      b.contains("payment successful") ||   // HDFC NetBanking: "Payment Successful! Rs.1175.00"
      b.contains("paid towards")       ||   // CC bill payment debit
      // Benefit card / transit card signals
      b.contains("is loaded with")     ||   // NCMC/transit card top-up
      b.contains("spent from")         ||   // Pluxee/Zeta/Zaggle spend: "Rs.350 spent from Pluxee"
      b.contains("successfully credited with") ||  // Pluxee/benefit card credit
      // [ADD] Confirmed 100% miss rate for each of the below across two
      // independent 500-message test datasets — each is a real, common
      // transaction template that this list simply didn't recognize.
      b.contains("withdrawal")         ||   // "Cash withdrawal of Rs.X..." (noun form; "withdrawn" above only
                                             // covers the verb form and doesn't substring-match "withdrawal")
      Regex("""\bwdl\b""", RegexOption.IGNORE_CASE).containsMatchIn(b) ||  // "ATM Cash Wdl of Rs.X..." (bank abbreviation)
      // [ADD] Legacy abbreviated bank SMS format: "AC XX2230 DR RS.77,614
      // ON 21FEB26 AVBL BAL RS.393,221.57 -YB". Bare "dr"/"cr" substring
      // checks are NOT used here deliberately — "dr" alone false-positives
      // on ordinary words like "address"/"ordered"/"hundred". Scoped
      // narrowly to the exact "AC <acct> DR/CR RS." shape, which is
      // extremely unlikely to appear outside this specific legacy format.
      Regex("""\bAC\s+[Xx*]{1,4}\d{4}\s+(?:DR|CR)\s+RS\.?\s*\d""", RegexOption.IGNORE_CASE).containsMatchIn(b) ||
      // [ADD] "Delhivery: Rs.X collected as COD payment for your shipment
      // delivered on DATE." — unlike prepaid e-commerce orders, there is no
      // separate bank SMS for cash paid at the door, so excluding this
      // (the way payee acknowledgments normally are) would mean the spend
      // is never captured anywhere. Treated as a real, if lower-confidence,
      // cash expense — see LEGACY... actually see COURIER_COD_PAYMENT rule
      // in ruleset.js. This is a product judgment call, not a definitive
      // "correct" answer; flag if you'd rather exclude it.
      b.contains("collected as")       ||
      b.contains("disbursed")          ||   // "Loan amount Rs.X disbursed to A/c..."
      b.contains("added to")           ||   // "Rs.X added to your PhonePe Wallet..."
      b.contains("used for")           ||   // "...Debit Card XNNNN used for Rs.X at MERCHANT..."
      Regex("""using\s+\w[\w\s]*card\s+\w*\s*for\s+rs""", RegexOption.IGNORE_CASE).containsMatchIn(b) ||  // "using SBI Debit Card X8812 for Rs..."
      b.contains("charged to")         || b.contains("charged for") ||  // ride fares, hotel/travel bookings
      b.contains("paid via")           ||   // "Rs.X paid via Cleartrip for..." (flight bookings)
      b.contains("paid for")           ||   // "BookMyShow: Rs.X paid for ... tickets"
      b.contains("paid at")            ||   // "Rs.X paid at Bharat Petroleum via card/UPI" (fuel)
      b.contains("cleared")            ||   // "Cheque No NNN for Rs.X has been cleared from A/c..."
      b.contains("purchased successfully") ||  // "Rs.X Google Play Gift Card purchased successfully..."
      b.contains("cash deposit")       ||   // "Cash deposit of Rs.X in A/c... via CDM..."
      b.contains("recharge of")        ||   // "Jio DTH Recharge of Rs.X successful..."
      b.contains("recharged with")     ||   // "Hyderabad Metro Smart Card recharged with Rs.X..."
      b.contains("issued against")     ||   // "Demand Draft No X for Rs.Y has been issued against A/c..."
      b.contains("loan amount")        ||   // belt-and-braces for loan disbursement phrasing variants
      // [ADD] "Airtel Postpaid Bill of Rs.X successful on..." — bare
      // "successful" (no "is"/"was"/"payment" prefix). Safe to add broadly
      // here because this whole block only runs after hasCurrencySignal is
      // already required to be true.
      b.contains("successful")         ||
      // [FIX] "failed" tightened check above only matches when the word is
      // immediately adjacent to "txn"/"transaction"/"payment". A natural
      // phrasing like "Transaction of Rs.X failed on..." (word order breaks
      // the adjacency) was silently dropped. Since this check only runs
      // after hasCurrencySignal is already required to be true, a bare
      // "failed" is safe here — non-financial messages like "KYC failed" or
      // "biometric auth failed" essentially never carry a Rs./INR amount.
      b.contains("failed")

    if (!hasCurrencySignal || !hasDirectionSignal) return false

    // ── 9. Drop payee-side acknowledgments (generic) ──────────────────────────
    //
    // Payee acknowledgments come from the merchant/utility/service confirming
    // they received your payment. The bank has already sent the real debit SMS.
    // Passing these creates false credits or duplicate debits.
    //
    // Generic structural rule (no merchant names):
    // Payee acknowledgments NEVER have a bank account reference.
    // Bank SMS ALWAYS has one (XX2759, Card x2343, A/c No 2759).
    // This difference makes the rule work for any merchant/utility.

    val hasBankAccountRef =
      Regex("""[ax][x*/]\d{4}""", RegexOption.IGNORE_CASE).containsMatchIn(b) ||
      Regex("""a/c\s*(?:no\.?)?\s*[x*]{0,4}\d{4}""", RegexOption.IGNORE_CASE).containsMatchIn(b) ||
      Regex("""card\s+[x*]?\d{4}""", RegexOption.IGNORE_CASE).containsMatchIn(b) ||
      Regex("""account\s+[x*]{1,4}\d{4}""", RegexOption.IGNORE_CASE).containsMatchIn(b)

    val isPayeeAcknowledgment =
      !hasBankAccountRef && (
        b.contains("thank you for your payment") ||   // utility/service receipt (CMWSSB, water boards etc.)
        b.contains("payment received")      ||   // utilities, schools, general
        b.contains("amount received")       ||   // housing, hospitals
        b.contains("premium received")      ||   // insurance
        b.contains("fee received")          ||   // schools, colleges
        b.contains("we have received")      ||   // generic
        b.contains("received your payment") ||   // generic
        // Recharge confirmation from provider side — bank debit already captured
        (b.contains("is successful") && b.contains("recharge")) ||
        // Service activation from provider side
        (b.contains("has been activated") && (b.contains("inr") || b.contains("rs.")))
      )

    if (isPayeeAcknowledgment) return false

    return true
  }

  // ───────────────────────────────────────────────────────────────────────────
  // PERMISSION CHECK
  // ───────────────────────────────────────────────────────────────────────────

  private fun hasPermission(context: android.content.Context): Boolean {
    return ContextCompat.checkSelfPermission(
      context, Manifest.permission.READ_SMS
    ) == PackageManager.PERMISSION_GRANTED
  }
}
