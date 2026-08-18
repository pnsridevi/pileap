/**
 * src/lib/syncedSmsCache.ts
 *
 * Device-local cache of already-synced SMS, keyed by a composite of
 * raw_sms_id + a hash of the message's own text (see buildSyncedSmsCacheKey
 * below) rather than raw_sms_id alone — a bare ID isn't a stable identity
 * for a message, since the OS can recycle a deleted message's ID for an
 * unrelated new one. Purpose: let ingestParsedMessages() skip already-
 * synced messages BEFORE they ever reach insertTransaction(), so a
 * crash/force-close mid-sync followed by a retry doesn't re-insert and
 * re-flag everything that already went through.
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

// [ADD] Small deterministic string hash (FNV-1a, 32-bit) — not a security
// primitive, just enough entropy that two genuinely different message
// bodies essentially never collide. Kept short (base-36) so composite keys
// don't meaningfully bloat storage size vs. the bare-ID keys this replaces.
function hashText(text: string): string {
  let hash = 0x811c9dc5; // FNV-1a 32-bit offset basis
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193); // FNV-1a 32-bit prime
  }
  return (hash >>> 0).toString(36);
}

// [ADD] raw_sms_id alone is not a stable identity for a message — Android's
// SMS content provider _id is not documented as permanently non-reusable,
// so a deleted message's ID can be recycled for an unrelated new message.
// Pairing the ID with a hash of the message's own text means a reused ID
// only matches the cache if the text also matches — the same safety
// property transactions.ts's findGenuineResyncMatch() already relies on
// server-side (raw_sms_id AND raw_text), applied locally too so the local
// pre-filter can no longer wrongly hide a genuinely new message from that
// server-side check before it ever runs.
//
// BalanceUpdate items have no raw_text field to hash (see smsParser.ts) —
// for those, this falls back to the ID alone, same behavior as before this
// fix. That's an accepted, narrower gap than the one being closed here: a
// wrongly-skipped balance disclosure delays a balance refresh, not a lost
// transaction.
export function buildSyncedSmsCacheKey(rawSmsId: string, rawText?: string | null): string {
  return rawText ? `${rawSmsId}:${hashText(rawText)}` : rawSmsId;
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