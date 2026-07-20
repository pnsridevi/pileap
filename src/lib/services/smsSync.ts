/**
 * src/lib/services/smsSync.ts
 * Location: apps/mobile/src/lib/services/smsSync.ts (confirmed)
 *
 * Single, reusable implementation of "read device SMS in a date window,
 * parse them, write the results to Supabase." This is the exact sequence
 * that already exists inside app/(app)/test-sms.tsx's fetchParsed() +
 * syncToSupabase() — but there, it's split across two separately-tapped
 * buttons with nothing forcing the second one, which is how a correctly-
 * parsed transaction (visible in test-sms's local preview) can end up never
 * reaching the `transactions` table at all. See chat history for the
 * pharmacy-transaction case this was diagnosed from.
 *
 * test-sms.tsx is DELIBERATELY NOT MODIFIED in this pass — it keeps calling
 * parseSmsMessages()/ingestParsedMessages() directly, exactly as before, so
 * its existing manual debug flow (parse a window, inspect results, decide
 * whether to sync, see the error list) keeps working unchanged. This file
 * is for the real, non-debug callers that don't exist yet — an app-open
 * hook and a background task — so they call ONE proven implementation
 * instead of a third copy of this sequence.
 *
 * [FIXED] Import path below confirmed against the real repo root
 * (apps/mobile/) via a build error: apps/mobile/src/lib/services/ ->
 * apps/mobile/modules/sms-reader/src/index is 3 levels up (services -> lib
 * -> src -> apps/mobile), not 4. Matches test-sms.tsx's own import
 * ('../../modules/sms-reader/src/index' from apps/mobile/app/(app)/,
 * which is 2 levels up from a shallower location) — same modules/ root,
 * different starting depth.
 */
import { SmsReader } from '../../../modules/sms-reader/src/index';
import { parseSmsMessages, isBalanceUpdate, type ParsedTransaction, type BalanceUpdate } from '@/lib/smsParser';
import { ingestParsedMessages, type IngestResult } from '@/lib/api/transactions';

export interface SmsSyncResult extends IngestResult {
  /** Total messages read from the device for this window, before Layer 0/1
   * filtering and parsing — useful for surfacing "N messages checked, M
   * transactions found" style status, distinct from IngestResult's
   * transaction-level counts. */
  messagesScanned: number;
}

/**
 * Reads device SMS for the given day window, runs the full parse pipeline,
 * and writes every resulting transaction/balance-update to Supabase in one
 * atomic-from-the-caller's-perspective call — no separate "now tap Sync"
 * step required.
 *
 * Mirrors test-sms.tsx's fetchParsed() + syncToSupabase() exactly (same
 * SmsReader.getMessages() call, same parseSmsMessages(), same
 * ingestParsedMessages()) — this is that sequence, not a reimplementation
 * of it, so behavior stays identical to what's already been manually
 * verified via the test-sms screen.
 */
export async function syncSmsMessages(fromDays: number, toDays: number): Promise<SmsSyncResult> {
  const msgs = await SmsReader.getMessages(fromDays, toDays);

  const results: (ParsedTransaction | BalanceUpdate)[] = parseSmsMessages(msgs);

  const ingestResult = await ingestParsedMessages(results);

  return {
    ...ingestResult,
    messagesScanned: msgs.length,
  };
}

/**
 * Convenience wrapper for the "on app open / periodic background tick"
 * case: syncs a rolling recent window rather than requiring the caller to
 * pick explicit fromDays/toDays like the manual test-sms windows do.
 *
 * [FLAG — NOT WIRED UP] Nothing calls this yet. Per the plan discussed:
 *   - app-open trigger: call this from a useEffect in the real root
 *     app/_layout.tsx (not the transactions-tab-scoped _layout.tsx shown so
 *     far) on mount/foreground.
 *   - periodic trigger: register an expo-background-fetch / expo-task-
 *     manager task that calls this on an interval, to actually fulfill
 *     accounts.tsx's existing UI copy ("Parses bank SMS every 30 min and on
 *     app open") — which nothing in the code currently implements.
 *   - Both of the above still re-scan the same fixed window on every call
 *     for now (no last-synced watermark yet) and rely on the existing
 *     duplicate-detection in transactions.ts to keep re-inserts from
 *     creating visible dupes. A real watermark (e.g. stored in
 *     AsyncStorage or a sync_state table) is a separate follow-up, not
 *     done here — flagging so this isn't mistaken for the complete fix.
 */
export async function syncRecentSmsMessages(): Promise<SmsSyncResult> {
  return syncSmsMessages(0, 90);
}