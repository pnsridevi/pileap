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

    AsyncFunction("getMessages") { promise: Promise ->
      val context = appContext.reactContext
        ?: return@AsyncFunction promise.reject(
            CodedException("ERR_NO_CONTEXT", "React context unavailable", null)
          )

      val granted = ContextCompat.checkSelfPermission(
        context,
        Manifest.permission.READ_SMS
      ) == PackageManager.PERMISSION_GRANTED

      if (!granted) {
        promise.reject(
          CodedException("ERR_NO_PERMISSION", "READ_SMS permission not granted", null)
        )
        return@AsyncFunction
      }

      try {
        val messages = mutableListOf<Map<String, Any>>()
        val ninetyDaysAgo = System.currentTimeMillis() - (90L * 24 * 60 * 60 * 1000)

        val uri = Uri.parse("content://sms/inbox")
        val projection = arrayOf("_id", "address", "body", "date")
        val selection = "date > ?"
        val selectionArgs = arrayOf(ninetyDaysAgo.toString())
        val sortOrder = "date DESC"

        val cursor: Cursor? = context.contentResolver.query(
          uri, projection, selection, selectionArgs, sortOrder
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

            messages.add(
              mapOf(
                "id"      to it.getString(idIndex),
                "address" to address,
                "body"    to body,
                "date"    to it.getLong(dateIndex)
              )
            )
          }
        }

        promise.resolve(messages)
      } catch (e: Exception) {
        promise.reject(
          CodedException("ERR_SMS_READ", e.message ?: "Failed to read SMS", e)
        )
      }
    }

    AsyncFunction("hasPermission") { promise: Promise ->
      val context = appContext.reactContext
        ?: return@AsyncFunction promise.resolve(false)

      val granted = ContextCompat.checkSelfPermission(
        context,
        Manifest.permission.READ_SMS
      ) == PackageManager.PERMISSION_GRANTED

      promise.resolve(granted)
    }
  }

  // ── Liberal financial SMS filter ──────────────────────────────────────────
  // Philosophy: filter is a ROUGH NET — rejects only obvious non-financial SMS.
  // Parser is the FINE MESH — discards anything that doesn't produce required
  // fields (amount + direction + date). Nothing promotional ever reaches the
  // transactions table because the parser can't extract a valid direction from it.
  //
  // Three rejection layers only:
  //   1. OTP / verification messages
  //   2. Delivery / logistics tracking
  //   3. Pure service / account management alerts with no amount
  //
  // Everything else that has any financial signal passes through to the parser.

  private fun isFinancialSms(body: String): Boolean {
    val b = body.lowercase()

    // ── Reject Layer 1: OTP and verification ─────────────────────────────────
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

    // ── Reject Layer 2: Delivery and logistics ────────────────────────────────
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

    // ── Reject Layer 3: Pure service alerts with no financial content ─────────
    // Only reject if there is NO amount signal at all
    val hasAmountSignal =
      b.contains("rs.") ||
      b.contains("rs ") ||
      b.contains("inr") ||
      b.contains("₹") ||
      Regex("""\d+[\.,]\d{2}""").containsMatchIn(b) // e.g. 1,234.00 or 1234.00

    if (!hasAmountSignal) {
      // No amount at all — check if it's a pure service alert
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

      // No amount + not a clear service alert → still pass through
      // Parser will discard it if no financial fields found
      return true
    }

    // Has an amount signal → always pass through to parser
    // This includes promotional SMS like the Kotak cashback example —
    // the parser will discard them because it can't extract a valid
    // debit/credit direction from promotional copy.
    return true
  }
}