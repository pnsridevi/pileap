package expo.modules.smsreader

import android.app.NotificationChannel
import android.app.NotificationManager
import android.content.Context
import android.os.Build
import androidx.core.app.NotificationCompat
import androidx.work.CoroutineWorker
import androidx.work.ForegroundInfo
import androidx.work.WorkerParameters
import kotlinx.coroutines.delay

// ─────────────────────────────────────────────────────────────────────────────
// ListenerSyncWorker — [ADD — Nov 4]
//
// Started by SmsListenerReceiver when a bank SMS arrives. Runs with no
// screen. Steps:
//   1. Wait 20 seconds. Banks send 2–3 SMS per payment, and the phone's SMS
//      app needs a moment to save each one to the inbox (the sync reads the
//      inbox, not the SMS Android handed to the receiver).
//   2. Run the JS task "pileap-sms-listener-sync", which calls the same
//      syncRecentSmsMessages() as Sync Now — same parsing, duplicate checks
//      and upload.
//   3. If another bank SMS arrived after step 2 started (its own job was
//      skipped because this one was running), sync once more. At most
//      MAX_ROUNDS rounds.
//
// Every step is recorded in ListenerEventStore and uploaded to
// background_sync_log by JS.
// ─────────────────────────────────────────────────────────────────────────────

class ListenerSyncWorker(
  context: Context,
  params: WorkerParameters
) : CoroutineWorker(context, params) {

  companion object {
    private const val BATCH_WAIT_MS = 20_000L
    private const val MAX_ROUNDS = 3
    private const val CHANNEL_ID = "pileap_sync"
    private const val NOTIFICATION_ID = 4711
  }

  override suspend fun doWork(): Result {
    val ctx = applicationContext
    val enqueuedAt = inputData.getLong("enqueued_at", 0L)

    ListenerEventStore.add(ctx, "listener_job_started", mapOf(
      "start_delay_ms" to (System.currentTimeMillis() - enqueuedAt),
      "attempt" to runAttemptCount
    ))

    delay(BATCH_WAIT_MS)

    var round = 1
    while (true) {
      val roundStartedAt = System.currentTimeMillis()
      val outcome = try {
        ListenerTaskRunner.run(ctx)
      } catch (e: Exception) {
        "error: " + (e.message ?: e.javaClass.simpleName)
      }

      ListenerEventStore.add(ctx, "listener_job_finished", mapOf(
        "round" to round,
        "outcome" to outcome,
        "total_ms" to (System.currentTimeMillis() - enqueuedAt)
      ))

      val newerSms = ListenerEventStore.lastBankSmsAt(ctx) > roundStartedAt
      if (!newerSms || round >= MAX_ROUNDS || outcome != "finished") break

      round++
      delay(BATCH_WAIT_MS)
    }

    // Always success: a failed sync is picked up by the next SMS, the
    // hourly task or app open. Retrying here would only drain battery.
    return Result.success()
  }

  // Only used on Android 11 and older, where an urgent job has to run as a
  // short foreground task with a notification. Android 12+ doesn't call it.
  override suspend fun getForegroundInfo(): ForegroundInfo {
    val nm = applicationContext.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
      nm.createNotificationChannel(
        NotificationChannel(CHANNEL_ID, "Transaction updates", NotificationManager.IMPORTANCE_MIN)
      )
    }
    val notification = NotificationCompat.Builder(applicationContext, CHANNEL_ID)
      .setSmallIcon(android.R.drawable.stat_notify_sync)
      .setContentTitle("Updating transactions")
      .setPriority(NotificationCompat.PRIORITY_MIN)
      .setSilent(true)
      .build()
    return ForegroundInfo(NOTIFICATION_ID, notification)
  }
}
