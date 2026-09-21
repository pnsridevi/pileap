/**
 * src/lib/services/smsSync.ts
 * Location: apps/mobile/src/lib/services/smsSync.ts
 *
 * Single, reusable implementation of "read device SMS in a date window,
 * parse them, write the results to Supabase." This is for the real,
 * non-debug callers: the on-app-open hook and the hourly background
 * task (wired up in app/(app)/_layout.tsx and backgroundSync.ts).
 * sync.tsx's "Debug Tools" section keeps its own independent copy of
 * this sequence, unchanged, for manual parser tuning.
 *
 * [UPDATE — this pass] Two changes:
 *
 *   1. Persisted "last synced" watermark (AsyncStorage, per user_id) —
 *      does NOT replace the existing dedup (ingestParsedMessages()'s
 *      syncedSmsCache check + server-side genuine-resync check are still
 *      what make re-scanning an overlapping window SAFE). The watermark
 *      exists purely to make automatic syncs CHEAP — an hourly tick only
 *      scans back to (lastSyncedAt - a safety buffer) instead of a full
 *      90 days every time. Falls back to 90 days on first run or after a
 *      long gap.
 *
 *   2. [FIX — closes an open item from the original file] The automatic
 *      path now has full parity with the debug flow's parse pipeline,
 *      which it previously did NOT have:
 *        - Fetches registeredFacts + customCategories and builds
 *          matchContext, same as fetchParsed() in the debug flow — this
 *          is what lets `resolvedFrom` get set to 'custom_category' /
 *          'registered_fact' during parsing.
 *        - Calls SmsReader.getLayer1Candidates() and logs them via
 *          logLayer1Candidates(), same as the debug flow.
 *        - Passes matchContext AND the logs object into
 *          parseSmsMessages(msgs, matchContext, logs) — without this,
 *          low-confidence parses were silently never logged at all on
 *          the automatic path.
 *        - Calls syncParseLogs(logs) after ingest, so haiku_candidate_log
 *          / low_confidence_log actually receive rows from automatic
 *          syncs, not just from manual Debug Tools runs.
 *      Every one of these mirrors the debug flow's own error handling:
 *      registeredFacts/customCategories fetch failures fall back to an
 *      empty matchContext (parsing still proceeds); Layer 1 candidate
 *      fetch failures are logged and swallowed; syncParseLogs failures
 *      are logged and swallowed. None of this logging machinery is
 *      allowed to fail the actual transaction sync, since this function
 *      runs unattended (background task, app-open effect) with no user
 *      watching to retry.
 *
 * The buffer (SAFETY_BUFFER_DAYS) exists because "days ago" here is a
 * whole-number day window, not a precise timestamp — a day or two of
 * overlap costs almost nothing (dedup discards it) and removes any risk
 * of missing an SMS that landed right at the boundary.
 *
 * [UPDATE — this pass, resilience] Two more gaps closed, found by tracing
 * through force-close / crash / concurrent-trigger scenarios against the
 * real code — not just this file: ingestParsedMessages() in
 * transactions.ts already commits its synced-ID cache after every chunk,
 * so a crash mid-ingest was already safe; these two are about the layer
 * ABOVE that, which wasn't:
 *
 *   3. Concurrency lock. Nothing stopped two calls to
 *      syncRecentSmsMessages() from running at once — e.g. the hourly
 *      background task firing at the exact moment the user is on the
 *      Sync screen and taps "Sync Now," or (on Android) the background
 *      task's own JS context overlapping briefly with the foreground
 *      app's. Two concurrent runs reading the same SMS window can each
 *      pass the OTHER's not-yet-committed dedup check before either has
 *      finished — a real race, not just a theoretical one, since each
 *      await point in the parse/ingest chain is a place the two runs can
 *      interleave. Added an AsyncStorage-based lock, scoped per user,
 *      that a second concurrent call respects by returning immediately
 *      instead of racing. The lock has a staleness timeout
 *      (LOCK_STALE_MS) specifically so a force-close or crash that
 *      leaves the lock file behind can't wedge every future sync
 *      forever — after the timeout, the next run treats a stale lock as
 *      abandoned and proceeds.
 *
 *   4. First-run backfill deferred from the background task. The FIRST
 *      sync ever (no watermark yet) scans the full 90-day window, which
 *      on a real inbox (500+ messages in this app's own test data) can
 *      take longer than the OS's background-task execution budget
 *      (iOS: seconds; Android via WorkManager: bounded but still
 *      finite). If the background task gets killed mid-way through a
 *      90-day first sync, that's not silently unsafe (same crash-safety
 *      as any other interruption — see above), but it wastes the task's
 *      limited execution window on partial progress. The on-app-open
 *      path has no such time limit (it runs in the live foreground app),
 *      so it's the right place for that first heavy sync. The background
 *      task now passes `allowFullBackfill: false` — if it wakes up and
 *      finds no watermark yet, it no-ops rather than attempting a 90-day
 *      scan, and leaves that first sync for the next time the user opens
 *      the app.
 */
