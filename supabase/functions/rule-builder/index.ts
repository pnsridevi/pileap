// supabase/functions/rule-builder/index.ts
//
// Turns bank wordings Haiku keeps confirming into parsing rules.
// Started by hand (never scheduled while testing):
//
//   POST /functions/v1/rule-builder              do it
//   POST /functions/v1/rule-builder?dry_run=1    show what it would do; changes nothing, no Haiku
//   POST /functions/v1/rule-builder?limit=2      make at most 2 rules this run (max 5)
//
// Header needed: x-rule-builder-secret: <RULE_BUILDER_SECRET>
// (so nobody else can start it, even with the app's key).
//
// Secrets (npx supabase secrets set ...):
//   ANTHROPIC_API_KEY      already set for haiku-submit
//   RULE_BUILDER_SECRET    any long random text; you send it in the header
//   RULE_BUILDER_MODE      'draft_only' (default) or 'auto'
//
// All decisions live in ../_shared/rule_builder_core.js. This file only
// reads and writes the database and calls Haiku.
//
// Needs ../_shared/layer2_interpreter.js, layer2_ruleset.js, layer1sim.js:
// run `node tools/build-shared.js` before every deploy.

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.45.4';
import interpreter from '../_shared/layer2_interpreter.js';
import lib from '../_shared/layer2_ruleset.js';
import layer1 from '../_shared/layer1sim.js';
import { runRuleBuilder, DEFAULT_SETTINGS } from '../_shared/rule_builder_core.js';

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
const SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
const ANTHROPIC_API_KEY = Deno.env.get('ANTHROPIC_API_KEY') ?? '';
const SECRET = Deno.env.get('RULE_BUILDER_SECRET') ?? '';
const MODE = Deno.env.get('RULE_BUILDER_MODE') === 'auto' ? 'auto' : 'draft_only';
const MODEL = Deno.env.get('RULE_WRITER_MODEL') ?? 'claude-haiku-4-5-20251001';
const MIN_USERS = Number(Deno.env.get('RULE_BUILDER_MIN_USERS') ?? DEFAULT_SETTINGS.minUsers);

const PAGE = 1000; // Supabase returns at most 1000 rows per request
const CHUNK = 100; // ids per "in (...)" filter

// deno-lint-ignore no-explicit-any
type Row = Record<string, any>;

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body, null, 2), { status, headers: { 'Content-Type': 'application/json' } });

