/**
 * rulesetStore.ts
 * Location: apps/mobile/src/lib/rulesetStore.ts
 *
 * Gets a compiled remote Layer 2 ruleset into layer2Engine before a parse
 * run. Call prepareRemoteRuleset() once per sync, before parseSmsMessages().
 *
 * Per sync:
 *   1. Load the cached ruleset (AsyncStorage) and compile it.
 *   2. Read ruleset_meta.version (one tiny row).
 *        same as cache → use cache, no further network.
 *        different     → fetch active parse_rules + bank_aliases, compile,
 *                        and only if that succeeds, replace the cache.
 *   3. Any failure (network, timeout, RLS, empty result, a row this app
 *      build can't compile) → keep the last good cache, or fall back to
 *      the bundled ruleset if there is none. Parsing never blocks on this.
 *
 * Logged to background_sync_log only when a full fetch actually happens
 * (ruleset_fetch_succeeded) or anything fails (ruleset_fetch_failed) —
 * not on every cache hit, which would be an hourly no-op row per device.
 *
 * Why version is read BEFORE the rows: if a rule changes between the two
 * reads, the cache is stored under the older version number, so the next
 * sync sees a newer version and refetches. Reading it after would let a
 * device keep stale rows under a current version number indefinitely.
 */

import AsyncStorage from '@react-native-async-storage/async-storage';
import { supabase } from '@/lib/supabase';
import {
  REMOTE_RULESET_MODE, setRemoteRuleset, clearRemoteRuleset, takeShadowReport,
} from './layer2Engine';

// eslint-disable-next-line @typescript-eslint/no-var-requires
const bundledLib = require('./layer2_ruleset.js');
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { compileRuleset, INTERPRETER_SCHEMA_VERSION } = require('./layer2_interpreter.js');

const CACHE_KEY = 'pileap.remoteRuleset.v1';
const NETWORK_TIMEOUT_MS = 8000;

interface CachedRuleset {
  version: number;
  schema: number;      // INTERPRETER_SCHEMA_VERSION the rows were compiled with
  fetchedAt: string;
  rules: unknown[];
  aliases: unknown[];
}

export type RulesetPrepareResult =
  | { source: 'disabled' }
  | { source: 'remote-fresh' | 'remote-cache'; version: number }
  | { source: 'bundled'; reason: string };

