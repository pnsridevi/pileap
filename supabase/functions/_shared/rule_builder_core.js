// supabase/functions/_shared/rule_builder_core.js
//
// The rule-builder's logic, with no Supabase or network code in it.
// index.ts (the Supabase function) supplies the database reads/writes and
// the call to Haiku; everything that decides anything lives here.
//
// One run:
//   1. Sort every SMS Haiku has answered (rule_builder_status).
//   2. Group the ones a new rule could fix by bank wording.
//   3. For each wording seen MIN_REPEATS times: get a rule (re-test a
//      passed draft, or ask Haiku to write one), run the checks, save it
//      as active (mode 'auto') or draft.
//   4. Probation: switch off an automatic rule the user had to correct;
//      end probation after PROBATION_DAYS with no corrections.

export const FUTURE_TENSE_MARKER =
  /\b(?:will|shall)\s+be\s+(?:debited|credited|deducted|refunded|processed|withdrawn)\b/i;

export const MIN_HAIKU_CONFIDENCE = 0.75;

// Final decisions: a row with one of these is not looked at again.
const FINAL_STATUSES = new Set([
  'not_transaction', 'future_payment', 'foreign_currency', 'unclear',
  'deleted_by_user', 'needs_layer1', 'already_covered', 'covered_differently',
  'rule_active', 'gave_up',
]);

export const DEFAULT_SETTINGS = {
  mode: 'draft_only',        // 'draft_only' | 'auto'
  minRepeats: 3,             // SMS of one wording before a rule is made
  minUsers: 1,               // different users of one wording
  maxRulesPerRun: 5,
  maxTries: 3,               // per wording
  probationDays: 7,
  maxHaikuRows: 3000,
  maxCorpus: 1500,
};

// ─── Small helpers ─────────────────────────────────────────────────────────

const normMerchant = (s) => String(s ?? '').toLowerCase().replace(/[^a-z0-9]/g, '');

export function merchantMatches(ruleMerchant, truthMerchant) {
  if (!truthMerchant) return true;
  if (!ruleMerchant) return false;
  const a = normMerchant(ruleMerchant), b = normMerchant(truthMerchant);
  if (!a || !b) return false;
  return a === b || (a.length >= 3 && b.length >= 3 && (a.startsWith(b) || b.startsWith(a)));
}

const sameAmount = (a, b) => a != null && b != null && Math.abs(Math.abs(Number(a)) - Math.abs(Number(b))) < 0.005;

