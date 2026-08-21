// supabase/functions/haiku-submit/index.ts
//
// Runs on a schedule (see README for suggested cadence — every 4-6h
// baseline, plus triggered right after a 90-day signup backfill sync).
//
// Scope, per the chat this was designed in:
//   - Only touches haiku_candidate_log rows with haiku_status = 'pending'.
//   - low_confidence_log is NEVER read here — confirmed shadow-only,
//     out of scope entirely (see smsParser.ts's own comment on it).
//   - This function only SUBMITS. It never writes to `transactions` and
//     never applies a result — that's haiku-collect's job, on purpose,
//     because the Batch API doesn't return instantly and this function
//     has an execution time cap.
//
// This is a NEW, separate prompt/client call from layer3_haiku.js's
// callHaiku() — deliberately not touching that file, which is shared
// with pipeline_test.js/comparison_test.js and scoped narrowly to
// "classify an unrecognized template." Zero shared code, zero risk to
// the existing call.
//
// [CHANGED — provisional-notice generalization pass] Two additions, both
// additive to the existing schema/prompt, nothing removed:
//   1. expected_confirmation_date — when is_provisional_notice is true,
//      Haiku now also extracts whatever timeframe the message itself
//      states ("within 3-4 days", "on 22/08/26"), so haiku-collect can
//      write a real per-message expiry instead of always falling back to
//      a flat default. Null when the message states no timeframe, or
//      when is_provisional_notice is false/null — haiku-collect applies
//      the same 14-day default transactions.ts's classic-rule path uses
//      in that case, so behavior stays consistent across both origins.
//   2. The escalation source now also includes messages flagged by
//      smsParser.ts's new future-tense debit guard (see that file) —
//      these arrive with reason: 'escalated_to_haiku', an existing,
//      already-handled value; no change needed here for that part, this
//      function already treats every 'pending' row identically regardless
//      of reason.

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.45.4';

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
const SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
const ANTHROPIC_API_KEY = Deno.env.get('ANTHROPIC_API_KEY')!;

// Tunables. Kept as constants, not magic numbers, so they're the first
// thing to adjust once real volume data comes in (per the chat: ~9.3%
// escalation rate, ~21 candidates per new signup, ~7/user/month steady
// state — none of this needs to be aggressive).
const CANDIDATES_PER_GROUP = 25;   // SMS bundled into one prompt/request
const MAX_CANDIDATES_PER_RUN = 500; // caps one invocation's cost/time
const MODEL = 'claude-haiku-4-5-20251001';

interface CandidateRow {
  id: string;
  user_id: string;
  raw_sms_id: string;
  raw_text: string;
  txn_date: string;
  reason: string;
  extracted_amount: number | null;
  extracted_is_credit: boolean | null;
  extracted_merchant: string | null;
  extracted_bank: string | null;
}

