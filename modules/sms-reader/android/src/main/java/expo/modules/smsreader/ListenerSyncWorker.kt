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
//   1. Wait 10 seconds. Banks send 2–3 SMS per payment, and the phone's SMS
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
    // [CHANGE — build 2] Was 20 s wait + up to 3 rounds. Android only
    // guarantees an urgent (expedited) job about 1 minute, and gives apps
    // that have repeatedly timed out (Pileap did, on 4 Nov: timeout-ej) no
    // more than that guarantee. So the whole job now fits in ~50 s:
    // 10 s wait (SMS delivery to Pileap took ~3 s in the logs) + sync capped
    // at 40 s (ListenerTaskRunner), and a second round only if time allows.
    private const val BATCH_WAIT_MS = 10_000L
    private const val MAX_ROUNDS = 2
    private const val SECOND_ROUND_ONLY_BEFORE_MS = 15_000L
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

    // [CHANGE — build 2] Wrapped so that if Android stops this job (timeout,
    // app frozen, process killed and restarted), the reason is recorded as
    // listener_job_stopped. If the job finishes normally, the "job pending"
    // marker is cleared so the next bank SMS starts a fresh job.
    var finishedNormally = false
    try {
      delay(BATCH_WAIT_MS)

      var round = 1
      while (true) {
        val roundStartedAt = System.currentTimeMillis()
        ListenerEventStore.add(ctx, "listener_job_step", mapOf("step" to "run_task", "round" to round))
        val outcome = try {
          ListenerTaskRunner.run(ctx)
        } catch (e: kotlinx.coroutines.CancellationException) {
          throw e
        } catch (e: Exception) {
          "error: " + (e.message ?: e.javaClass.simpleName)
        }

        ListenerEventStore.add(ctx, "listener_job_finished", mapOf(
          "round" to round,
          "outcome" to outcome,
          "total_ms" to (System.currentTimeMillis() - enqueuedAt)
        ))

        val newerSms = ListenerEventStore.lastBankSmsAt(ctx) > roundStartedAt
        val timeLeft = System.currentTimeMillis() - enqueuedAt < SECOND_ROUND_ONLY_BEFORE_MS + BATCH_WAIT_MS
        if (!newerSms || round >= MAX_ROUNDS || outcome != "finished" || !timeLeft) {
          // An SMS that arrived during the sync and didn't get its own round
          // is picked up by the next SMS, the hourly task or app open.
          break
        }

        round++
        delay(BATCH_WAIT_MS)
      }
      finishedNormally = true
    } finally {
      if (finishedNormally) {
        ListenerEventStore.setLastEnqueuedAt(ctx, 0L)
      } else {
        ListenerEventStore.add(ctx, "listener_job_stopped", mapOf(
          "stop_reason" to stopReasonOrNull(),
          "after_ms" to (System.currentTimeMillis() - enqueuedAt),
          "attempt" to runAttemptCount
        ))
      }
    }

    // Always success: a failed sync is picked up by the next SMS, the
    // hourly task or app open. Retrying here would only drain battery.
    return Result.success()
  }

  // Android's reason code for stopping this job (WorkManager 2.9+ on
  // Android 12+), read reflectively so an older WorkManager can't break the
  // build. e.g. 3 = timeout, 10 = quota, 11 = device state, 13 = system
  // processing, 4 = preempted. null if unknown.
  private fun stopReasonOrNull(): Int? = try {
    javaClass.getMethod("getStopReason").invoke(this) as? Int
  } catch (e: Exception) {
    null
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
