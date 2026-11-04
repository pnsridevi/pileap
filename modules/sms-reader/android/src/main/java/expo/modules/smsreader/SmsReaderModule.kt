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
import expo.modules.interfaces.taskManager.TaskManagerInterface

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
//   - [FIX] hasDirectionSignal only checked b.contains("avl bal") — the
//     abbreviated form used in per-transaction "Avl Bal Rs.X" disclosures.
//     It did NOT match "Available Bal", the spelled-out form banks use in
//     recurring daily/EOD balance broadcasts (e.g. "Available Bal in HDFC
//     Bank A/c XX2875 as on yesterday:01-APR-26 is INR 27,51,128.12.").
//     These broadcasts were being dropped entirely as no_signal — on days
//     with no other balance-bearing transaction, this was the ONLY source
//     of balance data for the account, so it was lost permanently, not just
//     miscategorized downstream. Confirmed on a real 90-180 day device
//     export: 75 of 633 messages (11.8%) matched this exact pattern and
//     were all being dropped before this fix. Added "available bal" as an
//     additional direction signal alongside the existing "avl bal" check.
//     These messages are still not transactions — Layer 2's
//     BALANCE_ALERT_ONLY rule (ruleset.js) is what routes them to an
//     accounts.balance_latest update instead of pending_review once they
//     reach it. This fix only ensures they aren't discarded before they
//     get that far.
//   - [FIX] "withdrawal" direction-signal check (step 8) is a bare
//     substring match, which matched the plural "withdrawals" inside
//     forward-looking POLICY text ("UPI cash withdrawals at ATMs will be
//     part of monthly free ATM txn limits. Rs. 23+tax per txn will apply
//     post free limit."), not just real withdrawal events — turning a fee-
//     schedule announcement into a phantom transaction. Added a step 7
//     exclusion scoped to the "w.e.f./effective from" + "will apply"
//     policy-notice construction. Mirrors the identical fix in
//     layer1sim.js.
//   - [ADD] "confirm(ed) receipt of Rs" added as a direction signal (step
//     8) — vendor/payee-side payment confirmations (e.g. insurer premium
//     receipts: "We confirm receipt of Rs. 28658.18 towards ManipalCigna
//     proposal no. : LIFETM050002204.") were being dropped as no_signal
//     with no safety net if the matching bank-side debit SMS were ever
//     missing. Layer 2's new PAYMENT_CONFIRMATION_NOTICE rule (ruleset.js)
//     + transactions.ts reconciliation is what prevents this from double-
//     counting alongside a real bank debit — mirrors the existing
//     PROVISIONAL_CREDIT_NOTICE pattern (IRCTC refunds, vendor
//     settlements) but for the debit side. Deliberately NOT added to the
//     step 9 payee-acknowledgment drop-list: unlike those phrases, this
//     one has no reconciliation safety net elsewhere if dropped, so it
//     must survive to Layer 2 instead. Mirrors the identical fix in
//     layer1sim.js.
// ─────────────────────────────────────────────────────────────────────────────

class SmsReaderModule : Module() {
  // [ADD] Per-call scratch value set by passesFilter() right before it
  // returns false at the one drop point (step 8, no_direction) that
  // getLayer1Candidates() cares about. Reset to null at the start of every
  // passesFilter() invocation by the caller loop — see getLayer1Candidates()
  // below. Not thread-shared state: SMS reading runs on a single coroutine
  // per call, never concurrently within one AsyncFunction invocation.
  // [CHANGE — Nov 4] Layer 1 now lives in Layer1Filter.kt (moved unchanged)
  // so the SMS listener can use the same rules.
  private val filter = Layer1Filter()

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

