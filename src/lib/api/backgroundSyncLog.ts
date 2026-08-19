/**
 * src/lib/api/backgroundSyncLog.ts
 * Location: apps/mobile/src/lib/api/backgroundSyncLog.ts (new)
 *
 * Writes a durable record of background-sync-task activity to Supabase,
 * so "is the OS actually running the hourly task?" can be answered by a
 * query instead of a guess. Nothing about this file's success or failure
 * is allowed to affect the actual sync — see the catch block below.
 *
 * ASSUMPTION: imports `supabase` from '@/lib/supabase', matching what
 * looked like this project's convention. Adjust the import if your
 * client lives somewhere else.
 */
import { supabase } from '@/lib/supabase';

export type BackgroundSyncEvent =
  | 'task_invoked'        // the OS called the task body — the actual answer to "is it running"
  | 'task_succeeded'      // ran, found and inserted new data
  | 'task_no_data'        // ran cleanly, nothing new (normal, common case)
  | 'task_failed'         // ran, threw
  | 'registration_succeeded'
  | 'registration_failed';

export async function logBackgroundSyncEvent(
  event: BackgroundSyncEvent,
  details?: Record<string, unknown>
): Promise<void> {
  try {
    const {
      data: { session },
    } = await supabase.auth.getSession();

    await supabase.from('background_sync_log').insert({
      user_id: session?.user?.id ?? null,
      event,
      details: details ?? null,
    });
  } catch (e) {
    // Deliberately swallowed — but unlike the low_confidence_log bug
    // from last session, this one is *supposed* to be silent: if the
    // logging write itself fails (offline, RLS, whatever), that must
    // never block or crash the real sync it's trying to observe.
    console.warn('logBackgroundSyncEvent failed:', e instanceof Error ? e.message : e);
  }
}