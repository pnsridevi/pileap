/**
 * src/lib/services/backgroundSync.ts
 * Location: apps/mobile/src/lib/services/backgroundSync.ts
 *
 * Registers a periodic background task that calls syncRecentSmsMessages().
 * This is the "even when the app isn't open" half of automatic sync — the
 * on-app-open / on-resume half lives in app/(app)/_layout.tsx.
 *
 * [CHANGE — Oct 28] Two fixes for "the hourly sync almost never runs":
 *
 *   1. Migrated from expo-background-fetch (deprecated since SDK 53, built
 *      on old JobScheduler/AlarmManager APIs) to expo-background-task
 *      (Android WorkManager). This project is on SDK 54.
 *
 *   2. This file is now imported from apps/mobile/index.js (the app's
 *      entry point), so TaskManager.defineTask() runs on EVERY JS start,
 *      including background starts with no UI. Before, it was only
 *      imported from app/(app)/_layout.tsx, which never loads in a
 *      background start — so the OS woke the app and found no task.
 *
 *   Task renamed (…-sync -> …-sync-v2): phones that already have the app
 *   still have the OLD task name registered under expo-background-fetch.
 *   With the old name, isTaskRegisteredAsync() would return true and the
 *   new WorkManager registration would be silently skipped. The old name
 *   is unregistered best-effort on first run.
 *
 * Honest limits (unchanged): Android decides when to actually run this.
 * minimumInterval is a minimum, not a schedule — runs can be delayed by
 * battery optimisation, Doze, or manufacturer restrictions
 * (Xiaomi/Oppo/Vivo especially). The on-open and on-resume syncs are what
 * guarantee freshness while the user is using the app.
 *
 * [TESTING] logBackgroundSyncEvent() calls write to background_sync_log so
 * "is the OS running this?" is answerable with a query.
 *
 * Requires:
 *   npx expo install expo-background-task
 *   npm uninstall expo-background-fetch
 * (native change — needs a new EAS build, not just eas update)
 */
import * as TaskManager from 'expo-task-manager';
import * as BackgroundTask from 'expo-background-task';
import { syncRecentSmsMessages } from './smsSync';
// [TESTING]
import { logBackgroundSyncEvent } from '@/lib/api/backgroundSyncLog';

export const BACKGROUND_SYNC_TASK = 'pileap-background-sms-sync-v2';
const OLD_BACKGROUND_SYNC_TASK = 'pileap-background-sms-sync';

// Minutes. expo-background-task takes minutes (not seconds like
// expo-background-fetch did). Android's floor is 15 minutes; 60 is a
// request, not a guarantee.
const MINIMUM_INTERVAL_MINUTES = 60;

// Must be at module scope — see the header for why this file is imported
// from index.js.
TaskManager.defineTask(BACKGROUND_SYNC_TASK, async () => {
  // [TESTING] Logged first, before anything can throw.
  await logBackgroundSyncEvent('task_invoked');

  try {
    // false: never do the heavy first-ever 90-day sync in the background;
    // leave it for the next app open (see smsSync.ts).
    const result = await syncRecentSmsMessages(false);

    if (result.skippedDeferredFirstSync || result.skippedConcurrentSync) {
      // [TESTING]
      await logBackgroundSyncEvent('task_no_data', {
        reason: result.skippedDeferredFirstSync ? 'deferred_first_sync' : 'concurrent_sync',
      });
      return BackgroundTask.BackgroundTaskResult.Success;
    }

    const hadNewData = result.transactionsInserted > 0 || result.balancesUpdated > 0;

    // [TESTING]
    await logBackgroundSyncEvent(hadNewData ? 'task_succeeded' : 'task_no_data', {
      transactionsInserted: result.transactionsInserted,
      balancesUpdated: result.balancesUpdated,
    });

    // expo-background-task only has Success / Failed (no NewData/NoData).
    return BackgroundTask.BackgroundTaskResult.Success;
  } catch (e) {
    // [TESTING]
    await logBackgroundSyncEvent('task_failed', {
      error: e instanceof Error ? e.message : String(e),
    });
    console.warn('Background SMS sync failed:', e instanceof Error ? e.message : e);
    return BackgroundTask.BackgroundTaskResult.Failed;
  }
});

/**
 * Call once on app startup (app/(app)/_layout.tsx). Safe on every launch.
 */
export async function registerBackgroundSyncAsync(): Promise<void> {
  // Best-effort cleanup of the old expo-background-fetch registration.
  try {
    if (await TaskManager.isTaskRegisteredAsync(OLD_BACKGROUND_SYNC_TASK)) {
      await TaskManager.unregisterTaskAsync(OLD_BACKGROUND_SYNC_TASK);
    }
  } catch (e) {
    console.warn('Could not unregister old background task:', e instanceof Error ? e.message : e);
  }

  // If the OS has background tasks restricted for this app, registering
  // won't help — log it so it shows up in background_sync_log.
  try {
    const status = await BackgroundTask.getStatusAsync();
    if (status === BackgroundTask.BackgroundTaskStatus.Restricted) {
      // [TESTING]
      await logBackgroundSyncEvent('registration_failed', { error: 'background tasks restricted by OS' });
      return;
    }
  } catch {
    // Status check is informational only — carry on and try to register.
  }

  const isRegistered = await TaskManager.isTaskRegisteredAsync(BACKGROUND_SYNC_TASK);
  if (isRegistered) return;

  try {
    await BackgroundTask.registerTaskAsync(BACKGROUND_SYNC_TASK, {
      minimumInterval: MINIMUM_INTERVAL_MINUTES,
    });
    // [TESTING]
    await logBackgroundSyncEvent('registration_succeeded', { task: BACKGROUND_SYNC_TASK });
  } catch (e) {
    // [TESTING]
    await logBackgroundSyncEvent('registration_failed', {
      error: e instanceof Error ? e.message : String(e),
    });
    throw e;
  }
}

/** Not currently called — kept for a future "disable background sync" setting. */
export async function unregisterBackgroundSyncAsync(): Promise<void> {
  if (await TaskManager.isTaskRegisteredAsync(BACKGROUND_SYNC_TASK)) {
    await BackgroundTask.unregisterTaskAsync(BACKGROUND_SYNC_TASK);
  }
}
