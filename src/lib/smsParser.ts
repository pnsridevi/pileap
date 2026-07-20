/**
 * smsParser.ts
 * Location: apps/mobile/src/lib/smsParser.ts
 *
 * Orchestrator for the 3-layer SMS parsing pipeline.
 *
 * Layer 1 — Already done by SmsReaderModule.kt (Kotlin, on-device filter)
 *            By the time messages arrive here, noise/OTPs are already dropped.
 *
 * Layer 2 — layer2_ruleset.js (regex rules for known bank SMS formats)
 *            Handles HDFC, PNB, SBI, Airtel etc. with high confidence.
 *            Returns structured fields if matched, null if no rule matched.
 *
 * Layer 3 — layer3_haiku.js (Claude Haiku, called from BACKEND only)
 *            NOT called here on-device. Messages that Layer 2 misses are
 *            flagged with parse_failure: 'escalated_to_haiku' and
 *            status: 'pending_review'. The backend Haiku worker picks these up
 *            from the parse_jobs queue after they are uploaded.
 *            (Arch ref: Section 10.3.3 — phone must never call Shared Fallback directly)
 *
 * Taxonomy fallback — if Layer 2 misses but the message has amount + direction,
 *                     the local taxonomy classifier runs as a middle step before
 *                     escalating to Haiku. This handles generic merchant patterns
 *                     that Layer 2 doesn't cover (e.g. Swiggy, Netflix, Zerodha).
 *
 * Flow per message:
 *   Layer 2 match?
 *     YES → build transaction from Layer 2 fields + run taxonomy for category
 *     NO  → try local taxonomy classifier
 *              classified? → build transaction
 *              not classified? → flag for Haiku (pending_review)
 *
 * Arch ref: Sections 4.4, 4.5, 4.8, 5.3, 5.7, 10.2, 10.3.3
 *
 * Change log:
 *   [FIX] needsReview now includes || l2.requires_classification — person VPA
 *         credits were auto-approved instead of routing to pending_review.
 *   [FIX] Restaurants: removed maxAmount:2000 cap (blocked Zomato/Swiggy/cafe
 *         bills above ₹2000), fixed domino'?s? → dominos? (missed "Dominos"),
 *         added dining/coffee/meal patterns.
 *   [FIX] Insurance: removed \bbajaj\s+finserv\b — Bajaj Finserv is a lending
 *         company too; "EMI" in the text is the correct signal for EMI entries.
 *   [FIX] extractBalance: added "balance is Rs." pattern for Indian Railways
 *         RWallet SMS ("Now the Available Balance is Rs.1000.00").
 *   [FIX] Travel sub_category 'Hotel' renamed to 'Accommodation' — 'hotel' is
 *         a common South Indian restaurant naming convention (Saravana Bhavan,
 *         Geetham etc.). Standalone \bhotel\b removed from taxonomy patterns;
 *         only unambiguous accommodation signals retained (oyo, booking.com etc.)
 *         Ambiguous hotel names route to pending_review; user classifies once,
 *         custom categories handle all future occurrences.
 *   [ADD] merchant_key field — normalised lookup key for custom category
 *         matching. Lowercase, alphanumeric + @ only, max 40 chars. Separate
 *         from merchant (display text) to survive truncation/casing variation.
 *   [FIX] \bpvr\b → \bpvr (no trailing \b) — pvrinox was not matching.
 *   [FIX] \bzepto\b → \bzepto (no trailing \b) — ZEPTONOW was not matching.
 *   [FIX] \bsip\b → \bsip\s+(of|installment|debit(ed)?|payment|contribution)\b
 *         — false positive on "sip gateway" (payment gateway, not SIP investment).
 *   [FIX] \bamazon\b in Shopping → \bamazon\b(?!\s+prime) — Amazon Prime was
 *         misfiling as Shopping instead of OTT. Also moved OTT entry above
 *         Shopping in TAXONOMY array so tie-break resolves correctly.
 *   [FIX] Telecom Mobile Recharge: expanded jio and airtel patterns to cover
 *         postpaid, bill, mobile, sim, plan, pack variants. Added \breliance\s+jio\b
 *         and \bbharti\s+airtel\b. Standalone \bjio\b and \bairtel\b were
 *         firing on JioMart, JioSaavn, Airtel Xstream Play, Airtel Payments Bank.
 *   [ADD] Transportation > Bus — redbus, abhibus, keybus.
 *   [ADD] Travel > Flight — cleartrip, easemytrip, ixigo.
 *   [ADD] Transportation > Public Transit — autope (IRCTC payment gateway).
 *   [ADD] Investment > Life Insurance — shriramlife, shriram life.
 *   [ADD] Investment > Health Insurance — manipalcigna, manipal cigna.
 *   [ADD] Income > Dividends > Stock Dividend — \bdividend\b, direction:credit.
 *   [ADD] Income > Salary — \bneft\s+cr\b for employer NEFT credits.
 *   [REMOVE] Food & Dining > Canteen (\bpluxee\b, \bmeal\s+card\b) — Pluxee is
 *         a payment instrument, not a spending category. Merchant at POS
 *         determines category (same as any UPI/card spend). If taxonomy
 *         matches → categorize; else → pending_review.
 *
 *   ── This pass (categorization coverage review) ─────────────────────────
 *   [FIX, THEN REVERTED — see next entry] needsReview (Layer 2 branch)
 *         briefly also required review when classify() returned null.
 *         Live-sync analysis found 217/259 parsed transactions had no
 *         category, most of those (177) still landing as status:'approved'.
 *         Reasoning at the time: an "approved" transaction with no category
 *         is what the review queue exists to catch. In practice this
 *         conflated "the facts might be wrong" (worth blocking on) with
 *         "we just have no category for it" (not a correctness issue,
 *         especially for P2P transfers, which structurally can never get a
 *         category from text). Shipping this put ~217/263 transactions in
 *         the review queue on the next real sync — an unusable amount of
 *         friction for something that wasn't actually broken. Reverted
 *         below.
 *   [REVERTED] The above is reverted — needsReview (Layer 2 branch) is back
 *         to its original three conditions (missing account, amount>=5000,
 *         l2.requires_classification). Missing category no longer forces
 *         pending_review on its own. The NACH-fallback classify() addition
 *         (see further down this log) still forces review for ITS specific
 *         low-confidence guess via isUnconfidentNachGuess — that one is a
 *         genuine guess worth double-checking, unlike a bare missing
 *         category. Category coverage is still meant to be visible to the
 *         user — via a lightweight "no category" tap-to-tag affordance on
 *         approved rows in the Transactions tab UI, not via the review gate.
 *   [FIX] Healthcare > Pharmacy — added \bmedicals?\b. "GANESH MEDICALS",
 *         "SHREE MEDICALS" etc. are extremely common Indian pharmacy-naming
 *         convention and only had \bpharmacy\b to match against.
 *   [ADD] Travel > General Travel — added generic \btravels?\b pattern.
 *         Local travel agencies (e.g. "SETHUMEENA TRAVELS") don't match any
 *         airline/OTA brand name and had nowhere to land.
 *   [FIX — REGRESSION] Telecom Mobile Recharge (jio/airtel) — the earlier
 *         fix that required a qualifying word after the brand name
 *         (recharge/prepaid/bill/etc.) over-corrected: real recharge SMS to
 *         a bare merchant name "JIO" or "airtel" (no qualifying word in the
 *         text at all — this is the common case, not the exception) no
 *         longer matched anything. Restored bare \bjio\b / \bairtel\b, but
 *         kept the false-positive fix via negative lookahead instead of a
 *         required suffix: excludes mart/saavn/cinema/hotstar/fiber for Jio
 *         and xstream/payments bank/thanks/fiber for Airtel. This preserves
 *         recall on the ordinary case while still keeping JioMart, Airtel
 *         Xstream, etc. out of Mobile Recharge. Fiber is excluded from both
 *         so "Jio Fiber"/"Airtel Fiber" fall through to the Broadband entry
 *         (which sits later in the array) instead of tying with/beating it.
 *   [ADD] NACH-channel fallback — classify() now accepts an optional channel
 *         param. When channel === 'NACH' and no text pattern matched
 *         anything, this returns a generic Liability > Recurring Payment >
 *         NACH Mandate classification rather than leaving category fully
 *         null. This does NOT mark the row auto-approved — the new
 *         !classification-forces-review rule above still doesn't apply here
 *         since a classification IS returned, so this is deliberately paired
 *         with requires_classification being forced true for this specific
 *         path (see parseSingleSms) so the user still confirms/reclassifies
 *         once — after which the custom-category checkbox (once wired) will
 *         apply their choice to all future NACH debits from that merchant_key.
 *         Rationale: arch doc's DEFINITIONAL_CONTRA_RULES (transactions.ts)
 *         already expects a GENERIC_PPF_SSY-style rule from Layer 2 for
 *         mandate transfers with no real counter-leg; this taxonomy fallback
 *         is a safety net for NACH debits that reach here without Layer 2
 *         having classified them (e.g. "INDIAN CLEARING CORP LTD" — 20 of
 *         259 transactions in one 90-day sample, all previously uncategorized).
 *   [ADD] New categories/sub-categories (all generic keyword patterns unless
 *         noted otherwise; P2P transfers to named individuals, donations, and
 *         domestic-help wages are deliberately NOT addressed here — no text
 *         signal distinguishes them from any other payment to a person, and
 *         per product decision these stay uncategorized for the user to tag
 *         via custom categories):
 *           - Utilities > Water
 *           - Utilities > DTH & Cable TV
 *           - Utilities > Broadband — generalized beyond Jio Fiber/Airtel
 *             Fiber to any ISP (ACT, Hathway, Excitel, BSNL, generic
 *             wifi/internet bill)
 *           - Utilities > Piped Gas (PNG)
 *           - Rent & Housing > Maintenance & Society Charges (RWA/society
 *             maintenance — housing-adjacent, filed under Rent & Housing
 *             rather than Utilities)
 *           - Food & Dining > Milk & Dairy
 *           - Household > Newspaper & Magazine (new top-level category)
 *           - Household > Home Services (pest control, plumber, electrician,
 *             appliance repair, RO/water-purifier service)
 *           - Household > Stationery
 *           - Transportation > Parking
 *           - Transportation > Vehicle Service & Repair (motors, garage,
 *             workshop)
 *           - Investment > Insurance > Motor Insurance
 *           - Investment > Gold
 *           - Asset > Government Schemes > PPF/SSY
 *           - Courier & Postal (new top-level category)
 *           - Taxes & Government (new top-level category — income tax, GST,
 *             property tax, TDS, traffic challan)
 *           - Subscriptions (new top-level category) — NOTE: unlike every
 *             other addition in this pass, this is a CURATED LIST of named
 *             SaaS/digital-service products (Spotify, Google One, Anthropic,
 *             OpenAI, Microsoft 365, etc.), not a generic keyword pattern.
 *             There is no generic word that reliably signals "this is a
 *             subscription" without false-positiving on ordinary business
 *             names (e.g. bare "sub" matches "Subhash Stores"). This list
 *             will need periodic manual additions as new services appear —
 *             flagging explicitly so this isn't mistaken for a
 *             self-maintaining pattern the way the rest of this file is.
 *           - Personal Care (salon, spa, parlour, Urban Company)
 *           - Fitness & Gym
 */

