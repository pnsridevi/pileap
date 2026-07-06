/**
 * layer3/haiku.js
 *
 * Layer 3 fallback — calls Claude Haiku to classify SMS that Layer 2's
 * regex ruleset couldn't match. This is a STUB. pipeline_test.js requires
 * this file unconditionally at the top (`require('../layer3/haiku')`),
 * so without a file here at all, the script crashes on load even if you
 * never pass --haiku. This stub lets the script run without it; callHaiku()
 * itself only needs to actually work if you run with the --haiku flag.
 *
 * To wire up real Haiku calls, fill in callHaiku() below. Expected return
 * shape (based on how pipeline_test.js consumes the result):
 *   {
 *     is_promotional: boolean,
 *     direction: 'credit' | 'debit' | null,
 *     amount: number | null,
 *     merchant: string | null,
 *     ...any other fields you want surfaced in haiku_results
 *   }
 */

const USE_REAL_HAIKU = !!process.env.ANTHROPIC_API_KEY;

async function callHaiku(body) {
  if (!USE_REAL_HAIKU) {
    throw new Error(
      'callHaiku() was invoked but ANTHROPIC_API_KEY is not set. ' +
      'Either set the env var and fill in the real API call below, ' +
      'or don\'t pass --haiku.'
    );
  }

  // ─── Fill in real implementation here ────────────────────────────────────
  // Example shape (using @anthropic-ai/sdk):
  //
  // const Anthropic = require('@anthropic-ai/sdk');
  // const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  // const msg = await client.messages.create({
  //   model: 'claude-haiku-4-5-20251001',
  //   max_tokens: 300,
  //   messages: [{
  //     role: 'user',
  //     content: `Classify this SMS as a financial transaction or not. If it
  // is, extract direction, amount, merchant. Respond as JSON only.\n\n${body}`,
  //   }],
  // });
  // return JSON.parse(msg.content[0].text);

  throw new Error('callHaiku() is a stub — fill in the real API call before using --haiku.');
}

module.exports = { callHaiku };