function chunks<T>(arr: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

// deno-lint-ignore no-explicit-any
function makeDb(sb: any, dryRun: boolean) {
  // deno-lint-ignore no-explicit-any
  async function all(build: (from: number, to: number) => any, limit: number): Promise<Row[]> {
    const out: Row[] = [];
    for (let from = 0; from < limit; from += PAGE) {
      const to = Math.min(from + PAGE, limit) - 1;
      const { data, error } = await build(from, to);
      if (error) throw new Error(error.message);
      out.push(...(data ?? []));
      if (!data || data.length < to - from + 1) break;
    }
    return out;
  }
  // deno-lint-ignore no-explicit-any
  const must = (r: { data: any; error: { message: string } | null }, what: string): any => {
    if (r.error) throw new Error(`${what}: ${r.error.message}`);
    return r.data;
  };
  const RULE_COLS = 'id, layer, rule_key, priority, status, match_patterns, exclude_patterns, fixed_fields, field_overrides, created_by, created_at, notes, source_signature, probation_until';

  return {
    loadActiveRules: async () => must(await sb.from('parse_rules').select(RULE_COLS)
      .eq('layer', 2).eq('status', 'active').order('priority', { ascending: true }), 'parse_rules'),

    loadAliases: async () => must(await sb.from('bank_aliases').select('token, bank_name, priority')
      .order('priority', { ascending: true }), 'bank_aliases'),

    loadHaikuRows: (limit: number) => all((f, t) => sb.from('haiku_candidate_log')
      .select('id, user_id, raw_sms_id, raw_text, txn_date, haiku_status, haiku_response, rule_builder_status')
      .in('haiku_status', ['done_updated', 'done_inserted', 'dropped_unresolvable'])
      .or('rule_builder_status.is.null,rule_builder_status.in.(waiting_for_repeats,rule_failed,rule_draft)')
      .order('haiku_processed_at', { ascending: false }).range(f, t), limit),

    loadNegatives: (limit: number) => all((f, t) => sb.from('haiku_candidate_log')
      .select('raw_text, txn_date').eq('rule_builder_status', 'not_transaction')
      .order('logged_at', { ascending: false }).range(f, t), limit),

    loadTransactionsFor: async (rows: Row[]) => {
      const ids = [...new Set(rows.map((r) => r.raw_sms_id))];
      const out: Row[] = [];
      for (const part of chunks(ids, CHUNK)) {
        out.push(...must(await sb.from('transactions')
          .select('user_id, raw_sms_id, raw_text, amount, merchant, status, is_deleted')
          .in('raw_sms_id', part), 'transactions'));
      }
      return out;
    },

    loadCorpus: (limit: number) => all((f, t) => sb.from('transactions')
      .select('raw_text, txn_date, amount, merchant')
      .not('raw_text', 'is', null).or('is_deleted.is.null,is_deleted.eq.false')
      .order('created_at', { ascending: false }).range(f, t), limit),

    loadReviewedSince: (since: string) => all((f, t) => sb.from('transactions')
      .select('raw_text, txn_date, amount').eq('status', 'user_reviewed').gte('created_at', since)
      .order('created_at', { ascending: false }).range(f, t), 5000),

    loadCompileFailuresSince: async (since: string) => must(await sb.from('background_sync_log')
      .select('created_at, details').eq('event', 'ruleset_fetch_failed').gte('created_at', since)
      .ilike('details->>error', '%compile%'), 'background_sync_log'),

    getAttempts: async (sig: string) => must(await sb.from('rule_builder_attempts')
      .select('attempts, last_error, last_rule_id').eq('template_signature', sig).maybeSingle(), 'rule_builder_attempts'),

    findPassedDraft: async (sig: string) => must(await sb.from('parse_rules').select(RULE_COLS)
      .eq('status', 'draft').eq('created_by', 'rule_builder').eq('source_signature', sig)
      .like('notes', 'Passed%').order('created_at', { ascending: false }).limit(1).maybeSingle(), 'parse_rules'),

    // ── writes (never reached in a dry run) ──
    upsertAttempts: async (sig: string, patch: Row) => {
      if (dryRun) return;
      must(await sb.from('rule_builder_attempts').upsert({ template_signature: sig, ...patch, updated_at: new Date().toISOString() }), 'rule_builder_attempts');
    },
    insertRule: async (row: Row) => must(await sb.from('parse_rules').insert(row).select(RULE_COLS).single(), 'insert parse_rules'),
    updateRule: async (id: string, patch: Row) => must(await sb.from('parse_rules').update(patch).eq('id', id).select(RULE_COLS).single(), 'update parse_rules'),
    insertRegressionRun: async (row: Row) => must(await sb.from('ruleset_regression_runs').insert(row).select('id').single(), 'ruleset_regression_runs').id,
    updateHaikuRows: async (ids: string[], patch: Row) => {
      if (dryRun || ids.length === 0) return;
      for (const part of chunks(ids, CHUNK)) {
        must(await sb.from('haiku_candidate_log').update({ ...patch, rule_builder_checked_at: new Date().toISOString() }).in('id', part), 'update haiku_candidate_log');
      }
    },
    resetHaikuRowsForRule: async (ruleId: string) => {
      if (dryRun) return;
      must(await sb.from('haiku_candidate_log').update({ rule_builder_status: null, rule_builder_note: null, promoted_to_rule_id: null })
        .eq('promoted_to_rule_id', ruleId), 'reset haiku_candidate_log');
    },
  };
}

// deno-lint-ignore no-explicit-any
async function writeRule(prompt: { system: string; user: string; tool: any }) {
  if (!ANTHROPIC_API_KEY) throw new Error('ANTHROPIC_API_KEY is not set');
  for (let attempt = 1; ; attempt++) {
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'x-api-key': ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
      body: JSON.stringify({
        model: MODEL,
        max_tokens: 2048,
        system: prompt.system,
        messages: [{ role: 'user', content: prompt.user }],
        tools: [prompt.tool],
        tool_choice: { type: 'tool', name: prompt.tool.name },
      }),
    });
    if (res.ok) {
      const body = await res.json();
      // deno-lint-ignore no-explicit-any
      const tool = (body.content ?? []).find((c: any) => c.type === 'tool_use');
      if (!tool) throw new Error('Haiku returned no rule');
      return tool.input;
    }
    const text = await res.text();
    if ((res.status === 429 || res.status >= 500) && attempt < 3) {
      await new Promise((r) => setTimeout(r, 2000 * attempt));
      continue;
    }
    throw new Error(`Haiku ${res.status}: ${text.slice(0, 200)}`);
  }
}

Deno.serve(async (req) => {
  if (req.method !== 'POST') return json(405, { error: 'use POST' });
  if (!SECRET || req.headers.get('x-rule-builder-secret') !== SECRET) {
    return json(401, { error: 'missing or wrong x-rule-builder-secret' });
  }

  const url = new URL(req.url);
  const dryRun = url.searchParams.get('dry_run') === '1';
  const limitParam = Number(url.searchParams.get('limit'));
  const maxRulesPerRun = Number.isFinite(limitParam) && limitParam > 0
    ? Math.min(limitParam, DEFAULT_SETTINGS.maxRulesPerRun)
    : DEFAULT_SETTINGS.maxRulesPerRun;

  const sb = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, { auth: { persistSession: false } });

  // One run at a time.
  let runId: string | null = null;
  if (!dryRun) {
    const { data, error } = await sb.rpc('rule_builder_start_run', { p_mode: MODE });
    if (error) return json(500, { error: `could not start: ${error.message}` });
    if (!data) return json(409, { error: 'another rule-builder run is still going; try again in a few minutes' });
    runId = data as string;
  }

  try {
    const summary = await runRuleBuilder(
      { db: makeDb(sb, dryRun), writeRule, interpreter, lib, layer1, now: new Date(), dryRun },
      { mode: MODE, maxRulesPerRun, minUsers: MIN_USERS },
    );
    if (runId) {
      await sb.from('rule_builder_runs').update({ status: 'finished', finished_at: new Date().toISOString(), summary }).eq('id', runId);
    }
    return json(200, summary);
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    if (runId) {
      await sb.from('rule_builder_runs').update({ status: 'failed', finished_at: new Date().toISOString(), error: message }).eq('id', runId);
    }
    return json(500, { error: message });
  }
});