// Layer 2 — require() because it is a CommonJS .js file
// eslint-disable-next-line @typescript-eslint/no-var-requires
// [FLAG — NOT FIXED] This imports './layer2_ruleset.js', but the file we
// have is named 'ruleset.js' (per its own header: "Location:
// apps/mobile/layer2/ruleset.js"). Left as-is since we can't see the actual
// repo layout from here — please confirm this resolves correctly in your
// build, or update one side to match the other.
const { matchMessage } = require('./layer2_ruleset.js');

// ─── Platform-agnostic input (arch 10.2) ─────────────────────────────────────

export interface RawMessage {
  id:      string;   // idempotency key
  address: string;   // SMS shortcode or email sender domain
  body:    string;   // raw message text
  date:    number;   // epoch milliseconds
}

// ─── Output type (maps to transactions table, arch 5.3.6) ────────────────────

export interface ParsedTransaction {
  kind:                  'transaction';
  raw_sms_id:            string;
  txn_date:              string;        // YYYY-MM-DD
  amount:                number | null; // signed: positive=credit, negative=debit
  type:                  TxnType | null;
  category:              string | null;
  sub_category:          string | null;
  merchant:              string | null;
  // [ADD] merchant_key — normalised for custom category lookup.
  // Lowercase, alphanumeric + @ only, max 40 chars.
  // Used as the key in customCatData lookup — do NOT use merchant (display)
  // for matching because casing/truncation varies across SMS templates.
  merchant_key:          string | null;
  source:                'sms';
  status:                'approved' | 'pending_review';

  // Enrichment
  account_number_masked: string | null;
  bank:                  string | null;
  channel:               string | null;
  balance:               number | null;

  // Ref number (arch 5.3.6 v3.1)
  ref_number:            string | null;
  ref_type:               'upi_rrn' | 'neft_utr' | 'unknown' | null;

  // Layer 2 metadata
  matched_rule:          string | null;
  confidence:            number | null;
  requires_classification: boolean;
  possible_contra:       boolean;

  // Deferred / post-insert
  txn_group_id:          null;
  is_infrastructure:     boolean;
  health_module_tag:     null;

  // Failure tracking
  parse_failure:         string | null;

  // Raw — AES-256 encrypt before INSERT (arch 11.2)
  raw_text:              string;
}

// [ADD] BalanceUpdate — returned instead of a ParsedTransaction when a
// message is a pure balance-disclosure with no money movement (see
// BALANCE_ALERT_ONLY in ruleset.js). Never inserted into `transactions` and
// never routed to pending_review — the caller should look this up/create in
// `accounts` (matched on account_number_masked + bank, scoped to user_id)
// and update balance_latest + balance_updated_at ONLY if message_date is
// newer than what's currently stored, per the "newest date wins" rule.
export interface BalanceUpdate {
  kind:                   'balance_update';
  raw_sms_id:             string;
  account_number_masked:  string | null;
  bank:                   string | null;
  balance:                number | null;
  message_date:           string;        // YYYY-MM-DD
}

export function isBalanceUpdate(
  item: ParsedTransaction | BalanceUpdate
): item is BalanceUpdate {
  return item.kind === 'balance_update';
}

export type TxnType = 'Expense' | 'Income' | 'Investment' | 'Liability' | 'Asset';

// ─── Internal types ───────────────────────────────────────────────────────────

interface ExtractedFields {
  amount:       number | null;
  isCredit:     boolean | null;
  accountLast4: string | null;
  merchant:     string | null;
  bank:         string | null;
  channel:      string | null;
  balance:      number | null;
  ref_number:   string | null;
  ref_type:     'upi_rrn' | 'neft_utr' | 'unknown' | null;
}

interface Classification {
  type:         TxnType;
  category:     string;
  sub_category: string | null;
}

// ─── UPI infrastructure senders ──────────────────────────────────────────────

const UPI_INFRA_SENDERS = ['NPCI', 'UPITRN', 'UPITXN', 'SBIPSG', 'HDFCPAY'];

// ─── Bank keyword map ─────────────────────────────────────────────────────────

const BANK_MAP: Record<string, string> = {
  'HDFC':       'HDFC Bank',
  'ICICI':      'ICICI Bank',
  'SBI':        'State Bank of India',
  'AXIS':       'Axis Bank',
  'KOTAK':      'Kotak Mahindra Bank',
  'YES BANK':   'Yes Bank',
  'YESBANK':    'Yes Bank',
  'PNB':        'Punjab National Bank',
  'BOB':        'Bank of Baroda',
  'CANARA':     'Canara Bank',
  'IDFC':       'IDFC First Bank',
  'INDUSIND':   'IndusInd Bank',
  'FEDERAL':    'Federal Bank',
  'RBL':        'RBL Bank',
  'UNION BANK': 'Union Bank of India',
  'PAYTM':      'Paytm Payments Bank',
  'AIRTEL':     'Airtel Payments Bank',
  'AU BANK':    'AU Small Finance Bank',
  'AUBANK':     'AU Small Finance Bank',
  'BANDHAN':    'Bandhan Bank',
};

// ─── UPI VPA domain → bank/wallet ────────────────────────────────────────────

const UPI_DOMAIN_MAP: Record<string, string> = {
  okaxis:      'Axis Bank',
  okhdfcbank:  'HDFC Bank',
  oksbi:       'State Bank of India',
  okicici:     'ICICI Bank',
  ybl:         'PhonePe / Yes Bank',
  ibl:         'IndusInd Bank',
  axl:         'Axis Bank',
  paytm:       'Paytm',
  apl:         'Amazon Pay',
  jupiteraxis: 'Jupiter / Axis',
  fbl:         'Federal Bank',
  rbl:         'RBL Bank',
  kotak:       'Kotak Bank',
  icici:       'ICICI Bank',
  sbi:         'SBI',
  hdfcbank:    'HDFC Bank',
  indus:       'IndusInd Bank',
  aubank:      'AU Small Finance Bank',
  idfc:        'IDFC First Bank',
  airtel:      'Airtel Payments Bank',
};

// ─── Channel keyword map ──────────────────────────────────────────────────────

const CHANNEL_MAP: Record<string, string> = {
  'UPI':         'UPI',
  'NEFT':        'NEFT',
  'RTGS':        'RTGS',
  'IMPS':        'IMPS',
  'ATM':         'ATM',
  'POS':         'POS',
  'NACH':        'NACH',
  'ECS':         'ECS',
  'ACH':         'ACH',
  'NET BANKING': 'Net Banking',
  'NETBANKING':  'Net Banking',
  'CREDIT CARD': 'Credit Card',
  'DEBIT CARD':  'Debit Card',
  'WALLET':      'Wallet',
};

// ─── Taxonomy ─────────────────────────────────────────────────────────────────
//
// ARRAY ORDER MATTERS — first match with highest pattern score wins.
// Entries that share keywords with broader categories must come FIRST.
// Example: OTT (amazon prime) must be above Shopping (amazon) so that
// "Amazon Prime" resolves to OTT and not Shopping.
//
// Convention (kept consistent across every entry, including new ones added
// in this pass): multi-word patterns always use \s+ between words (never a
// literal space, since real SMS text varies — double spaces, tabs from
// template padding, etc. are common), and every pattern carries the /i flag.
// Case-sensitive or rigid-space patterns are treated as bugs in this file.

interface TaxonomyEntry {
  type:         TxnType;
  category:     string;
  sub_category: string | null;
  patterns:     RegExp[];
  direction?:   'credit' | 'debit';
  minAmount?:   number;
  maxAmount?:   number;
}