function hash8(s) {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193); }
  return (h >>> 0).toString(16).padStart(8, '0').toUpperCase();
}

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// "Rs.500 debited from A/c XX1234 to SWIGGY on 30-OCT-26"
//   -> "rs # debited from a c <acct> to <m> on # <mon> #"
// Same bank wording -> same signature, whatever the amount, merchant,
// account or date.
export function templateSignature(body, merchant) {
  let t = String(body ?? '');
  const m = String(merchant ?? '').trim();
  if (m.length >= 2) t = t.replace(new RegExp(escapeRe(m), 'gi'), ' <m> ');
  t = t
    .replace(/https?:\/\/\S+/gi, ' <url> ')
    .replace(/\S+@\S+/g, ' <id> ')
    .replace(/\b(?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\b/gi, ' <mon> ')
    .replace(/[xX*]+\d+/g, ' <acct> ')
    .replace(/\d+(?:[.,:/-]\d+)*/g, ' # ')
    .toLowerCase()
    .replace(/[^a-z#<>\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return t;
}

// ─── Step 1: the truth for one SMS, and its sort ───────────────────────────

// Haiku's answer, replaced by the user's values when they reviewed the
// transaction on the phone.
export function truthFor(row, txn) {
  const c = row.haiku_response?.classification ?? null;
  if (txn && txn.is_deleted) return { skip: 'deleted_by_user' };
  if (txn && txn.status === 'user_reviewed' && txn.amount != null && Number(txn.amount) !== 0) {
    return {
      source: 'user',
      direction: Number(txn.amount) > 0 ? 'credit' : 'debit',
      amount: Math.abs(Number(txn.amount)),
      merchant: txn.merchant ?? null,
    };
  }
  if (!c) return { skip: 'unclear' };
  if (!c.is_transaction || Number(c.confidence) < MIN_HAIKU_CONFIDENCE) return { skip: 'not_transaction' };
  if (c.is_provisional_notice) return { skip: 'future_payment' };
  if (c.currency && String(c.currency).toUpperCase() !== 'INR') return { skip: 'foreign_currency' };
  if (c.amount == null || !c.direction) return { skip: 'unclear' };
  return { source: 'haiku', direction: c.direction, amount: Math.abs(Number(c.amount)), merchant: c.merchant ?? null };
}

// Decides what a new rule can (and can't) do for one SMS.
export function sortOne(row, truth, ctx) {
  if (truth.skip) return { status: truth.skip };
  const body = row.raw_text;
  if (FUTURE_TENSE_MARKER.test(body)) return { status: 'future_payment' };
  const l1 = ctx.layer1.passesLayer1Filter(body);
  if (!l1.pass) return { status: 'needs_layer1', note: `Layer 1 drops it (${l1.reason})` };
  const now = ctx.baseline(body, row.txn_date);
  if (now) {
    if (now.discard) return { status: 'covered_differently', note: `rule ${now.rule} ignores it (${now.reason})` };
    if (now.direction === truth.direction && sameAmount(now.amount, truth.amount)) {
      return { status: 'already_covered', note: `read by ${now.matched_rule}` };
    }
    return { status: 'covered_differently', note: `rule ${now.matched_rule} reads ${now.direction} ${now.amount}` };
  }
  return { status: 'candidate', signature: templateSignature(body, truth.merchant) };
}

// ─── Step 2: group by wording ──────────────────────────────────────────────

export function groupCandidates(items, settings) {
  const groups = new Map();
  for (const it of items) {
    if (!groups.has(it.signature)) groups.set(it.signature, []);
    groups.get(it.signature).push(it);
  }
  const out = [];
  for (const [signature, list] of groups) {
    // Same SMS text twice (two syncs, two devices) counts once.
    const unique = [...new Map(list.map((i) => [i.row.raw_text, i])).values()];
    const users = new Set(unique.map((i) => i.row.user_id)).size;
    out.push({
      signature,
      ruleKeyBase: `AUTO_${hash8(signature)}`,
      items: unique,
      allRows: list,
      users,
      ready: unique.length >= settings.minRepeats && users >= settings.minUsers,
    });
  }
  out.sort((a, b) => b.items.length - a.items.length);
  return out;
}

// ─── Step 3a: the rule Haiku writes ────────────────────────────────────────

const ALLOWED_HELPERS = ['extractAmount', 'extractMerchant', 'extractAccount', 'extractChannel', 'extractDate'];
const ALLOWED_OVERRIDE_FIELDS = ['amount', 'merchant', 'account_number_masked', 'channel', 'txn_date'];

export const RULE_TOOL = {
  name: 'return_rule',
  description: 'Return exactly one parsing rule for the SMS wording shown.',
  input_schema: {
    type: 'object',
    properties: {
      match_patterns: {
        type: 'array',
        items: { type: 'object', properties: { re: { type: 'string' }, flags: { type: 'string' } }, required: ['re'] },
      },
      exclude_patterns: {
        type: 'array',
        items: { type: 'object', properties: { re: { type: 'string' }, flags: { type: 'string' } }, required: ['re'] },
      },
      direction: { type: 'string', enum: ['debit', 'credit'] },
      channel: { type: ['string', 'null'] },
      field_overrides: { type: 'object' },
      explanation: { type: 'string' },
    },
    required: ['match_patterns', 'direction', 'field_overrides'],
  },
};

export function buildRulePrompt(group, exampleRules, lastError) {
  const system = `You write ONE SMS-parsing rule for an Indian personal-finance app. A rule is JSON data read by a fixed interpreter on the user's phone; it is never code.

Format:
- match_patterns: 1 to 3 JavaScript regular expressions as strings (no surrounding slashes), each {"re": "...", "flags": "i"}. Allowed flags: i, m, s, u. The rule fires if ANY match_pattern matches and NO exclude_pattern matches.
- exclude_patterns: optional, same shape.
- direction: "debit" (money left the user's account) or "credit" (money came in).
- channel: optional fixed value such as "UPI", "Card", "NEFT", "IMPS", "NACH", "Net Banking", or null.
- field_overrides: how to read each value, as {"<field>": {"steps": [ ... ]}}. Fields allowed: amount, merchant, account_number_masked, txn_date, channel. Steps are tried in order; the first that finds a value wins. Step types:
    {"re": "...", "flags": "i", "group": 1, "as": "number"}   for amounts ("number" removes commas)
    {"re": "...", "flags": "i", "group": 1}                   for text such as a merchant or the last digits of an account
    {"helper": "<name>"} with name one of: ${ALLOWED_HELPERS.join(', ')}

Hard rules:
- Patterns must match the bank's FIXED wording only. Use only words that appear in EVERY example below.
- Never put an amount, account number, phone number, date, reference number, or any person's or merchant's name inside a pattern. Capture them with a group instead.
- amount must come from a "re" step with "as": "number", or from {"helper": "extractAmount"}.
- If the examples have a merchant or counterparty, read it in field_overrides.merchant.
- If the SMS states the last digits of an account or card, read them in field_overrides.account_number_masked (digits only).
- A capture group must capture only the value, nothing around it.

Two rules already in use, as examples of the format:
${JSON.stringify(exampleRules, null, 1)}

Return the rule with the return_rule tool.`;

  const examples = group.items.slice(0, 8).map((it, i) =>
    `[${i + 1}] SMS: """${it.row.raw_text}"""\n    expected: direction=${it.truth.direction}, amount=${it.truth.amount}, merchant=${it.truth.merchant ?? 'none'}`,
  ).join('\n\n');

  let user = `These SMS share one wording. Write one rule that reads all of them and gives the expected values.\n\n${examples}`;
  if (lastError) user += `\n\nAn earlier rule for this wording failed this check: ${lastError}\nWrite a rule that passes it.`;
  return { system, user, tool: RULE_TOOL };
}

function checkSteps(field, spec) {
  if (!spec || !Array.isArray(spec.steps) || spec.steps.length === 0) throw new Error(`${field}: needs a "steps" list`);
  for (const k of Object.keys(spec)) if (k !== 'steps') throw new Error(`${field}: only "steps" is allowed`);
  for (const s of spec.steps) {
    if ('re' in s) {
      for (const k of Object.keys(s)) if (!['re', 'flags', 'group', 'as'].includes(k)) throw new Error(`${field}: "${k}" not allowed`);
      if (s.as && !['text', 'number'].includes(s.as)) throw new Error(`${field}: "as" must be text or number`);
    } else if ('helper' in s) {
      if (Object.keys(s).length !== 1) throw new Error(`${field}: helper steps take only "helper"`);
      if (!ALLOWED_HELPERS.includes(s.helper)) throw new Error(`${field}: helper "${s.helper}" not allowed`);
    } else if ('value' in s) {
      if (field !== 'channel') throw new Error(`${field}: fixed values only allowed for channel`);
    } else {
      throw new Error(`${field}: unknown step ${JSON.stringify(s)}`);
    }
  }
}

// Turns Haiku's tool output into a parse_rules row (not yet saved).
export function ruleFromOutput(out, ruleKey, signature, onProbation) {
  if (!out || typeof out !== 'object') throw new Error('no rule returned');
  const match = Array.isArray(out.match_patterns) ? out.match_patterns : [];
  if (match.length < 1 || match.length > 3) throw new Error('needs 1 to 3 match_patterns');
  const exclude = Array.isArray(out.exclude_patterns) ? out.exclude_patterns : [];
  if (exclude.length > 3) throw new Error('at most 3 exclude_patterns');
  const clean = (p) => ({ re: String(p.re), flags: p.flags ? String(p.flags) : 'i' });
  if (!['debit', 'credit'].includes(out.direction)) throw new Error('direction must be debit or credit');
  const overrides = out.field_overrides && typeof out.field_overrides === 'object' ? out.field_overrides : {};
  for (const [f, spec] of Object.entries(overrides)) {
    if (!ALLOWED_OVERRIDE_FIELDS.includes(f)) throw new Error(`field "${f}" not allowed`);
    checkSteps(f, spec);
  }
  const fixed = { direction: out.direction, possible_contra: false, confidence: 0.8 };
  if (out.channel && !overrides.channel) fixed.channel = String(out.channel);
  if (onProbation) fixed.requires_classification = true;
  return {
    layer: 2,
    rule_key: ruleKey,
    match_patterns: match.map(clean),
    exclude_patterns: exclude.map(clean),
    fixed_fields: fixed,
    field_overrides: overrides,
    source_signature: signature,
    created_by: 'rule_builder',
  };
}

// ─── Step 3b: the checks ───────────────────────────────────────────────────

function regexSources(rule) {
  const out = [];
  for (const p of rule.match_patterns || []) out.push(p.re);
  for (const p of rule.exclude_patterns || []) out.push(p.re);
  for (const spec of Object.values(rule.field_overrides || {})) {
    for (const s of spec.steps || []) if (s.re) out.push(s.re);
  }
  return out;
}

// No personal details may end up in a rule every user downloads.
export function privacyProblem(rule, bodies) {
  const lowerBodies = bodies.map((b) => b.toLowerCase());
  for (const src of regexSources(rule)) {
    if (/\(\?<[A-Za-z]/.test(src)) return 'named capture groups are not allowed';
    const literal = src
      .replace(/\\./g, ' ')            // escapes: \d \s \. \b ...
      .replace(/\[[^\]]*\]/g, ' ')     // character classes
      .replace(/\{\d+(?:,\d*)?\}/g, ' '); // {4} {1,3}
    if (/\d{3,}/.test(literal)) return `pattern contains a number: /${src}/`;
    for (const w of literal.match(/[A-Za-z]{4,}/g) || []) {
      if (!lowerBodies.every((b) => b.includes(w.toLowerCase()))) {
        return `pattern word "${w}" is not in every SMS of this wording (could be a name)`;
      }
    }
  }
  const strings = [];
  if (rule.fixed_fields?.merchant) strings.push(String(rule.fixed_fields.merchant));
  for (const s of rule.field_overrides?.merchant?.steps || []) if (typeof s.value === 'string') strings.push(s.value);
  for (const s of strings) {
    if (!lowerBodies.every((b) => b.includes(s.toLowerCase()))) return `fixed merchant "${s}" is not in every SMS`;
  }
  return null;
}

// Runs every check. Returns { passed, failure, stats }.
//   ctx: { interpreter, lib, layer1, activeRows, aliases, baseline }
//   group: { items: [{ row, truth }], signature }
//   corpus: [{ body, date, truth|null, signature|null }]  (transactions + other Haiku rows)
//   negatives: [{ body, date }]                        (Haiku said: not a transaction)
export function testRule(rule, group, corpus, negatives, ctx) {
  const stats = { total_messages: 0, newly_matched_count: 0, regressions_count: 0 };
  const fail = (failure) => ({ passed: false, failure, stats });

  // 1. Loads, together with every active rule, in the phone's own reader.
  const maxPriority = ctx.activeRows.reduce((m, r) => Math.max(m, Number(r.priority) || 0), 0);
  const placed = { ...rule, priority: maxPriority + 10, status: 'active' };
  let full, alone;
  try {
    full = ctx.interpreter.compileRuleset({ rules: [...ctx.activeRows, placed], aliases: ctx.aliases }, ctx.lib);
    alone = ctx.interpreter.compileRuleset({ rules: [placed], aliases: ctx.aliases }, ctx.lib);
  } catch (e) {
    return fail(`does not load in the phone's rule reader: ${e.message}`);
  }

  // 2. Privacy.
  const privacy = privacyProblem(rule, group.items.map((i) => i.row.raw_text));
  if (privacy) return fail(`privacy: ${privacy}`);

  // 3. Every SMS of the wording: passes Layer 1, read by THIS rule, same values.
  for (const { row, truth } of group.items) {
    stats.total_messages++;
    if (!ctx.layer1.passesLayer1Filter(row.raw_text).pass) return fail('an SMS of this wording is dropped by Layer 1');
    const r = full.matchMessage(row.raw_text, row.txn_date);
    const short = row.raw_text.slice(0, 60);
    if (!r || r.discard) return fail(`does not read: "${short}…"`);
    if (r.matched_rule !== rule.rule_key) return fail(`another rule (${r.matched_rule}) reads "${short}…" first`);
    if (r.direction !== truth.direction) return fail(`reads ${r.direction}, expected ${truth.direction}: "${short}…"`);
    if (!sameAmount(r.amount, truth.amount)) return fail(`reads amount ${r.amount}, expected ${truth.amount}: "${short}…"`);
    if (!merchantMatches(r.merchant, truth.merchant)) return fail(`reads merchant "${r.merchant}", expected "${truth.merchant}": "${short}…"`);
    if (r.account_number_masked && !row.raw_text.includes(String(r.account_number_masked))) {
      return fail(`account "${r.account_number_masked}" is not in the SMS: "${short}…"`);
    }
  }

  // 4. Changes nothing that already works, and stays within its own wording.
  //    The rule sits after every active rule, so it can only change an SMS
  //    no active rule reads today. Those are checked one by one.
  const groupBodies = new Set(group.items.map((i) => i.row.raw_text));
  for (const c of corpus) {
    if (groupBodies.has(c.body)) continue;
    stats.total_messages++;
    if (!alone.matchMessage(c.body, c.date)) continue;            // cheap first look
    if (ctx.baseline(c.body, c.date)) continue;                   // an active rule reads it first
    const r = full.matchMessage(c.body, c.date);
    if (!r || r.discard || r.matched_rule !== rule.rule_key) continue;
    stats.newly_matched_count++;
    if (c.truth) {
      if (r.direction !== c.truth.direction || !sameAmount(r.amount, c.truth.amount)) {
        stats.regressions_count++;
        return fail(`reads another SMS differently from what it really is: "${c.body.slice(0, 60)}…"`);
      }
    } else if (templateSignature(c.body, r.merchant) !== group.signature) {
      stats.regressions_count++;
      return fail(`also reads a different wording: "${c.body.slice(0, 60)}…"`);
    }
  }

  // 5. Reads nothing Haiku said is not a transaction.
  for (const n of negatives) {
    stats.total_messages++;
    if (!alone.matchMessage(n.body, n.date)) continue;
    if (ctx.baseline(n.body, n.date)) continue;
    const r = full.matchMessage(n.body, n.date);
    if (r && !r.discard && r.matched_rule === rule.rule_key) {
      stats.regressions_count++;
      return fail(`reads an SMS Haiku said is not a transaction: "${n.body.slice(0, 60)}…"`);
    }
  }

  return { passed: true, failure: null, stats, priority: placed.priority };
}

// ─── Step 4: probation ─────────────────────────────────────────────────────

// For one automatic rule on probation: did the user correct anything it read?
//   reviewed: transactions with status 'user_reviewed', created after the rule.
export function probationCorrection(rule, reviewed, ctx) {
  let full;
  try {
    full = ctx.interpreter.compileRuleset({ rules: ctx.activeRows, aliases: ctx.aliases }, ctx.lib);
  } catch (e) {
    return `the active rules no longer load: ${e.message}`;
  }
  for (const t of reviewed) {
    if (!t.raw_text || t.amount == null) continue;
    const r = full.matchMessage(t.raw_text, t.txn_date);
    if (!r || r.discard || r.matched_rule !== rule.rule_key) continue;
    const direction = Number(t.amount) > 0 ? 'credit' : 'debit';
    if (r.direction !== direction || !sameAmount(r.amount, t.amount)) {
      return `you corrected "${t.raw_text.slice(0, 60)}…" to ${direction} ${Math.abs(Number(t.amount))}`;
    }
  }
  return null;
}

// ─── The whole run ─────────────────────────────────────────────────────────
//
// deps:
//   db.*           database reads/writes (index.ts)
//   writeRule(p)   asks Haiku for a rule: (prompt) -> tool output object
//   interpreter, lib, layer1   the app's reading code (_shared copies)
//   now            Date
//   dryRun         true = decide and report only: no writes, no Haiku
export async function runRuleBuilder(deps, settingsIn = {}) {
  const settings = { ...DEFAULT_SETTINGS, ...settingsIn };
  const { db, interpreter, lib, layer1, now, dryRun } = deps;
  const summary = {
    mode: settings.mode, dry_run: !!dryRun, sorted: {}, wordings_waiting: 0,
    rules_made: [], rules_failed: [], probation: [], needs_layer1_examples: [],
  };

  // Active rules, compiled once: this is "what the phone does today".
  const activeRows = await db.loadActiveRules();
  const aliases = await db.loadAliases();
  if (activeRows.length === 0) throw new Error('no active rules in parse_rules');
  const ctx = { interpreter, lib, layer1, activeRows: [...activeRows], aliases, baseline: null };
  const recompile = () => {
    const set = interpreter.compileRuleset({ rules: ctx.activeRows, aliases }, lib);
    ctx.baseline = (body, date) => set.matchMessage(body, date);
  };
  recompile();

  // ── 1. Sort ──
  const rows = await db.loadHaikuRows(settings.maxHaikuRows);
  const txns = await db.loadTransactionsFor(rows);
  const txnKey = (r) => `${r.user_id}|${r.raw_sms_id}|${r.raw_text}`;
  const txnBy = new Map(txns.map((t) => [txnKey(t), t]));

  const candidates = [];
  // "Not a transaction" SMS from earlier runs are kept as checks too.
  const negatives = (await db.loadNegatives(settings.maxCorpus)).map((n) => ({ body: n.raw_text, date: n.txn_date }));
  const statusUpdates = new Map(); // status|note -> ids
  for (const row of rows) {
    const truth = row.haiku_status === 'dropped_unresolvable'
      ? { skip: 'not_transaction' }
      : truthFor(row, txnBy.get(txnKey(row)));
    const s = sortOne(row, truth, ctx);
    summary.sorted[s.status] = (summary.sorted[s.status] || 0) + 1;
    if (s.status === 'not_transaction') negatives.push({ body: row.raw_text, date: row.txn_date });
    if (s.status === 'needs_layer1' && summary.needs_layer1_examples.length < 5) {
      summary.needs_layer1_examples.push(templateSignature(row.raw_text, truth.merchant).slice(0, 100));
    }
    if (s.status === 'candidate') {
      candidates.push({ row, truth, signature: s.signature });
    } else if (FINAL_STATUSES.has(s.status) && row.rule_builder_status !== s.status) {
      const k = `${s.status}|${s.note ?? ''}`;
      if (!statusUpdates.has(k)) statusUpdates.set(k, []);
      statusUpdates.get(k).push(row.id);
    }
  }
  if (!dryRun) {
    for (const [k, ids] of statusUpdates) {
      const [status, note] = k.split('|');
      await db.updateHaikuRows(ids, { rule_builder_status: status, rule_builder_note: note || null });
    }
  }

  // ── 2. Group ──
  const groups = groupCandidates(candidates, settings);
  summary.wordings_waiting = groups.filter((g) => !g.ready).length;
  if (!dryRun) {
    for (const g of groups.filter((x) => !x.ready)) {
      await db.updateHaikuRows(g.allRows.map((i) => i.row.id), {
        rule_builder_status: 'waiting_for_repeats',
        rule_builder_note: `${g.items.length} of ${settings.minRepeats} seen`,
        template_signature: g.signature,
      });
    }
  }

  // Test material: real transactions + every other Haiku-confirmed SMS.
  const corpusRows = await db.loadCorpus(settings.maxCorpus);
  const corpus = [];
  const seen = new Set();
  for (const t of corpusRows) {
    if (!t.raw_text || seen.has(t.raw_text)) continue;
    seen.add(t.raw_text);
    const truth = t.amount != null && Number(t.amount) !== 0
      ? { direction: Number(t.amount) > 0 ? 'credit' : 'debit', amount: Math.abs(Number(t.amount)) }
      : null;
    corpus.push({ body: t.raw_text, date: t.txn_date, truth, signature: templateSignature(t.raw_text, t.merchant) });
  }
  for (const c of candidates) {
    if (seen.has(c.row.raw_text)) continue;
    seen.add(c.row.raw_text);
    corpus.push({ body: c.row.raw_text, date: c.row.txn_date, truth: c.truth, signature: c.signature });
  }

  // ── 3. Rules for wordings that are ready ──
  const exampleRules = activeRows
    .filter((r) => r.field_overrides && Object.keys(r.field_overrides).length > 0)
    .slice(0, 2)
    .map((r) => ({ match_patterns: r.match_patterns, exclude_patterns: r.exclude_patterns, fixed_fields: r.fixed_fields, field_overrides: r.field_overrides }));

  let made = 0;
  for (const g of groups.filter((x) => x.ready)) {
    if (made >= settings.maxRulesPerRun) break;
    const attempts = await db.getAttempts(g.signature);
    if (attempts && attempts.attempts >= settings.maxTries) {
      if (!dryRun) await db.updateHaikuRows(g.allRows.map((i) => i.row.id), { rule_builder_status: 'gave_up', rule_builder_note: `stopped after ${attempts.attempts} failed tries: ${attempts.last_error}`, template_signature: g.signature });
      continue;
    }
    if (dryRun) { summary.rules_made.push({ wording: g.signature, sms: g.items.length, would: 'ask Haiku for a rule' }); made++; continue; }

    const ids = g.allRows.map((i) => i.row.id);
    const tryNo = (attempts?.attempts ?? 0) + 1;
    const ruleKey = `${g.ruleKeyBase}_${tryNo}`;
    const activate = settings.mode === 'auto';

    // A draft that already passed (made while mode was draft_only) is
    // re-tested and switched on in 'auto' mode, never re-written by Haiku.
    // In 'draft_only' mode it is left as it is.
    const passedDraft = await db.findPassedDraft(g.signature);
    if (passedDraft && !activate) continue;
    made++;
    let candidateRule;
    try {
      if (passedDraft) {
        candidateRule = { ...passedDraft };
      } else {
        const prompt = buildRulePrompt(g, exampleRules, attempts?.last_error ?? null);
        const out = await deps.writeRule(prompt);
        candidateRule = ruleFromOutput(out, ruleKey, g.signature, true);
      }
    } catch (e) {
      const err = `Haiku's rule is not usable: ${e.message}`;
      await db.upsertAttempts(g.signature, { attempts: tryNo, last_error: err, last_rule_id: null });
      await db.updateHaikuRows(ids, { rule_builder_status: 'rule_failed', rule_builder_note: err, template_signature: g.signature });
      summary.rules_failed.push({ wording: g.signature, reason: err });
      continue;
    }

    const result = testRule(candidateRule, g, corpus, negatives, ctx);
    const status = result.passed && activate ? 'active' : 'draft';
    const note = result.passed
      ? (activate ? `Passed all checks on ${g.items.length} SMS; active, on probation.` : `Passed all checks on ${g.items.length} SMS; draft because mode is draft_only.`)
      : `Failed: ${result.failure}`;

    let saved;
    if (passedDraft) {
      saved = await db.updateRule(passedDraft.id, {
        status,
        notes: note,
        priority: result.priority ?? passedDraft.priority,
        probation_until: status === 'active' ? new Date(now.getTime() + settings.probationDays * 864e5).toISOString() : null,
      });
    } else {
      saved = await db.insertRule({
        ...candidateRule,
        status,
        priority: result.priority ?? 9999,
        notes: note,
        probation_until: status === 'active' ? new Date(now.getTime() + settings.probationDays * 864e5).toISOString() : null,
      });
    }

    const runId = await db.insertRegressionRun({
      rule_ids: [saved.id],
      total_messages: result.stats.total_messages,
      newly_matched_count: result.stats.newly_matched_count,
      regressions_count: result.stats.regressions_count,
      passed: result.passed,
      notes: note,
      run_by: 'rule-builder',
    });
    if (result.passed) await db.updateRule(saved.id, { last_passing_regression_run_id: runId });

    if (result.passed) {
      await db.upsertAttempts(g.signature, { attempts: attempts?.attempts ?? 0, last_error: null, last_rule_id: saved.id });
      await db.updateHaikuRows(ids, {
        rule_builder_status: status === 'active' ? 'rule_active' : 'rule_draft',
        rule_builder_note: note, template_signature: g.signature, promoted_to_rule_id: saved.id,
      });
      summary.rules_made.push({ rule_key: saved.rule_key, status, wording: g.signature, sms: g.items.length });
      if (status === 'active') { ctx.activeRows.push(saved); recompile(); }
    } else {
      await db.upsertAttempts(g.signature, { attempts: tryNo, last_error: result.failure, last_rule_id: saved.id });
      await db.updateHaikuRows(ids, {
        rule_builder_status: 'rule_failed', rule_builder_note: note, template_signature: g.signature, promoted_to_rule_id: null,
      });
      summary.rules_failed.push({ rule_key: saved.rule_key, wording: g.signature, reason: result.failure });
    }
  }

  // ── 4. Probation ──
  const onProbation = ctx.activeRows.filter((r) => r.created_by === 'rule_builder' && r.probation_until);
  const fetchFailures = onProbation.length ? await db.loadCompileFailuresSince(
    onProbation.reduce((m, r) => (r.created_at < m ? r.created_at : m), onProbation[0].created_at),
  ) : [];
  for (const rule of onProbation) {
    const reviewed = await db.loadReviewedSince(rule.created_at);
    let problem = probationCorrection(rule, reviewed, ctx);
    if (!problem && fetchFailures.some((f) => f.created_at >= rule.created_at)) {
      problem = 'phones reported the rules could not be loaded after this rule went live';
    }
    if (problem) {
      summary.probation.push({ rule_key: rule.rule_key, action: 'switched off', reason: problem });
      if (!dryRun) {
        await db.updateRule(rule.id, { status: 'archived', probation_until: null, notes: `Switched off: ${problem}` });
        const a = await db.getAttempts(rule.source_signature);
        await db.upsertAttempts(rule.source_signature, { attempts: (a?.attempts ?? 0) + 1, last_error: problem, last_rule_id: rule.id });
        await db.resetHaikuRowsForRule(rule.id);
      }
    } else if (new Date(rule.probation_until) <= now) {
      summary.probation.push({ rule_key: rule.rule_key, action: 'probation ended' });
      if (!dryRun) {
        const fixed = { ...rule.fixed_fields };
        delete fixed.requires_classification;
        await db.updateRule(rule.id, { fixed_fields: fixed, probation_until: null, notes: `${rule.notes ?? ''} Probation ended with no corrections.`.trim() });
      }
    } else {
      summary.probation.push({ rule_key: rule.rule_key, action: 'still on probation', until: rule.probation_until });
    }
  }

  return summary;
}