import AsyncStorage from '@react-native-async-storage/async-storage';
import { SmsReader } from '../../../modules/sms-reader/src/index';
import {
  parseSmsMessages, logLayer1Candidates,
  type ParsedTransaction, type BalanceUpdate, type MatchContext, type ParseLogs,
} from '@/lib/smsParser';
import { ingestParsedMessages, type IngestResult } from '@/lib/api/transactions';
import { fetchActiveRegisteredFacts } from '@/lib/api/registeredFacts';
import { fetchCustomCategories } from '@/lib/api/customCategories';
import { syncParseLogs } from '@/lib/api/parseLogs';
import { supabase } from '@/lib/supabase';

// [ADD — this pass] Staged progress reporting, replacing the flat
// (processed, total) callback from the previous pass. A bare chunk
// counter during a long first sync (500+ messages) reads as cold and
// unexplained — "why is a number going up slowly." Splitting the run
// into named stages lets the UI narrate what's actually happening
// ("Reading your messages…" -> "Found 312, checking for
// transactions…" -> "Saving 47 transactions…"), which is a meaningfully
// different, more reassuring experience for the same underlying work.
export type SyncStage = 'reading' | 'parsing' | 'saving';
export interface SyncProgressUpdate {
  stage: SyncStage;
  /** Total messages read from the device — set once the 'parsing' stage
   * begins, present on every update from then on. */
  messagesScanned?: number;
  /** Chunk-level insert progress — only present during the 'saving'
   * stage (mirrors ingestParsedMessages()'s own onProgress signature
   * one level up). */
  processed?: number;
  total?: number;
}
export type SyncProgressListener = (update: SyncProgressUpdate) => void;

// [ADD — this pass] Module-level sync-status signal. Exists because the
// Sync screen previously only knew about a sync IT triggered
// (manualSyncing local state) — it had no way to know a sync was already
// running because the root layout's app-open effect or the hourly
// background task kicked one off. A user opening the app and immediately
// tapping "Sync Now" would just get "already running, try again" with no
// warning beforehand. This is a plain module-level pub/sub, not a zustand
// store — deliberately minimal, scoped to exactly this one boolean, so it
// doesn't require introducing a new store just for this.
type SyncStatusListener = (syncing: boolean) => void;
const syncStatusListeners = new Set<SyncStatusListener>();
let syncInProgress = false;

function setSyncInProgress(value: boolean): void {
  syncInProgress = value;
  syncStatusListeners.forEach((l) => l(value));
}

/** Current sync-in-progress state, read synchronously — for an initial
 * render before the first pub/sub event arrives. */
export function isSyncInProgress(): boolean {
  return syncInProgress;
}

/** Subscribes to sync start/stop events from ANY caller of
 * syncSmsMessages() — app-open, background task, or a manual "Sync Now"
 * tap, regardless of which screen or code path triggered it. Fires
 * immediately with the current state on subscribe, then on every change.
 * Returns an unsubscribe function. */
