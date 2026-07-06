/**
 * Full Pipeline Test Harness
 *
 * Runs all messages through:
 *   Layer 0 → Layer 1 → Layer 2 → Dedup → Layer 3 (Haiku, if API key provided)
 *
 * Run: node test/pipeline_test.js
 * Run with Haiku: ANTHROPIC_API_KEY=sk-... node test/pipeline_test.js --haiku
 */

const fs   = require('fs');
const path = require('path');
const crypto = require('crypto');
const { passesLayer0, passesLayer1Filter } = require('../layer2/layer1sim');
const { matchMessage } = require('../layer2/ruleset');
const { callHaiku } = require('../layer3/haiku');

const USE_HAIKU   = process.argv.includes('--haiku') && process.env.ANTHROPIC_API_KEY;

const inputFile = process.argv[2];
if (!inputFile) {
  console.error('Usage: node test/pipeline_test.js <report.json> [--haiku]');
  process.exit(1);
}
const REPORT_PATH = path.isAbsolute(inputFile) ? inputFile : path.join(__dirname, inputFile);

// ─── Load test data ───────────────────────────────────────────────────────────
const reportData = JSON.parse(fs.readFileSync(REPORT_PATH, 'utf8'));
const messages   = reportData.transactions;

// ─── Rule priority for Case 3 contra dedup ───────────────────────────────────
// Higher number = more specific = wins when same amount+date+account conflicts.
// [FIX] This map was written against an earlier, smaller rule set (4 rules).
// The ruleset now has 23 rules; anything not listed here silently fell back
// to priority -1 via the `?? -1` below — LOWER than both generic catch-alls
// (GENERIC_CREDIT=1, GENERIC_DEBIT=0). That means if a specific rule like
// LOAN_DISBURSEMENT ever collided on (amount, date, account) with a
// GENERIC_CREDIT match, the generic match would have won the dedup, which
// is backwards — named rules should be trusted over the catch-alls, not
// the other way round. Every current named rule is now listed; the two
// generic catch-alls stay at the bottom.
const RULE_PRIORITY = {
  'GENERIC_PPF_SSY':               3,
  'GENERIC_NACH':                  3,
  'GENERIC_CC_SPEND_TXN':          3,
  'GENERIC_CC_PAYMENT':            3,
  'PLUXEE_SPEND':                  3,
  'PLUXEE_CREDIT':                 3,
  'NCMC_LOAD':                     3,
  'GENERIC_WALLET_SPEND':          3,
  'GENERIC_NETBANKING_PAYMENT':    3,
  'LOAN_DISBURSEMENT':             3,
  'CHEQUE_CLEARED_DEBIT':          3,
  'CARD_POS_USED_FOR':             3,
  'GENERIC_CHARGED':               3,
  'CASH_DEPOSIT':                  3,
  'WALLET_LOAD':                   3,
  'GENERIC_PAID_TO':               3,
  'GENERIC_PURCHASE_CONFIRMATION': 3,
  'DEMAND_DRAFT_ISSUED':           3,
  'LEGACY_DR_CR_FORMAT':           3,
  'COURIER_COD_PAYMENT':           3,
  'REFUND_INITIATED':              3,
  'GENERIC_CREDIT':                1,
  'GENERIC_DEBIT':                 0,
};

// ─── Known promotional patterns (ground truth for false positive detection) ───
function isKnownPromo(body) {
  const b = body.toLowerCase();
  return b.includes('kotak.bank.in') ||
         b.includes('airtelxstream') ||
         (b.includes('pre-approved') && !b.includes('a/c') && !b.includes('xx')) ||
         b.includes('vivoignite') ||
         b.includes('krishnayan') ||
         b.includes('pvrinox.com') ||
         (b.includes('airtel.in/') && !b.includes('successful') && !b.includes('debited'));
}

// ─── Known noise (ground truth for messages that should be fully dropped) ─────
function isKnownNoise(body) {
  const b = body.toLowerCase();
  return b.includes('மின்தடங்கல்') ||
         b.includes('மிஸ்டு கால்') ||
         b.includes('ரீசார்ஜ் பேக் முடிகிறது') ||
         (b.includes('boarding allowed') && !b.includes('rs')) ||
         b.includes('menurates.irctc') ||
         b.includes('solemate account') ||
         b.includes('locker access') ||
         b.includes('locker branch') ||
         b.includes('trai dnd') ||
         b.includes('attention_investors') ||
         b.includes('on-board food menu') ||
         b.includes('bseindia.com') ||
         b.includes('sanchar saathi') ||
         (b.includes('dear passenger') && !b.includes('rs')) ||
         b.includes('vivoignite') ||
         b.includes('subject to reconciliation') ||  // TANGEDCO payee confirmations
         b.includes('tnebnet.org');                  // TANGEDCO payment portal
}