const TAXONOMY: TaxonomyEntry[] = [

  // ── Food & Dining ─────────────────────────────────────────────────────────
  { type: 'Expense', category: 'Food & Dining', sub_category: 'Quick Commerce',
    direction: 'debit',
    patterns: [
      /\bblinkit\b/i,
      // [FIX] \bzepto\b → \bzepto (no trailing \b) — ZEPTONOW was not matching.
      /\bzepto/i,
      /\bswiggy\s+instamart\b/i,
      /\binstamart\b/i,
      /\bdunzo\b/i,
    ] },

  // [FIX] Removed maxAmount:2000 — no logical cap on restaurant bills.
  // [FIX] domino'?s? → dominos? — "Dominos" (no apostrophe) was not matching.
  // [FIX] Added: dining, coffee, meal.
  // NOTE: \bhotel\b intentionally NOT here — in South India "hotel" is a
  // common restaurant name (Saravana Bhavan, Geetham etc.). Standalone hotel
  // routes to pending_review; user classifies once via custom categories.
  // NOTE: \bpluxee\b and \bmeal\s+card\b intentionally NOT here — Pluxee is
  // a payment instrument. Merchant at POS determines category.
  { type: 'Expense', category: 'Food & Dining', sub_category: 'Restaurants',
    direction: 'debit',
    patterns: [
      /\bzomato\b/i, /\bswiggy\b/i, /\brestaurant\b/i, /\bpizza\s+hut\b/i,
      /\bdominos?\b/i, /\bkfc\b/i, /\bmcdonald'?s?\b/i, /\bsubway\b/i,
      /\bburger\s+king\b/i, /\bstarbucks\b/i, /\bcafe\b/i,
      /\bdining\b/i, /\bcoffee\b/i, /\bmeal\b/i,
      // [ADD — this pass] Generic sweets/bhavan-chain patterns. "Bhavan"
      // is a common South Indian vegetarian-restaurant naming convention
      // (Saravana Bhavan, Adyar Ananda Bhavan/A2B, etc.) — distinct from
      // the \bhotel\b exclusion noted above, since "bhavan" doesn't carry
      // the same lodging ambiguity "hotel" does in Indian usage.
      // \bsweets?\b and \bmithai\b cover sweet shops generically
      // (confirmed real gap: "SHREE GURU SWEETS", "MEENA MITHAI MANDIR"
      // both landed uncategorized). Deliberately generic — keyed on the
      // naming convention, not any single merchant name.
      /\bbhavan\b/i, /\bsweets?\b/i, /\bmithai\b/i,
    ] },

  { type: 'Expense', category: 'Food & Dining', sub_category: 'Groceries',
    direction: 'debit',
    patterns: [/\bbigbasket\b/i, /\bd[\s-]?mart\b/i, /\breliance\s+(fresh|smart)\b/i,
               /\bsupermarket\b/i, /\bgrocery\b/i, /\bbig\s+bazaar\b/i] },

  // [ADD — this pass] Milk & Dairy. Deliberately its own sub_category
  // rather than folded into Groceries — recurring daily/monthly milk-booth
  // debits have a very different spending pattern than one-off grocery
  // runs, and keeping them separate makes any future spend-trend feature
  // more useful. \bmilk\b alone is broad (could theoretically false-positive
  // on an unrelated merchant name containing "milk"), but the false-positive
  // cost here is low and the false-negative cost of requiring more context
  // is high — most milk-booth SMS are terse.
  { type: 'Expense', category: 'Food & Dining', sub_category: 'Milk & Dairy',
    direction: 'debit',
    patterns: [/\bmilk\b/i, /\bdairy\b/i, /\bmilk\s+booth\b/i] },

  // ── Entertainment — OTT MUST be above Shopping ────────────────────────────
  // [FIX] Moved OTT block above Shopping to fix Amazon Prime tie-break.
  // Previously OTT was below Shopping, so "Amazon Prime" scored 1 on both
  // and Shopping won because it appeared first in the array.
  { type: 'Expense', category: 'Entertainment', sub_category: 'OTT Subscriptions',
    direction: 'debit',
    patterns: [
      /\bnetflix\b/i, /\bhotstar\b/i, /\bdisney\+?\s*hotstar\b/i,
      /\bamazon\s+prime\b/i,   // explicit "amazon prime" — must be here, not Shopping
      /\bsonyliv\b/i, /\bzee5\b/i,
    ] },

  // ── Shopping ──────────────────────────────────────────────────────────────
  // [FIX — this pass] direction: 'debit' added. Real data showed refund
  // credits from these same merchants (e.g. "Credit Alert! Rs.246.00
  // credited...from VPA flipkart.hypg@yespay", "...from VPA
  // amazon.refunds@axisbank") were matching this bare merchant-name
  // pattern and getting tagged as Shopping spend with a POSITIVE amount —
  // a sign-inconsistent, confusing result (money coming IN labeled as an
  // expense category). A genuine online-shopping purchase is always a
  // debit; a credit from these merchants is a refund/cashback, not a new
  // purchase. Same root-cause class as the PPF/SSY direction fix above.
  { type: 'Expense', category: 'Shopping', sub_category: 'Online Shopping',
    direction: 'debit',
    patterns: [
      // [FIX] \bamazon\b(?!\s+prime) — negative lookahead prevents "Amazon Prime"
      // from matching here (it already matched OTT above).
      /\bamazon\b(?!\s+prime)/i,
      /\bflipkart\b/i, /\bmyntra\b/i, /\bnykaa\b/i, /\bmeesho\b/i,
    ] },

  { type: 'Expense', category: 'Shopping', sub_category: 'Electronics',
    direction: 'debit',
    patterns: [/\bcroma\b/i, /\bvijay\s+sales\b/i, /\breliance\s+digital\b/i] },

  // ── Transportation ────────────────────────────────────────────────────────
  { type: 'Expense', category: 'Transportation', sub_category: 'Tolls & FASTag',
    direction: 'debit',
    patterns: [/\bfastag\b/i, /\bnhai\b/i, /\btoll\s+(plaza|gate|debit|charge)\b/i] },

  { type: 'Expense', category: 'Transportation', sub_category: 'Ride Hailing',
    // [ADD — this pass] "roppentransport" — Roppen Transportation Services
    // Pvt Ltd is Rapido's registered legal entity name, which is what some
    // POS/UPI-handle SMS templates surface as the merchant instead of
    // "Rapido". Different string entirely from the existing \brapido\b
    // pattern (no shared substring), so needs its own pattern, not a
    // matching-algorithm fix. Verified clean against all real merchant
    // names across both users — no collisions.
    direction: 'debit',
    patterns: [/\buber\b/i, /\bola\b/i, /\brapido\b/i, /\bblusmart\b/i, /\broppentransport\b/i] },

  { type: 'Expense', category: 'Transportation', sub_category: 'Fuel',
    direction: 'debit',
    patterns: [/\bpetrol\s+(pump|station|bunk)\b/i, /\bhpcl\b/i, /\biocl\b/i, /\bbpcl\b/i] },

  // [ADD] Transportation > Bus
  { type: 'Expense', category: 'Transportation', sub_category: 'Bus',
    direction: 'debit',
    patterns: [/\bredbus\b/i, /\babhibus\b/i, /\bkeybus\b/i] },

  // [FIX — this pass] direction: 'debit' added. Real data showed IRCTC
  // refund credits (both a direct "Credit Alert...from VPA
  // irctc.payu@mairtel" and a "ticket cancelled...will be refunded"
  // message) matching this bare merchant-name pattern and getting tagged
  // as Transportation spend with a POSITIVE amount. Booking a train/metro
  // ticket is always a debit; a credit mentioning these merchants is a
  // cancellation refund, not a new fare purchase. Same root-cause class as
  // the PPF/SSY direction fix above.
  { type: 'Expense', category: 'Transportation', sub_category: 'Public Transit',
    direction: 'debit',
    patterns: [
      /\bmetro\s+(rail|card|recharge|fare)\b/i,
      /\birctc\b/i,
      /\bindian\s+railways?\b/i,
      // [ADD] autope — IRCTC payment gateway used for transit/rail payments
      /\bautope\b/i,
    ] },

  // [ADD — this pass] Transportation > Parking. Evidenced directly in live
  // data ("EXPRESS AVENUE PARKING", "CMRL GOVERNMENT ESTATE PA" — the
  // latter almost certainly a metro-station parking area abbreviation).
  { type: 'Expense', category: 'Transportation', sub_category: 'Parking',
    direction: 'debit',
    patterns: [/\bparking\b/i] },

  // [ADD — this pass] Transportation > Vehicle Service & Repair. Evidenced
  // directly in live data ("HARDEEP MOTORS"). \bmotors?\b is broad (many
  // Indian vehicle dealers/service centres use "Motors" in their name) —
  // accepted tradeoff since a false positive here just means a vehicle
  // -adjacent spend gets a vehicle-adjacent category, low real-world cost.
  { type: 'Expense', category: 'Transportation', sub_category: 'Vehicle Service & Repair',
    direction: 'debit',
    patterns: [
      /\bmotors?\b/i, /\bgarage\b/i, /\bworkshop\b/i,
      /\bcar\s+service\b/i, /\bbike\s+service\b/i, /\bauto\s*mobile\b/i,
    ] },

  // ── Utilities ─────────────────────────────────────────────────────────────
  { type: 'Expense', category: 'Utilities', sub_category: 'Electricity',
    // [ADD — this pass] National electricity DISCOM abbreviations beyond the
    // existing Karnataka (escom/bescom) and Maharashtra (mseb) coverage —
    // Tamil Nadu, Kerala, Maharashtra, Punjab, UP, West Bengal, Haryana (x2),
    // Rajasthan, MP, Andhra (x2), Telangana, West Bengal private, Gujarat
    // private, Mumbai/Delhi private. Verified clean against all real
    // merchant names across both users — no collisions.
    direction: 'debit',
    patterns: [/\bescom\b/i, /\bmseb\b/i, /\bbescom\b/i, /\btata\s+power\b/i,
               /\bpower\s+(bill|payment)\b/i, /\belectricity\s+(bill|payment)\b/i,
               /\btangedco\b/i, /\btneb\b/i, /\bkseb\b/i, /\bmsedcl\b/i,
               /\bpspcl\b/i, /\buppcl\b/i, /\bwbsedcl\b/i, /\bdhbvn\b/i,
               /\buhbvn\b/i, /\bjvvnl\b/i, /\bmppkvvcl\b/i, /\bapspdcl\b/i,
               /\bapepdcl\b/i, /\btsspdcl\b/i, /\bcesc\b/i,
               /\btorrent\s*power\b/i, /\badani\s*electricity\b/i] },

  { type: 'Expense', category: 'Utilities', sub_category: 'Gas',
    direction: 'debit',
    patterns: [/\bgas\s+(bill|payment)\b/i, /\bindane\b/i, /\bbharat\s+gas\b/i, /\bhp\s+gas\b/i] },

  // [ADD — this pass] Utilities > Piped Gas (PNG). Kept distinct from
  // cylinder Gas above — billing pattern (metered, monthly) differs from
  // cylinder refills. Bare \bpng\b intentionally excluded (too short, risks
  // matching unrelated 3-letter occurrences); requires accompanying context.
  { type: 'Expense', category: 'Utilities', sub_category: 'Piped Gas',
    direction: 'debit',
    patterns: [
      /\bpiped\s+gas\b/i, /\bpng\s+bill\b/i,
      /\bmahanagar\s+gas\b/i, /\bindraprastha\s+gas\b/i,
    ] },

  // [ADD — this pass] Utilities > Water.
  { type: 'Expense', category: 'Utilities', sub_category: 'Water',
    direction: 'debit',
    patterns: [
      /\bwater\s+(bill|tax|tanker|board|supply|charge)\b/i,
      /\bbwssb\b/i, /\bhmwssb\b/i, /\bjal\s+board\b/i,
      // [ADD — this pass] cmwssb = Chennai Metropolitan Water Supply and
      // Sewerage Board; djb = Delhi Jal Board; mcgm = Mumbai's municipal
      // corporation (handles water billing among other services). Verified
      // clean against all real merchant names across both users — cmwssb
      // matches only the intended real merchant, no false positives.
      /\bcmwssb\b/i, /\bdjb\b/i, /\bmcgm\b/i,
    ] },

  // [ADD — this pass] Utilities > DTH & Cable TV. No prior category existed
  // for this at all.
  { type: 'Expense', category: 'Utilities', sub_category: 'DTH & Cable TV',
    direction: 'debit',
    patterns: [
      /\btata\s*sky\b/i, /\bd2h\b/i, /\bdish\s*tv\b/i,
      /\bsun\s+direct\b/i, /\bdth\s+recharge\b/i, /\bcable\s+tv\b/i,
    ] },

  // ── Telecom ───────────────────────────────────────────────────────────────
  // [FIX — REGRESSION, this pass] Jio and Airtel Mobile Recharge patterns.
  // Previous fix required a qualifying word after the brand name to avoid
  // matching JioMart/JioSaavn/Airtel Xstream/Airtel Payments Bank — but that
  // also broke the ordinary case: a real recharge SMS to bare merchant "JIO"
  // or "airtel" (no qualifying word present anywhere in the text) stopped
  // matching entirely. Restored bare brand-name matching, using a negative
  // lookahead to exclude the known false-positive suffixes instead of
  // requiring a suffix. "fiber" is excluded from both here so Jio
  // Fiber/Airtel Fiber fall through to the Broadband entry below instead of
  // tying with (and, by array order, losing to) this entry.
  { type: 'Expense', category: 'Telecom', sub_category: 'Mobile Recharge',
    direction: 'debit',
    patterns: [
      /\bjio\b(?!\s*(mart|saavn|cinema|hotstar|fiber))/i,
      /\breliance\s+jio\b/i,
      /\bairtel\b(?!\s*(xstream|payments\s*bank|thanks|fiber))/i,
      /\bbharti\s+airtel\b/i,
      /\bmobile\s+(recharge|topup)\b/i,
      /\btalktime\b/i,
    ] },

  // [FIX — this pass] Broadband generalized beyond Jio Fiber/Airtel Fiber —
  // any ISP debit was previously falling through entirely. Also added
  // generic wifi/internet bill patterns for ISPs not explicitly named.
  { type: 'Expense', category: 'Utilities', sub_category: 'Broadband',
    direction: 'debit',
    patterns: [
      /\bjio\s+fiber\b/i, /\bairtel\s+fiber\b/i,
      /\bact\s+fibernet\b/i, /\bhathway\b/i, /\bexcitel\b/i, /\bbsnl\s+broadband\b/i,
      /\bbroadband\s+(bill|payment)\b/i, /\bwifi\s+(bill|recharge)\b/i,
      /\binternet\s+(bill|recharge)\b/i,
    ] },

  // ── Healthcare ────────────────────────────────────────────────────────────
  // [FIX — this pass] Added \bmedicals?\b — "GANESH MEDICALS" and similar
  // (extremely common Indian pharmacy-naming convention) only had
  // \bpharmacy\b to match against before this.
  { type: 'Expense', category: 'Healthcare', sub_category: 'Pharmacy',
    direction: 'debit',
    patterns: [/\bapollo\s+pharmacy\b/i, /\bmedplus\b/i, /\bnetmeds\b/i,
               /\bpharmeasy\b/i, /\b1mg\b/i, /\bpharmacy\b/i, /\bmedicals?\b/i] },

  { type: 'Expense', category: 'Healthcare', sub_category: 'Hospital & Clinic',
    // [ADD — this pass] "bone" — orthopedic/bone-joint clinics commonly
    // include it directly in the business name (e.g. "STAR BONE JOINT
    // CENTER"). Verified clean against every real merchant name across both
    // users — matches only the intended orthopedic clinic, no collisions.
    direction: 'debit',
    patterns: [/\bhospital\b/i, /\bclinic\b/i, /\bfortis\b/i,
               /\bapollo\s+hospitals?\b/i, /\bconsultation\s+fee\b/i, /\bbone\b/i] },

  // ── Entertainment (Movies) ────────────────────────────────────────────────
  { type: 'Expense', category: 'Entertainment', sub_category: 'Movies & Events',
    direction: 'debit',
    patterns: [
      /\bbookmyshow\b/i,
      // [FIX] \bpvr\b → \bpvr (no trailing \b) — pvrinox was not matching.
      /\bpvr/i,
      /\binox\b/i,
      /\bcinepolis\b/i,
    ] },

  // ── Education ─────────────────────────────────────────────────────────────
  { type: 'Expense', category: 'Education', sub_category: 'Tuition & Courses',
    direction: 'debit',
    patterns: [/\bbyju'?s?\b/i, /\bunacademy\b/i, /\budemy\b/i,
               /\bschool\s+fee\b/i, /\bcollege\s+fee\b/i, /\btuition\s+fee\b/i] },

  // ── Travel ────────────────────────────────────────────────────────────────
  { type: 'Expense', category: 'Travel', sub_category: 'Flight',
    direction: 'debit',
    patterns: [
      /\bindigo\b/i, /\bair\s+india\b/i, /\bspicejet\b/i,
      /\bvistara\b/i, /\bflight\s+ticket\b/i,
      // [ADD] OTA platforms for flight booking
      /\bcleartrip\b/i, /\beasemytrip\b/i, /\bixigo\b/i,
    ] },

  // [FIX] Renamed sub_category 'Hotel' → 'Accommodation' to avoid collision
  // with South Indian restaurant naming ("Hotel Saravana Bhavan" etc.).
  // Patterns: only unambiguous accommodation signals retained.
  // \bhotel\b alone removed — it is ambiguous in Indian context.
  // \bhotel\s+booking\b kept — "hotel booking" strongly implies a stay.
  { type: 'Expense', category: 'Travel', sub_category: 'Accommodation',
    direction: 'debit',
    patterns: [
      /\boyorooms?\b/i, /\btreebo\b/i, /\bfabhotel\b/i,
      /\bhotel\s+booking\b/i, /\bgoibibo\b/i,
      /\bbooking\.com\b/i, /\bairbnb\b/i, /\bmakemytrip\b/i,
    ],
    minAmount: 500 },

  // [ADD — this pass] Travel > General Travel. Local travel agencies (e.g.
  // "SETHUMEENA TRAVELS" in live data) don't match any airline/OTA brand
  // name above and had nowhere to land. Placed after the more specific
  // Flight/Accommodation entries so brand-specific matches still win ties
  // when a merchant name happens to contain both.
  { type: 'Expense', category: 'Travel', sub_category: 'General Travel',
    direction: 'debit',
    patterns: [/\btravels?\b/i] },

  // ── Rent & Housing ────────────────────────────────────────────────────────
  { type: 'Expense', category: 'Rent & Housing', sub_category: 'House Rent',
    direction: 'debit',
    patterns: [/\bhouse\s+rent\b/i, /\bflat\s+rent\b/i,
               /\brent\s+(payment|paid|transfer)\b/i, /\bmonthly\s+rent\b/i] },

  // [ADD — this pass] Rent & Housing > Maintenance & Society Charges (RWA).
  // \brwa\b alone is a risky bare 3-letter match, so it's required to
  // appear with a qualifying word; the other patterns are specific enough
  // to stand alone.
  { type: 'Expense', category: 'Rent & Housing', sub_category: 'Maintenance & Society Charges',
    direction: 'debit',
    patterns: [
      /\bmaintenance\s+(charge|fee|bill)\b/i, /\bsociety\s+maintenance\b/i,
      /\bapartment\s+maintenance\b/i, /\bflat\s+maintenance\b/i,
      /\brwa\s+(maintenance|charge|fee)\b/i,
    ] },

  // ── Finance Charges ───────────────────────────────────────────────────────
  { type: 'Expense', category: 'Finance Charges', sub_category: 'Cash Withdrawal',
    direction: 'debit',
    patterns: [/\batm\s+(debit|withdrawal|wdl|cash)\b/i, /\bcash\s+withdrawal\b/i] },

  { type: 'Expense', category: 'Finance Charges', sub_category: 'Bank Charges',
    direction: 'debit',
    patterns: [/\bservice\s+charge\b/i, /\bannual\s+(fee|charge)\b/i,
               /\bpenalty\b/i, /\blate\s+payment\s+fee\b/i] },

  // ── Household (new category, this pass) ───────────────────────────────────
  { type: 'Expense', category: 'Household', sub_category: 'Newspaper & Magazine',
    direction: 'debit',
    patterns: [/\bnewspaper\b/i, /\bmagazine\s+subscription\b/i, /\bnews\s+agency\b/i] },

  // Pest control, plumber, electrician, appliance repair, RO/water-purifier
  // service — generic keyword signals, none existed anywhere before this.
  { type: 'Expense', category: 'Household', sub_category: 'Home Services',
    direction: 'debit',
    patterns: [
      /\bpest\s+control\b/i, /\bplumber\b/i, /\belectrician\b/i,
      /\bappliance\s+repair\b/i, /\bro\s+service\b/i, /\bwater\s+purifier\s+service\b/i,
      /\burban\s*company\b/i,
    ] },

  { type: 'Expense', category: 'Household', sub_category: 'Stationery',
    direction: 'debit',
    patterns: [/\bstationers?\b/i, /\bstationery\b/i] },

  // ── Personal Care & Fitness (new categories, this pass) ───────────────────
  { type: 'Expense', category: 'Personal Care', sub_category: null,
    direction: 'debit',
    patterns: [/\bsalon\b/i, /\bspa\b/i, /\bparlour\b/i, /\bbarber\b/i] },

  { type: 'Expense', category: 'Fitness & Gym', sub_category: null,
    direction: 'debit',
    patterns: [/\bgym\b/i, /\bfitness\b/i, /\bcult\.?fit\b/i, /\byoga\s+class\b/i] },

  // ── Courier & Postal (new category, this pass) ────────────────────────────
  { type: 'Expense', category: 'Courier & Postal', sub_category: null,
    direction: 'debit',
    patterns: [
      /\bdtdc\b/i, /\bblue\s*dart\b/i, /\bindia\s+post\b/i,
      /\bdelhivery\b/i, /\bekart\b/i, /\bxpressbees\b/i,
    ] },

  // ── Taxes & Government (new category, this pass) ──────────────────────────
  // \btds\b bare is short but the surrounding banking-SMS context makes
  // false positives unlikely in practice.
  { type: 'Expense', category: 'Taxes & Government', sub_category: null,
    direction: 'debit',
    patterns: [
      /\bincome\s+tax\b/i, /\bgst\s+payment\b/i, /\bproperty\s+tax\b/i,
      /\bmunicipal\s+tax\b/i, /\btraffic\s+challan\b/i, /\be-?challan\b/i,
      /\btds\b/i,
    ] },

  // ── Subscriptions (new category, this pass) ───────────────────────────────
  // CURATED LIST — see change-log note at top of file. Unlike every other
  // entry in this taxonomy, there is no generic keyword that means
  // "subscription" without false-positiving on ordinary business names.
  // This list needs periodic manual maintenance as new services appear.
  { type: 'Expense', category: 'Subscriptions', sub_category: null,
    direction: 'debit',
    patterns: [
      /\bspotify\b/i, /\byoutube\s+premium\b/i, /\bapple\s+(music|one|icloud)\b/i,
      /\bmicrosoft\s*365\b/i, /\bgoogle\s+(one|workspace|storage)\b/i,
      // [ADD] Google Play / "Google India Digital Serv" — the actual
      // merchant name banks show for Google Play Store purchases (app
      // purchases, subscriptions billed through Play Store, etc.).
      // Confirmed missing in real data: ₹3,655 and ₹3,731 debits to
      // "Google India Digital Serv" via UPI landed as category: null
      // because this entry only matched google+one/workspace/storage.
      // Deliberately does NOT match bare "google pay" — that's a payment
      // channel/app name (GPay), not a merchant, and would false-positive
      // on completely unrelated UPI payments made "via Google Pay."
      // "play" and "india digital" are distinct tokens from "pay", so no
      // overlap risk.
      /\bgoogle\s+(play|india\s+digital)\b/i,
      /\banthropic\b/i, /\bclaude\b/i, /\bopenai\b/i, /\bchatgpt\b/i,
      /\bcanva\b/i, /\bdropbox\b/i, /\bnotion\b/i, /\baws\b/i,
    ] },

  // ── Income ────────────────────────────────────────────────────────────────
  { type: 'Income', category: 'Salary', sub_category: 'Monthly Salary',
    direction: 'credit',
    patterns: [
      /\bsalary\b/i, /\bsal\s+credit\b/i, /\bpayroll\b/i,
      /\bach\s+(credit|cr)\b/i, /\bcorporate\s+credit\b/i,
      // [ADD] Employer NEFT salary credits not caught by \bsalary\b keyword.
      // "NEFT Cr-BOFA0MM6205-LOGITECH ENGINEERING AND DESIGNS-VIJAYARAGHAVAN C"
      //
      // [FIX — this pass] Narrowed with a negative lookahead. Confirmed real
      // false positive: "NEFT Cr-CIUB0000032-LIC INDIA D075-P N SRIDEVI..."
      // — an LIC policy payout (maturity/bonus), not wages — was matching
      // the bare phrase and getting labeled Monthly Salary. "NEFT Cr" is
      // generic NEFT-credit narration used for insurance payouts, refunds,
      // dividends, and vendor payments alike, not specific to payroll; on
      // its own it's too weak a signal to decide Salary. The lookahead
      // blocks the match when a clearly-non-employer term appears within
      // the same narration segment, while leaving the original LOGITECH
      // example (no such term nearby) matching exactly as before. This is
      // a narrow patch for the one confirmed case, not a general solution —
      // an employer name will always be open-ended and un-listable the same
      // way merchant names are; the real fix is the same confidence-gating/
      // custom_categories direction already discussed and deferred for
      // that broader class of problem.
      /\bneft\s+cr\b(?!.{0,60}?\b(?:lic|insurance|assurance|amc|mutual\s+fund|dividend|interest|refund)\b)/i,
    ] },

  { type: 'Income', category: 'Refunds', sub_category: 'Purchase Refund',
    direction: 'credit',
    patterns: [/\brefund\b/i, /\bcashback\b/i, /\brefunded\b/i] },

  // [FIX — this pass] Split out of the Purchase Refund entry above.
  // "reversal"/"reversed" was previously lumped in with "refund"/
  // "cashback" under the same sub_category, but they're not the same
  // event: a merchant refund is new money coming back after a purchase; a
  // payment reversal is YOUR OWN money bouncing back because a transfer
  // failed (e.g. "Ac XX0778 credited Rs.50000.00...for reversal of UPI
  // txn" — confirmed real example, not a purchase refund at all).
  // Conflating them overstates income/savings-rate by counting a failed
  // send-then-return as if it were new money. Kept under the same
  // top-level Refunds category (not a new one) so the existing
  // runContraDetection() type==='Income' exclusion guard still applies —
  // see the original comment this replaces for why that guard matters:
  // an uncategorized reversal has type: null and isn't excluded by it,
  // so it can get wrongly matched against the original failed debit as a
  // "possible internal transfer". Distinguishing the sub_category doesn't
  // change that protection, just makes it possible for downstream
  // aggregates (e.g. health modules) to tell the two apart instead of
  // reporting a reversal as if it were real refund income.
  { type: 'Income', category: 'Refunds', sub_category: 'Payment Reversal',
    direction: 'credit',
    patterns: [/\breversal\b/i, /\bamount\s+reversed\b/i, /\breversed\b/i] },

  { type: 'Income', category: 'Passive Income', sub_category: 'Interest Income',
    direction: 'credit',
    patterns: [/\binterest\s+(credit|credited|received)\b/i,
               /\bfd\s+interest\b/i, /\bsavings\s+interest\b/i] },

  // [ADD] Stock Dividend income — distinct from interest income.
  // "3rd Interim Dividend of 50 paise per share for FY 2025-26 by Manappuram Finance"
  // direction: credit — dividends are always credits.
  { type: 'Income', category: 'Dividends', sub_category: 'Stock Dividend',
    direction: 'credit',
    patterns: [/\bdividend\b/i] },

  // [ADD — this pass] Income > Bank Deposit > Cheque. Confirmed real gap:
  // "Update! INR 23,000.00 deposited...for CHQ DEP-CTS CLG2-CHENNAI RK
  // SALAI - CTS.Avl bal...Cheque deposits in A/C are subject to clearing"
  // landed uncategorized. Deliberately does NOT use a bare \bcheque\b
  // pattern — verified against the real corpus that "Cheque deposits in
  // A/C are subject to clearing" is generic footer boilerplate present on
  // 41 different messages (NEFT/IB transfer credits etc.), not specific to
  // actual cheque deposits — a bare pattern would have massively
  // over-matched. \bchq\s*dep\b is the specific signal (CTS = Cheque
  // Truncation System, the actual clearing-house code), confirmed to match
  // only the one real cheque-deposit transaction in the corpus.
  // sub_category explicitly labelled 'Cheque' rather than left null, per
  // product request — otherwise there's no way to tell, just by looking at
  // a transaction row, where this credit actually came from.
  { type: 'Income', category: 'Bank Deposit', sub_category: 'Cheque',
    direction: 'credit',
    patterns: [/\bchq\s*dep\b/i, /\bcheque\s+deposit(?:ed)?\b/i] },

  // ── Investment ────────────────────────────────────────────────────────────
  { type: 'Investment', category: 'Mutual Funds', sub_category: 'SIP',
    // [FIX] \bsip\b → requires qualifying context word.
    // Bare \bsip\b was firing on "sip gateway" (a payment gateway, not SIP investment).
    // "sip of", "sip installment", "sip debited", "sip payment", "sip contribution"
    patterns: [
      /\bsip\s+(of|installment|debit(?:ed)?|payment|contribution)\b/i,
      /\bsystematic\s+investment\s+plan\b/i,
    ] },

  // [FIX — this pass] direction: 'debit' added. Real data showed a Zerodha
  // "quarterly settlement payout" credit (unused margin returned to the
  // user, not a stock trade) matching this bare merchant-name pattern and
  // getting tagged as Investment > Stocks > Equity Purchase with a
  // POSITIVE amount — self-contradictory, since a "purchase" by definition
  // costs money. A genuine equity purchase is always a debit; a credit
  // from a broker is a settlement, withdrawal, or dividend (dividends are
  // already separately handled by the Income > Dividends entry above).
  // Same root-cause class as the PPF/SSY direction fix above.
  { type: 'Investment', category: 'Stocks', sub_category: 'Equity Purchase',
    direction: 'debit',
    patterns: [/\bzerodha\b/i, /\bgroww\b/i, /\bupstox\b/i,
               /\bangelone\b/i, /\bangel\s+one\b/i, /\bdhan\b/i] },

  // [ADD — this pass] Investment > Gold.
  { type: 'Investment', category: 'Gold', sub_category: null,
    patterns: [
      /\bsafegold\b/i, /\bdigital\s+gold\b/i, /\bpaytm\s+gold\b/i,
      /\bsovereign\s+gold\s+bond\b/i, /\bgold\s+bond\b/i,
    ] },

  // [ADD — this pass] Investment > Bonds — new category, not previously in
  // TAXONOMY. Verified /\bbond\b/i clean against every real merchant name
  // across both users except the one it's meant to catch (a NetBanking
  // payment to "CSHFREINDIABONDPRIVA" — Cashfree India Bond Private — which
  // needs the merchant-scoped loose-match pass above, since "bond" has no
  // word boundary inside that glued merchant string). Does not conflict
  // with the more specific "sovereign gold bond"/"gold bond" patterns above
  // — those score higher (2 pattern hits vs. 1) for an actual gold-bond
  // purchase, so Gold still wins that scoring comparison as it should.
  //
  // [REQUIRED COMPANION CHANGE] 'Bonds' must also be added to
  // transactionCategories.ts's TAXONOMY.Investment array (with a
  // subCategories: ['Bond Purchase'] entry) or transactions in this
  // category will render as "Uncategorized" in the UI despite being
  // correctly classified here — the exact three-way taxonomy mismatch
  // documented at the top of transactionCategories.ts.
  { type: 'Investment', category: 'Bonds', sub_category: 'Bond Purchase',
    patterns: [/\bbond\b/i] },

  // [FIX] Removed \bbajaj\s+finserv\b — Bajaj Finserv is primarily EMI/lending.
  // Bajaj Allianz kept (insurance-only entity, unambiguous).
  // [ADD] shriramlife — Shriram Life Insurance.
  { type: 'Investment', category: 'Insurance', sub_category: 'Life Insurance',
    patterns: [
      /\blic\s+(premium|policy)\b/i, /\bterm\s+(plan|insurance)\b/i,
      /\binsurance\s+premium\b/i, /\bpolicy\s+premium\b/i,
      /\bbajaj\s+allianz\b/i,
      // [ADD]
      /\bshriram\s*life\b/i, /\bshriramlife\b/i,
    ] },

  // [ADD] manipalcigna — ManipalCigna Health Insurance.
  { type: 'Investment', category: 'Insurance', sub_category: 'Health Insurance',
    patterns: [
      /\bhealth\s+insurance\b/i, /\bmediclaim\b/i, /\bstar\s+health\b/i,
      // [ADD]
      /\bmanipal\s*cigna\b/i, /\bmanipalcigna\b/i,
    ] },

  // [ADD — this pass] Investment > Insurance > Motor Insurance. No prior
  // category existed for vehicle insurance at all.
  { type: 'Investment', category: 'Insurance', sub_category: 'Motor Insurance',
    patterns: [
      /\bmotor\s+insurance\b/i, /\bvehicle\s+insurance\b/i,
      /\bcar\s+insurance\b/i, /\bbike\s+insurance\b/i,
      /\bicici\s+lombard\b/i, /\bhdfc\s+ergo\b/i, /\bbajaj\s+allianz\s+general\b/i,
    ] },

  // ── Liability ─────────────────────────────────────────────────────────────
  { type: 'Liability', category: 'EMI', sub_category: 'Loan EMI',
    patterns: [/\bemi\s+(deducted|debited|paid)\b/i, /\bloan\s+emi\b/i,
               /\bnach\s+debit\b/i, /\bauto\s+debit\s+emi\b/i] },

  { type: 'Liability', category: 'Loans', sub_category: 'Home Loan',
    patterns: [/\bhome\s+loan\b/i, /\bhousing\s+loan\b/i, /\bmortgage\b/i] },

  { type: 'Liability', category: 'Loans', sub_category: 'Personal Loan',
    patterns: [/\bpersonal\s+loan\b/i, /\binstant\s+loan\b/i] },

  // ── Asset ─────────────────────────────────────────────────────────────────
  { type: 'Asset', category: 'Bank Deposits', sub_category: 'Fixed Deposit',
    patterns: [/\bfixed\s+deposit\b/i, /\bfd\s+(created|booked|opened)\b/i] },

  { type: 'Asset', category: 'Government Schemes', sub_category: 'NPS',
    patterns: [/\bnps\b/i, /\bnational\s+pension\s+(scheme|system)\b/i] },

  // [ADD — this pass] Asset > Government Schemes > PPF/SSY. Filed under
  // Asset to match the existing NPS entry's type — flagging that NPS (Asset)
  // and SIP (Investment, above) currently sit under different top-level
  // `type`s despite being similar long-term-savings instruments; not
  // changed here since it wasn't clear whether that split is intentional.
  // Also acts as a safety net for transactions.ts's DEFINITIONAL_CONTRA_RULES
  // (GENERIC_PPF_SSY), which currently has no Layer-2 rule feeding it that
  // we can see from this file — if Layer 2 never sets matched_rule to
  // GENERIC_PPF_SSY, this at least gets the transaction categorized instead
  // of falling through uncategorized.
  // [FIX — this pass] direction: 'debit' added. Without it, an incoming
  // transfer whose narration happens to say "PPF" (real example: a
  // person's own transfers, some captioned "PPF", others "House expenses",
  // same person/amount, only the PPF-captioned ones were affected) got
  // classified as if the money arriving WAS a PPF asset. PPF/SSY is only
  // ever a real asset-classification event when money is actually moving
  // OUT to the scheme, never on the credit side — an incoming credit that
  // happens to mention PPF is not itself a contribution. Matters beyond
  // mislabeling: health-module risk/liquidity scoring reads this
  // category, so an unrestricted credit match double-counts the same PPF
  // contribution (once when it arrives from wherever, again when it's
  // actually moved into PPF).
  { type: 'Asset', category: 'Government Schemes', sub_category: 'PPF/SSY',
    direction: 'debit',
    patterns: [
      /\bppf\b/i, /\bpublic\s+provident\s+fund\b/i,
      /\bsukanya\s+samriddhi\b/i, /\bssy\b/i,
    ] },
];