export function subscribeSyncStatus(listener: SyncStatusListener): () => void {
  syncStatusListeners.add(listener);
  listener(syncInProgress);
  return () => syncStatusListeners.delete(listener);
}

export interface SmsSyncResult extends IngestResult {
  /** Total messages read from the device for this window, before Layer 0/1
   * filtering and parsing. */
  messagesScanned: number;
  /** True if this call returned immediately because another sync was
   * already in progress (see the concurrency-lock note above). All other
   * fields are zeroed/empty when this is true — no work was attempted. */
  skippedConcurrentSync?: boolean;
  /** True if this call returned immediately because it's a background-task
   * invocation hitting a first-ever sync (no watermark yet) — deferred to
   * the next on-app-open sync instead of risking a background-execution
   * timeout partway through a full 90-day scan. */
  skippedDeferredFirstSync?: boolean;
  /** [ADD] The arrival timestamp (device SMS date, not sync-completion
   * time) of the newest message that was actually, successfully synced
   * this run — excludes any message whose raw_sms_id appears in
   * ingestResult.errors. null if nothing was successfully synced (empty
   * window, or every item in the window failed). syncRecentSmsMessages()
   * uses this to set a precise watermark instead of "now" — see there for
   * why a failed message must never be allowed to advance it. */
  newestSyncedMessageDate: Date | null;
}

const FULL_WINDOW_DAYS = 90;
const SAFETY_BUFFER_DAYS = 2;
const WATERMARK_KEY_PREFIX = 'pileap:lastSyncedAt:';
// [ADD] Separate from WATERMARK_KEY_PREFIX above. That key is now purely
// an internal scan-sizing input (see the split below) — precise to the
// newest message's real arrival time, capped so it never advances past a
// failed message. This key is purely for what the UI shows as "Last
// synced": the wall-clock moment a sync attempt last actually completed,
// regardless of whether it found anything new. These need to be
// different values — see getLastSyncedAt()'s docblock for why conflating
// them (the original design, and this file's own earlier pass) breaks
// the UI whenever a completed sync finds zero new messages.
const LAST_SYNC_DISPLAY_KEY_PREFIX = 'pileap:lastSyncDisplayAt:';
// [ADD] Separate from LAST_SYNC_DISPLAY_KEY_PREFIX (a timestamp) — this
// holds the actual outcome (counts) of the most recent successfully
// completed sync, regardless of which caller triggered it. Written at the
// same point as setLastSyncDisplayTime(), inside syncRecentSmsMessages()
// itself, so every caller (manual "Sync Now", the hourly background task,
// the on-app-open effect) gets this for free without each needing its own
// plumbing. Exists because the Sync screen's status card previously only
// ever showed a result from a sync IT triggered (manualSyncResult) — a
// transaction synced by the background/on-open path showed nothing until
// the user manually pressed Sync Now, at which point it correctly (but
// confusingly) showed 0 new, since there was nothing left for that manual
// run to find. See getLastSyncResult() below for the read side.
const LAST_SYNC_RESULT_KEY_PREFIX = 'pileap:lastSyncResult:';
const LOCK_KEY_PREFIX = 'pileap:syncLock:';
// Generous on purpose — a full 90-day/500+-message first sync (foreground,
// no OS time limit) should never realistically take this long, but the
// cost of the timeout being slightly too generous (a legitimately-stuck
// run blocks new syncs a few minutes longer) is far smaller than the cost
// of it being too tight (two runs racing and double-processing).
const LOCK_STALE_MS = 5 * 60 * 1000;

const EMPTY_RESULT: SmsSyncResult = {
  transactionsInserted: 0, balancesUpdated: 0, duplicatesSkipped: 0,
  duplicatesFlagged: 0, skippedBeforeLastSync: 0, skippedAlreadySynced: 0,
  recoveredViaServerCheck: 0, errors: [], messagesScanned: 0,
  newestSyncedMessageDate: null,
};

