/**
 * confidenceGate.js — Layer 2 "confidence gate"
 * Proposed location: apps/mobile/src/lib/confidenceGate.js
 *
 * PROBLEM THIS SOLVES:
 * matchMessage() in ruleset.js only self-rejects when amount or direction
 * come back null (see matchMessage()'s own `if (result.amount === null ||
 * result.direction === null) return null;`). Everything else — a wrong or
 * blank bank, a garbage merchant, a channel that fell through to a default
 * — is returned as a "successful" match and trusted completely. This is
 * exactly how the SRINIVASA/MURALI V bugs (see ruleset.js change log)
 * existed silently for a while: technically successful, actually wrong,
 * and nothing ever double-checked it.
 *
 * SCOPE (deliberate): this only assesses Layer 2 matches — i.e. only the
 * `l2 && !l2.discard` branch in smsParser.ts. It was backtested against
 * 1,140 real Layer-2-matched rows from transactions_rows__2_.csv, NOT
 * against the taxonomy-fallback path's extractFields() output, which uses
 * a different extractor entirely. Do not call this on taxonomy-fallback
 * results without backtesting that path separately first — the false-flag
 * rate has not been measured there and may differ.
 *
 * HISTORY:
 * First attempt used 5 checks and flagged 91% of matches — useless. Two of
 * those checks were too noisy: "matched via a generic rule" flagged huge
 * numbers of perfectly correct transactions, and "leftover unexplained
 * text" flagged normal boilerplate (Ref numbers, "Not You?" text) as
 * suspicious. Cut down to the 2 checks below, which backtested at a 7%
 * flag rate (84/1,140) — workable, not noisy. Only 1 of 372 already-
 * `approved` rows would have flipped to review. Retroactively caught both
 * real bugs found this session (SRINIVASA, MURALI V) when tested against
 * the pre-fix code, caught purely by shape (merchant === null), without
 * knowing the specific pattern in advance. 25 randomly sampled unflagged
 * rows were manually audited by hand — all 25 were genuinely correct.
 *
 * HONEST LIMITATION: this only catches *structurally* broken results
 * (empty, numeric, garbled). It cannot catch a wrong-but-plausible-looking
 * extraction — e.g. a regex grabbing the wrong field, where that field
 * still happens to look like a real name. No offline backtest can give a
 * true number for that risk; the only way to measure it is to run this in
 * shadow mode against real production traffic and track real corrections
 * over time. Do not treat a low flag rate as "this is 93% accurate" — it
 * is only "7% of matches look structurally suspicious."
 */

// Merchant "looks fake" if any of these hold. Thresholds match what the
// merchant-extraction regexes in ruleset.js themselves allow (capture
// groups are typically 1-40 chars), so "too short/too long" here is meant
// to catch extraction spillover, not to second-guess a legitimately short
// or long real name.
const MIN_MERCHANT_LEN = 3;
const MAX_MERCHANT_LEN = 40;

function merchantLooksFake(merchant) {
  if (merchant === null || merchant === undefined) return 'merchant_null';

  const trimmed = String(merchant).trim();

  if (trimmed.length === 0) return 'merchant_null';
  if (/^\d+$/.test(trimmed)) return 'merchant_pure_digits';
  if (trimmed.includes('/')) return 'merchant_contains_slash';
  if (/a\/c/i.test(trimmed)) return 'merchant_contains_ac';
  if (/cust\s*id/i.test(trimmed)) return 'merchant_contains_cust_id';
  if (/not\s+you/i.test(trimmed)) return 'merchant_contains_not_you';
  if (trimmed.length < MIN_MERCHANT_LEN) return 'merchant_too_short';
  if (trimmed.length > MAX_MERCHANT_LEN) return 'merchant_too_long';

  return null;
}

/**
 * assessConfidence(l2)
 *
 * @param {object} l2 - the object returned by matchMessage() in ruleset.js
 *   for a successful (non-null, non-discard) match. Only l2.bank and
 *   l2.merchant are read — everything else is ignored on purpose (see
 *   HISTORY above on why the first 3 checks were dropped).
 *
 * @returns {{ flagged: boolean, reasons: string[] }}
 *   flagged   - true if either check fired.
 *   reasons   - machine-readable reason codes, for logging. Can be more
 *               than one (e.g. bank null AND merchant null on the same
 *               row) — callers should store the full list, not just the
 *               first reason, so the shadow log can tell which check(s)
 *               are actually pulling their weight over time.
 */
function assessConfidence(l2) {
  const reasons = [];

  // Check 1 — bank name came back null.
  if (!l2 || !l2.bank) {
    reasons.push('bank_null');
  }

  // Check 2 — merchant looks structurally fake.
  const merchantReason = l2 ? merchantLooksFake(l2.merchant) : 'merchant_null';
  if (merchantReason) {
    reasons.push(merchantReason);
  }

  return {
    flagged: reasons.length > 0,
    reasons,
  };
}

module.exports = { assessConfidence, merchantLooksFake };