// Forced structured output via tool_use — same defensive principle
// layer3_haiku.js's callHaiku() already uses (validate/coerce, never
// trust model output shape blindly), just extended to an array shape
// for the batched-multiple-candidates-per-prompt case.
const RESPONSE_TOOL = {
  name: 'return_classifications',
  // [CHANGED] Reverted the omission approach — real test data showed a
  // genuine transaction (an AutoPay success message) silently vanish
  // because Haiku didn't include an entry for it, and a missing entry was
  // indistinguishable from a deliberate "not a transaction" call. Every
  // message now gets exactly one entry, guaranteed, via is_transaction —
  // nothing can silently disappear without a trace anymore. The token
  // saving from omission was marginal anyway (fixed overhead dominates
  // the real per-call cost, per the first test's numbers), so this
  // correctness fix costs little.
  description: 'Return exactly one classification entry per message given, no exceptions — including messages you determine are not transactions.',
  input_schema: {
    type: 'object',
    properties: {
      results: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            raw_sms_id: { type: 'string' },
            is_transaction: { type: 'boolean' },
            direction: { type: ['string', 'null'], enum: ['credit', 'debit', null] },
            amount: { type: ['number', 'null'] },
            currency: { type: ['string', 'null'] },
            merchant: { type: ['string', 'null'] },
            // Answers "is this a future-tense promise ('will be debited')
            // rather than an already-happened confirmation ('was
            // debited')" — used by haiku-collect to decide whether to run
            // the provisional-notice linking check.
            is_provisional_notice: { type: ['boolean', 'null'] },
            // [ADD] Only meaningful when is_provisional_notice is true.
            // ISO 8601 date string (YYYY-MM-DD) if the message states or
            // implies a specific date/window the money is expected to
            // move by (e.g. "within 3-4 days" of the message's own date,
            // "on 22/08/26"). Null if is_provisional_notice is false/null,
            // or if it's true but no timeframe is stated in the text —
            // haiku-collect falls back to a flat default in that case,
            // never guesses one here.
            expected_confirmation_date: { type: ['string', 'null'] },
            confidence: { type: 'number' },
          },
          required: ['raw_sms_id', 'is_transaction', 'direction', 'amount', 'currency', 'merchant', 'is_provisional_notice', 'expected_confirmation_date', 'confidence'],
        },
      },
    },
    required: ['results'],
  },
  // [ADD] Per the real token count from the first test run (1969 input
  // tokens for only ~550 tokens of actual message content), the fixed
  // overhead per call — system prompt + this tool schema — dominates the
  // cost far more than message content does. The earlier cache_control
  // only covered the system prompt block; this one extends the cached
  // prefix to include the tool schema too, since it's very likely the
  // bigger of the two. Anthropic's documented cache-prefix behavior
  // covers tools + system + messages in that order, so a breakpoint here
  // should capture this block (and anything before it) for reuse across
  // groups in the same run. Confirm this is actually working by checking
  // `cache_read_input_tokens` on group 2+ of a run with >25 candidates —
  // a single 5-candidate test (one group) can't show this either way.
  cache_control: { type: 'ephemeral' },
};

const SYSTEM_PROMPT = `You classify Indian bank/financial-vendor SMS a regex parser couldn't confidently resolve (amount unclear, direction unclear, template unrecognized, or a suspected future-tense promise the parser isn't certain about).

For EACH message, include exactly one entry, tagged with its raw_sms_id. Do not skip any message, even ones you're confident are not transactions — always return an entry.

First decide is_transaction: does this message show money that has moved, is about to move, or is being refunded — OR does it name a specific account, card, UPI ID, or reference/transaction number in that context? Either is enough. A price merely mentioned while describing a plan, offer, or reminder is NOT a transaction, even with a real amount.

If is_transaction is false, leave direction/amount/currency/merchant/is_provisional_notice/expected_confirmation_date null and give your confidence in that "not a transaction" call.

If is_transaction is true, also fill in:
  1. direction — "credit" or "debit". Null if unclear.
  2. amount — plain number, in the currency stated (do NOT convert — see currency). Null if unclear; never guess.
  3. currency — ISO 4217 code (e.g. "INR", "USD"). Default "INR" if unstated. Never estimate a conversion rate yourself.
  4. merchant — counterparty name if identifiable, else null.
  5. is_provisional_notice — true only if future/promised ("will be debited"), false if already happened.
  6. expected_confirmation_date — ONLY when is_provisional_notice is true: if the message states or clearly implies a specific date or window the money is expected to move by (e.g. "within 3-4 days", "on 22/08/26"), give that as an ISO date (YYYY-MM-DD). Otherwise null — do not guess a date the message doesn't support.
  7. confidence — 0 to 1, your confidence in the extracted fields. Reserve 0.8+ for explicit transaction language; score lower if you're inferring from context rather than reading it directly.

Use the return_classifications tool.`;

function buildPrompt(group: CandidateRow[]): string {
  return group
    .map((c, i) => {
      const hints = [
        c.extracted_amount !== null ? `parser guessed amount: ${c.extracted_amount}` : null,
        c.extracted_is_credit !== null ? `parser guessed direction: ${c.extracted_is_credit ? 'credit' : 'debit'}` : null,
        c.extracted_merchant ? `parser guessed merchant: ${c.extracted_merchant}` : null,
        c.extracted_bank ? `parser guessed bank: ${c.extracted_bank}` : null,
      ].filter(Boolean).join(', ');
      return `[${i + 1}] raw_sms_id: ${c.raw_sms_id}\nreason failed: ${c.reason}${hints ? `\n(${hints})` : ''}\nmessage: """${c.raw_text}"""`;
    })
    .join('\n\n');
}

