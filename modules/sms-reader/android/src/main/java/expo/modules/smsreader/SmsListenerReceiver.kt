package expo.modules.smsreader

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.provider.Telephony
import androidx.work.Constraints
import androidx.work.ExistingWorkPolicy
import androidx.work.NetworkType
import androidx.work.OneTimeWorkRequestBuilder
import androidx.work.OutOfQuotaPolicy
import androidx.work.WorkManager
import androidx.work.workDataOf

// ─────────────────────────────────────────────────────────────────────────────
// SmsListenerReceiver — [ADD — Nov 4]
//
// Android calls this for every incoming SMS, even when Pileap is closed
// (SMS_RECEIVED is one of the broadcasts apps may still receive in the
// background). Registered in this module's AndroidManifest.xml, so it's
// merged into the app automatically. Needs RECEIVE_SMS, which
// backgroundSync.ts asks for on app start.
//
// What it does (in a few milliseconds, no JS, no network):
//   1. Joins multi-part SMS back into one body per sender.
//   2. Runs the same Layer 0 + Layer 1 checks as SmsReaderModule. OTPs,
//      promos and other noise stop here.
//   3. Records "listener_sms_received" (no SMS text, no phone numbers).
//   4. For bank SMS, starts ONE ListenerSyncWorker. Unique work + KEEP: the
//      2–3 SMS a bank sends for one payment join the same job.
//
// Pileap Dev only: an SMS from a normal phone number containing PILEAPTEST
// starts the job too, to test the chain without a payment. (It won't
// create a transaction: the sync's own Layer 0 drops phone-number senders.)
// ─────────────────────────────────────────────────────────────────────────────

class SmsListenerReceiver : BroadcastReceiver() {

  companion object {
    const val UNIQUE_WORK = "pileap-sms-listener-sync"
    private const val TEST_KEYWORD = "pileaptest"
  }

  override fun onReceive(context: Context, intent: Intent) {
    if (intent.action != Telephony.Sms.Intents.SMS_RECEIVED_ACTION) return

    try {
      val parts = Telephony.Sms.Intents.getMessagesFromIntent(intent) ?: return
      if (parts.isEmpty()) return

      val receivedAt = System.currentTimeMillis()
      val isDevApp = context.packageName.endsWith(".dev")
      var startJob = false

      for ((address, msgs) in parts.groupBy { it.originatingAddress ?: "" }) {
        val body = msgs.joinToString("") { it.messageBody ?: "" }
        val smsTime = msgs.first().timestampMillis

        // Same Layer 0 checks as SmsReaderModule.getMessages().
        val isPromo = address.endsWith("-P", ignoreCase = true)
        val isNumeric = address.matches(Regex("^\\d+$"))
        val looksLikePhone = address.matches(Regex("^\\+?\\d+$"))
        val passesLayer0 = !isPromo && !isNumeric

        val filter = Layer1Filter()
        filter.lastDropReason = null
        val passesLayer1 = passesLayer0 && filter.passesFilter(body)

        val isTest = isDevApp && looksLikePhone && body.lowercase().contains(TEST_KEYWORD)
        val isBank = passesLayer1 || isTest

        ListenerEventStore.add(context, "listener_sms_received", mapOf(
          // Never store a personal phone number.
          "sender" to (if (looksLikePhone) "phone_number" else address),
          "delivery_ms" to (receivedAt - smsTime),
          "layer0" to passesLayer0,
          "layer1" to passesLayer1,
          "test" to isTest,
          "starts_job" to isBank,
          "parts" to msgs.size
        ))

        if (isBank) startJob = true
      }

      if (!startJob) return

      ListenerEventStore.setLastBankSmsAt(context, receivedAt)

      val request = OneTimeWorkRequestBuilder<ListenerSyncWorker>()
        // Ask Android to run it now. If the app's quota for urgent jobs is
        // used up, it still runs as a normal job.
        .setExpedited(OutOfQuotaPolicy.RUN_AS_NON_EXPEDITED_WORK_REQUEST)
        // Wait for internet if the phone is offline.
        .setConstraints(
          Constraints.Builder().setRequiredNetworkType(NetworkType.CONNECTED).build()
        )
        .setInputData(workDataOf("enqueued_at" to receivedAt))
        .build()

      WorkManager.getInstance(context.applicationContext)
        .enqueueUniqueWork(UNIQUE_WORK, ExistingWorkPolicy.KEEP, request)
    } catch (e: Exception) {
      ListenerEventStore.add(context, "listener_error", mapOf(
        "where" to "receiver",
        "error" to (e.message ?: e.javaClass.simpleName)
      ))
    }
  }
}
