/**
 * src/lib/services/backgroundSync.ts
 * Location: apps/mobile/src/lib/services/backgroundSync.ts (new)
 *
 * Registers an hourly background task that calls syncRecentSmsMessages().
 * This is the "even when the app isn't open" half of automatic sync — the
 * on-app-open half is a plain useEffect in app/(app)/_layout.tsx, which
 * doesn't need any of this.
 *
 * [IMPORTANT — be honest about what this guarantees] Android background
 * execution is subject to OS-level battery optimization (Doze mode,
 * manufacturer-specific restrictions on Xiaomi/Oppo/Vivo/etc.), so
 * "every hour" is a MINIMUM interval requested from the OS, not a
 * guarantee — the actual tick can be delayed, batched with other apps'
 * background work, or occasionally skipped. This is a real, known
 * limitation of expo-background-fetch/expo-task-manager on Android, not
 * a bug in this file. The on-app-open sync in _layout.tsx is what
 * actually guarantees freshness whenever the user has the app open; this
 * background task is a best-effort top-up for the gaps in between.
 *
 * Requires (not yet in package.json — run):
 *   npx expo install expo-task-manager expo-background-fetch
 */
import * as TaskManager from 'expo-task-manager';
import * as BackgroundFetch from 'expo-background-fetch';
import { syncRecentSmsMessages } from './smsSync';

export const BACKGROUND_SYNC_TASK = 'pileap-background-sms-sync';

// Task body must be defined at module scope (not inside a component) —
// expo-task-manager requires this so it can re-register the task handler
// on app relaunch, including from a killed/background state.
TaskManager.defineTask(BACKGROUND_SYNC_TASK, async () => {
  try {
    // false: defer a first-ever (no-watermark) full 90-day sync to the
    // next on-app-open run — see smsSync.ts's header for why. The
    // background task should only ever be doing small incremental
    // catch-ups, never the heavy first backfill.
    const result = await syncRecentSmsMessages(false);
    if (result.skippedDeferredFirstSync || result.skippedConcurrentSync) {
      return BackgroundFetch.BackgroundFetchResult.NoData;
    }
    // BackgroundFetch.BackgroundFetchResult.NewData tells the OS this run
    // actually produced something, which can favorably influence how
    // often it's willing to grant future background time to this task.
    return result.transactionsInserted > 0 || result.balancesUpdated > 0
      ? BackgroundFetch.BackgroundFetchResult.NewData
      : BackgroundFetch.BackgroundFetchResult.NoData;
  } catch (e) {
    console.warn('Background SMS sync failed:', e instanceof Error ? e.message : e);
    return BackgroundFetch.BackgroundFetchResult.Failed;
  }
});

/**
 * Call once on app startup (see app/(app)/_layout.tsx). Safe to call on
 * every launch — registerTaskAsync() is idempotent, re-registering an
 * already-registered task is a no-op rather than an error.
 */
export async function registerBackgroundSyncAsync(): Promise<void> {
  const isRegistered = await TaskManager.isTaskRegisteredAsync(BACKGROUND_SYNC_TASK);
  if (isRegistered) return;

  await BackgroundFetch.registerTaskAsync(BACKGROUND_SYNC_TASK, {
    minimumInterval: 60 * 60, // 1 hour, in seconds — see the honesty note above re: OS enforcement
    stopOnTerminate: false,   // keep trying to run even if the user force-closes the app
    startOnBoot: true,        // resume scheduling after a device reboot
  });
}

/** Not currently called anywhere — kept for symmetry / a future
 * "disable background sync" setting, so that feature doesn't need this
 * plumbing rebuilt from scratch. */
export async function unregisterBackgroundSyncAsync(): Promise<void> {
  const isRegistered = await TaskManager.isTaskRegisteredAsync(BACKGROUND_SYNC_TASK);
  if (isRegistered) await BackgroundFetch.unregisterTaskAsync(BACKGROUND_SYNC_TASK);
}