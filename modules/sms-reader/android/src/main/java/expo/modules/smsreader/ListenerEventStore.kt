package expo.modules.smsreader

import android.content.Context
import android.util.Log
import org.json.JSONArray
import org.json.JSONObject

// ─────────────────────────────────────────────────────────────────────────────
// ListenerEventStore — [ADD — Nov 4]
//
// A small list of events kept on the phone (SharedPreferences), written by
// SmsListenerReceiver and ListenerSyncWorker. Also remembers when the last
// bank SMS arrived, so the worker can tell whether it needs another round. Native code has no Supabase
// login, so it can't write to background_sync_log itself. Instead JS
// uploads this list the next time it runs (app open or the hourly task),
// keeping each event's original time in details.at.
//
// No SMS text and no personal phone numbers are stored: only the bank
// sender code (e.g. "AX-HDFCBK-S"), times and filter results.
// ─────────────────────────────────────────────────────────────────────────────

internal object ListenerEventStore {
  private const val PREFS = "pileap_sms_listener_events"
  private const val KEY = "events"
  private const val MAX_EVENTS = 300
  private const val KEY_LAST_BANK_SMS = "last_bank_sms_at"

  @Synchronized
  fun setLastBankSmsAt(context: Context, at: Long) {
    context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
      .edit().putLong(KEY_LAST_BANK_SMS, at).commit()
  }

  @Synchronized
  fun lastBankSmsAt(context: Context): Long =
    context.getSharedPreferences(PREFS, Context.MODE_PRIVATE).getLong(KEY_LAST_BANK_SMS, 0L)

  // [ADD — build 2] When the current listener job was enqueued; 0 = no job
  // pending (the worker clears it when it finishes normally). Lets the
  // receiver replace a job that got stuck instead of being blocked by it.
  private const val KEY_LAST_ENQUEUED = "last_job_enqueued_at"
  const val LOG_TAG = "PileapListener"

  @Synchronized
  fun setLastEnqueuedAt(context: Context, at: Long) {
    context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
      .edit().putLong(KEY_LAST_ENQUEUED, at).commit()
  }

  @Synchronized
  fun lastEnqueuedAt(context: Context): Long =
    context.getSharedPreferences(PREFS, Context.MODE_PRIVATE).getLong(KEY_LAST_ENQUEUED, 0L)

  /** Records the event and also writes it to logcat (tag PileapListener). */
  fun add(context: Context, event: String, details: Map<String, Any?>) {
    val d = JSONObject()
    try {
      details.forEach { (k, v) -> d.put(k, v ?: JSONObject.NULL) }
    } catch (e: Exception) { }
    addJson(context, event, d)
  }

  @Synchronized
  fun addJson(context: Context, event: String, d: JSONObject) {
    try { Log.i(LOG_TAG, "$event $d") } catch (e: Exception) { }
    try {
      val prefs = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
      val list = JSONArray(prefs.getString(KEY, "[]"))

      val item = JSONObject()
      item.put("event", event)
      item.put("at", System.currentTimeMillis())
      item.put("details", d)
      list.put(item)

      // Keep only the newest MAX_EVENTS.
      val trimmed = JSONArray()
      val start = maxOf(0, list.length() - MAX_EVENTS)
      for (i in start until list.length()) trimmed.put(list.get(i))

      prefs.edit().putString(KEY, trimmed.toString()).commit()
    } catch (e: Exception) {
      // Logging must never break the receiver or the job.
    }
  }

  @Synchronized
  fun peek(context: Context): String {
    val prefs = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
    return prefs.getString(KEY, "[]") ?: "[]"
  }

  /** Removes the first [count] events (the ones JS has just uploaded). */
  @Synchronized
  fun removeFirst(context: Context, count: Int) {
    try {
      val prefs = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
      val list = JSONArray(prefs.getString(KEY, "[]"))
      val kept = JSONArray()
      for (i in count until list.length()) kept.put(list.get(i))
      prefs.edit().putString(KEY, kept.toString()).commit()
    } catch (e: Exception) {
      // Ignore: worst case the same events are uploaded twice.
    }
  }
}
