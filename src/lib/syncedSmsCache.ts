/**
 * src/lib/syncedSmsCache.ts
 *
 * Device-local cache of SMS raw_sms_id values already successfully synced
 * to Supabase for the current user. Purpose: let ingestParsedMessages()
 * skip already-synced messages BEFORE they ever reach insertTransaction(),
 * so a crash/force-close mid-sync followed by a retry doesn't re-insert
 * and re-flag everything that already went through.
 *
 * DELIBERATELY device-local, not a new `transactions.raw_sms_id` column —
 * see the discussion this was built from. What that choice buys and costs:
 *   - Survives: app close, force-close, background-kill, "Clear Cache"
 *     (AsyncStorage is its own storage area, NOT the OS cache directory
 *     that "Clear Cache" wipes).
 *   - Does NOT survive: "Clear Data", uninstall/reinstall, or a second
 *     device. Accepted gap — these are rare, deliberate user actions, not
 *     something a crash can trigger. If ever hit, nothing breaks: the
 *     existing server-side checks (findExistingTransactionForSms,
 *     findDuplicateCandidate) still protect correctness exactly as they
 *     did before this cache existed. Worst case is some already-synced
 *     messages get re-flagged for manual dismissal once — not silent
 *     duplication, not data loss.
 *   - This cache is PURELY a client-side optimization to avoid attempting
 *     an insert at all for messages this device already knows it sent. It
 *     is never the source of truth for "is this a duplicate" and never
 *     replaces the server-side checks, which keep running unchanged for
 *     anything not found in this cache.
 *
 * Scoped per-user (keyed by userId) so switching accounts on the same
 * device never leaks one user's synced-IDs into another's, and never
 * blocks a different user's sync.
 *
 * Known limitation, not addressed here: this list only ever grows. For
 * this app's actual volumes (a one-time backlog sync, then small
 * increments) that's not a practical problem any time soon, but if this
 * ever needs pruning, prune by dropping IDs whose txn_date is older than
 * some retention window — not addressed now (YAGNI).
 */
import AsyncStorage from '@react-native-async-storage/async-storage';

function storageKey(userId: string): string {
  return `synced_sms_ids:${userId}`;
}

export async function getSyncedSmsIds(userId: string): Promise<Set<string>> {
  try {
    const raw = await AsyncStorage.getItem(storageKey(userId));
    if (!raw) return new Set();
    const parsed = JSON.parse(raw);
    return new Set(Array.isArray(parsed) ? parsed : []);
  } catch (e) {
    // A corrupt/unreadable cache degrades to "acts like before this
    // feature existed" (empty set — full fallback to server-side checks),
    // never throws and never blocks sync.
    console.warn('getSyncedSmsIds: failed to read cache, treating as empty:', e);
    return new Set();
  }
}

export async function markSmsIdsSynced(userId: string, ids: string[]): Promise<void> {
  if (ids.length === 0) return;
  try {
    const existing = await getSyncedSmsIds(userId);
    for (const id of ids) existing.add(id);
    await AsyncStorage.setItem(storageKey(userId), JSON.stringify([...existing]));
  } catch (e) {
    // Best-effort — a failed write here doesn't affect whether this run's
    // inserts actually succeeded (that already happened before this is
    // called). It only means this run's crash-protection doesn't persist;
    // next sync falls back to the server-side checks for these IDs, same
    // as if this cache didn't exist.
    console.warn('markSmsIdsSynced: failed to persist cache:', e);
  }
}