// [FIX] Was supabase.auth.getUser() — that call always makes a network
// round-trip to Supabase's auth server to revalidate the token, even
// though the result is only ever used to tag a sync/watermark with a
// user_id, not to make an authorization decision (RLS on the server
// enforces real access control regardless). Android restricts background
// network access outside Doze maintenance windows, so this call can hang
// well past the background task's execution budget when invoked from
// backgroundSync.ts — the task then gets killed by the OS before it ever
// reaches a logBackgroundSyncEvent('task_succeeded'/'task_failed') call,
// which matches the observed symptom exactly: 'task_invoked' logs (that
// one happens before this function is ever called), then nothing further.
// getSession() reads the already-cached session from local storage, no
// network required — the same call backgroundSyncLog.ts's own auth check
// already uses successfully in this exact background context. This is
// called at the very top of every sync (foreground and background), so
// this also removes an unnecessary network hit from every manual/on-open
// sync too, not just the background path.
async function getCurrentUserIdOrNull(): Promise<string | null> {
  const { data: { session } } = await supabase.auth.getSession();
  return session?.user?.id ?? null;
}

/** [FIX] Was reading/writing the same key syncRecentSmsMessages() uses to
 * size the next scan window — see LAST_SYNC_DISPLAY_KEY_PREFIX's comment
 * above for why that broke the UI. Now purely display: the wall-clock
 * time a sync attempt last actually completed, for the Sync screen's
 * status card. Not used for any scan-window math — see
 * getScanWatermark()/setScanWatermark() below for that. */
export async function getLastSyncedAt(): Promise<Date | null> {
  const userId = await getCurrentUserIdOrNull();
  if (!userId) return null;
  const raw = await AsyncStorage.getItem(LAST_SYNC_DISPLAY_KEY_PREFIX + userId);
  return raw ? new Date(raw) : null;
}

async function setLastSyncDisplayTime(userId: string, when: Date): Promise<void> {
  await AsyncStorage.setItem(LAST_SYNC_DISPLAY_KEY_PREFIX + userId, when.toISOString());
}

/** [ADD] Read side of LAST_SYNC_RESULT_KEY_PREFIX — see its own comment
 * above for the full "why". Returns null if no sync has ever completed on
 * this device for this user (fresh install, or storage cleared), same
 * "degrade to empty/null, never throw" convention as getSyncedSmsIds()
 * elsewhere in this file. Callers should treat null as "no sync yet,"
 * not as an error. */
export async function getLastSyncResult(): Promise<{ transactionsInserted: number; balancesUpdated: number; at: Date } | null> {
  const userId = await getCurrentUserIdOrNull();
  if (!userId) return null;
  try {
    const raw = await AsyncStorage.getItem(LAST_SYNC_RESULT_KEY_PREFIX + userId);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (typeof parsed?.transactionsInserted !== 'number' || typeof parsed?.at !== 'string') return null;
    return {
      transactionsInserted: parsed.transactionsInserted,
      balancesUpdated: typeof parsed.balancesUpdated === 'number' ? parsed.balancesUpdated : 0,
      at: new Date(parsed.at),
    };
  } catch (e) {
    console.warn('getLastSyncResult: failed to read, treating as none:', e);
    return null;
  }
}

async function setLastSyncResult(userId: string, result: SmsSyncResult): Promise<void> {
  try {
    await AsyncStorage.setItem(
      LAST_SYNC_RESULT_KEY_PREFIX + userId,
      JSON.stringify({
        transactionsInserted: result.transactionsInserted,
        balancesUpdated: result.balancesUpdated,
        at: new Date().toISOString(),
      }),
    );
  } catch (e) {
    // Best-effort, same reasoning as markSmsIdsSynced() in
    // syncedSmsCache.ts — a failed write here only means the status
    // card falls back to its "no sync yet" placeholder next read, never
    // affects whether the real sync succeeded.
    console.warn('setLastSyncResult: failed to persist, status card will fall back:', e);
  }
}

