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
  const hasCurrencyMarker = b.includes("rs.") || b.includes("rs ") || b.includes("inr") || b.includes("₹") || /rs\d/.test(b);
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
  // [FIX] Was a literal b.includes("will be credited") — breaks on
  // line-wrapped SMS ("will be\ncredited"). Confirmed: an insurance
  // maturity notice for Rs.713,954.55 (money not due until a future date)
  // slipped through this exact way and was recorded as a completed credit
  // today. Now tolerates any whitespace between the words.
  if (/will\s+be\s+credited/i.test(body) || /will\s+be\s+processed/i.test(body) || /will\s+be\s+refunded/i.test(body)) {
    return { pass: false, reason: 'future_credit' };
  }

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
    b.includes("avl bal") || b.includes("balance after") ||
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
    b.includes("failed");

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