// ─── merchant_key normaliser ──────────────────────────────────────────────────
// Produces a stable, case-insensitive, truncation-safe key for custom category
// lookup. Strips everything except alphanumeric and @ (to preserve VPA handles).
// Max 40 chars to match the DB column length.
// Use this key — not the display merchant string — when reading/writing
// customCatData, both on-device and in the backend.

function normaliseMerchantKey(merchant: string | null): string | null {
  if (!merchant) return null;
  return merchant
    .toLowerCase()
    .replace(/[^a-z0-9@]/g, '')   // keep only alphanum + @ for VPAs
    .substring(0, 40)             // max 40 chars
    || null;                      // return null if result is empty string
}

// ─── Main export ──────────────────────────────────────────────────────────────

export function parseSmsMessages(
  messages: RawMessage[]
): (ParsedTransaction | BalanceUpdate)[] {
  return messages.map(msg => parseSingleSms(msg));
}

// ─── Single message orchestrator ─────────────────────────────────────────────

function parseSingleSms(msg: RawMessage): ParsedTransaction | BalanceUpdate {
  const body    = msg.body;
  const isInfra = UPI_INFRA_SENDERS.some(s => msg.address.toUpperCase().includes(s));
  const msgDate = new Date(msg.date).toISOString().split('T')[0];

  // ── LAYER 2 ───────────────────────────────────────────────────────────────
  const l2 = matchMessage(body, msgDate);

  if (l2 && l2.discard) {
    // [ADD] Pure balance-disclosure SMS — never a transaction. Return a
    // distinct BalanceUpdate so the caller updates accounts.balance_latest
    // directly and never inserts into transactions or pending_review.
    if (l2.reason === 'balance_disclosure_no_transaction') {
      return {
        kind:                   'balance_update',
        raw_sms_id:             msg.id,
        account_number_masked:  l2.account_number_masked,
        bank:                   l2.bank,
        balance:                l2.balance,
        message_date:           msgDate,
      };
    }
    // [FIX] Was hardcoded to 'declined_transaction' regardless of the actual
    // reason — cc_emi_conversion_not_new_txn discards were being mislabeled.
    return buildDiscarded(msg, msgDate, isInfra, l2.reason);
  }

  if (l2 && !l2.discard) {
    const isCredit = l2.direction === 'credit';
    const classification = l2.suggested_category
      ? parseSuggestedCategory(l2.suggested_category)
      : classify(body.toLowerCase(), isCredit, l2.amount, l2.channel, l2.merchant);

    const signedAmount = isCredit ? Math.abs(l2.amount) : -Math.abs(l2.amount);

    // [REVERTED — see change log] A prior pass added `|| !classification`
    // here, forcing review on every transaction with no category at all.
    // That conflated two different questions: "is this transaction's facts
    // (amount/account/direction) possibly wrong?" — worth blocking on — vs.
    // "do we just not have a category label for it?" — not a correctness
    // risk, especially for the large P2P bucket (payments to named
    // individuals) where no category will ever be derivable from text
    // alone. Forcing review on missing-category alone put ~217 of 263
    // transactions in the queue in practice, most of them P2P transfers
    // with nothing actually wrong. Reverted to the original three
    // conditions. Missing category is still visible and actionable — the
    // Transactions tab can surface "no category" as a lightweight
    // tap-to-tag affordance on approved rows (category IS NULL is a trivial
    // filter) — without gating the transaction's approval on it.
    const needsReview =
      !l2.account_number_masked   ||
      Math.abs(l2.amount) >= 5000 ||
      l2.requires_classification;

    // [ADD — this pass] NACH-channel classify() fallback (see below) returns
    // a generic "Recurring Payment > NACH Mandate" classification instead of
    // null so the row isn't left fully uncategorized — but it's still a
    // guess, not a confident match, so it must still route to pending_review
    // regardless of the `!classification` check above (which would no
    // longer fire since classification is non-null here). forcedReview
    // covers that case explicitly.
    const isUnconfidentNachGuess =
      classification?.category === 'Recurring Payment' &&
      classification?.sub_category === 'NACH Mandate';

    return {
      kind:                   'transaction',
      raw_sms_id:             msg.id,
      txn_date:               l2.txn_date || msgDate,
      amount:                 signedAmount,
      type:                   classification?.type        ?? null,
      category:               classification?.category    ?? null,
      sub_category:           classification?.sub_category ?? null,
      merchant:               l2.merchant,
      merchant_key:           normaliseMerchantKey(l2.merchant),
      source:                 'sms',
      status:                 (needsReview || isUnconfidentNachGuess) ? 'pending_review' : 'approved',
      account_number_masked:  l2.account_number_masked,
      bank:                   l2.bank,
      channel:                l2.channel,
      balance:                l2.balance ?? null,
      ref_number:             l2.ref_number,
      ref_type:               l2.ref_type,
      matched_rule:           l2.matched_rule,
      confidence:             l2.confidence,
      requires_classification: l2.requires_classification || isUnconfidentNachGuess,
      possible_contra:        l2.possible_contra,
      txn_group_id:           null,
      is_infrastructure:      isInfra,
      health_module_tag:      null,
      parse_failure:          null,
      raw_text:               body,
    };
  }

  // ── TAXONOMY FALLBACK ─────────────────────────────────────────────────────
  const extracted = extractFields(body);

  if (extracted.amount === null) {
    return buildEscalated(msg, msgDate, isInfra, extracted, 'missing_amount');
  }
  if (extracted.isCredit === null) {
    return buildEscalated(msg, msgDate, isInfra, extracted, 'unknown_direction');
  }

  const classification = classify(body.toLowerCase(), extracted.isCredit, extracted.amount, extracted.channel, extracted.merchant);

  if (!classification) {
    return buildEscalated(msg, msgDate, isInfra, extracted, 'escalated_to_haiku');
  }

  const signedAmount = extracted.isCredit
    ? Math.abs(extracted.amount)
    : -Math.abs(extracted.amount);

  const needsReview =
    !extracted.accountLast4 ||
    Math.abs(extracted.amount) >= 5000;

  return {
    kind:                   'transaction',
    raw_sms_id:             msg.id,
    txn_date:               msgDate,
    amount:                 signedAmount,
    type:                   classification.type,
    category:               classification.category,
    sub_category:           classification.sub_category,
    merchant:               extracted.merchant,
    merchant_key:           normaliseMerchantKey(extracted.merchant),
    source:                 'sms',
    status:                 needsReview ? 'pending_review' : 'approved',
    account_number_masked:  extracted.accountLast4,
    bank:                   extracted.bank,
    channel:                extracted.channel,
    balance:                extracted.balance,
    ref_number:              extracted.ref_number,
    ref_type:                extracted.ref_type,
    matched_rule:            null,
    confidence:              0.7,
    requires_classification: false,
    possible_contra:         false,
    txn_group_id:            null,
    is_infrastructure:       isInfra,
    health_module_tag:       null,
    parse_failure:           null,
    raw_text:                body,
  };
}