/** [ADD] Internal only — not read by the UI. Sizes the next sync's scan
 * window (see syncRecentSmsMessages()'s fromDays calculation). Precise to
 * the newest successfully-synced message's real arrival time, and never
 * advances past a run where every scanned message failed — see
 * syncRecentSmsMessages() for the full reasoning on both of those. */
async function getScanWatermark(): Promise<Date | null> {
  const userId = await getCurrentUserIdOrNull();
  if (!userId) return null;
  const raw = await AsyncStorage.getItem(WATERMARK_KEY_PREFIX + userId);
  return raw ? new Date(raw) : null;
}

async function setScanWatermark(userId: string, when: Date): Promise<void> {
  await AsyncStorage.setItem(WATERMARK_KEY_PREFIX + userId, when.toISOString());
}

/** Attempts to acquire the per-user sync lock. Returns true if acquired
 * (caller must releaseLock() when done, ideally in a finally block).
 * Returns false if another sync genuinely appears to be in progress
 * (lock exists and isn't stale yet) — caller should back off, not retry
 * in a loop, since the other run will finish on its own. A stale lock
 * (older than LOCK_STALE_MS — left behind by a force-close/crash that
 * never reached releaseLock()) is treated as abandoned and overwritten. */
async function acquireLock(userId: string): Promise<boolean> {
  const key = LOCK_KEY_PREFIX + userId;
  try {
    const existing = await AsyncStorage.getItem(key);
    if (existing) {
      const lockedAt = Number(existing);
      if (!Number.isNaN(lockedAt) && Date.now() - lockedAt < LOCK_STALE_MS) {
        return false; // genuinely in progress elsewhere
      }
      // stale — previous run never released it (crash/force-close mid-sync)
    }
    await AsyncStorage.setItem(key, String(Date.now()));
    return true;
  } catch (e) {
    // A lock we can't read/write is a lock we can't trust — fail OPEN
    // (proceed without it) rather than permanently blocking sync because
    // of an unrelated AsyncStorage problem. Worst case without a working
    // lock is the same race this lock exists to reduce, not a new one.
    console.warn('smsSync: sync lock read/write failed, proceeding without it:', e instanceof Error ? e.message : e);
    return true;
  }
}

async function releaseLock(userId: string): Promise<void> {
  try {
    await AsyncStorage.removeItem(LOCK_KEY_PREFIX + userId);
  } catch (e) {
    // Non-fatal — worst case the next run sees a stale lock and waits out
    // LOCK_STALE_MS before proceeding, same as any other abandoned lock.
    console.warn('smsSync: failed to release sync lock:', e instanceof Error ? e.message : e);
  }
}

/** Same fallback-on-failure behavior as the debug flow's fetchParsed():
 * a matchContext fetch failure should not block parsing/syncing, it
 * just means this run parses without custom-category/registered-fact
 * resolution. */
async function buildMatchContext(): Promise<MatchContext> {
  try {
    const [registeredFacts, customCategories] = await Promise.all([
      fetchActiveRegisteredFacts(),
      fetchCustomCategories(),
    ]);
    return { registeredFacts, customCategories };
  } catch (e) {
    console.warn('smsSync: registered_facts/custom_categories fetch failed — parsing without match context:', e instanceof Error ? e.message : e);
    return {};
  }
}

/** Same fallback-on-failure behavior as the debug flow: a Layer 1
 * candidate fetch failure is logged and swallowed, never blocks the
 * actual parse/sync. */
async function logLayer1(fromDays: number, toDays: number, logs: ParseLogs): Promise<void> {
  try {
    const layer1Candidates = await SmsReader.getLayer1Candidates(fromDays, toDays);
    logLayer1Candidates(layer1Candidates, logs);
  } catch (e) {
    console.warn('smsSync: getLayer1Candidates failed — continuing without Layer 1 candidate logging:', e instanceof Error ? e.message : e);
  }
}

