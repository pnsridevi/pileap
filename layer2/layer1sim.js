/**
 * layer2/layer1sim.js
 *
 * JS mirror of SmsReaderModule.kt's Layer 0 + Layer 1 filtering logic, for
 * use in Node-based test harnesses (comparison_test.js, pipeline_test.js)
 * where the real filter runs on-device in Kotlin and can't be called
 * directly from a test script.
 *
 * MUST STAY IN SYNC WITH SmsReaderModule.kt — this is a manual port, not a
 * shared source. If SmsReaderModule.kt changes, this file must be updated
 * to match, or these test scripts will silently test against stale logic.
 * Ported from and validated against the SmsReaderModule.kt patch that was
 * regression-tested across 2400 messages (0 crashes, 0 unexpected drops)
 * — see PATCH_NOTES_ROUND3.md for what's covered.
 *
 * Exports:
 *   passesLayer0(address)      — sender-level drops (mirrors Kotlin Layer 0
 *                                 in getMessages(): -P suffix, pure numeric)
 *   passesLayer1Filter(body)   — body-first liberal filter, returns
 *                                 { pass: boolean, reason: string|null }
 *
 * Change log:
 *   - [FIX] hasDirectionSignal only checked b.includes("avl bal") — the
 *     abbreviated per-transaction form ("Avl Bal Rs.X"). It never matched
 *     the spelled-out form banks use in recurring daily/EOD balance
 *     broadcasts: "Available Bal in HDFC Bank A/c XX2875 as on
 *     yesterday:01-APR-26 is INR 27,51,128.12." On days with no other
 *     balance-bearing transaction SMS, this broadcast was the ONLY source
 *     of balance data for the account — and it was being dropped entirely
 *     (no_signal), not merely miscategorized downstream. Confirmed on a
 *     real 90-180 day device export: 75/633 messages (11.8%) matched this
 *     exact pattern, 0 of them passing before this fix. Mirrors the
 *     identical fix in SmsReaderModule.kt. These are still not
 *     transactions — see BALANCE_ALERT_ONLY in ruleset.js for how Layer 2
 *     routes them to an accounts.balance_latest update instead of
 *     pending_review once they reach it. This fix only ensures they aren't
 *     discarded before they get that far.
 */

// ─── Layer 0 — sender-level drops ─────────────────────────────────────────
// Mirrors the inline checks in SmsReaderModule.kt's getMessages():
//   if (address.endsWith("-P", ignoreCase = true)) continue
//   if (address.matches(Regex("^\\d+$"))) continue

function passesLayer0(address) {
  if (!address) return false;
  if (address.toUpperCase().endsWith('-P')) return false;
  if (/^\d+$/.test(address)) return false;
  return true;
}

// ─── Layer 1 — body-first liberal filter ──────────────────────────────────

