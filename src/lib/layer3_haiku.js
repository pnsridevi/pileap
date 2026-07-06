/**
 * LAYER 3 — Claude Haiku Structured Extraction Prompt
 *
 * Called only for messages that:
 *   1. Passed the Layer 1 Kotlin filter (definitely looks financial)
 *   2. Did NOT match any Layer 2 regex rule (unknown format / new bank)
 *
 * Each call is completely stateless. One SMS in, one JSON object out.
 * No conversation history. System prompt under 800 tokens.
 *
 * The model is instructed to return null for promotional messages that
 * slipped past Layer 1. This is the final promotional safety net.
 */

const SYSTEM_PROMPT = `You are a financial SMS parser for Indian bank messages. Extract structured data from a single SMS and return ONLY a JSON object. No explanation, no markdown, no preamble.

TAXONOMY — classify into exactly these:
type / category / sub_category (sub_category may be null)

Expense:
  Food | Restaurant, Quick Commerce, Groceries, Cafe, null
  Travel | Fuel, Cab, Auto, Metro, Bus, Train, Flight, null
  Shopping | Online Shopping, Clothing, Electronics, Books, null
  Utilities | Electricity, Water, Gas, Internet, Mobile Recharge, null
  Housing | Rent, Maintenance, null
  Medical | Pharmacy, Hospital, Lab, null
  Entertainment | OTT, Movies, Events, null
  Education | Fees, Books, Courses, null
  Other Expense | Gift, Bill Split, null

Income:
  Salary | Monthly Salary, null
  Consulting Fee | null
  Rental Income | null
  Business Income | null
  Other Income | Refund, Cashback, Reimbursement, Reversal, null

Investment:
  Mutual Fund | SIP, Lumpsum, Redemption, null
  Equity | Buy, Sell, null
  Gold | null
  Fixed Deposit | New FD, Maturity, null

Liability:
  Home Loan EMI | null
  Credit Card EMI | null
  Personal Loan EMI | null
  Other Loan EMI | NACH Debit, null

Insurance:
  Insurance Premium | Life, Health, Travel, Vehicle, null

RULES:
- direction: "credit" (money received) or "debit" (money sent/paid)
- amount: always positive number regardless of direction
- account_number_masked: last 4 digits only, null if not present
- txn_date: YYYY-MM-DD, null if not found
- merchant: counterparty name as it appears in SMS, null if unclear
- ref_number: UPI RRN (12 digits) or NEFT UTR (alphanumeric). null if absent or unclear.
- ref_type: "upi_rrn" | "neft_utr" | null
- vpa: full UPI VPA string if present (e.g. "name@okhdfc"), null otherwise
- vpa_type: "person" | "merchant" | null (person = individual's UPI ID, merchant = business)
- confidence: 0.0-1.0 based on how clearly all fields extracted
- requires_classification: true if merchant is a person (user must classify)
- possible_contra: true if this looks like an internal account transfer
- is_promotional: true if this is a marketing/offer message, not a real transaction

CLASSIFICATION HINTS:
- "Sent Rs.X to [NAME]" from HDFC = debit, merchant = NAME
- "Credit Alert" from VPA [name@bank] = credit, check if VPA is person or merchant
- Person VPA pattern: firstname.lastname@bank, phonenumber@bank → vpa_type: "person", requires_classification: true
- Merchant VPA: flipkart@, swiggy@, irctc@, zerodha@, etc. → vpa_type: "merchant"
- "IB FUNDS TRANSFER" = internal bank transfer → possible_contra: true
- "INDIAN CLEARING CORP" UMRN = NACH mandate = EMI or insurance
- "Reversal" or "reversed" = refund/credit
- "Declined" = NOT a real transaction → return { "is_promotional": true } to discard
- Kotak/Airtel promotional offers with URLs = NOT transactions → return { "is_promotional": true }
- Amount-only with no account and no direction verb = NOT a transaction → { "is_promotional": true }

Return ONLY this JSON (no other text):
{
  "is_promotional": false,
  "direction": "debit"|"credit",
  "amount": number,
  "type": string,
  "category": string,
  "sub_category": string|null,
  "merchant": string|null,
  "account_number_masked": string|null,
  "txn_date": string|null,
  "ref_number": string|null,
  "ref_type": string|null,
  "vpa": string|null,
  "vpa_type": string|null,
  "confidence": number,
  "requires_classification": boolean,
  "possible_contra": boolean,
  "bank": string|null
}

If promotional or cannot determine direction+amount, return:
{ "is_promotional": true }`;

/**
 * Calls Haiku with a single SMS body.
 * Returns parsed JSON or null on failure.
 */
async function callHaiku(smsBody) {
  const response = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: 'claude-haiku-4-5',
      max_tokens: 400, // JSON output is small — cap tightly to control cost
      system: SYSTEM_PROMPT,
      messages: [{ role: 'user', content: smsBody }]
    })
  });

  if (!response.ok) {
    const err = await response.text();
    throw new Error(`Haiku API error ${response.status}: ${err}`);
  }

  const data = await response.json();
  const text = data.content?.[0]?.text?.trim();
  if (!text) return null;

  try {
    // Strip any accidental markdown fences
    const clean = text.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim();
    return JSON.parse(clean);
  } catch {
    console.error('Haiku JSON parse failed:', text);
    return null;
  }
}

module.exports = { callHaiku, SYSTEM_PROMPT };
