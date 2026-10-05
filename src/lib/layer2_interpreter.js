/**
 * layer2_interpreter.js
 * Location: apps/mobile/src/lib/layer2_interpreter.js
 *
 * Evaluates the remote Layer 2 ruleset (parse_rules + bank_aliases rows)
 * with the same output contract as layer2_ruleset.js's matchMessage().
 *
 * Plain CommonJS on purpose — the same file runs on-device (required
 * from layer2Engine.ts) and in Node (compare_rulesets.js), so the thing
 * the parity harness tests is literally the thing the app runs.
 *
 * Nothing in a row is executable code. A row can only reference:
 *   - regexes (compiled with a flag whitelist), and
 *   - helper NAMES from the fixed HELPERS table below (bundled app code).
 * Any row that references something this build doesn't know (unknown
 * step type, helper, field, or flag) makes the WHOLE ruleset fail to
 * compile. That's deliberate: silently skipping one rule changes which
 * later, broader rule catches a message — a partial ruleset is a
 * different ruleset. The caller falls back to its last good cache or to
 * the bundled ruleset instead.
 *
 * ── Row shape ────────────────────────────────────────────────────────
 * match_patterns / exclude_patterns: [{ "re": "...", "flags": "im" }]
 *   Rule fires if ANY match_pattern matches and NO exclude_pattern does.
 *   (AND of two positives is written as one regex with lookaheads — see
 *   VENDOR_SETTLEMENT_NOTICE.)
 *
 * fixed_fields: { field: literal }        e.g. {"channel": "NACH"}
 * field_overrides: { field: { steps: [...], null_if?: [...], rewrite?: [...] } }
 *
 * Step types (tried in order; first step producing a value wins):
 *   { re, flags, group=1, as="text"|"number"|"date_dm_envelope_year",
 *     template?: "Cheque #{1}", map?: {"cr": "credit"} }
 *   { helper: "extractMerchant", input_field?: "_vpa" }
 *   { value: <literal> }
 *   { test: { re, flags }, value: <literal> }
 *   { lookup: "<field>", map?: {...}, null_value?: <lit>, default?: <lit> }
 *
 * A step "produces a value" unless its result is null/undefined/''/NaN.
 * Fields starting with "_" are scratch values (computed on demand, never
 * emitted). Fields are computed lazily, so lookups work regardless of
 * jsonb key order.
 *
 * Precedence per field: field_overrides > fixed_fields > DEFAULTS below.
 */

'use strict';

const INTERPRETER_SCHEMA_VERSION = 1;

const ALLOWED_FLAGS = new Set(['i', 'm', 's', 'u']); // never g/y: stateful lastIndex

const OUTPUT_FIELDS = new Set([
  'direction', 'amount', 'bank', 'channel', 'account_number_masked', 'txn_date',
  'merchant', 'balance', 'ref_number', 'ref_type', 'possible_contra',
  'requires_classification', 'vpa_type', 'confidence', 'discard_reason',
]);

// What a field falls back to when a rule says nothing about it — mirrors
// the helper each rule's extract() used by default in layer2_ruleset.js.
const DEFAULTS = {
  amount:                  { helper: 'extractAmount' },
  bank:                    { helper: 'extractBank' },
  channel:                 { helper: 'extractChannel' },
  account_number_masked:   { helper: 'extractAccount' },
  txn_date:                { helper: 'extractDate' },
  merchant:                { helper: 'extractMerchant' },
  balance:                 { helper: 'extractBalance' },
  ref_number:              { helper: 'refNumber' },
  ref_type:                { helper: 'refType' },
  possible_contra:         { value: false },
  requires_classification: { value: false },
  vpa_type:                { value: null },
  direction:               { value: null },
  confidence:              { value: null },
  discard_reason:          { value: null },
};

const STEP_KEYS = {
  re:     new Set(['re', 'flags', 'group', 'as', 'template', 'map']),
  helper: new Set(['helper', 'input_field']),
  value:  new Set(['value']),
  test:   new Set(['test', 'value']),
  lookup: new Set(['lookup', 'map', 'null_value', 'default']),
};

function stepType(step) {
  if ('test' in step) return 'test';
  if ('re' in step) return 're';
  if ('helper' in step) return 'helper';
  if ('lookup' in step) return 'lookup';
  if ('value' in step) return 'value';
  return null;
}

