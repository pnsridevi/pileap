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
  ref_type:              'upi_rrn' | 'neft_utr' | 'unknown' | null;

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
    patterns: [
      /\bzomato\b/i, /\bswiggy\b/i, /\brestaurant\b/i, /\bpizza\s+hut\b/i,
      /\bdominos?\b/i, /\bkfc\b/i, /\bmcdonald'?s?\b/i, /\bsubway\b/i,
      /\bburger\s+king\b/i, /\bstarbucks\b/i, /\bcafe\b/i,
      /\bdining\b/i, /\bcoffee\b/i, /\bmeal\b/i,
    ] },

  { type: 'Expense', category: 'Food & Dining', sub_category: 'Groceries',
    patterns: [/\bbigbasket\b/i, /\bd[\s-]?mart\b/i, /\breliance\s+(fresh|smart)\b/i,
               /\bsupermarket\b/i, /\bgrocery\b/i, /\bbig\s+bazaar\b/i] },

  // ── Entertainment — OTT MUST be above Shopping ────────────────────────────
  // [FIX] Moved OTT block above Shopping to fix Amazon Prime tie-break.
  // Previously OTT was below Shopping, so "Amazon Prime" scored 1 on both
  // and Shopping won because it appeared first in the array.
  { type: 'Expense', category: 'Entertainment', sub_category: 'OTT Subscriptions',
    patterns: [
      /\bnetflix\b/i, /\bhotstar\b/i, /\bdisney\+?\s*hotstar\b/i,
      /\bamazon\s+prime\b/i,   // explicit "amazon prime" — must be here, not Shopping
      /\bsonyliv\b/i, /\bzee5\b/i,
    ] },

  // ── Shopping ──────────────────────────────────────────────────────────────
  { type: 'Expense', category: 'Shopping', sub_category: 'Online Shopping',
    patterns: [
      // [FIX] \bamazon\b(?!\s+prime) — negative lookahead prevents "Amazon Prime"
      // from matching here (it already matched OTT above).
      /\bamazon\b(?!\s+prime)/i,
      /\bflipkart\b/i, /\bmyntra\b/i, /\bnykaa\b/i, /\bmeesho\b/i,
    ] },

  { type: 'Expense', category: 'Shopping', sub_category: 'Electronics',
    patterns: [/\bcroma\b/i, /\bvijay\s+sales\b/i, /\breliance\s+digital\b/i] },

  // ── Transportation ────────────────────────────────────────────────────────
  { type: 'Expense', category: 'Transportation', sub_category: 'Tolls & FASTag',
    patterns: [/\bfastag\b/i, /\bnhai\b/i, /\btoll\s+(plaza|gate|debit|charge)\b/i] },

  { type: 'Expense', category: 'Transportation', sub_category: 'Ride Hailing',
    patterns: [/\buber\b/i, /\bola\b/i, /\brapido\b/i, /\bblusmart\b/i] },

  { type: 'Expense', category: 'Transportation', sub_category: 'Fuel',
    patterns: [/\bpetrol\s+(pump|station|bunk)\b/i, /\bhpcl\b/i, /\biocl\b/i, /\bbpcl\b/i] },

  // [ADD] Transportation > Bus
  { type: 'Expense', category: 'Transportation', sub_category: 'Bus',
    patterns: [/\bredbus\b/i, /\babhibus\b/i, /\bkeybus\b/i] },

  { type: 'Expense', category: 'Transportation', sub_category: 'Public Transit',
    patterns: [
      /\bmetro\s+(rail|card|recharge|fare)\b/i,
      /\birctc\b/i,
      /\bindian\s+railways?\b/i,
      // [ADD] autope — IRCTC payment gateway used for transit/rail payments
      /\bautope\b/i,
    ] },

  // ── Utilities ─────────────────────────────────────────────────────────────
  { type: 'Expense', category: 'Utilities', sub_category: 'Electricity',
    patterns: [/\bescom\b/i, /\bmseb\b/i, /\bbescom\b/i, /\btata\s+power\b/i,
               /\bpower\s+(bill|payment)\b/i, /\belectricity\s+(bill|payment)\b/i] },

  { type: 'Expense', category: 'Utilities', sub_category: 'Gas',
    patterns: [/\bgas\s+(bill|payment)\b/i, /\bindane\b/i, /\bbharat\s+gas\b/i, /\bhp\s+gas\b/i] },

  // ── Telecom ───────────────────────────────────────────────────────────────
  // [FIX] Expanded Jio and Airtel patterns.
  // Problem: standalone \bjio\b fired on JioMart, JioSaavn, JioCinema.
  // Problem: standalone \bairtel\b fired on Airtel Xstream Play, Airtel Payments Bank.
  // Fix: require a qualifying word after brand name OR use full brand name.
  { type: 'Expense', category: 'Telecom', sub_category: 'Mobile Recharge',
    patterns: [
      /\bjio\s*(recharge|prepaid|postpaid|bill|mobile|sim|plan|pack)\b/i,
      /\breliance\s+jio\b/i,
      /\bairtel\s*(recharge|prepaid|postpaid|bill|mobile|sim|plan|pack|fiber)\b/i,
      /\bbharti\s+airtel\b/i,
      /\bmobile\s+(recharge|topup)\b/i,
      /\btalktime\b/i,
    ] },

  { type: 'Expense', category: 'Telecom', sub_category: 'Broadband',
    patterns: [/\bjio\s+fiber\b/i, /\bairtel\s+fiber\b/i, /\bbroadband\s+(bill|payment)\b/i] },

  // ── Healthcare ────────────────────────────────────────────────────────────
  { type: 'Expense', category: 'Healthcare', sub_category: 'Pharmacy',
    patterns: [/\bapollo\s+pharmacy\b/i, /\bmedplus\b/i, /\bnetmeds\b/i,
               /\bpharmeasy\b/i, /\b1mg\b/i, /\bpharmacy\b/i] },

  { type: 'Expense', category: 'Healthcare', sub_category: 'Hospital & Clinic',
    patterns: [/\bhospital\b/i, /\bclinic\b/i, /\bfortis\b/i,
               /\bapollo\s+hospitals?\b/i, /\bconsultation\s+fee\b/i] },

  // ── Entertainment (Movies) ────────────────────────────────────────────────
  { type: 'Expense', category: 'Entertainment', sub_category: 'Movies & Events',
    patterns: [
      /\bbookmyshow\b/i,
      // [FIX] \bpvr\b → \bpvr (no trailing \b) — pvrinox was not matching.
      /\bpvr/i,
      /\binox\b/i,
      /\bcinepolis\b/i,
    ] },

  // ── Education ─────────────────────────────────────────────────────────────
  { type: 'Expense', category: 'Education', sub_category: 'Tuition & Courses',
    patterns: [/\bbyju'?s?\b/i, /\bunacademy\b/i, /\budemy\b/i,
               /\bschool\s+fee\b/i, /\bcollege\s+fee\b/i, /\btuition\s+fee\b/i] },

  // ── Travel ────────────────────────────────────────────────────────────────
  { type: 'Expense', category: 'Travel', sub_category: 'Flight',
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
    patterns: [
      /\boyorooms?\b/i, /\btreebo\b/i, /\bfabhotel\b/i,
      /\bhotel\s+booking\b/i, /\bgoibibo\b/i,
      /\bbooking\.com\b/i, /\bairbnb\b/i, /\bmakemytrip\b/i,
    ],
    minAmount: 500 },

  // ── Rent & Housing ────────────────────────────────────────────────────────
  { type: 'Expense', category: 'Rent & Housing', sub_category: 'House Rent',
    patterns: [/\bhouse\s+rent\b/i, /\bflat\s+rent\b/i,
               /\brent\s+(payment|paid|transfer)\b/i, /\bmonthly\s+rent\b/i] },

  // ── Finance Charges ───────────────────────────────────────────────────────
  { type: 'Expense', category: 'Finance Charges', sub_category: 'Cash Withdrawal',
    patterns: [/\batm\s+(debit|withdrawal|wdl|cash)\b/i, /\bcash\s+withdrawal\b/i] },

  { type: 'Expense', category: 'Finance Charges', sub_category: 'Bank Charges',
    patterns: [/\bservice\s+charge\b/i, /\bannual\s+(fee|charge)\b/i,
               /\bpenalty\b/i, /\blate\s+payment\s+fee\b/i] },

  // ── Income ────────────────────────────────────────────────────────────────
  { type: 'Income', category: 'Salary', sub_category: 'Monthly Salary',
    direction: 'credit',
    patterns: [
      /\bsalary\b/i, /\bsal\s+credit\b/i, /\bpayroll\b/i,
      /\bach\s+(credit|cr)\b/i, /\bcorporate\s+credit\b/i,
      // [ADD] Employer NEFT salary credits not caught by \bsalary\b keyword.
      // "NEFT Cr-BOFA0MM6205-LOGITECH ENGINEERING AND DESIGNS-VIJAYARAGHAVAN C"
      /\bneft\s+cr\b/i,
    ] },

  { type: 'Income', category: 'Refunds', sub_category: 'Purchase Refund',
    patterns: [/\brefund\b/i, /\bcashback\b/i, /\breversal\b/i,
               /\bamount\s+reversed\b/i, /\brefunded\b/i] },

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

  // ── Investment ────────────────────────────────────────────────────────────
  { type: 'Investment', category: 'Mutual Funds', sub_category: 'SIP',
    // [FIX] \bsip\b → requires qualifying context word.
    // Bare \bsip\b was firing on "sip gateway" (a payment gateway, not SIP investment).
    // "sip of", "sip installment", "sip debited", "sip payment", "sip contribution"
    patterns: [
      /\bsip\s+(of|installment|debit(?:ed)?|payment|contribution)\b/i,
      /\bsystematic\s+investment\s+plan\b/i,
    ] },

  { type: 'Investment', category: 'Stocks', sub_category: 'Equity Purchase',
    patterns: [/\bzerodha\b/i, /\bgroww\b/i, /\bupstox\b/i,
               /\bangelone\b/i, /\bangel\s+one\b/i, /\bdhan\b/i] },

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

