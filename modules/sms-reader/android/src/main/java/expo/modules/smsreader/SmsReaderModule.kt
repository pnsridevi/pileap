package expo.modules.smsreader

import android.Manifest
import android.content.pm.PackageManager
import android.database.Cursor
import android.net.Uri
import androidx.core.content.ContextCompat
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import expo.modules.kotlin.Promise
import expo.modules.kotlin.exception.CodedException

class SmsReaderModule : Module() {
  override fun definition() = ModuleDefinition {
    Name("SmsReader")

    // Returns filtered bank SMS from last 90 days
    AsyncFunction("getMessages") { promise: Promise ->
      val context = appContext.reactContext
        ?: return@AsyncFunction promise.reject(
            CodedException("ERR_NO_CONTEXT", "React context unavailable", null)
          )

      val granted = ContextCompat.checkSelfPermission(
        context, Manifest.permission.READ_SMS
      ) == PackageManager.PERMISSION_GRANTED

      if (!granted) {
        promise.reject(CodedException("ERR_NO_PERMISSION", "READ_SMS permission not granted", null))
        return@AsyncFunction
      }

      try {
        val messages = mutableListOf<Map<String, Any>>()
        val ninetyDaysAgo = System.currentTimeMillis() - (90L * 24 * 60 * 60 * 1000)
        val cursor: Cursor? = context.contentResolver.query(
          Uri.parse("content://sms/inbox"),
          arrayOf("_id", "address", "body", "date"),
          "date > ?",
          arrayOf(ninetyDaysAgo.toString()),
          "date DESC"
        )
        cursor?.use {
          val idIndex   = it.getColumnIndexOrThrow("_id")
          val addrIndex = it.getColumnIndexOrThrow("address")
          val bodyIndex = it.getColumnIndexOrThrow("body")
          val dateIndex = it.getColumnIndexOrThrow("date")
          while (it.moveToNext()) {
            val address = it.getString(addrIndex) ?: continue
            val body    = it.getString(bodyIndex) ?: continue
            if (!isFinancialSms(body)) continue
            messages.add(mapOf(
              "id"      to it.getString(idIndex),
              "address" to address,
              "body"    to body,
              "date"    to it.getLong(dateIndex)
            ))
          }
        }
        promise.resolve(messages)
      } catch (e: Exception) {
        promise.reject(CodedException("ERR_SMS_READ", e.message ?: "Failed to read SMS", e))
      }
    }

    // Debug: returns all unique senders + total count from raw inbox (last 90 days)
    // Used to diagnose which senders are present but being filtered out
    AsyncFunction("getAllSenders") { promise: Promise ->
      val context = appContext.reactContext
        ?: return@AsyncFunction promise.reject(
            CodedException("ERR_NO_CONTEXT", "React context unavailable", null)
          )

      val granted = ContextCompat.checkSelfPermission(
        context, Manifest.permission.READ_SMS
      ) == PackageManager.PERMISSION_GRANTED

      if (!granted) {
        promise.reject(CodedException("ERR_NO_PERMISSION", "READ_SMS permission not granted", null))
        return@AsyncFunction
      }

      try {
        val senders = mutableSetOf<String>()
        var totalCount = 0
        val ninetyDaysAgo = System.currentTimeMillis() - (90L * 24 * 60 * 60 * 1000)
        val cursor: Cursor? = context.contentResolver.query(
          Uri.parse("content://sms/inbox"),
          arrayOf("address", "date"),
          "date > ?",
          arrayOf(ninetyDaysAgo.toString()),
          "date DESC"
        )
        cursor?.use {
          val addrIndex = it.getColumnIndexOrThrow("address")
          while (it.moveToNext()) {
            totalCount++
            val address = it.getString(addrIndex) ?: continue
            senders.add(address)
          }
        }
        promise.resolve(mapOf(
          "totalCount" to totalCount,
          "senders"    to senders.sorted()
        ))
      } catch (e: Exception) {
        promise.reject(CodedException("ERR_SMS_READ", e.message ?: "Failed to read senders", e))
      }
    }

    // Check if READ_SMS permission is granted
    AsyncFunction("hasPermission") { promise: Promise ->
      val context = appContext.reactContext
        ?: return@AsyncFunction promise.resolve(false)
      val granted = ContextCompat.checkSelfPermission(
        context, Manifest.permission.READ_SMS
      ) == PackageManager.PERMISSION_GRANTED
      promise.resolve(granted)
    }
  }

  // ── Liberal financial SMS filter ──────────────────────────────────────────
  private fun isFinancialSms(body: String): Boolean {
    val b = body.lowercase()

    // Layer 1: Reject OTP
    val isOtp =
      b.contains("otp") ||
      b.contains("one time password") ||
      b.contains("verification code") ||
      b.contains("do not share") ||
      b.contains("do not disclose") ||
      b.contains("never share") ||
      b.contains("confidential code") ||
      b.contains("login code") ||
      b.contains("sign in code") ||
      b.contains("authentication code")
    if (isOtp) return false

    // Layer 2: Reject delivery/logistics
    val isDelivery =
      (b.contains("delivered") && !b.contains("rs.") && !b.contains("inr")) ||
      b.contains("out for delivery") ||
      b.contains("shipment") ||
      b.contains("your order has been") ||
      b.contains("pickup scheduled") ||
      b.contains("courier") ||
      b.contains("tracking id") ||
      b.contains("dispatched") ||
      (b.contains("package") && !b.contains("rs.") && !b.contains("inr"))
    if (isDelivery) return false

    // Layer 3: Reject pure service alerts with no amount
    val hasAmountSignal =
      b.contains("rs.") ||
      b.contains("rs ") ||
      b.contains("inr") ||
      b.contains("₹") ||
      Regex("""\d+[\.,]\d{2}""").containsMatchIn(b)

    if (!hasAmountSignal) {
      val isPureServiceAlert =
        b.contains("kyc") ||
        b.contains("your account is") ||
        b.contains("nominee") ||
        b.contains("password changed") ||
        b.contains("profile updated") ||
        b.contains("registered mobile") ||
        b.contains("linked successfully") ||
        b.contains("unlinked") ||
        b.contains("feedback") ||
        b.contains("survey") ||
        b.contains("thank you for banking") ||
        b.contains("welcome to") ||
        (b.contains("dear customer, your") && b.contains("updated"))
      if (isPureServiceAlert) return false
      return true
    }

    return true
  }
}
