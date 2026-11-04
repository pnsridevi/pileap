/**
 * src/lib/api/backgroundSyncLog.ts
 * Location: apps/mobile/src/lib/api/backgroundSyncLog.ts
 *
 * Writes a durable record of background-sync-task activity to Supabase,
 * so "is the OS actually running the hourly task?" can be answered by a
 * query instead of a guess. Nothing about this file's success or failure
 * is allowed to affect the actual sync — see the catch blocks below.
 *
 * [CHANGE — Nov 4]
 *   1. Supabase's insert() doesn't throw when the server rejects a row; it
 *      returns { error }. That error is now checked and printed, so a
 *      rejected log row no longer disappears without a trace.
 *   2. flushListenerEvents(): uploads the SMS listener events that
 *      the native receiver/job recorded on the phone (they can't write to
 *      Supabase themselves). Each event keeps its original time in
 *      details.at; created_at is the upload time.
 */
import { supabase } from '@/lib/supabase';
import { SmsReader } from '../../../modules/sms-reader/src/index';

export type BackgroundSyncEvent =
  | 'task_invoked'        // the OS called the task body — the actual answer to "is it running"
  | 'task_succeeded'      // ran, found and inserted new data
  | 'task_no_data'        // ran cleanly, nothing new (normal, common case)
  | 'task_failed'         // ran, threw
  | 'registration_succeeded'
  | 'registration_failed'
  // [ADD — Nov 4] SMS listener (JS side; the native side's events —
  // listener_sms_received, listener_job_started, listener_job_finished,
  // listener_error — arrive through flushListenerEvents())
  | 'listener_permission'
  | 'listener_sync_invoked'
  | 'listener_sync_succeeded'
  | 'listener_sync_no_data'
  | 'listener_sync_failed'
  // [ADD — Nov 4] haiku_candidate_log / low_confidence_log upload problems
  // (written from smsSync.ts after every sync, whatever triggered it)
  | 'parse_logs_failed';

export async function logBackgroundSyncEvent(
  event: BackgroundSyncEvent,
  details?: Record<string, unknown>
): Promise<void> {
  try {
    const {
      data: { session },
    } = await supabase.auth.getSession();

    const { error } = await supabase.from('background_sync_log').insert({
      user_id: session?.user?.id ?? null,
      event,
      details: details ?? null,
    });
    if (error) console.warn('logBackgroundSyncEvent rejected:', error.message);
  } catch (e) {
    // Deliberately swallowed: if the logging write itself fails (offline,
    // RLS, whatever), that must never block or crash the real sync it's
    // trying to observe.
    console.warn('logBackgroundSyncEvent failed:', e instanceof Error ? e.message : e);
  }
}

interface StoredListenerEvent {
  event: string;
  at: number; // epoch ms, when it happened on the phone
  details: Record<string, unknown>;
}

/**
 * [ADD — Nov 4] Uploads the SMS listener events stored on the phone, then
 * removes only the ones that were uploaded. Safe to call often; does
 * nothing when the list is empty. Never throws.
 */
export async function flushListenerEvents(): Promise<void> {
  try {
    const raw = await SmsReader.peekListenerEvents();
    const events = JSON.parse(raw || '[]') as StoredListenerEvent[];
    if (!Array.isArray(events) || events.length === 0) return;

    const {
      data: { session },
    } = await supabase.auth.getSession();

    const rows = events.map((e) => ({
      user_id: session?.user?.id ?? null,
      event: e.event,
      details: { ...(e.details ?? {}), at: new Date(e.at).toISOString() },
    }));

    const { error } = await supabase.from('background_sync_log').insert(rows);
    if (error) {
      console.warn('flushListenerEvents rejected:', error.message);
      return; // keep them on the phone and try again next time
    }

    await SmsReader.clearListenerEvents(events.length);
  } catch (e) {
    console.warn('flushListenerEvents failed:', e instanceof Error ? e.message : e);
  }
}