function compileRegex(spec, where) {
  if (!spec || typeof spec.re !== 'string') throw new Error(`${where}: missing "re"`);
  const flags = spec.flags == null ? '' : String(spec.flags);
  for (const f of flags) {
    if (!ALLOWED_FLAGS.has(f)) throw new Error(`${where}: flag "${f}" not allowed`);
  }
  try {
    return new RegExp(spec.re, flags);
  } catch (e) {
    throw new Error(`${where}: invalid regex (${e.message})`);
  }
}

function hasValue(v) {
  return !(v === null || v === undefined || v === '' || (typeof v === 'number' && Number.isNaN(v)));
}

/**
 * @param {{rules: object[], aliases: object[]}} data  rows as fetched
 * @param {object} lib  the bundled helper module (layer2_ruleset.js exports)
 * @returns {{ matchMessage: Function, ruleKeys: string[], aliasCount: number }}
 */
function compileRuleset(data, lib) {
  if (!data || !Array.isArray(data.rules) || !Array.isArray(data.aliases)) {
    throw new Error('ruleset: expected { rules: [], aliases: [] }');
  }
  if (data.rules.length === 0) throw new Error('ruleset: zero rules (all draft? RLS only returns active rows)');
  if (data.aliases.length === 0) throw new Error('ruleset: zero bank aliases');

  // ── Bank extraction from bank_aliases (replaces BANK_TOKENS) ──────────
  // Same normalization as layer2_ruleset.js's extractBank(); ORDER is
  // load-bearing (first substring hit wins), hence the priority column.
  const aliases = data.aliases
    .map((a) => ({ token: String(a.token || '').toLowerCase(), name: a.bank_name, priority: Number(a.priority) }))
    .filter((a) => a.token && a.name)
    .sort((x, y) => (x.priority - y.priority) || (x.token < y.token ? -1 : x.token > y.token ? 1 : 0));

  function extractBank(body) {
    const stripped = body.replace(/\S+@\S+/g, ' ');
    const n = stripped.toLowerCase().replace(/[\s\-_/.]/g, '');
    for (const a of aliases) if (n.includes(a.token)) return a.name;
    return null;
  }

  const HELPERS = {
    extractAmount:              (b) => lib.extractAmount(b),
    extractBank,
    extractChannel:             (b) => lib.extractChannel(b),
    extractAccount:             (b) => lib.extractAccount(b),
    extractDate:                (b) => lib.extractDate(b),
    extractMerchant:            (b) => lib.extractMerchant(b),
    extractBalance:             (b) => lib.extractBalance(b),
    extractBenefitCardMerchant: (b) => lib.extractBenefitCardMerchant(b),
    extractBenefitCardChannel:  (b) => lib.extractBenefitCardChannel(b),
    isPossibleSelfTransfer:     (b) => lib.isPossibleSelfTransfer(b),
    classifyVpa:                (b) => lib.classifyVpa(b),
    refNumber:                  (b) => lib.extractRefNumber(b).ref_number,
    refType:                    (b) => lib.extractRefNumber(b).ref_type,
  };
  for (const [name, fn] of Object.entries(HELPERS)) {
    if (typeof fn !== 'function') throw new Error(`helper ${name} unavailable`);
  }
  for (const needed of ['extractAmount', 'extractChannel', 'extractAccount', 'extractDate',
    'extractMerchant', 'extractBalance', 'extractBenefitCardMerchant', 'extractBenefitCardChannel',
    'isPossibleSelfTransfer', 'classifyVpa', 'extractRefNumber', 'extractReferenceValue']) {
    if (typeof lib[needed] !== 'function') throw new Error(`bundled lib is missing ${needed}()`);
  }

  function compileStep(step, where) {
    if (!step || typeof step !== 'object') throw new Error(`${where}: step must be an object`);
    const type = stepType(step);
    if (!type) throw new Error(`${where}: unknown step type (${JSON.stringify(step)})`);
    for (const k of Object.keys(step)) {
      if (!STEP_KEYS[type].has(k)) throw new Error(`${where}: unknown key "${k}" for ${type} step`);
    }
    switch (type) {
      case 're': {
        const rx = compileRegex(step, where);
        const group = step.group == null ? 1 : step.group;
        const as = step.as || 'text';
        if (!['text', 'number', 'date_dm_envelope_year'].includes(as)) throw new Error(`${where}: unknown "as": ${as}`);
        return { type, rx, group, as, template: step.template, map: step.map };
      }
      case 'helper':
        if (!HELPERS[step.helper]) throw new Error(`${where}: unknown helper "${step.helper}"`);
        return { type, fn: HELPERS[step.helper], input_field: step.input_field };
      case 'test':
        return { type, rx: compileRegex(step.test, where), value: step.value };
      case 'lookup':
        return { type, field: step.lookup, map: step.map, hasNull: 'null_value' in step,
          null_value: step.null_value, hasDefault: 'default' in step, default: step.default };
      default:
        return { type, value: step.value };
    }
  }

  function compileField(spec, where) {
    if (!spec || !Array.isArray(spec.steps) || spec.steps.length === 0) {
      throw new Error(`${where}: needs a non-empty "steps" array`);
    }
    for (const k of Object.keys(spec)) {
      if (!['steps', 'null_if', 'rewrite'].includes(k)) throw new Error(`${where}: unknown key "${k}"`);
    }
    return {
      steps: spec.steps.map((s, i) => compileStep(s, `${where}.steps[${i}]`)),
      null_if: (spec.null_if || []).map((p, i) => compileRegex(p, `${where}.null_if[${i}]`)),
      rewrite: (spec.rewrite || []).map((r, i) => ({ rx: compileRegex(r, `${where}.rewrite[${i}]`), value: r.value })),
    };
  }

  const DEFAULT_FIELDS = {};
  for (const [f, step] of Object.entries(DEFAULTS)) {
    DEFAULT_FIELDS[f] = { steps: [compileStep(step, `default.${f}`)], null_if: [], rewrite: [] };
  }

  const seenKeys = new Set();
  const rules = data.rules
    .filter((r) => r.layer === 2 || r.layer === undefined)
    .slice()
    .sort((a, b) => (a.priority - b.priority) || (a.rule_key < b.rule_key ? -1 : 1))
    .map((row) => {
      const key = row.rule_key;
      if (!key) throw new Error('rule missing rule_key');
      if (seenKeys.has(key)) throw new Error(`duplicate rule_key ${key}`);
      seenKeys.add(key);
      const match = (row.match_patterns || []).map((p, i) => compileRegex(p, `${key}.match_patterns[${i}]`));
      if (match.length === 0) throw new Error(`${key}: no match_patterns`);
      const exclude = (row.exclude_patterns || []).map((p, i) => compileRegex(p, `${key}.exclude_patterns[${i}]`));

      const fields = {};
      const fixed = row.fixed_fields || {};
      for (const [f, v] of Object.entries(fixed)) {
        if (!OUTPUT_FIELDS.has(f)) throw new Error(`${key}.fixed_fields: unknown field "${f}"`);
        fields[f] = { steps: [{ type: 'value', value: v }], null_if: [], rewrite: [], fixed: true };
      }
      const overrides = row.field_overrides || {};
      for (const [f, spec] of Object.entries(overrides)) {
        if (!OUTPUT_FIELDS.has(f) && !f.startsWith('_')) throw new Error(`${key}.field_overrides: unknown field "${f}"`);
        if (f in fixed) throw new Error(`${key}: "${f}" is in both fixed_fields and field_overrides`);
        fields[f] = compileField(spec, `${key}.field_overrides.${f}`);
      }
      // ref_number/ref_type come from one helper call in the bundled
      // code — overriding one without the other would mix sources.
      if (('ref_number' in fields) !== ('ref_type' in fields)) {
        throw new Error(`${key}: ref_number and ref_type must be specified together`);
      }
      // Every referenced lookup/input field must resolve to something.
      for (const spec of Object.values(fields)) {
        for (const s of spec.steps) {
          const dep = s.type === 'lookup' ? s.field : s.type === 'helper' ? s.input_field : null;
          if (dep && !(dep in fields) && !(dep in DEFAULT_FIELDS)) {
            throw new Error(`${key}: step references undefined field "${dep}"`);
          }
        }
      }
      return { key, match, exclude, fields };
    });

  function evaluate(rule, body, messageDate) {
    const cache = {};
    const inProgress = new Set();

    function get(field) {
      if (field in cache) return cache[field];
      if (inProgress.has(field)) throw new Error(`${rule.key}: circular field reference at "${field}"`);
      inProgress.add(field);
      const spec = rule.fields[field] || DEFAULT_FIELDS[field];
      const v = spec ? runField(spec) : null;
      inProgress.delete(field);
      cache[field] = v;
      return v;
    }

    function runStep(s) {
      switch (s.type) {
        case 'value': return s.value;
        case 'test': return s.rx.test(body) ? s.value : null;
        case 'helper': {
          if (s.input_field) {
            const input = get(s.input_field);
            return hasValue(input) ? s.fn(input) : null;
          }
          return s.fn(body);
        }
        case 'lookup': {
          const v = get(s.field);
          if (!hasValue(v)) return s.hasNull ? s.null_value : null;
          if (s.map) {
            const k = String(v).toLowerCase();
            if (Object.prototype.hasOwnProperty.call(s.map, k)) return s.map[k];
            return s.hasDefault ? s.default : null;
          }
          return s.hasDefault ? s.default : v;
        }
        case 're': {
          const m = body.match(s.rx);
          if (!m) return null;
          if (s.as === 'date_dm_envelope_year') {
            if (!messageDate || messageDate.length < 4) return null;
            return `${messageDate.substring(0, 4)}-${m[2]}-${m[1].padStart(2, '0')}`;
          }
          const raw = m[s.group];
          if (raw === undefined) return null;
          if (s.as === 'number') return parseFloat(raw.replace(/,/g, ''));
          let v = raw.trim();
          if (s.map) {
            const k = v.toLowerCase();
            v = Object.prototype.hasOwnProperty.call(s.map, k) ? s.map[k] : null;
          }
          if (s.template && hasValue(v)) v = s.template.replace(/\{1\}/g, v);
          return v;
        }
        default: return null;
      }
    }

    function runField(spec) {
      let v = null;
      for (const s of spec.steps) {
        const out = runStep(s);
        if (spec.fixed || hasValue(out)) { v = out; break; }
      }
      if (typeof v === 'string') {
        if (spec.null_if.some((rx) => rx.test(v))) return null;
        for (const r of spec.rewrite) if (r.rx.test(v)) { v = r.value; break; }
      }
      return v;
    }

    return get;
  }

  // Output assembly mirrors layer2_ruleset.js's matchMessage() line for
  // line, EXCEPT direction: the bundled code falls back to
  // rule.id.includes('CREDIT') when a rule sets none. That is not carried
  // over — renaming a rule_key must never be able to flip a transaction's
  // direction. Every migrated row states its direction explicitly; a row
  // with none yields direction null and the message falls through (safe).
  function matchMessage(body, messageDate) {
    for (const rule of rules) {
      if (!rule.match.some((rx) => rx.test(body))) continue;
      if (rule.exclude.some((rx) => rx.test(body))) continue;

      const get = evaluate(rule, body, messageDate);
      const direction = get('direction');

      if (direction === 'declined') {
        return { discard: true, reason: 'declined_transaction', rule: rule.key };
      }
      const discardReason = get('discard_reason');
      if (discardReason) {
        const balance = get('balance');
        return {
          discard: true,
          reason: discardReason,
          rule: rule.key,
          account_number_masked: get('account_number_masked') || null,
          bank: get('bank') || null,
          balance: balance ?? null,
        };
      }

      const balance = get('balance');
      const result = {
        matched_rule:            rule.key,
        bank:                    get('bank') || null,
        channel:                 get('channel') || null,
        direction:               direction || null,
        amount:                  get('amount') || null,
        account_number_masked:   get('account_number_masked') || null,
        txn_date:                get('txn_date') || messageDate,
        merchant:                get('merchant') || null,
        balance:                 balance ?? null,
        ref_number:              get('ref_number') || null,
        ref_type:                get('ref_type') || null,
        reference_value:         lib.extractReferenceValue(body),
        confidence:              get('confidence'),
        possible_contra:         get('possible_contra') || false,
        requires_classification: get('requires_classification') || false,
        vpa_type:                get('vpa_type') || null,
        escalate_to_haiku:       false,
      };
      if (result.amount === null || result.direction === null) return null;
      return result;
    }
    return null;
  }

  return { matchMessage, ruleKeys: rules.map((r) => r.key), aliasCount: aliases.length };
}

module.exports = { compileRuleset, INTERPRETER_SCHEMA_VERSION };