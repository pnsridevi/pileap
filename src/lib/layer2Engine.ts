/**
 * layer2Engine.ts
 * Location: apps/mobile/src/lib/layer2Engine.ts
 *
 * The one place smsParser.ts gets Layer 2's matchMessage() from. Decides,
 * per the EXPO_PUBLIC_REMOTE_RULESET_MODE flag, whether the bundled
 * layer2_ruleset.js or the remote (parse_rules) ruleset answers:
 *
 *   off     (default) bundled only. Remote is never fetched or run.
 *   shadow  bundled answers; remote runs alongside on every message and
 *           any difference is recorded. Zero user-facing effect — this is
 *           the mode for proving parity on real devices.
 *   on      remote answers. Bundled is the fallback whenever no valid
 *           remote ruleset is loaded, or remote throws on a message.
 *
 * Synchronous by design, same as the bundled matchMessage(): all network
 * and cache work happens beforehand in rulesetStore.prepareRemoteRuleset(),
 * which hands a compiled ruleset to setRemoteRuleset(). Until that has
 * run successfully, every mode behaves exactly like 'off'.
 */

// eslint-disable-next-line @typescript-eslint/no-var-requires
const bundled = require('./layer2_ruleset.js');

export type RemoteRulesetMode = 'off' | 'shadow' | 'on';

// Must be a literal process.env.EXPO_PUBLIC_* access so Expo inlines it
// at build time. Set per build profile in eas.json (and .env for local).
const RAW_MODE = process.env.EXPO_PUBLIC_REMOTE_RULESET_MODE;
export const REMOTE_RULESET_MODE: RemoteRulesetMode =
  RAW_MODE === 'on' || RAW_MODE === 'shadow' ? RAW_MODE : 'off';

type MatchFn = (body: string, messageDate: string) => any;

let remote: { matchMessage: MatchFn; version: number } | null = null;

export function setRemoteRuleset(compiled: { matchMessage: MatchFn }, version: number): void {
  remote = { matchMessage: compiled.matchMessage, version };
}

export function clearRemoteRuleset(): void {
  remote = null;
}

export function activeRulesetInfo(): { mode: RemoteRulesetMode; source: 'bundled' | 'remote'; version: number | null } {
  const usingRemote = REMOTE_RULESET_MODE === 'on' && remote !== null;
  return { mode: REMOTE_RULESET_MODE, source: usingRemote ? 'remote' : 'bundled', version: remote?.version ?? null };
}

// ── Shadow bookkeeping ─────────────────────────────────────────────────
// Rule keys and field NAMES only — never message bodies or values, since
// this summary is uploaded to background_sync_log. Bodies go to the dev
// console only (__DEV__), for reproducing a mismatch locally.
export interface ShadowMismatch {
  bundled_rule: string;
  remote_rule: string;
  fields: string[];
}
const MAX_SAMPLES = 50;
let shadowCompared = 0;
let shadowMismatchCount = 0;
let shadowRemoteErrors = 0;
let shadowSamples: ShadowMismatch[] = [];

const ruleOf = (r: any): string => (r == null ? '(no match)' : String(r.matched_rule ?? r.rule ?? '?'));

function diffFields(a: any, b: any): string[] {
  if (a == null || b == null) return ['(whole result)'];
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  const out: string[] = [];
  keys.forEach((k) => { if (JSON.stringify(a[k]) !== JSON.stringify(b[k])) out.push(k); });
  return out;
}

export function takeShadowReport(): {
  version: number | null; compared: number; mismatch_count: number; remote_errors: number; samples: ShadowMismatch[];
} {
  const report = {
    version: remote?.version ?? null,
    compared: shadowCompared,
    mismatch_count: shadowMismatchCount,
    remote_errors: shadowRemoteErrors,
    samples: shadowSamples,
  };
  shadowCompared = 0;
  shadowMismatchCount = 0;
  shadowRemoteErrors = 0;
  shadowSamples = [];
  return report;
}

export function matchMessage(body: string, messageDate: string): any {
  if (REMOTE_RULESET_MODE === 'off' || remote === null) {
    return bundled.matchMessage(body, messageDate);
  }

  if (REMOTE_RULESET_MODE === 'on') {
    try {
      return remote.matchMessage(body, messageDate);
    } catch (e) {
      // Fail safe per message, not per ruleset: this one message falls
      // back to bundled; the next still tries remote.
      console.warn('layer2Engine: remote ruleset threw, using bundled for this message:', e instanceof Error ? e.message : e);
      return bundled.matchMessage(body, messageDate);
    }
  }

  // shadow
  const b = bundled.matchMessage(body, messageDate);
  shadowCompared++;
  try {
    const r = remote.matchMessage(body, messageDate);
    if (JSON.stringify(b) !== JSON.stringify(r)) {
      shadowMismatchCount++;
      const sample = { bundled_rule: ruleOf(b), remote_rule: ruleOf(r), fields: diffFields(b, r) };
      if (shadowSamples.length < MAX_SAMPLES) shadowSamples.push(sample);
      if (__DEV__) console.warn('layer2Engine shadow mismatch', sample, { body, bundled: b, remote: r });
    }
  } catch (e) {
    shadowRemoteErrors++;
    if (__DEV__) console.warn('layer2Engine shadow: remote threw', e, { body });
  }
  return b;
}