/**
 * Reads device SMS for the given day window, runs the full parse
 * pipeline (with match context + parse-log capture, same as the manual
 * debug flow), writes results to Supabase, and pushes captured logs to
 * haiku_candidate_log / low_confidence_log.
 *
 * @param onProgress Optional — fires at each stage transition (reading ->
 *   parsing -> saving) and on every chunk during the saving stage. See
 *   SyncProgressUpdate's docblock above. Previously only wired up in the
 *   Debug Tools manual sync button as a bare chunk counter; a first-time
 *   90-day/500+-message sync via this path showed nothing but a spinner
 *   for however long it took. The Sync screen's "Sync Now" button now
 *   narrates real stages instead.
 */
export async function syncSmsMessages(
  fromDays: number,
  toDays: number,
  onProgress?: SyncProgressListener,
): Promise<SmsSyncResult> {
  onProgress?.({ stage: 'reading' });
  const msgs = await SmsReader.getMessages(fromDays, toDays);

  onProgress?.({ stage: 'parsing', messagesScanned: msgs.length });

  const logs: ParseLogs = { haikuCandidates: [], lowConfidence: [] };
  await logLayer1(fromDays, toDays, logs);

  const matchContext = await buildMatchContext();

  const results: (ParsedTransaction | BalanceUpdate)[] = parseSmsMessages(msgs, matchContext, logs);
  const ingestResult = await ingestParsedMessages(results, (processed, total) => {
    onProgress?.({ stage: 'saving', messagesScanned: msgs.length, processed, total });
  });

  // Log sync failures never fail the overall sync — same convention as
  // the debug flow's syncToSupabase(), which fires this after the ingest
  // Alert regardless of ingest outcome.
  try {
    await syncParseLogs(logs);
  } catch (e) {
    console.warn('smsSync: syncParseLogs failed:', e instanceof Error ? e.message : e);
  }

  // [ADD] Newest arrival time among messages that were actually,
  // successfully synced this run — used by syncRecentSmsMessages() as a
  // precise watermark instead of "sync finished at". Deliberately excludes
  // anything that shows up in ingestResult.errors: a failed message must
  // never be allowed to push the watermark past itself, or it silently
  // ages out of the next run's scan window without ever having succeeded.
  const failedIds = new Set(ingestResult.errors.map((e) => e.raw_sms_id));
  let newestSyncedMessageDate: Date | null = null;
  for (const msg of msgs) {
    if (failedIds.has(msg.id)) continue;
    if (!newestSyncedMessageDate || msg.date > newestSyncedMessageDate.getTime()) {
      newestSyncedMessageDate = new Date(msg.date);
    }
  }

  return {
    ...ingestResult,
    messagesScanned: msgs.length,
    newestSyncedMessageDate,
  };
}

/**
 * The real automatic-sync entry point — called on app open and from the
 * hourly background task (see backgroundSync.ts). Uses the stored
 * watermark to scan the smallest safe window, falls back to the full
 * 90-day window on first run or after a long gap, and updates the
 * watermark on completion.
 *
 * @param allowFullBackfill Defaults to true (the on-app-open caller's
 *   case). The background task passes false — see the "resilience" note
 *   in this file's header for why a first-ever full-90-day sync should
 *   run in the foreground, not in a time-limited background task.
 * @param onProgress Optional — see syncSmsMessages()'s param doc. Only
 *   meaningful for a caller that's actually watching (the Sync screen's
 *   manual button); the background task and app-open effect both omit it.
 */