            if (filter.passesFilter(body)) {
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

    // ── getLayer1Candidates ─────────────────────────────────────────────────
    // [ADD] Returns messages Layer 1 dropped specifically because a currency
    // signal was present but no recognized direction verb was found
    // (passesFilter's step 8 "no_direction" case) — the one drop category
    // backtesting showed has real (if rare, ~4.7% of drops) risk of losing
    // genuine transactions, the same shape that produced the Zerodha
    // "processed" and IRCTC "will be refunded" bugs before those verbs were
    // added. Every other Layer 1 drop (OTP, telecom, loyalty, promo,
    // service_noise, payee_ack) is intentionally excluded — backtested as
    // safe, reliably paired with a separate real bank SMS.
    //
    // These are logging candidates only. Nothing here creates a transaction
    // or calls Haiku — see logLayer1Candidates() in smsParser.ts, which
    // writes them into the existing Log A (haiku_candidate_log) pipeline.
    AsyncFunction("getLayer1Candidates") { fromDays: Int, toDays: Int, promise: Promise ->
      val context = appContext.reactContext
        ?: return@AsyncFunction promise.reject(
            CodedException("ERR_NO_CONTEXT", "React context unavailable", null))

      if (!hasPermission(context)) {
        promise.reject(CodedException("ERR_NO_PERMISSION", "READ_SMS permission not granted", null))
        return@AsyncFunction
      }

      try {
        val candidates = mutableListOf<Map<String, Any?>>()
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

            // Same Layer 0 gate as getMessages() — a -P/numeric sender is
            // never a candidate regardless of what its body says.
            if (address.endsWith("-P", ignoreCase = true)) continue
            if (address.matches(Regex("^\\d+$"))) continue

            filter.lastDropReason = null
            val passed = filter.passesFilter(body)
            if (!passed && filter.lastDropReason == "no_direction") {
              candidates.add(mapOf(
                "id"      to it.getString(idIndex),
                "address" to address,
                "body"    to body,
                "date"    to it.getLong(dateIndex)
              ))
            }
          }
        }

        promise.resolve(candidates)
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

    // ── SMS listener ([ADD — Nov 4]) ─────────────────────────────────────────
    // registerListenerTask(name): connects the JS task defined with
    // TaskManager.defineTask(name, ...) to ListenerTaskConsumer, so
    // ListenerSyncWorker can run it after a bank SMS. Safe to call on every
    // app start; does nothing if already registered.
    AsyncFunction("registerListenerTask") { taskName: String ->
      val taskManager = appContext.legacyModule<TaskManagerInterface>()
        ?: throw CodedException("ERR_NO_TASK_MANAGER", "expo-task-manager not available", null)
      if (!taskManager.taskHasConsumerOfClass(taskName, ListenerTaskConsumer::class.java)) {
        taskManager.registerTask(taskName, ListenerTaskConsumer::class.java, emptyMap<String, Any>())
      }
    }

    // SmsListenerReceiver and ListenerSyncWorker record what they did in a
    // small on-phone list (ListenerEventStore). JS reads it with
    // peekListenerEvents(), uploads it to background_sync_log, and only
    // then calls clearListenerEvents(count), so nothing is lost if the
    // upload fails.
    AsyncFunction("peekListenerEvents") { promise: Promise ->
      val context = appContext.reactContext
        ?: return@AsyncFunction promise.resolve("[]")
      promise.resolve(ListenerEventStore.peek(context))
    }

    // [ADD — build 2] Lets the JS listener task record its own steps in the
    // same on-phone log (no network needed, so it still works if the app is
    // about to be frozen). detailsJson is a JSON object string.
    AsyncFunction("recordListenerEvent") { event: String, detailsJson: String, promise: Promise ->
      val context = appContext.reactContext
        ?: return@AsyncFunction promise.resolve(null)
      val details = try { org.json.JSONObject(detailsJson) } catch (e: Exception) { org.json.JSONObject() }
      ListenerEventStore.addJson(context, event, details)
      promise.resolve(null)
    }

    AsyncFunction("clearListenerEvents") { count: Int, promise: Promise ->
      val context = appContext.reactContext
        ?: return@AsyncFunction promise.resolve(null)
      ListenerEventStore.removeFirst(context, count)
      promise.resolve(null)
    }

    // ── hasPermission ────────────────────────────────────────────────────────
    AsyncFunction("hasPermission") { promise: Promise ->
      val context = appContext.reactContext
        ?: return@AsyncFunction promise.resolve(false)
      promise.resolve(hasPermission(context))
    }
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