// Port of SmsReaderModule.kt passesFilter() logic to JS for testing
function passesLayer1Filter(body) {
  const b = body.toLowerCase();

  // 1. OTP
  if (b.includes("otp") || b.includes("one time password") || b.includes("verification code") ||
      b.includes("do not share") || b.includes("do not disclose") || b.includes("never share") ||
      b.includes("confidential code") || b.includes("login code") || b.includes("sign in code") ||
      b.includes("authentication code") || b.includes("is your otp") || b.includes("is the otp")) {
    return { pass: false, reason: 'otp' };
  }

  // 2. delivery/logistics
  // [ADD] "Amt 235 will be refunded..." — whole-rupee amount stated via
  // "Amt" with no "Rs."/"INR" token and no decimal point at all, so it
  // matched neither the existing rs./rs␣/inr/₹/rs\d markers nor the
  // decimal-amount fallback used elsewhere in this file. Confirmed: 5 of
  // 11 real IRCTC refund messages in a real device export used this exact
  // form and had no currency signal at all as a result — same failure
  // shape as the already-fixed "Rs1,532" (no space/period) gap, different
  // missing token. Generic "amt" + digit check, not IRCTC-specific.
  const hasCurrencyMarker = b.includes("rs.") || b.includes("rs ") || b.includes("inr") || b.includes("₹") || /rs\d/.test(b) || /\bamt\.?\s*\d/i.test(b);
  if (!hasCurrencyMarker) {
    if (b.includes("out for delivery") || b.includes("shipment") || b.includes("your order has been") ||
        b.includes("pickup scheduled") || b.includes("courier") || b.includes("tracking id") ||
        b.includes("dispatched") || b.includes("order confirmed") || b.includes("order placed")) {
      return { pass: false, reason: 'delivery' };
    }
  }

  // 3. telecom noise
  if (b.includes("pack expir") || b.includes("recharge today") || b.includes("recharge now") ||
      b.includes("your pack") || b.includes("data pack") || b.includes("missed call") ||
      b.includes("misted call") || b.includes("voicemail") || b.includes("voice mail") ||
      b.includes("call back") || b.includes("call alert")) {
    return { pass: false, reason: 'telecom' };
  }

  // 4. future credit
  // [CHANGED] This used to hard-drop these messages outright (money hasn't
  // moved yet; actual credit expected as a separate later bank SMS). That
  // was safe as long as this phrasing only covered rare, non-actionable
  // cases like a distant insurance maturity date. Real data shows it also
  // covers near-term, concrete promises that genuinely need tracking: 11
  // real IRCTC refund messages ("Amt 375.36 will be refunded within 3-4
  // days... -IRCTC") were being silently and permanently dropped by this
  // exact rule, with no way to ever reconcile them against the bank
  // credit that follows days later.
  // No longer dropped here — these now pass through to Layer 2, where a
  // dedicated rule (PROVISIONAL_CREDIT_NOTICE in ruleset.js) intercepts
  // "will be credited/refunded/processed" BEFORE GENERIC_CREDIT's bare
  // \bcredited\b/\brefunded\b patterns can wrongly treat these as a
  // completed transaction — that interception is what now prevents the
  // original insurance-maturity regression, in place of the outright drop
  // that used to sit here. See PROVISIONAL_CREDIT_NOTICE and the
  // reconciliation logic in transactions.ts for the full flow: these
  // create a flagged, pending_review placeholder that gets automatically
  // hidden (is_deleted) once a matching real bank credit is later
  // ingested — so only the real credit ends up visible to the user.

  // 5. loyalty points
  if (/(?:points|coins|reward\s+points)\s.*credited|credited\s.*(?:points|coins|reward\s+points)/i.test(body)) {
    return { pass: false, reason: 'loyalty' };
  }

  // 6. promotional
  const hasOfferLanguage = b.includes("pre-approved") || b.includes("lifetime free") || b.includes("t&c") ||
    b.includes("tap to") || b.includes("tap here") || b.includes("click here") || b.includes("apply now") ||
    b.includes("avail now") || b.includes("get upto") || b.includes("get up to") || b.includes("flat 5%") ||
    b.includes("5% cashback") || b.includes("reward points") || b.includes("free tickets") ||
    b.includes("limited time") || b.includes("offer ends");
  const hasPromoUrl = b.includes("kotak.bank.in") || b.includes("hdfc.bank.in") || b.includes("hdfcbk.io") ||
    b.includes("airtelxstream") || b.includes("airtel.in/") || b.includes("bookmyshow.com") ||
    b.includes("vivoignite.com") || (b.includes("http") && b.includes("bit.ly")) || (b.includes("http") && b.includes("gs.im"));
  const hasAccountRef = /[ax][x/]\d{4}/.test(b) || /a\/c\s*[x*]{1,6}\d{4}/.test(b) || /card\s+\d{4}/.test(b) ||
    (b.includes("your account") && (b.includes("debited") || b.includes("credited")));
  if (hasOfferLanguage && hasPromoUrl && !hasAccountRef) return { pass: false, reason: 'promo' };

  // 7. non-financial service noise
  if (b.includes("power cut") || b.includes("power outage") || b.includes("will be restored") ||
      b.includes("beware dealing on unsolicited") || b.includes("attention_investors") ||
      b.includes("locker access") || b.includes("locker branch") || b.includes("on-board food menu") ||
      b.includes("menurates.irctc") || b.includes("boarding allowed") || b.includes("trai dnd") ||
      b.includes("sanchar saathi") || b.includes("mobile tower") ||
      b.includes("total due:") || b.includes("min.due:") || b.includes("minimum due:") ||
      (b.includes("credit card") && b.includes("pay by") && b.includes("statement")) ||
      (b.includes("amount due") && b.includes("credit card") && b.includes("pay instantly")) ||
      /fare:\d+/i.test(b) ||
      (b.includes("traded value") && b.includes("cm rs")) ||
      (b.includes("trade confirmation") && b.includes("value rs")) ||
      (b.includes("fund bal") && b.includes("securities bal")) ||
      b.includes("cashless claim") ||
      (b.includes("claim") && (b.includes("clarification") || b.includes("additional info") || b.includes("received your cashless") || b.includes("processed your cashless"))) ||
      (b.includes("passbook balance") && b.includes("contribution")) ||
      ((b.includes("pf contribution") || b.includes("epf contribution")) &&
       (b.includes("credited to your pf") || b.includes("credited to your epf") || b.includes("passbook"))) ||
      b.includes("epfo youtube") ||
      (b.includes("please complete the transaction") && b.includes("link is valid"))) {
    return { pass: false, reason: 'service_noise' };
  }

  // 8. pass gate
  const hasCurrencySignal = hasCurrencyMarker || /\d{1,3}(,\d{3})*\.\d{2}/.test(b);
  const hasDirectionSignal =
    b.includes("debited") || b.includes("credited") || b.includes("deducted") || b.includes("withdrawn") ||
    b.includes("deposited") || b.includes("transferred") ||
    b.includes("sent rs") || b.includes("sent inr") || b.includes("sent ₹") ||
    b.includes("spent") ||
    b.includes("received rs") || b.includes("received inr") || b.includes("received ₹") ||
    b.includes("payment of") || b.includes("payment alert") ||
    b.includes("paid to") || b.includes("paid rs") || b.includes("paid inr") ||
    b.includes("refund") || b.includes("reversal") || b.includes("reversed") ||
    b.includes("salary") || b.includes("credit alert") || b.includes("debit alert") ||
    b.includes("txn alert") || b.includes("transaction alert") ||
    b.includes("purchase of") || b.includes("payment received") ||
    b.includes("amount debited") || b.includes("amount credited") ||
    b.includes("avl bal") ||
    // [FIX] "avl bal" only matches the abbreviated per-transaction form
    // ("Avl Bal Rs.X"). It never matched the spelled-out form used in
    // recurring daily/EOD balance broadcasts: "Available Bal in HDFC Bank
    // A/c XX2875 as on yesterday:01-APR-26 is INR 27,51,128.12." Confirmed
    // on real device data: 75/633 messages (11.8%) matched this exact
    // pattern and were being lost entirely. Mirrors the identical fix in
    // SmsReaderModule.kt.
    b.includes("available bal") ||
    b.includes("balance after") ||
    b.includes("declined") ||
    b.includes("txn failed") || b.includes("transaction failed") || b.includes("payment failed") ||
    b.includes("txn rs.") || b.includes("has been used for") || b.includes("has been charged") ||
    b.includes("spent on") ||
    b.includes("is successful") || b.includes("was successful") || b.includes("payment successful") ||
    b.includes("paid towards") ||
    b.includes("is loaded with") || b.includes("spent from") || b.includes("successfully credited with") ||
    // [ADD] mirrors SmsReaderModule.kt patch
    b.includes("withdrawal") ||
    /\bwdl\b/i.test(b) ||
    /\bAC\s+[Xx*]{1,4}\d{4}\s+(?:DR|CR)\s+RS\.?\s*\d/i.test(b) ||
    b.includes("collected as") ||
    b.includes("disbursed") ||
    b.includes("added to") ||
    b.includes("used for") ||
    /using\s+\w[\w\s]*card\s+\w*\s*for\s+rs/i.test(b) ||
    b.includes("charged to") || b.includes("charged for") ||
    b.includes("paid via") ||
    b.includes("paid for") ||
    b.includes("paid at") ||
    b.includes("cleared") ||
    b.includes("purchased successfully") ||
    b.includes("cash deposit") ||
    b.includes("recharge of") ||
    b.includes("recharged with") ||
    b.includes("issued against") ||
    b.includes("loan amount") ||
    b.includes("successful") ||
    // [FIX] mirrors SmsReaderModule.kt patch — bare "failed" now allowed
    // (safe because hasCurrencySignal is already required)
    b.includes("failed") ||
    // [ADD] Vendor/broker settlement & payout language. Confirmed gap: a
    // real Zerodha quarterly settlement SMS ("Your quarterly settlement
    // payout for Rs.83.24... is processed... You should see the funds in
    // your bank account within 24 hours") matched NONE of the signals
    // above and was dropped as no_signal — permanently, since Layer 1
    // false negatives can't be recovered downstream. Unlike step 4's
    // future_credit drop (explicit "will be credited/processed/refunded"
    // — money NOT yet moved, a separate bank SMS is expected later), this
    // phrasing describes a settlement that has ALREADY happened ("is
    // processed", not "will be processed") and — per real device data —
    // sometimes has NO separate bank-side confirmation SMS at all for
    // small broker/vendor settlements. Generic by construction: keyed on
    // structural vendor-settlement vocabulary, not on "Zerodha" or any
    // named sender, so this applies equally to Groww/Upstox/any payout
    // source, any user. Safe to add broadly here because, like every
    // other entry in this block, it only fires after hasCurrencySignal is
    // already required to be true. Downstream, Layer 2 does not yet have
    // a rule that positively recognizes this pattern as a confirmed
    // transaction — it will fall through to the taxonomy fallback /
    // Haiku escalation path and land in pending_review, which is the
    // correct, safe landing spot until the dedicated Layer 2 rule +
    // bank-confirmation reconciliation check are built (next step).
    b.includes("processed") ||
    b.includes("settlement") ||
    b.includes("payout");

  if (!hasCurrencySignal || !hasDirectionSignal) return { pass: false, reason: 'no_signal' };

  // 9. payee ack
  const hasBankAccountRef = /[ax][x*/]\d{4}/i.test(b) || /a\/c\s*(?:no\.?)?\s*[x*]{0,4}\d{4}/i.test(b) ||
    /card\s+[x*]?\d{4}/i.test(b) || /account\s+[x*]{1,4}\d{4}/i.test(b);
  const isPayeeAck = !hasBankAccountRef && (
    b.includes("thank you for your payment") || b.includes("payment received") || b.includes("amount received") ||
    b.includes("premium received") || b.includes("fee received") || b.includes("we have received") ||
    b.includes("received your payment") ||
    (b.includes("is successful") && b.includes("recharge")) ||
    (b.includes("has been activated") && (b.includes("inr") || b.includes("rs.")))
  );
  if (isPayeeAck) return { pass: false, reason: 'payee_ack' };

  return { pass: true, reason: null };
}

module.exports = { passesLayer0, passesLayer1Filter };