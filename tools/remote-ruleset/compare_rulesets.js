#!/usr/bin/env node
/**
 * compare_rulesets.js — bundled vs remote Layer 2 parity check.
 *
 *   node compare_rulesets.js --bundled ../src/lib/layer2_ruleset.js \
 *                            --rules parse_rules_seed.json \
 *                            --corpus corpus.json [--corpus more.json] \
 *                            [--show 20] [--report report.json]
 *
 * --rules accepts either parse_rules_seed.json ({rules, aliases}) or a
 *   file you export from Supabase in the same shape — that second form is
 *   how you check that what's IN THE DATABASE matches, not just what the
 *   generator produced.
 *
 * Corpus: JSON array (or {messages:[...]}) of strings or objects with a
 *   body/text/message/sms field and an optional date (YYYY-MM-DD or epoch
 *   ms) as date/message_date/timestamp. Missing date → 2026-01-15.
 *
 * Exit code 0 = every message produced an identical result on both
 * sides; 1 = at least one mismatch.
 */

'use strict';

const fs = require('fs');
const path = require('path');
const { compileRuleset } = require('../../src/lib/layer2_interpreter.js');

function args() {
  const out = { corpus: [], show: 20 };
  const a = process.argv.slice(2);
  for (let i = 0; i < a.length; i++) {
    const k = a[i];
    const v = a[i + 1];
    if (k === '--bundled') { out.bundled = v; i++; }
    else if (k === '--rules') { out.rules = v; i++; }
    else if (k === '--corpus') { out.corpus.push(v); i++; }
    else if (k === '--show') { out.show = Number(v); i++; }
    else if (k === '--report') { out.report = v; i++; }
  }
  if (!out.bundled || !out.rules || out.corpus.length === 0) {
    console.error('usage: --bundled <ruleset.js> --rules <seed.json> --corpus <file.json> [...]');
    process.exit(2);
  }
  return out;
}

function toIsoDate(d) {
  if (d == null) return '2026-01-15';
  if (typeof d === 'number') return new Date(d).toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' });
  const s = String(d);
  if (/^\d{4}-\d{2}-\d{2}/.test(s)) return s.slice(0, 10);
  if (/^\d{10,13}$/.test(s)) return toIsoDate(Number(s.length === 10 ? Number(s) * 1000 : s));
  return '2026-01-15';
}

function loadCorpus(files) {
  const msgs = [];
  for (const file of files) {
    let data = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (!Array.isArray(data)) data = data.messages || data.corpus || data.data || [];
    data.forEach((m, i) => {
      if (typeof m === 'string') { msgs.push({ id: `${path.basename(file)}#${i}`, body: m, date: toIsoDate(null) }); return; }
      const body = m.body ?? m.text ?? m.message ?? m.sms ?? m.raw_text;
      if (typeof body !== 'string') return;
      msgs.push({
        id: m.id ?? m.raw_sms_id ?? `${path.basename(file)}#${i}`,
        body,
        date: toIsoDate(m.date ?? m.message_date ?? m.timestamp),
      });
    });
  }
  return msgs;
}

function same(a, b) {
  return JSON.stringify(a) === JSON.stringify(b);
}

function fieldDiff(a, b) {
  if (a === null || b === null) return { whole: { bundled: a, remote: b } };
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  const d = {};
  for (const k of keys) if (!same(a[k], b[k])) d[k] = { bundled: a[k], remote: b[k] };
  return d;
}

const label = (r) => (r === null ? '(no match)' : r.discard ? `${r.rule} [discard:${r.reason}]` : r.matched_rule);

function main() {
  const opt = args();
  const lib = require(path.resolve(opt.bundled));
  const data = JSON.parse(fs.readFileSync(opt.rules, 'utf8'));
  const remote = compileRuleset(data, lib);
  const corpus = loadCorpus(opt.corpus);

  const firedBundled = {};
  const mismatches = [];
  let errors = 0;

  for (const m of corpus) {
    const b = lib.matchMessage(m.body, m.date);
    let r;
    try {
      r = remote.matchMessage(m.body, m.date);
    } catch (e) {
      errors++;
      mismatches.push({ id: m.id, body: m.body, date: m.date, error: e.message });
      continue;
    }
    const k = b ? (b.matched_rule || b.rule) : '(no match)';
    firedBundled[k] = (firedBundled[k] || 0) + 1;
    if (!same(b, r)) {
      mismatches.push({ id: m.id, body: m.body, date: m.date, bundled_rule: label(b), remote_rule: label(r), diff: fieldDiff(b, r) });
    }
  }

  console.log(`\nMessages: ${corpus.length}   mismatches: ${mismatches.length}   interpreter errors: ${errors}\n`);

  console.log('Rule coverage (bundled side) — rules with 0 hits are NOT verified by this corpus:');
  for (const key of [...remote.ruleKeys, '(no match)']) {
    const n = firedBundled[key] || 0;
    console.log(`  ${n === 0 ? '!!' : '  '} ${String(n).padStart(5)}  ${key}`);
  }

  if (mismatches.length) {
    console.log(`\nFirst ${Math.min(opt.show, mismatches.length)} mismatches:`);
    for (const mm of mismatches.slice(0, opt.show)) {
      console.log(`\n— ${mm.id}  [${mm.date}]`);
      console.log(`  ${mm.body.replace(/\n/g, '⏎ ').slice(0, 200)}`);
      if (mm.error) { console.log(`  INTERPRETER ERROR: ${mm.error}`); continue; }
      console.log(`  bundled: ${mm.bundled_rule}   remote: ${mm.remote_rule}`);
      for (const [f, v] of Object.entries(mm.diff)) {
        console.log(`    ${f}: ${JSON.stringify(v.bundled)}  →  ${JSON.stringify(v.remote)}`);
      }
    }
  }

  if (opt.report) {
    fs.writeFileSync(opt.report, JSON.stringify({ total: corpus.length, coverage: firedBundled, mismatches }, null, 2));
    console.log(`\nFull report: ${opt.report}`);
  }

  process.exit(mismatches.length ? 1 : 0);
}

main();