export async function syncRecentSmsMessages(
  allowFullBackfill = true,
  onProgress?: SyncProgressListener,
): Promise<SmsSyncResult> {
  const userId = await getCurrentUserIdOrNull();
  if (!userId) {
    // Not signed in — nothing to sync against. Callers (app-open effect,
    // background task) should treat this as a normal no-op, not an error.
    return EMPTY_RESULT;
  }

  const lastSyncedAt = await getScanWatermark();

  if (!lastSyncedAt && !allowFullBackfill) {
    // First-ever sync, called from the background task — defer to the
    // next on-app-open sync rather than risking a background-execution
    // timeout partway through a full 90-day/500+-message first parse.
    return { ...EMPTY_RESULT, skippedDeferredFirstSync: true };
  }

  const acquired = await acquireLock(userId);
  if (!acquired) {
    return { ...EMPTY_RESULT, skippedConcurrentSync: true };
  }

  // [ADD] Sync-status signal — see the pub/sub block near the top of this
  // file. Wraps only the actual work (not the lock/watermark bookkeeping
  // around it), so subscribers see "syncing" for exactly as long as real
  // work is happening.
  setSyncInProgress(true);
  try {
    let fromDays = FULL_WINDOW_DAYS;
    if (lastSyncedAt) {
      const daysSince = Math.ceil((Date.now() - lastSyncedAt.getTime()) / (1000 * 60 * 60 * 24));
      fromDays = Math.min(FULL_WINDOW_DAYS, daysSince + SAFETY_BUFFER_DAYS);
    }

    // Matches SmsReader.getMessages(fromDays, toDays)'s existing
    // convention (0 = today, larger number = further back):
    // {fromDays: 0, toDays: 90} reads "from today back to 90 days ago."
    const result = await syncSmsMessages(0, fromDays, onProgress);

    // Watermark is set only after full completion — deliberately the
    // LAST thing this function does. If anything above throws (crash,
    // force-close, network loss), execution never reaches this line, so
    // the watermark stays at its old value and the NEXT sync naturally
    // re-scans from the last point that actually finished, not from
    // wherever this run happened to die. Combined with
    // ingestParsedMessages()'s per-chunk dedup cache, that overlap is
    // safe to re-process, not just safe to attempt.
    //
    // [FIX] Was `new Date()` — the wall-clock moment THIS FUNCTION
    // finished, not when the newest message actually arrived on the
    // device. result.newestSyncedMessageDate is the real arrival time of
    // the newest message that genuinely succeeded this run (see
    // syncSmsMessages()), which is both more precise and immune to any
    // mismatch between sync-completion time and message arrival time.
    //
    // Two cases where it's null, handled differently:
    //   - Nothing was scanned at all (empty window, already fully caught
    //     up) — safe to advance to now, since there was nothing to lose.
    //   - Something WAS scanned but every single item failed — do NOT
    //     advance the watermark at all. Leave it exactly where it was, so
    //     the next run re-scans this same window instead of silently
    //     treating a fully-failed run as fully-synced.
    if (result.newestSyncedMessageDate) {
      await setScanWatermark(userId, result.newestSyncedMessageDate);
    } else if (result.messagesScanned === 0) {
      await setScanWatermark(userId, new Date());
    }
    // [ADD] Separate from the scan watermark above. Reaching this line
    // means the sync attempt itself completed — didn't crash, wasn't
    // skipped as concurrent/deferred (those return earlier, before this
    // point, and correctly never touch either watermark). That's exactly
    // what "Last synced" should mean to the user: the app successfully
    // checked, whether or not it found anything new to add. Always "now"
    // here — unlike the scan watermark, this one isn't trying to be
    // precise about message arrival time, it's answering a different
    // question ("did a sync just run") that has nothing to do with
    // whether any message happened to be new.
    await setLastSyncDisplayTime(userId, new Date());
    // [ADD] See LAST_SYNC_RESULT_KEY_PREFIX's comment above — persisted
    // here, not in each caller, so the manual button, the background
    // task, and the on-app-open effect all feed the same status card
    // without each needing its own write.
    await setLastSyncResult(userId, result);
    return result;
  } finally {
    await releaseLock(userId);
    setSyncInProgress(false);
  }
}