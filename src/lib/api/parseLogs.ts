/**
 * src/lib/api/parseLogs.ts
 *
 * Uploads Log A (haiku candidates) and Log B (confidence-gate flags) —
 * see smsParser.ts's ParseLogs/HaikuCandidateLogEntry/LowConfidenceLogEntry
 * for what these mean and why they're kept separate.
 *
 * DELIBERATELY separate from ingestParsedMessages() (lib/api/transactions.ts,
 * not shared, referenced here only by name) — a failure in log upload must
 * never affect whether real transactions sync. Every call in here is
 * wrapped so this file can only ever return a result object; it never
 * throws out to the caller. Call this AFTER the real sync succeeds (or in
 * parallel, in its own try/catch) — never in a place where its failure
 * could block or roll back the real thing.
 *
 * NOT ADDRESSED HERE (see migrations/parse_logs.sql for the same note):
 * transactions.raw_text gets AES-256 encrypted before insert somewhere
 * inside ingestParsedMessages(), which hasn't been shared. raw_text here
 * is sent as plain text. Flag, don't guess — apply the same treatment
 * before this goes beyond your own test device.
 */
import { supabase } from '@/lib/supabase';
import type { ParseLogs } from '@/lib/smsParser';

export interface ParseLogSyncResult {
  haikuCandidatesInserted: number;
  lowConfidenceInserted:   number;
  errors: string[];
}

const EMPTY_RESULT: ParseLogSyncResult = {
  haikuCandidatesInserted: 0,
  lowConfidenceInserted:   0,
  errors: [],
};

export async function syncParseLogs(logs: ParseLogs): Promise<ParseLogSyncResult> {
  if (logs.haikuCandidates.length === 0 && logs.lowConfidence.length === 0) {
    return { ...EMPTY_RESULT };
  }

  const result: ParseLogSyncResult = { haikuCandidatesInserted: 0, lowConfidenceInserted: 0, errors: [] };

  // [FIX-shaped note, matching the existing convention in test-sms.tsx's
  // matchContext fetch] If we can't resolve the current user, degrade to
  // "log sync silently skipped" — never throw, never block the caller.
  let userId: string;
  try {
    const { data, error } = await supabase.auth.getUser();
    if (error || !data?.user) {
      result.errors.push('syncParseLogs: no authenticated user — skipped');
      return result;
    }
    userId = data.user.id;
  } catch (e: any) {
    result.errors.push(`syncParseLogs: auth lookup failed — ${e?.message ?? e}`);
    return result;
  }

  if (logs.haikuCandidates.length > 0) {
    try {
      const rows = logs.haikuCandidates.map(e => ({
        user_id:              userId,
        raw_sms_id:           e.raw_sms_id,
        raw_text:             e.raw_text,
        txn_date:             e.txn_date,
        reason:               e.reason,
        extracted_amount:     e.extracted_amount,
        extracted_is_credit:  e.extracted_is_credit,
        extracted_merchant:   e.extracted_merchant,
        extracted_bank:       e.extracted_bank,
        extracted_channel:    e.extracted_channel,
        logged_at:            e.logged_at,
      }));
      // [CHANGED] Identity key is (user_id, raw_sms_id, raw_text, reason) —
      // NOT raw_sms_id alone. Mirrors transactions.ts's
      // findGenuineResyncMatch(): raw_sms_id alone is unsafe because
      // Android can reuse a deleted message's ID for an unrelated new
      // message. Requiring the exact raw_text too means that case is
      // correctly treated as a new message, not silently skipped.
      // Still ignoreDuplicates (skip, don't update) — Log A is an
      // append-only history of "this was a Haiku candidate," which stays
      // true even after a fix, so a stale row here isn't misleading the
      // way a stale Log B row would be.
      const { error } = await supabase
        .from('haiku_candidate_log')
        .upsert(rows, { onConflict: 'user_id,raw_sms_id,raw_text,reason', ignoreDuplicates: true });
      if (error) {
        result.errors.push(`haiku_candidate_log: ${error.message}`);
      } else {
        result.haikuCandidatesInserted = rows.length;
      }
    } catch (e: any) {
      result.errors.push(`haiku_candidate_log: ${e?.message ?? e}`);
    }
  }

  if (logs.lowConfidence.length > 0) {
    try {
      const rows = logs.lowConfidence.map(e => ({
        user_id:                  userId,
        raw_sms_id:               e.raw_sms_id,
        raw_text:                 e.raw_text,
        txn_date:                 e.txn_date,
        matched_rule:             e.matched_rule,
        l2_bank:                  e.l2_bank,
        l2_merchant:              e.l2_merchant,
        l2_amount:                e.l2_amount,
        l2_direction:             e.l2_direction,
        confidence_gate_reasons:  e.confidence_gate_reasons,
        logged_at:                e.logged_at,
      }));
      // [CHANGED] Identity key is (user_id, raw_sms_id, raw_text) — same
      // reasoning as Log A above. UNLIKE Log A, this is a real
      // upsert-with-update (ignoreDuplicates left false/default): if a
      // ruleset or confidence-gate fix changes what this exact message
      // gets flagged for, the row should reflect the CURRENT
      // classification, not the stale one from before the fix. Log A
      // stays append-only on purpose (see its own comment); Log B does
      // not, because "is this still low-confidence" is the whole point of
      // this table and a stale answer here is actively misleading.
      const { error } = await supabase
        .from('low_confidence_log')
        .upsert(rows, { onConflict: 'user_id,raw_sms_id,raw_text' });
      if (error) {
        result.errors.push(`low_confidence_log: ${error.message}`);
      } else {
        result.lowConfidenceInserted = rows.length;
      }
    } catch (e: any) {
      result.errors.push(`low_confidence_log: ${e?.message ?? e}`);
    }
  }

  return result;
}