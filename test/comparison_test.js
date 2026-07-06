const fs   = require('fs');
const path = require('path');

const { passesLayer1Filter } = require('../layer2/layer1sim');
const { matchMessage }       = require('../layer2/ruleset');

const inputFile = process.argv[2];
if (!inputFile) {
  console.error('Usage: node test/comparison_test.js <raw_text_file.json>');
  console.error('Example: node test/comparison_test.js raw_text_0_to_90_days.json');
  process.exit(1);
}

const inputPath = path.isAbsolute(inputFile)
  ? inputFile
  : path.join(__dirname, inputFile);

if (!fs.existsSync(inputPath)) {
  console.error(`File not found: ${inputPath}`);
  process.exit(1);
}

const outputDir = path.join(__dirname, 'output');
if (!fs.existsSync(outputDir)) fs.mkdirSync(outputDir);

const raw      = JSON.parse(fs.readFileSync(inputPath, 'utf8'));
const messages = raw.messages;
const window   = raw.window || 'unknown';

console.log(`\n${'─'.repeat(60)}`);
console.log(`PILEAP COMPARISON TEST`);
console.log(`Window : ${window}`);
console.log(`Input  : ${messages.length} messages`);
console.log(`${'─'.repeat(60)}\n`);

function passesLayer0(address) {
  if (!address) return false;
  if (address.toUpperCase().endsWith('-P')) return false;
  if (/^\d+$/.test(address)) return false;
  return true;
}

const parserResults = [];
const regexResults  = [];
const haikuResults  = [];

for (const msg of messages) {
  const body    = msg.body;
  const address = msg.address;
  const msgDate = msg.date;

  if (!passesLayer0(address)) {
    parserResults.push({
      id: msg.id, address, date: msgDate, body,
      layer1: { passed: false, reason: 'layer0_drop' },
    });
    continue;
  }

  const l1 = passesLayer1Filter(body);

  parserResults.push({
    id: msg.id, address, date: msgDate, body,
    layer1: { passed: l1.pass, reason: l1.reason },
  });

  if (!l1.pass) continue;

  const l2 = matchMessage(body, msgDate);

  if (l2 && l2.discard) {
    regexResults.push({
      id: msg.id, address, date: msgDate, body,
      layer2: { matched: false, rule: null, discard: true, reason: l2.reason, result: null },
    });
    continue;
  }

  if (l2 && !l2.discard) {
    regexResults.push({
      id: msg.id, address, date: msgDate, body,
      layer2: {
        matched: true,
        rule:    l2.matched_rule,
        discard: false,
        reason:  null,
        result: {
          direction:               l2.direction,
          amount:                  l2.amount,
          bank:                    l2.bank,
          channel:                 l2.channel,
          merchant:                l2.merchant,
          account_number_masked:   l2.account_number_masked,
          txn_date:                l2.txn_date,
          ref_number:              l2.ref_number,
          ref_type:                l2.ref_type,
          confidence:              l2.confidence,
          possible_contra:         l2.possible_contra,
          requires_classification: l2.requires_classification,
        },
      },
    });
    continue;
  }

  regexResults.push({
    id: msg.id, address, date: msgDate, body,
    layer2: { matched: false, rule: null, discard: false, reason: 'no_rule_matched', result: null },
  });

  haikuResults.push({ id: msg.id, address, date: msgDate, body, reason: 'no_layer2_rule' });
}

const l1Passed  = parserResults.filter(r => r.layer1.passed);
const l1Dropped = parserResults.filter(r => !r.layer1.passed);

const dropReasons = {};
for (const r of l1Dropped) {
  const reason = r.layer1.reason || 'unknown';
  dropReasons[reason] = (dropReasons[reason] || 0) + 1;
}

const l2Matched   = regexResults.filter(r => r.layer2.matched);
const l2Discarded = regexResults.filter(r => r.layer2.discard);
const l2Missed    = regexResults.filter(r => !r.layer2.matched && !r.layer2.discard);

const ruleHits = {};
for (const r of l2Matched) {
  const rule = r.layer2.rule || 'unknown';
  ruleHits[rule] = (ruleHits[rule] || 0) + 1;
}

const windowSlug = window.replace(/\s+/g, '_').replace(/→/g, 'to');

const parserPath = path.join(outputDir, `parser_${windowSlug}.json`);
const regexPath  = path.join(outputDir, `regex_${windowSlug}.json`);
const haikuPath  = path.join(outputDir, `haiku_${windowSlug}.json`);

fs.writeFileSync(parserPath, JSON.stringify({
  generated_at: new Date().toISOString(),
  window,
  summary: {
    total: messages.length,
    passed_layer1: l1Passed.length,
    dropped_layer1: l1Dropped.length,
    drop_reasons: dropReasons,
  },
  passed:  l1Passed,
  dropped: l1Dropped,
}, null, 2));

fs.writeFileSync(regexPath, JSON.stringify({
  generated_at: new Date().toISOString(),
  window,
  summary: {
    total_input: l1Passed.length,
    matched:     l2Matched.length,
    discarded:   l2Discarded.length,
    not_matched: l2Missed.length,
    rule_hits:   ruleHits,
  },
  matched:     l2Matched,
  discarded:   l2Discarded,
  not_matched: l2Missed,
}, null, 2));

fs.writeFileSync(haikuPath, JSON.stringify({
  generated_at: new Date().toISOString(),
  window,
  summary: { total_for_haiku: haikuResults.length },
  messages: haikuResults,
}, null, 2));

console.log(`LAYER 0+1 — parser_${windowSlug}.json`);
console.log(`  Total input   : ${messages.length}`);
console.log(`  Passed        : ${l1Passed.length}`);
console.log(`  Dropped       : ${l1Dropped.length}`);
console.log(`  Drop reasons  :`);
for (const [reason, count] of Object.entries(dropReasons).sort((a,b) => b[1]-a[1])) {
  console.log(`    ${reason.padEnd(30)} ${count}`);
}

console.log(`\nLAYER 2 — regex_${windowSlug}.json`);
console.log(`  Total input   : ${l1Passed.length}`);
console.log(`  Matched       : ${l2Matched.length}`);
console.log(`  Discarded     : ${l2Discarded.length}`);
console.log(`  Not matched   : ${l2Missed.length}`);
console.log(`  Rule hits     :`);
for (const [rule, count] of Object.entries(ruleHits).sort((a,b) => b[1]-a[1])) {
  console.log(`    ${rule.padEnd(35)} ${count}`);
}

console.log(`\nHAIKU — haiku_${windowSlug}.json`);
console.log(`  Would send    : ${haikuResults.length} messages to Haiku`);

console.log(`\n${'─'.repeat(60)}`);
console.log(`Output written to test/output/`);
console.log(`  ${path.basename(parserPath)}`);
console.log(`  ${path.basename(regexPath)}`);
console.log(`  ${path.basename(haikuPath)}`);
console.log(`${'─'.repeat(60)}\n`);