// ─── Build helpers ────────────────────────────────────────────────────────────

function buildDiscarded(
  msg: RawMessage,
  msgDate: string,
  isInfra: boolean,
  reason: string,
): ParsedTransaction {
  return {
    kind: 'transaction',
    raw_sms_id: msg.id, txn_date: msgDate, amount: null,
    type: null, category: null, sub_category: null,
    merchant: null, merchant_key: null,
    source: 'sms', status: 'pending_review',
    account_number_masked: null, bank: null, channel: null, balance: null,
    ref_number: null, ref_type: null,
    matched_rule: null, confidence: null,
    requires_classification: false, possible_contra: false,
    txn_group_id: null, is_infrastructure: isInfra, health_module_tag: null,
    parse_failure: reason, raw_text: msg.body,
  };
}

function buildEscalated(
  msg: RawMessage,
  msgDate: string,
  isInfra: boolean,
  extracted: ExtractedFields,
  reason: string,
): ParsedTransaction {
  const signedAmount = extracted.amount === null
    ? null
    : extracted.isCredit === null
      ? null
      : extracted.isCredit
        ? Math.abs(extracted.amount)
        : -Math.abs(extracted.amount);

  return {
    kind: 'transaction',
    raw_sms_id: msg.id, txn_date: msgDate,
    amount: signedAmount,
    type: null, category: null, sub_category: null,
    merchant:     extracted.merchant,
    merchant_key: normaliseMerchantKey(extracted.merchant),
    source: 'sms', status: 'pending_review',
    account_number_masked: extracted.accountLast4,
    bank: extracted.bank, channel: extracted.channel, balance: extracted.balance,
    ref_number: extracted.ref_number, ref_type: extracted.ref_type,
    matched_rule: null, confidence: null,
    requires_classification: false, possible_contra: false,
    txn_group_id: null, is_infrastructure: isInfra, health_module_tag: null,
    parse_failure: reason, raw_text: msg.body,
  };
}

