/**
 * layer3/haiku.js
 *
 * Layer 3 fallback — calls Claude Haiku to classify SMS that Layer 2's
 * regex ruleset couldn't match. pipeline_test.js requires this file
 * unconditionally at the top (`require('../layer3/haiku')`), so this file
 * must always exist and load cleanly even when --haiku isn't passed;
 * callHaiku() itself only needs to actually work when it's called.
 *
 * SCOPE (per product decision): this is ONLY for messages Layer 2's
 * regex ruleset genuinely can't classify — new or unrecognized bank/
 * vendor SMS templates. It is deliberately NOT used for the vendor-
 * payout-notice / bank-confirmation reconciliation logic (see
 * VENDOR_SETTLEMENT_NOTICE / PROVISIONAL_CREDIT_NOTICE in ruleset.js and
 * the reconciliation functions in transactions.ts) — that stays fully
 * deterministic, no LLM judgment call involved. Haiku's only job is the
 * narrower one: "I don't recognize this template at all, what is it."
 *
 * Return shape (consumed by pipeline_test.js and, eventually, whatever
 * backend worker processes the parse_jobs queue — see note at the bottom
 * of this file, that worker doesn't exist in what's been shared so far):
 *   {
 *     is_promotional: boolean,
 *     direction: 'credit' | 'debit' | null,
 *     amount: number | null,
 *     merchant: string | null,
 *     confidence: number | null,
 *   }
 */

const USE_REAL_HAIKU = !!process.env.ANTHROPIC_API_KEY;

// Kept narrow and explicit on purpose: this prompt should only ever be
// asked to do what Layer 2 already couldn't — classify a message it has
// never seen a template for. It is NOT asked to make judgment calls Layer
// 2 handles deterministically (promotional-sender filtering by TRAI
// suffix, duplicate detection, NACH/mandate handling, vendor-notice
// reconciliation) — all of that stays in ruleset.js/transactions.ts.
const SYSTEM_PROMPT = `You classify Indian bank and financial-vendor SMS messages that a regex-based parser could not match against any known template. You are only ever called on messages that already failed every existing rule — your job is narrow: figure out what this specific, unrecognized message is.

Determine:
1. Is this promotional, an OTP, or other non-transactional noise that should have been filtered before reaching you?
2. If it describes a real or promised movement of money: the direction (credit = money to the user, debit = money from the user), the amount in rupees, and the merchant or counterparty name if identifiable from the text.

Respond with ONLY a JSON object — no markdown fences, no other text:
{
  "is_promotional": boolean,
  "direction": "credit" | "debit" | null,
  "amount": number | null,
  "merchant": string | null,
  "confidence": number
}

"confidence" is your own confidence in this classification, from 0 to 1.
If you cannot confidently determine the amount or direction, return null for that field rather than guessing — a human reviews the original message either way (this always routes to pending_review), so a null is safer than a wrong number.`;

async function callHaiku(body) {
  if (!USE_REAL_HAIKU) {
    throw new Error(
      'callHaiku() was invoked but ANTHROPIC_API_KEY is not set. ' +
      'Either set the env var, or don\'t pass --haiku.'
    );
  }

  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const Anthropic = require('@anthropic-ai/sdk');
  const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

  const msg = await client.messages.create({
    model: 'claude-haiku-4-5-20251001',
    max_tokens: 300,
    system: SYSTEM_PROMPT,
    messages: [{ role: 'user', content: body }],
  });

  const text = msg.content
    .filter((block) => block.type === 'text')
    .map((block) => block.text)
    .join('');

  // Defensive: models occasionally wrap JSON in fences despite instructions
  // not to. Strip them before parsing rather than failing on a technicality.
  const cleaned = text.replace(/```json|```/g, '').trim();

  let parsed;
  try {
    parsed = JSON.parse(cleaned);
  } catch (e) {
    throw new Error(`callHaiku() got a non-JSON response from Haiku: ${text.slice(0, 200)}`);
  }

  // Validate/coerce rather than trusting the model's output shape blindly —
  // a malformed field here should degrade to null (safe, routes to human
  // review), not silently propagate a wrong type into the pipeline.
  return {
    is_promotional: !!parsed.is_promotional,
    direction: (parsed.direction === 'credit' || parsed.direction === 'debit') ? parsed.direction : null,
    amount: (typeof parsed.amount === 'number' && !isNaN(parsed.amount)) ? parsed.amount : null,
    merchant: (typeof parsed.merchant === 'string' && parsed.merchant.trim()) ? parsed.merchant.trim() : null,
    confidence: (typeof parsed.confidence === 'number' && !isNaN(parsed.confidence)) ? parsed.confidence : null,
  };
}

module.exports = { callHaiku };

// ─── STILL OPEN — not addressed by this file alone ─────────────────────────
// The actual caller (the backend worker that reads the parse_jobs queue and
// invokes callHaiku() per smsParser.ts's own header comment: "The backend
// Haiku worker picks these up from the parse_jobs queue after they are
// uploaded") has not been shared and doesn't appear to exist in what's been
// provided so far. Filling in this function makes --haiku usable from
// pipeline_test.js/comparison_test.js (the test harnesses that already
// import it), but does NOT wire Haiku into the real production pipeline —
// that worker still needs to be written, including its own decisions on
// per-message vs. batched calls, retry/timeout handling, and cost caps —
// none of which this file makes on its own.