function withTimeout<T>(p: PromiseLike<T>, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<T>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} timed out after ${NETWORK_TIMEOUT_MS}ms`)), NETWORK_TIMEOUT_MS);
  });
  return Promise.race([Promise.resolve(p), timeout]).finally(() => clearTimeout(timer));
}

async function readCache(): Promise<CachedRuleset | null> {
  try {
    const raw = await AsyncStorage.getItem(CACHE_KEY);
    if (!raw) return null;
    const c = JSON.parse(raw) as CachedRuleset;
    if (c.schema !== INTERPRETER_SCHEMA_VERSION) return null; // compiled for a different interpreter
    return c;
  } catch {
    return null;
  }
}

function tryCompile(c: { rules: unknown[]; aliases: unknown[] }): { matchMessage: (b: string, d: string) => any } | null {
  try {
    return compileRuleset({ rules: c.rules, aliases: c.aliases }, bundledLib);
  } catch (e) {
    console.warn('rulesetStore: ruleset failed to compile:', e instanceof Error ? e.message : e);
    return null;
  }
}

/**
 * Writes to background_sync_log. ASSUMED columns: user_id, event, details
 * (jsonb) — match these to what backgroundSync.ts already inserts if they
 * differ.
 *
 * Fire-and-forget: callers do NOT await this. When the device is offline
 * the insert can hang for a long time, and the hourly background task has
 * a short OS time budget — logging must never delay parsing. Never throws.
 */
function logRulesetEvent(event: string, details: Record<string, unknown>): void {
  (async () => {
    const { data: { session } } = await supabase.auth.getSession();
    const userId = session?.user?.id;
    if (!userId) return;
    const { error } = await withTimeout(
      supabase.from('background_sync_log').insert({ user_id: userId, event, details }),
      `log ${event}`,
    );
    if (error) console.warn(`rulesetStore: failed to log ${event}:`, error.message);
  })().catch((e) => {
    console.warn(`rulesetStore: failed to log ${event}:`, e instanceof Error ? e.message : e);
  });
}

let inFlight: Promise<RulesetPrepareResult> | null = null;

export function prepareRemoteRuleset(): Promise<RulesetPrepareResult> {
  if (REMOTE_RULESET_MODE === 'off') return Promise.resolve({ source: 'disabled' });
  // App-open sync and the background task can overlap; share one fetch.
  if (!inFlight) inFlight = doPrepare().finally(() => { inFlight = null; });
  return inFlight;
}

async function doPrepare(): Promise<RulesetPrepareResult> {
  const cached = await readCache();
  const cachedCompiled = cached ? tryCompile(cached) : null;

  const fallBack = async (error: string): Promise<RulesetPrepareResult> => {
    if (cached && cachedCompiled) {
      setRemoteRuleset(cachedCompiled, cached.version);
    } else {
      clearRemoteRuleset();
    }
    logRulesetEvent('ruleset_fetch_failed', {
      error,
      cached_version_used: cached && cachedCompiled ? cached.version : null,
      fallback: cached && cachedCompiled ? 'cache' : 'bundled',
      mode: REMOTE_RULESET_MODE,
    });
    return cached && cachedCompiled
      ? { source: 'remote-cache', version: cached.version }
      : { source: 'bundled', reason: error };
  };

  try {
    const meta = await withTimeout(
      supabase.from('ruleset_meta').select('version').eq('id', true).single(),
      'ruleset_meta',
    );
    if (meta.error || !meta.data) return fallBack(`ruleset_meta: ${meta.error?.message ?? 'no row'}`);
    const version = Number(meta.data.version);

    if (cached && cachedCompiled && cached.version === version) {
      setRemoteRuleset(cachedCompiled, version);
      return { source: 'remote-cache', version };
    }

    const [rulesRes, aliasesRes] = await withTimeout(Promise.all([
      supabase
        .from('parse_rules')
        .select('layer, rule_key, priority, match_patterns, exclude_patterns, fixed_fields, field_overrides')
        .eq('layer', 2)
        .eq('status', 'active')
        .order('priority', { ascending: true }),
      supabase
        .from('bank_aliases')
        .select('token, bank_name, priority')
        .order('priority', { ascending: true }),
    ]), 'parse_rules/bank_aliases');

    if (rulesRes.error) return fallBack(`parse_rules: ${rulesRes.error.message}`);
    if (aliasesRes.error) return fallBack(`bank_aliases: ${aliasesRes.error.message}`);

    const fresh: CachedRuleset = {
      version,
      schema: INTERPRETER_SCHEMA_VERSION,
      fetchedAt: new Date().toISOString(),
      rules: rulesRes.data ?? [],
      aliases: aliasesRes.data ?? [],
    };

    const compiled = tryCompile(fresh);
    if (!compiled) return fallBack(`version ${version} failed to compile (0 active rules, or a row this app build doesn't support)`);

    setRemoteRuleset(compiled, version);
    try {
      await AsyncStorage.setItem(CACHE_KEY, JSON.stringify(fresh));
    } catch (e) {
      // Still usable for this session; next sync just refetches.
      console.warn('rulesetStore: failed to persist ruleset cache:', e instanceof Error ? e.message : e);
    }
    logRulesetEvent('ruleset_fetch_succeeded', {
      version,
      rules: fresh.rules.length,
      aliases: fresh.aliases.length,
      previous_cached_version: cached?.version ?? null,
      mode: REMOTE_RULESET_MODE,
    });
    return { source: 'remote-fresh', version };
  } catch (e) {
    return fallBack(e instanceof Error ? e.message : String(e));
  }
}

/** Shadow mode only: upload a summary of bundled-vs-remote differences
 * seen during the parse run that just finished. No-op otherwise. */
export async function flushShadowReport(): Promise<void> {
  if (REMOTE_RULESET_MODE !== 'shadow') return;
  const report = takeShadowReport();
  if (report.compared === 0) return;
  if (report.mismatch_count > 0 || report.remote_errors > 0) {
    console.warn(`rulesetStore: shadow run — ${report.mismatch_count}/${report.compared} mismatches, ${report.remote_errors} remote errors`);
  }
  logRulesetEvent('ruleset_shadow_compare', report as unknown as Record<string, unknown>);
}