function chunk<T>(arr: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

Deno.serve(async (req) => {
  const supabase = createClient(SUPABASE_URL, SERVICE_ROLE_KEY);

  // [ADD] Optional ?limit=5 for manual test runs — e.g.
  // `curl -X POST .../haiku-submit?limit=5`. A scheduled cron call with
  // no query string is unaffected: falls back to MAX_CANDIDATES_PER_RUN,
  // same as before. Always clamped to MAX_CANDIDATES_PER_RUN as a ceiling
  // regardless of what's passed in, so this can't be used to accidentally
  // submit more than the intended cap in one run.
  const url = new URL(req.url);
  const requestedLimit = Number(url.searchParams.get('limit'));
  const effectiveLimit =
    Number.isFinite(requestedLimit) && requestedLimit > 0
      ? Math.min(requestedLimit, MAX_CANDIDATES_PER_RUN)
      : MAX_CANDIDATES_PER_RUN;

  const { data: pending, error: fetchError } = await supabase
    .from('haiku_candidate_log')
    .select('id, user_id, raw_sms_id, raw_text, txn_date, reason, extracted_amount, extracted_is_credit, extracted_merchant, extracted_bank')
    .eq('haiku_status', 'pending')
    .order('logged_at', { ascending: true })
    .limit(effectiveLimit);

  if (fetchError) {
    return new Response(JSON.stringify({ error: fetchError.message }), { status: 500 });
  }
  if (!pending || pending.length === 0) {
    return new Response(JSON.stringify({ submitted: 0, message: 'no pending candidates' }), { status: 200 });
  }

  const groups = chunk(pending as CandidateRow[], CANDIDATES_PER_GROUP);

  const batchRequests = groups.map((group) => ({
    // custom_id must be unique per request within the batch — used by
    // haiku-collect to map a result back to exactly these candidate rows.
    custom_id: crypto.randomUUID(),
    params: {
      model: MODEL,
      max_tokens: 4096,
      // [COST] cache_control marks this block cacheable: the first group
      // in a submit run pays full price to write the cache, every group
      // after it (same run, same ~5 min window) reads it at a steep
      // discount instead of re-paying full price for the same ~300-word
      // prompt every single group. With up to 20 groups per run, this is
      // the single biggest lever against repeated fixed-cost overhead —
      // separate from, and in addition to, the Batch API's own 50% off.
      system: [{ type: 'text', text: SYSTEM_PROMPT, cache_control: { type: 'ephemeral' } }],
      messages: [{ role: 'user', content: buildPrompt(group) }],
      tools: [RESPONSE_TOOL],
      tool_choice: { type: 'tool', name: 'return_classifications' },
    },
  }));

  const batchResp = await fetch('https://api.anthropic.com/v1/messages/batches', {
    method: 'POST',
    headers: {
      'x-api-key': ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01',
      'content-type': 'application/json',
    },
    body: JSON.stringify({ requests: batchRequests }),
  });

  if (!batchResp.ok) {
    // Deliberately do NOT touch any row's haiku_status on failure — they
    // stay 'pending' and get picked up by the next scheduled run. No
    // partial-state cleanup needed since nothing was written yet.
    const errText = await batchResp.text();
    return new Response(JSON.stringify({ error: `batch submit failed: ${errText}` }), { status: 502 });
  }

  const batch = await batchResp.json();
  const batchId: string = batch.id;

  // Mark every row in every group as 'sent', tagged with which specific
  // group (custom_id) it belongs to — haiku-collect uses haiku_group_id
  // to match this row to its result within the batch's output file.
  for (let g = 0; g < groups.length; g++) {
    const ids = groups[g].map((c) => c.id);
    const { error: updateError } = await supabase
      .from('haiku_candidate_log')
      .update({ haiku_status: 'sent', haiku_batch_id: batchId, haiku_group_id: batchRequests[g].custom_id })
      .in('id', ids);
    if (updateError) {
      // The batch was already submitted and will run regardless — an
      // update failure here just means haiku-collect won't find these
      // rows via haiku_batch_id later. Surface it loudly rather than
      // silently losing the candidates.
      console.error(`Failed to mark group ${g} as sent:`, updateError.message);
    }
  }

  return new Response(
    JSON.stringify({ submitted: pending.length, groups: groups.length, batch_id: batchId }),
    { status: 200 },
  );
});