// ─── Dedup helpers ────────────────────────────────────────────────────────────

function makeRrnKey(l2result) {
  if (!l2result.ref_number || l2result.ref_type !== 'upi_rrn') return null;
  return l2result.ref_number;
}

function makeBodyHash(body) {
  return crypto.createHash('md5').update(body.trim()).digest('hex');
}

function makeContraKey(l2result) {
  if (!l2result.amount || !l2result.txn_date || !l2result.account_number_masked) return null;
  return `${l2result.amount}|${l2result.txn_date}|${l2result.account_number_masked}`;
}

// ─── Run pipeline ─────────────────────────────────────────────────────────────
async function runPipeline() {
  const results = {
    total:              messages.length,
    layer0_dropped:     [],
    layer1_dropped:     [],
    layer1_passed:      [],
    layer2_matched:     [],
    layer2_escalated:   [],
    layer2_discarded:   [],
    dedup_dropped:      [],
    haiku_results:      [],
    false_positives:    [],
    false_negatives:    [],
  };

  const seenRrns       = new Set();
  const seenBodyHashes = new Set();
  const contraMap      = new Map();

  console.log(`\n${'─'.repeat(60)}`);
  console.log(`PILEAP SMS PIPELINE TEST — ${messages.length} messages`);
  console.log(`${'─'.repeat(60)}\n`);

  for (const msg of messages) {
    const body    = msg.raw_text;
    const msgDate = new Date(msg.txn_date).toISOString().split('T')[0];
    const address = msg.address || '';
    const isPromo = isKnownPromo(body);
    const isNoise = isKnownNoise(body);

    if (!passesLayer0(address)) {
      results.layer0_dropped.push({ body: body.substring(0, 80), address });
      continue;
    }

    const l1 = passesLayer1Filter(body);

    if (!l1.pass) {
      results.layer1_dropped.push({
        body:    body.substring(0, 80),
        reason:  l1.reason,
        isPromo,
        isNoise,
      });

      if (!isPromo && !isNoise && msg.parse_failure !== 'missing_amount') {
        const couldBeReal =
          body.toLowerCase().includes('rs.')      ||
          body.toLowerCase().includes('inr')      ||
          body.toLowerCase().includes('debited')  ||
          body.toLowerCase().includes('credited');
        if (couldBeReal && msg.amount !== null) {
          results.false_negatives.push({
            body:            body.substring(0, 100),
            reason:          l1.reason,
            amount:          msg.amount,
            original_status: msg.parse_failure,
          });
        }
      }
      continue;
    }

    results.layer1_passed.push(body);

    if (isPromo || isNoise) {
      results.false_positives.push({
        body: body.substring(0, 100),
        type: isPromo ? 'promo' : 'noise',
      });
    }

    const l2 = matchMessage(body, msgDate);

    if (l2 === null) {
      results.layer2_escalated.push({ body, originalData: msg });
      continue;
    }

    if (l2.discard) {
      results.layer2_discarded.push({
        body:   body.substring(0, 80),
        reason: l2.reason,
      });
      continue;
    }

    const rrnKey = makeRrnKey(l2);
    if (rrnKey !== null) {
      if (seenRrns.has(rrnKey)) {
        results.dedup_dropped.push({
          body:   body.substring(0, 80),
          reason: 'duplicate_rrn',
          key:    rrnKey,
        });
        continue;
      }
      seenRrns.add(rrnKey);
    }

    const bodyHash = makeBodyHash(body);
    if (rrnKey === null) {
      if (seenBodyHashes.has(bodyHash)) {
        results.dedup_dropped.push({
          body:   body.substring(0, 80),
          reason: 'duplicate_body',
          key:    bodyHash,
        });
        continue;
      }
    }
    seenBodyHashes.add(bodyHash);

    const contraKey = makeContraKey(l2);
    if (contraKey !== null) {
      if (contraMap.has(contraKey)) {
        const existing = contraMap.get(contraKey);
        const incomingPriority = RULE_PRIORITY[l2.matched_rule]   ?? -1;
        const existingPriority = RULE_PRIORITY[existing.rule]     ?? -1;

        if (incomingPriority > existingPriority) {
          results.layer2_matched[existing.index] = { result: l2, originalData: msg };
          contraMap.set(contraKey, {
            rule:  l2.matched_rule,
            index: existing.index,
          });
          results.dedup_dropped.push({
            body:   body.substring(0, 80),
            reason: 'contra_replaced_existing',
            key:    contraKey,
            note:   `${existing.rule} replaced by ${l2.matched_rule}`,
          });
          continue;
        } else {
          results.dedup_dropped.push({
            body:   body.substring(0, 80),
            reason: 'contra_lower_priority',
            key:    contraKey,
            note:   `${l2.matched_rule} lost to ${existing.rule}`,
          });
          continue;
        }
      }
      contraMap.set(contraKey, {
        rule:  l2.matched_rule,
        index: results.layer2_matched.length,
      });
    }

    results.layer2_matched.push({ result: l2, originalData: msg });
  }

  if (USE_HAIKU && results.layer2_escalated.length > 0) {
    console.log(`\nCalling Haiku for ${results.layer2_escalated.length} escalated messages...`);
    let haikuProcessed = 0;

    for (const item of results.layer2_escalated) {
      try {
        const haikuResult = await callHaiku(item.body);
        results.haiku_results.push({
          body:         item.body.substring(0, 80),
          result:       haikuResult,
          originalData: item.originalData,
        });
        haikuProcessed++;
        if (haikuProcessed % 10 === 0) {
          process.stdout.write(`  ${haikuProcessed}/${results.layer2_escalated.length}\r`);
        }
        await new Promise(r => setTimeout(r, 100));
      } catch (err) {
        console.error(`Haiku error: ${err.message}`);
      }
    }
  }

  console.log(`\n${'═'.repeat(60)}`);
  console.log('PIPELINE RESULTS');
  console.log(`${'═'.repeat(60)}`);

  const l0DropRate = (results.layer0_dropped.length / results.total * 100).toFixed(1);
  const l1DropRate = (results.layer1_dropped.length / results.total * 100).toFixed(1);
  const l2MatchRate = results.layer1_passed.length > 0
    ? (results.layer2_matched.length / results.layer1_passed.length * 100).toFixed(1)
    : 0;

  console.log(`\nLAYER 0 (Sender filter)`);
  console.log(`  Dropped:         ${results.layer0_dropped.length} (${l0DropRate}%)`);

  console.log(`\nLAYER 1 (Body filter)`);
  console.log(`  Total input:     ${results.total - results.layer0_dropped.length}`);
  console.log(`  Dropped:         ${results.layer1_dropped.length} (${l1DropRate}% of total)`);
  console.log(`  Passed to L2:    ${results.layer1_passed.length}`);

  console.log(`\nLAYER 2 (Regex Ruleset)`);
  console.log(`  Input:           ${results.layer1_passed.length}`);
  console.log(`  Matched:         ${results.layer2_matched.length} (${l2MatchRate}% of L2 input)`);
  console.log(`  Discarded:       ${results.layer2_discarded.length} (declined txns)`);
  console.log(`  Escalated (→L3): ${results.layer2_escalated.length}`);

  console.log(`\nDEDUP`);
  const dedupByReason = {};
  for (const d of results.dedup_dropped) {
    dedupByReason[d.reason] = (dedupByReason[d.reason] || 0) + 1;
  }
  if (results.dedup_dropped.length === 0) {
    console.log(`  No duplicates found`);
  } else {
    for (const [reason, count] of Object.entries(dedupByReason)) {
      console.log(`  ${reason.padEnd(30)} ${count}`);
    }
    console.log(`  Total removed:   ${results.dedup_dropped.length}`);
  }

  if (USE_HAIKU) {
    const haikuPromos  = results.haiku_results.filter(r =>  r.result?.is_promotional).length;
    const haikuParsed  = results.haiku_results.filter(r => !r.result?.is_promotional).length;
    console.log(`\nLAYER 3 (Haiku)`);
    console.log(`  Input:           ${results.layer2_escalated.length}`);
    console.log(`  Parsed:          ${haikuParsed}`);
    console.log(`  Promotional:     ${haikuPromos}`);
    console.log(`  Errors:          ${results.layer2_escalated.length - results.haiku_results.length}`);
  } else {
    console.log(`\nLAYER 3 (Haiku) — not run (use --haiku flag)`);
    console.log(`  Would receive:   ${results.layer2_escalated.length} messages`);
  }

  const dropReasons = {};
  for (const d of results.layer1_dropped) {
    dropReasons[d.reason] = (dropReasons[d.reason] || 0) + 1;
  }
  console.log(`\nLayer 1 Drop Reasons:`);
  for (const [reason, count] of Object.entries(dropReasons).sort((a,b) => b[1]-a[1])) {
    console.log(`  ${reason.padEnd(25)} ${count}`);
  }

  const ruleHits = {};
  for (const m of results.layer2_matched) {
    const rule = m.result.matched_rule;
    ruleHits[rule] = (ruleHits[rule] || 0) + 1;
  }
  console.log(`\nLayer 2 Rule Hits:`);
  for (const [rule, count] of Object.entries(ruleHits).sort((a,b) => b[1]-a[1])) {
    console.log(`  ${rule.padEnd(35)} ${count}`);
  }

  if (results.false_positives.length > 0) {
    console.log(`\n⚠️  FALSE POSITIVES — ${results.false_positives.length} promos/noise passed Layer 1:`);
    for (const fp of results.false_positives.slice(0, 10)) {
      console.log(`  [${fp.type}] ${fp.body}`);
    }
    if (results.false_positives.length > 10) {
      console.log(`  ... and ${results.false_positives.length - 10} more`);
    }
  } else {
    console.log(`\n✅ FALSE POSITIVES: None`);
  }

  if (results.false_negatives.length > 0) {
    console.log(`\n🚨 FALSE NEGATIVES — ${results.false_negatives.length} real transactions DROPPED:`);
    for (const fn of results.false_negatives) {
      console.log(`  [${fn.reason}] amount:${fn.amount} | ${fn.body}`);
    }
  } else {
    console.log(`\n✅ FALSE NEGATIVES: None`);
  }

  console.log(`\n── SAMPLE LAYER 2 MATCHES (first 5) ──`);
  for (const m of results.layer2_matched.slice(0, 5)) {
    const r = m.result;
    console.log(`  Rule: ${r.matched_rule}`);
    console.log(`  ${r.direction?.toUpperCase()} ${r.amount} | ${r.merchant || 'no merchant'} | acct:${r.account_number_masked || 'null'}`);
    console.log(`  date:${r.txn_date} | ref:${r.ref_number || 'null'} | conf:${r.confidence}`);
    if (r.requires_classification) console.log(`  ⚠️  Needs user classification (person VPA)`);
    if (r.possible_contra)         console.log(`  ↔️  Possible contra transaction`);
    console.log();
  }

  if (results.dedup_dropped.length > 0) {
    console.log(`── DEDUP DROPPED (first 10) ──`);
    for (const d of results.dedup_dropped.slice(0, 10)) {
      console.log(`  [${d.reason}] ${d.note ? d.note + ' | ' : ''}${d.body}`);
    }
  }

  if (!USE_HAIKU) {
    console.log(`\n── HAIKU CANDIDATES (what Layer 3 would receive) ──`);
    for (const item of results.layer2_escalated.slice(0, 8)) {
      console.log(`  ${item.body.substring(0, 100).replace(/\n/g, ' ')}`);
    }
  }

  const pendingHaiku = USE_HAIKU ? 0 : results.layer2_escalated.length;
  const haikuParsed  = USE_HAIKU
    ? results.haiku_results.filter(r => !r.result?.is_promotional).length
    : 0;

  console.log(`\n${'═'.repeat(60)}`);
  console.log(`FINAL SUMMARY`);
  console.log(`${'═'.repeat(60)}`);
  console.log(`  Total messages:        ${results.total}`);
  console.log(`  Layer 0 dropped:       ${results.layer0_dropped.length}`);
  console.log(`  Layer 1 dropped:       ${results.layer1_dropped.length}`);
  console.log(`  Dedup removed:         ${results.dedup_dropped.length}`);
  console.log(`  Cleanly parsed (L2):   ${results.layer2_matched.length}`);
  console.log(`  ${USE_HAIKU ? 'Parsed by Haiku:  ' : 'Awaiting Haiku:   '}     ${pendingHaiku || haikuParsed}`);
  console.log(`  Discarded (declined):  ${results.layer2_discarded.length}`);
  console.log(`  False positives:       ${results.false_positives.length}`);
  console.log(`  False negatives:       ${results.false_negatives.length}`);

  const outputPath = path.join(__dirname, '../test_results.json');
  fs.writeFileSync(outputPath, JSON.stringify({
    summary: {
      total:              results.total,
      layer0_dropped:     results.layer0_dropped.length,
      layer1_dropped:     results.layer1_dropped.length,
      layer1_passed:      results.layer1_passed.length,
      layer2_matched:     results.layer2_matched.length,
      layer2_discarded:   results.layer2_discarded.length,
      layer2_escalated:   results.layer2_escalated.length,
      dedup_dropped:      results.dedup_dropped.length,
      dedup_by_reason:    dedupByReason,
      false_positives:    results.false_positives.length,
      false_negatives:    results.false_negatives.length,
      rule_hits:          ruleHits,
      drop_reasons:       dropReasons,
    },
    dedup_dropped:    results.dedup_dropped,
    false_positives:  results.false_positives,
    false_negatives:  results.false_negatives,
    haiku_candidates: results.layer2_escalated.map(e => ({
      body:                   e.body,
      original_parse_failure: e.originalData.parse_failure,
      original_amount:        e.originalData.amount,
    })),
    layer2_matches: results.layer2_matched.map(m => ({
      result:   m.result,
      original: m.originalData,
    })),
  }, null, 2));

  console.log(`\nDetailed results written to test_results.json`);
}

runPipeline().catch(console.error);