// ─── Field extractors ─────────────────────────────────────────────────────────

function extractFields(body: string): ExtractedFields {
  const bodyLower = body.toLowerCase();
  const bodyUpper = body.toUpperCase();
  return {
    amount:       extractAmount(body),
    isCredit:     extractDirection(bodyLower),
    accountLast4: extractAccountLast4(bodyLower),
    merchant:     extractMerchant(body),
    bank:         detectBank(bodyUpper, body),
    channel:      detectChannel(bodyUpper),
    balance:      extractBalance(body),
    ...extractRefNumber(body),
  };
}

function extractAmount(body: string): number | null {
  const patterns = [
    /INR\s+([\d,]+(?:\.\d{1,2})?)/i,
    /Rs\.?\s*([\d,]+(?:\.\d{1,2})?)/i,
    /₹\s*([\d,]+(?:\.\d{1,2})?)/,
    /([\d,]+\.\d{2})\s*(?:has been|debited|credited|deducted)/i,
  ];
  for (const p of patterns) {
    const m = body.match(p);
    if (m) {
      const n = parseFloat(m[1].replace(/,/g, ''));
      if (!isNaN(n) && n > 0) return n;
    }
  }
  return null;
}

function extractDirection(bodyLower: string): boolean | null {
  // [FIX] 'paid to'/'paid via'/'paid for'/'used for'/'withdrawal' were missing
  // here even though Layer 1 (Kotlin) already recognizes them as debit
  // signals and lets those messages through — this fallback couldn't
  // classify direction for them, so they were escalated as
  // 'unknown_direction' instead of being handled locally. Now that Layer 2
  // has dedicated rules for most of these, this fallback should rarely be
  // hit for them, but kept in sync for the messages that still reach here.
  const debitKw = [
    'debited', 'deducted', 'withdrawn', 'withdrawal', 'spent', 'payment of',
    'transferred to', 'sent to', 'purchase', 'charged',
    'emi due', 'emi paid', 'emi deducted', 'premium of',
    'paid to', 'paid via', 'paid for', 'paid towards', 'used for', 'cleared',
  ];
  const creditKw = [
    'credited', 'received', 'deposited', 'refund', 'salary',
    'reversed', 'cashback', 'added to', 'transfer from', 'disbursed',
    'neft cr', 'imps cr', 'ach credit',
  ];
  const debitScore  = debitKw.filter(kw => bodyLower.includes(kw)).length;
  const creditScore = creditKw.filter(kw => bodyLower.includes(kw)).length;
  if (debitScore  > creditScore) return false;
  if (creditScore > debitScore)  return true;
  if (debitScore  > 0)           return false;
  return null;
}