export function parseSmsMessages(messages: RawMessage[]): ParsedTransaction[] {
  return messages.map(msg => parseSingleSms(msg));
}

// ─── Single message orchestrator ─────────────────────────────────────────────

function parseSingleSms(msg: RawMessage): ParsedTransaction {
  const body    = msg.body;
  const isInfra = UPI_INFRA_SENDERS.some(s => msg.address.toUpperCase().includes(s));
  const msgDate = new Date(msg.date).toISOString().split('T')[0];

  // ── LAYER 2 ───────────────────────────────────────────────────────────────
  const l2 = matchMessage(body, msgDate);

  if (l2 && l2.discard) {
    return buildDiscarded(msg, msgDate, isInfra, 'declined_transaction');
  }

  if (l2 && !l2.discard) {
    const isCredit = l2.direction === 'credit';
    const classification = l2.suggested_category
      ? parseSuggestedCategory(l2.suggested_category)
      : classify(body.toLowerCase(), isCredit, l2.amount);

    const signedAmount = isCredit ? Math.abs(l2.amount) : -Math.abs(l2.amount);

    // [FIX] Added || l2.requires_classification — person VPA credits were
    // auto-approved. They need user confirmation of what the payment was for.
    const needsReview =
      !l2.account_number_masked   ||
      Math.abs(l2.amount) >= 5000 ||
      l2.requires_classification;

    return {
      raw_sms_id:             msg.id,
      txn_date:               l2.txn_date || msgDate,
      amount:                 signedAmount,
      type:                   classification?.type        ?? null,
      category:               classification?.category    ?? null,
      sub_category:           classification?.sub_category ?? null,
      merchant:               l2.merchant,
      merchant_key:           normaliseMerchantKey(l2.merchant),
      source:                 'sms',
      status:                 needsReview ? 'pending_review' : 'approved',
      account_number_masked:  l2.account_number_masked,
      bank:                   l2.bank,
      channel:                l2.channel,
      balance:                l2.balance ?? null,
      ref_number:             l2.ref_number,
      ref_type:               l2.ref_type,
      matched_rule:           l2.matched_rule,
      confidence:             l2.confidence,
      requires_classification: l2.requires_classification,
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

  const classification = classify(body.toLowerCase(), extracted.isCredit, extracted.amount);

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
    ref_number:             extracted.ref_number,
    ref_type:               extracted.ref_type,
    matched_rule:           null,
    confidence:             0.7,
    requires_classification: false,
    possible_contra:        false,
    txn_group_id:           null,
    is_infrastructure:      isInfra,
    health_module_tag:      null,
    parse_failure:          null,
    raw_text:               body,
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

function classify(
  bodyLower: string,
  isCredit: boolean,
  amount: number,
): Classification | null {
  const direction = isCredit ? 'credit' : 'debit';
  let bestEntry: TaxonomyEntry | null = null;
  let bestScore = 0;

  for (const entry of TAXONOMY) {
    if (entry.direction && entry.direction !== direction) continue;
    if (entry.maxAmount !== undefined && amount > entry.maxAmount) continue;
    if (entry.minAmount !== undefined && amount < entry.minAmount) continue;
    const score = entry.patterns.filter(p => p.test(bodyLower)).length;
    if (score > bestScore) { bestScore = score; bestEntry = entry; }
  }

  if (!bestEntry) return null;
  return {
    type:         bestEntry.type,
    category:     bestEntry.category,
    sub_category: bestEntry.sub_category,
  };
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