function extractAccountLast4(bodyLower: string): string | null {
  const patterns = [
    /(?:a\/c|acct?|account|card|ac)[\s.#:]*(?:no\.?|number|ending|xx+|\.+)?\s*[x*]*(\d{4})\b/i,
    /(?:xx|\.{2,}|\*+)(\d{4})\b/i,
    /\b(\d{4})\s+(?:is credited|is debited|has been)/i,
  ];
  for (const p of patterns) {
    const m = bodyLower.match(p);
    if (m) return m[1];
  }
  return null;
}

// [FIX] Added "balance is Rs." pattern for Indian Railways RWallet SMS.
function extractBalance(body: string): number | null {
  const patterns = [
    /(?:avl\.?\s*bal(?:ance)?|available\s+balance|bal(?:ance)?(?:\s+is)?)[:\s]+(?:inr|rs\.?|₹)?\s*([\d,]+(?:\.\d{1,2})?)/i,
    /(?:a\/c\s+bal|ac\s+balance)[:\s]+(?:inr|rs\.?|₹)?\s*([\d,]+(?:\.\d{1,2})?)/i,
    /balance\s+is\s+(?:rs\.?|inr|₹)\s*([\d,]+(?:\.\d{1,2})?)/i,
  ];
  for (const p of patterns) {
    const m = body.match(p);
    if (m) {
      const n = parseFloat(m[1].replace(/,/g, ''));
      if (!isNaN(n)) return n;
    }
  }
  return null;
}

function extractMerchant(body: string): string | null {
  const upiMatch = body.match(/(?:to|from)\s+([A-Za-z0-9 &._-]{2,40})@[a-z]+/i);
  if (upiMatch) return upiMatch[1].trim();
  const atMatch = body.match(/\bat\s+([A-Za-z0-9 &._-]{2,40})(?:\s+on|\s+for|[,.])/i);
  if (atMatch) return atMatch[1].trim();
  const towardsMatch = body.match(/towards\s+([A-Za-z0-9 &._-]{2,40})(?:\s+on|\s+for|[,.])/i);
  if (towardsMatch) return towardsMatch[1].trim();
  return null;
}

function detectBank(bodyUpper: string, body: string): string | null {
  for (const [kw, name] of Object.entries(BANK_MAP)) {
    if (bodyUpper.includes(kw)) return name;
  }
  const vpaMatch = body.match(/[\w.\-]+@(\w+)/i);
  if (vpaMatch) {
    const domain = vpaMatch[1].toLowerCase();
    if (UPI_DOMAIN_MAP[domain]) return UPI_DOMAIN_MAP[domain];
  }
  return null;
}

function detectChannel(bodyUpper: string): string | null {
  for (const [kw, label] of Object.entries(CHANNEL_MAP)) {
    if (bodyUpper.includes(kw)) return label;
  }
  return null;
}

function extractRefNumber(body: string): Pick<ExtractedFields, 'ref_number' | 'ref_type'> {
  const neftPatterns = [
    /(?:utr|neft\s*ref|neft\s*no\.?|rtgs\s*ref)[:\s#]*([A-Z]{4}\d{12,18})/i,
    /\b([A-Z]{4}\d{12,18})\b/,
  ];
  for (const p of neftPatterns) {
    const m = body.match(p);
    if (m) return { ref_number: m[1].toUpperCase(), ref_type: 'neft_utr' };
  }
  const upiPatterns = [
    /(?:upi\s*ref(?:\s*no\.?)?|rrn|ref\s*no\.?|transaction\s*id)[:\s#]*(\d{12})\b/i,
  ];
  for (const p of upiPatterns) {
    const m = body.match(p);
    if (m) return { ref_number: m[1], ref_type: 'upi_rrn' };
  }
  return { ref_number: null, ref_type: null };
}

// ─── Taxonomy classifier ──────────────────────────────────────────────────────

// [FIX — this pass] Every pattern in TAXONOMY is \b-bounded, which only ever
// matches merchant names embedded in naturally spaced bank text ("To ADYAR
// ANANDA BHAVAN SWEET On..."). It structurally cannot match the same real
// merchant when a different SMS template glues the name together with no
// separators (UPI-handle / POS-terminal style: "At adyaranandabhavanswe.6325
// by UPI...") — "bhavan" has word characters on both sides there, so no \b
// transition exists, no matter how many merchant strings get added to the
// list. Confirmed on 988 real transactions across two users: the same real
// merchant (Amazon, Google Play, Decathlon, Adyar Ananda Bhavan, Aakash
// Hospital...) classifies correctly under one SMS template and silently
// falls through to unclassified under the other, purely because of spacing.
//
// Fix: a second pass, scoped ONLY to the isolated merchant field (never the
// full body), tests a boundary-stripped ("loose") version of the same
// pattern against a space-stripped merchant string. Scoping to merchant-only
// — not the whole message — is deliberate and load-bearing: an earlier
// version of this fix tested loosened patterns against the whole body and
// caused real regressions (e.g. /\brefund\b/i, boundary-stripped, became a
// bare substring match that also fired on "refunded" — a word the taxonomy
// deliberately keeps as a separate pattern — double-counting one narrative
// word as two pattern hits and flipping an already-correct classification).
// Narrative/context patterns (refund, refunded, salary, meal, dining...)
// only ever run against the properly-spaced full body, exactly as before.
// Only patterns representing merchant-identity keywords get the loose
// merchant-only pass, and only when the normal pass already failed.
//
// LOOSE_MATCH_DENYLIST — patterns unsafe to loosen even scoped to merchant-
// only: complete standalone short brand tokens that are also common Indian
// name/word roots (e.g. "dhan" — the Dhan trading app — is a common root in
// names like Dhanalakshmi, Dhanush; boundary-stripped it false-matched real
// unrelated person/store names in live data). Verified by testing every
// pattern in TAXONOMY against every real unclassified merchant/person name
// across two independent users' full transaction history — this was the
// only genuine collision found. Re-run that same check before trusting any
// newly-added pattern; add to this set if it turns up another one.
// [FIX — this pass] Added \bspa\b. Confirmed real bug: boundary-stripped,
// "spa" substring-matches inside "yespay" (the bank-domain suffix on
// flipkart.hypg@yespay), mislabeling genuine Flipkart refund credits as
// "Personal Care". Same collision class as the existing "dhan" entry —
// a short, common-letter-sequence pattern that reads fine word-bounded
// but false-positives constantly once boundaries are stripped.
const LOOSE_MATCH_DENYLIST = new Set<string>([
  '\\bdhan\\b',
  '\\bspa\\b',
]);

// [ADD — this pass] General safeguard alongside the denylist above, for
// the same bug class rather than one more entry per incident. Checked
// against every real merchant string in the corpus: every pattern with a
// stripped alnum core of 3 characters or fewer that WAS needed via loose
// matching (i.e. didn't already match directly on the full message body)
// turned out to be an accidental collision ("spa" in "yespay") — while
// every pattern of 4+ characters that loose-matched turned out to be a
// genuine hit (e.g. "bond" inside a glued "...INDIABONDPRIVA..." payee
// name — a real bonds platform, correctly identified). A flat length
// floor isn't a perfect substitute for actually checking real data before
// trusting a new pattern, but it closes off the specific risk class that
// caused the "spa" bug automatically, for every future pattern, without
// waiting for it to mislabel a real transaction first.
const MIN_LOOSE_MATCH_CORE_LENGTH = 4;

function looseCoreLength(pattern: RegExp): number {
  return pattern.source.replace(/[^a-zA-Z0-9]/g, '').length;
}

const looseVariantCache = new WeakMap<RegExp, RegExp>();

function toLooseVariant(pattern: RegExp): RegExp {
  const cached = looseVariantCache.get(pattern);
  if (cached) return cached;
  // Drop \b anchors (no boundaries exist in a glued string) and \s+/\s*
  // (no separators exist either), so the same keyword still matches once
  // merchant text has been fused together by the SMS template.
  const looseSource = pattern.source
    .replace(/\\b/g, '')
    .replace(/\\s\+/g, '')
    .replace(/\\s\*/g, '');
  const loose = new RegExp(looseSource, pattern.flags);
  looseVariantCache.set(pattern, loose);
  return loose;
}

function toNoSpaceMerchant(merchant: string | null | undefined): string {
  if (!merchant) return '';
  return merchant.toLowerCase().replace(/[^a-z0-9]/g, '');
}

// [FIX — this pass] Added optional `channel` param, used only for the NACH
// fallback below. Every existing call site is updated to pass it through
// (l2.channel or extracted.channel) — behaviour for every other message is
// unchanged, since the fallback only triggers when channel === 'NACH' AND
// no text pattern matched anything.
//
// [FIX — this pass] Added optional `merchant` param, used only for the
// merchant-scoped loose-match fallback described above. Every existing call
// site is updated to pass it through (l2.merchant or extracted.merchant).
function classify(
  bodyLower: string,
  isCredit: boolean,
  amount: number,
  channel?: string | null,
  merchant?: string | null,
): Classification | null {
  const direction = isCredit ? 'credit' : 'debit';
  const merchantNoSpace = toNoSpaceMerchant(merchant);
  let bestEntry: TaxonomyEntry | null = null;
  let bestScore = 0;

  for (const entry of TAXONOMY) {
    if (entry.direction && entry.direction !== direction) continue;
    if (entry.maxAmount !== undefined && amount > entry.maxAmount) continue;
    if (entry.minAmount !== undefined && amount < entry.minAmount) continue;
    const score = entry.patterns.filter(p => {
      if (p.test(bodyLower)) return true;
      if (!merchantNoSpace || LOOSE_MATCH_DENYLIST.has(p.source)) return false;
      if (looseCoreLength(p) < MIN_LOOSE_MATCH_CORE_LENGTH) return false;
      return toLooseVariant(p).test(merchantNoSpace);
    }).length;
    if (score > bestScore) { bestScore = score; bestEntry = entry; }
  }

  if (bestEntry) {
    return {
      type:         bestEntry.type,
      category:     bestEntry.category,
      sub_category: bestEntry.sub_category,
    };
  }

  // [ADD — this pass] NACH fallback. No text pattern matched anything, but
  // Layer 2 (or extractFields()) already told us this is a NACH mandate
  // debit — a real, recurring, non-P2P payment to a registered entity
  // (typically a clearing house acting on behalf of a SIP/insurance/EMI
  // mandate; live data showed "INDIAN CLEARING CORP LTD" as 100% of NACH
  // matches, 20 of 259 transactions in one 90-day sample, all previously
  // uncategorized). Rather than leave this fully blank, return a generic
  // label — the caller (parseSingleSms) still forces pending_review for
  // this specific classification via isUnconfidentNachGuess, so this is a
  // helpful default label, not a confident auto-approval.
  if (!isCredit && channel === 'NACH') {
    return {
      type:         'Liability',
      category:     'Recurring Payment',
      sub_category: 'NACH Mandate',
    };
  }

  return null;
}

function parseSuggestedCategory(suggested: string): Classification | null {
  if (!suggested) return null;
  const parts = suggested.split(':');
  if (parts.length < 2) return null;
  return {
    type:         parts[0] as TxnType,
    category:     parts[1],
    sub_category: parts[2] ?? null,
  };
}