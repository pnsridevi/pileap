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
 *   ── This pass (merchant taxonomy expansion, per pileap_module_merchant_
 *      taxonomy.md) ──────────────────────────────────────────────────────
 *   [ADD] TaxonomyEntry.ambiguous / Classification.ambiguous — forces
 *         pending_review in BOTH parseSingleSms branches when a
 *         classification is a best-guess for a merchant whose SMS text
 *         structurally can't distinguish between multiple real categories.
 *   [FIX] Investment > Stocks > Equity Purchase (Zerodha/Groww/Upstox/etc.)
 *         — marked ambiguous:true. A bare debit to a broker platform has no
 *         text signal distinguishing equity purchase from MF-via-Coin, a
 *         bond purchase, F&O margin, or gold — was previously guessed as
 *         Equity Purchase and auto-approved every time. Real fix (not this
 *         pass) is a Table-X-style "what do you use this broker for"
 *         registration so this stops needing to guess per-transaction.
 *   [ADD] Broker list expanded: 5paisa, ICICI Direct, HDFC Securities,
 *         Kotak Securities, Motilal Oswal, IIFL Securities, Sharekhan,
 *         Paytm Money, IndMoney, Axis Direct, SBI Securities, Fyers, Alice Blue.
 *   [ADD] Mutual Funds > SIP — named AMC direct-debit patterns (HDFC/SBI/
 *         ICICI Pru/Axis/Nippon India/UTI/Kotak MF, Mirae Asset, Franklin
 *         Templeton, DSP, ABSL MF, Parag Parikh, Quant MF) + aggregators
 *         (Kuvera, ET Money, Zerodha Coin). NOT ambiguous — an AMC only
 *         ever does mutual funds, unlike a broker/aggregator platform.
 *   [ADD] Bonds — IndiaBonds, Wint Wealth, GoldenPi. Gold — Augmont.
 *   [ADD] Insurance > Life — HDFC Life, ICICI Prudential Life, SBI Life,
 *         Max Life, Tata AIA, PNB MetLife, Kotak Life, ABSL Insurance,
 *         Canara HSBC Life, Star Union Dai-ichi, Future Generali Life.
 *   [ADD] Insurance > Health — Niva Bupa, Max Bupa, Care Health, HDFC Ergo
 *         Health, ICICI Lombard Health, ABSL Health, Reliance Health,
 *         Bajaj Allianz Health, National Insurance.
 *   [ADD] Insurance > Motor — Tata AIG, Digit, Acko (latter two require
 *         qualifying "insurance"/"policy" context — bare tokens are common
 *         enough word/name roots to risk the same collision class as the
 *         existing dhan/spa loose-match denylist entries).
 *   [ADD] Insurance > Annuity/Pension — new sub-category, named providers
 *         only (LIC Jeevan Shanti, HDFC Life Click2Retire).
 *   [ADD] Loans > Auto Loan (new) — Sundaram Finance, Mahindra Finance, TVS Credit.
 *   [ADD] Loans > Education Loan (new) — Avanse, HDFC Credila, Auxilo.
 *   [ADD] Loans > Gold Loan (new) — Muthoot, Manappuram.
 *   [ADD] Loans > Personal Loan — Bajaj Finserv, Fullerton, IDFC First,
 *         Tata Capital, Navi, KreditBee, MoneyTap, CASHe.
 *   [ADD] Loans > Home Loan — LIC HFL, ICICI Home Finance.
 *   [ADD] BNPL — new category (LazyPay, Simpl, ZestMoney, Amazon Pay Later).
 *   [ADD] Bank Deposits > Recurring Deposit — new sub-category, taxonomy
 *         doc flagged zero prior coverage.
 *   [ADD] Government Schemes > SCSS/NSC/KVP — new sub-category, no prior coverage.
 *   [NOT DONE — deliberately] Real estate, P2P lending, REITs/InvITs
 *         (unless broker-routed, already covered by the broker expansion),
 *         rental income, freelance income, domestic help/rent — taxonomy
 *         doc tags these [CUSTOM], not [REGEX]. No universal SMS pattern
 *         exists for person/entity-specific payees; left unaddressed here
 *         by design, pending the custom_categories write path (see
 *         transactions.ts gap #8).
 *   [NOT DONE — deliberately] Travel insurance — taxonomy doc warns this is
 *         usually a small bundled add-on inside a flight/OTA booking and
 *         must NOT get miscounted as Insurance Cover; no safe text signal
 *         separates it from the parent booking, so no pattern was added.
 *
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
// [CONFIRMED, not a bug] './layer2_ruleset.js' and 'ruleset.js' are two
// copies of the same rules, kept in sync manually — 'layer2_ruleset.js' is
// the on-device/JS-only testing copy used until the Kotlin native module
// (SmsReaderModule.kt) ships; 'ruleset.js' is the production target. Any
// fix landing in one (e.g. the merchant '/' stop-token fix) must be
// mirrored into the other until they're unified.
const { matchMessage } = require('./layer2_ruleset.js');

// [ADD] Confidence gate — standalone module, not yet wired to affect any
// real decision. See confidenceGate.js's own header for full scope/history.
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { assessConfidence } = require('./confidenceGate.js');

// ─── Platform-agnostic input (arch 10.2) ─────────────────────────────────────

export interface RawMessage {
  id:      string;   // idempotency key
  address: string;   // SMS shortcode or email sender domain
  body:    string;   // raw message text
  date:    number;   // epoch milliseconds
}

// ─── Logging only — NOT wired to any real decision or Haiku call ────────────
//
// Two separate logs, deliberately kept apart because they mean different
// things:
//
// Log A ("haiku candidates") — messages that already, today, get routed
// toward eventual Haiku escalation via the existing pending_review /
// parse_failure mechanism (missing_amount, unknown_direction,
// escalated_to_haiku). This is just a record of that already-happening
// path; nothing here changes what parseSingleSms returns for these rows.
//
// Log B ("low confidence") — messages Layer 2 matched and would otherwise
// treat as fully successful, but which the confidence gate (see
// confidenceGate.js) thinks look structurally suspicious. These do NOT go
// to Haiku today and their status/parse_failure is completely unaffected
// by this — this is purely "if the gate were live, this is what it would
// have flagged," for later comparison against ground truth.
//
// Both are optional and additive: if the caller doesn't pass a `logs`
// object into parseSmsMessages(), nothing is collected and behavior is
// byte-for-byte identical to before this change.

export interface HaikuCandidateLogEntry {
  raw_sms_id: string;
  raw_text:   string;
  // [ADD] The message's own date, NOT the log-write time. Deliberately
  // NOT part of this log's identity key — transactions.ts's own history
  // (see findExistingTransactionForSms's comments) found that (raw_text,
  // txn_date) can collide for two genuinely different real messages (e.g.
  // two same-day SIP debits with identical text). Kept here purely for
  // readability when eyeballing the log later ("show me flags from
  // March"), not for dedup — see logHaikuCandidate()/syncParseLogs() for
  // the actual identity key used.
  txn_date:   string;
  reason:     'missing_amount' | 'unknown_direction' | 'escalated_to_haiku';
  // Whatever the taxonomy-fallback extractor (extractFields) managed to
  // pull out before giving up — useful context when reviewing the log,
  // not a claim that any of it is reliable.
  extracted_amount:    number | null;
  extracted_is_credit: boolean | null;
  extracted_merchant:  string | null;
  extracted_bank:      string | null;
  extracted_channel:   string | null;
  logged_at: string; // ISO timestamp
}

export interface LowConfidenceLogEntry {
  raw_sms_id: string;
  raw_text:   string;
  // [ADD] Same note as HaikuCandidateLogEntry.txn_date above — readability
  // only, not part of the identity key.
  txn_date:   string;
  matched_rule: string | null;
  l2_bank:      string | null;
  l2_merchant:  string | null;
  l2_amount:    number | null;
  l2_direction: string | null;
  confidence_gate_reasons: string[];
  logged_at: string; // ISO timestamp
}

export interface ParseLogs {
  haikuCandidates: HaikuCandidateLogEntry[];
  lowConfidence:   LowConfidenceLogEntry[];
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

  // [ADD] Which mechanism produced the category, if any — see
  // Classification.resolvedFrom for the full explanation. Undefined for
  // ordinary regex matches (the vast majority of rows); only set when
  // custom_categories or registered_facts actually resolved this one.
  resolvedFrom?:          'custom_category' | 'registered_fact';

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
  // [ADD] Generic reference string (UMRN/Mandate ID/Policy No/Folio No/...)
  // — for registered_facts matching only. See extractReferenceValue() below
  // and its counterpart in layer2_ruleset.js for why this is deliberately
  // NOT typed by label — one field, whatever the bank/entity happened to
  // call it.
  reference_value: string | null;
}

// ─── registered_facts / custom_categories — matching context ─────────────
//
// [ADD] These mirror the DB tables of the same name (see migrations).
// Passed in from the caller (test-sms.tsx today; any future sync entry
// point later) as an optional MatchContext — smsParser.ts stays a pure
// function with no DB access of its own, per the existing architecture.
// Fetched ONCE per sync batch by the caller, not per-message.

export interface RegisteredFact {
  id:                    string;
  fact_type:             'emi' | 'sip' | 'insurance_premium' | 'salary';
  reference_value:       string | null;
  // [ADD] Now the primary Tier-2 matching signal, alongside amount — see
  // matchRegisteredFact() below. Normalised via the same
  // normaliseMerchantKey() custom_categories already uses, so both tables
  // agree on what "the same merchant" means.
  merchant_key:          string | null;
  expected_amount:       number | null;
  amount_tolerance:      number;
  // [KEPT — no longer consumed by matchRegisteredFact()] A recurring
  // payment isn't necessarily monthly (weekly/quarterly are real cases
  // too), so day-of-month was never a reliable "same fact" signal on its
  // own. Matching now runs on amount + merchant_key instead (see below).
  // Not deleting these fields/columns in case day-tolerance ever needs
  // revisiting — they're just no longer read by the matcher.
  expected_day:          number | null;
  day_tolerance:         number;
  resolved_type:         TxnType;
  resolved_category:     string;
  resolved_sub_category: string | null;
  // [ADD] Only meaningful when fact_type === 'emi' — null otherwise. Not
  // consumed by matchRegisteredFact() (matching is amount/merchant_key/
  // reference only, deliberately identity-agnostic beyond that); this
  // rides along purely for the Debt Ratio scoring formula (unsecured EMIs
  // weighted 2x) to read once health_module_tag scoring consumption
  // resumes.
  is_secured_debt:        boolean | null;
}

export interface CustomCategoryEntry {
  merchant_key: string;
  type:         TxnType;
  category:     string;
  sub_category: string | null;
}

export interface MatchContext {
  registeredFacts?:  RegisteredFact[];
  customCategories?: CustomCategoryEntry[];
}

export interface Classification {
  type:         TxnType;
  category:     string;
  sub_category: string | null;
  // [ADD] Carried from TaxonomyEntry.ambiguous — true when this label is a
  // best-guess default for a merchant/platform whose SMS text structurally
  // cannot distinguish between multiple real categories (e.g. a broker
  // debit that could be equity, MF-via-Coin, bonds, or margin — the SMS
  // never says which). Never silently auto-approved; see needsReview in
  // both parseSingleSms branches.
  ambiguous?:   boolean;
  // [ADD] Which mechanism produced this classification. Purely informational
  // (not written to the DB as its own column — TransactionRow/EditModal can
  // use it to show e.g. "matched from your saved Zerodha preference" vs a
  // generic category badge). Undefined = ordinary regex match, the default.
  resolvedFrom?: 'custom_category' | 'registered_fact';
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
  // [ADD] American Express — issues cards directly, not through an agent
  // bank, so it was entirely absent from this map. Same gap fixed in
  // ruleset.js's BANK_TOKENS (extractBank()) — this map is the separate
  // lookup used elsewhere in this file.
  'AMEX':              'American Express',
  'AMERICAN EXPRESS':  'American Express',
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
  // [ADD] Mark true when this entry's label is a best-guess for a merchant
  // whose SMS text can't structurally distinguish between multiple real
  // categories (e.g. broker platforms — see Zerodha/Groww/Upstox entry
  // below). Forces pending_review instead of silent auto-approval. Do NOT
  // set this on entries where the merchant/keyword genuinely is
  // unambiguous (AMC direct debits, named insurers, named lenders) — only
  // on platform names that structurally cover more than one real category.
  ambiguous?:   boolean;
}

const TAXONOMY: TaxonomyEntry[] = [

  // ── Quick Commerce ───────────────────────────────────────────────────────
  // [CHANGE] Previously two separate entries: Zepto had its own top-level
  // 'Zepto' category, while Blinkit/Instamart/Dunzo sat as a sub-category
  // inside Food & Dining. Consolidated into one shared bucket category —
  // same pattern as Shopping (Amazon/Flipkart/Myntra/Nykaa/Meesho all
  // co-equal merchants under one category), so a new quick-commerce
  // merchant can just be added to this one patterns array rather than
  // needing its own category block.
  { type: 'Expense', category: 'Quick Commerce', sub_category: 'Instant Delivery',
    direction: 'debit',
    patterns: [
      /\bblinkit\b/i,
      // No trailing \b — ZEPTONOW (no space before "NOW") would not match
      // \bzepto\b, see changelog note above.
      /\bzepto/i,
      /\bswiggy\s+instamart\b/i,
      /\binstamart\b/i,
      /\bdunzo\b/i,
    ] },

  // ── Food & Dining ─────────────────────────────────────────────────────────
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
               /\bsuper\s*market\b/i, /\bgrocery\b/i, /\bbig\s+bazaar\b/i] },

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
    // [FIX] Added \bwithdrawn\b. Real HDFC ATM template — "Withdrawn
    // Rs.12000 From HDFC Bank Card x2898 At +TRIPLICANE On DATE Bal
    // Rs.X" — never contains the literal word "ATM" or the phrase "cash
    // withdrawal" anywhere in the body, so neither existing pattern ever
    // matched it despite GENERIC_DEBIT (layer2_ruleset.js) already
    // recognizing "Withdrawn" as a real transaction. Confirmed live: every
    // ATM withdrawal in production data landed Uncategorized for this
    // reason. Scoped to direction:'debit' (already true for this whole
    // entry), so this can't collide with an unrelated credit-side mention.
    patterns: [/\batm\s+(debit|withdrawal|wdl|cash)\b/i, /\bcash\s+withdrawal\b/i, /\bwithdrawn\b/i] },

  { type: 'Expense', category: 'Finance Charges', sub_category: 'Bank Charges',
    direction: 'debit',
    patterns: [/\bservice\s+charges?\b/i, /\bannual\s+(fee|charge)\b/i,
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
      // [REMOVED — this pass] Was: a bare `\bneft\s+cr\b` pattern (with a
      // negative-lookahead blocklist for LIC/insurance/mutual fund/
      // dividend/refund) that guessed Salary for ANY unblocked "NEFT Cr"
      // narration. Removed per product decision, not narrowed further —
      // real data confirmed the failure mode generalizes beyond what any
      // blocklist can keep up with: "NEFT Cr-RATN0000999-PROJAS
      // CONSULTANCY SERVICES PRIVATE-..." (a consulting/business payment,
      // not the user's employer) matched cleanly and got auto-labeled
      // Monthly Salary with zero human check, since this taxonomy entry
      // never set `ambiguous: true`. "NEFT Cr" is a generic bank-credit
      // narration prefix used for salary, consulting fees, freelance
      // payments, family transfers, B2B payments, and government payouts
      // alike — genuinely too weak a signal to decide Salary on its own,
      // and every non-employer sender name that hasn't been seen yet would
      // need its own blocklist entry to catch, one false positive at a
      // time. Employer names are open-ended and un-listable the same way
      // merchant names are.
      //
      // NEFT credits with no matching pattern here now fall through with
      // category: null (Income type still applies — see the amount-sign-
      // based type derivation, unaffected by this change) rather than a
      // confident wrong guess. The real path to a correct category is
      // extractMerchant() actually naming the sender (see the new NEFT-Cr
      // merchant pattern in ruleset.js) so custom_categories can resolve
      // it — matchCustomCategory() already runs BEFORE this taxonomy table
      // in classify(), so once merchant extraction works for a given NEFT
      // narration, a user's one-time custom-category choice takes
      // permanent priority over any text-pattern guess here, for that
      // sender specifically, going forward.
    ] },

  { type: 'Income', category: 'Refunds', sub_category: 'Purchase Refund',
    direction: 'credit',
    // [FIX] Added \brefunds\b (plural) — confirmed via a 1,127-message
    // real-data test that this was the ONLY case in the entire corpus
    // whose classification depended on loose-matching. The message
    // ("...from VPA amazon.refunds@axisbank...") has "refunds" with real
    // punctuation boundaries on both sides (a dot before, @ after), so it
    // matches directly with no loose-matching needed once the plural form
    // is included — this was a pluralization gap, not a genuine need for
    // substring/boundary-stripped matching.
    patterns: [/\brefund\b/i, /\brefunds\b/i, /\bcashback\b/i, /\brefunded\b/i] },

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
               /\bfd\s+interest\b/i, /\bsavings\s+interest\b/i,
               // [FIX — this pass, found via corpus test] Real template
               // "Quarterly interest Rs.X credited to A/c Y as on DATE" —
               // one of the most common credit templates in the corpus
               // (appears across nearly every bank) — matched none of the
               // above: "interest" and "credited" aren't adjacent, the
               // amount clause sits between them. Was landing as a fully
               // uncategorized 'approved' credit (small amounts don't trip
               // the >=5000 review threshold), invisible to Income
               // Stability/Savings Rate despite being real, recurring
               // income. Bounded-distance pattern, still direction:'credit'
               // scoped so this can't leak into debit-side matches.
               /\binterest\b.{0,40}\bcredited\b/i,
               // [FIX] Added \binterest\s+paid\b. Real HDFC template —
               // "Update! INR 211.00 deposited in HDFC Bank A/c XX4820 on
               // 30-JUN-26 for Interest paid till 30-JUN-2026.Avl bal..."
               // — never uses "credited"/"received" at all, only "paid",
               // so none of the patterns above ever matched it despite
               // GENERIC_CREDIT (layer2_ruleset.js) already recognizing
               // "deposited" as a real transaction. Confirmed live: every
               // one of these quarterly/monthly interest credits landed
               // Uncategorized for this reason.
               /\binterest\s+paid\b/i] },

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
    //
    // [ADD — this pass] Named AMC direct-debit patterns from taxonomy doc.
    // Unlike the broker-platform entry above, these are NOT ambiguous — an
    // AMC (as opposed to a broker/aggregator) only ever does mutual funds,
    // so a debit naming one of these directly is a confident SIP/lump-sum
    // MF match with no other plausible category. Aggregator names that
    // ALSO do non-MF investing (Groww, Paytm Money, IndMoney — already in
    // the broker list above) are deliberately NOT duplicated here; a plain
    // debit to one of those stays ambiguous and pending_review, same as
    // any other broker debit, unless the SMS also contains an explicit
    // "SIP"/"mutual fund" signal (which the patterns above already catch
    // and which will out-score the ambiguous broker entry).
    direction: 'debit',
    patterns: [
      /\bsip\s+(of|installment|debit(?:ed)?|payment|contribution)\b/i,
      /\bsystematic\s+investment\s+plan\b/i,
      /\bhdfc\s*mutual\s*fund\b/i, /\bhdfc\s*mf\b/i,
      /\bsbi\s*mutual\s*fund\b/i, /\bsbi\s*mf\b/i,
      /\bicici\s*prudential\s*mf\b/i, /\bicici\s*pru\s*mf\b/i,
      /\baxis\s*mutual\s*fund\b/i, /\baxis\s*mf\b/i,
      /\bnippon\s*india\s*mf\b/i, /\buti\s*mutual\s*fund\b/i, /\buti\s*mf\b/i,
      /\bkotak\s*mutual\s*fund\b/i, /\bkotak\s*mf\b/i,
      /\bmirae\s*asset\b/i, /\bfranklin\s*templeton\b/i,
      /\bdsp\s*mutual\s*fund\b/i, /\bdsp\s*mf\b/i,
      /\baditya\s*birla\s*sun\s*life\s*mf\b/i, /\babsl\s*mf\b/i,
      /\bparag\s*parikh\b/i, /\bquant\s*mutual\s*fund\b/i, /\bquant\s*mf\b/i,
      /\bkuvera\b/i, /\bet\s*money\b/i, /\bzerodha\s*coin\b/i,
      // [ADD] Real gap found via user data: "PPFAS" is Parag Parikh
      // Financial Advisory Services' own abbreviation, used directly in
      // real bank SMS ("Bill payment... for PPFAS Mutual Fund...") — the
      // existing /\bparag\s*parikh\b/i pattern above doesn't cover this
      // alias, so it was falling through to pending_review despite Parag
      // Parikh already being a recognized AMC. Two genuinely new AMCs also
      // added: Tata Mutual Fund and PGIM India — both confirmed real,
      // recurring SIP debits in real data with no existing pattern.
      /\bppfas\b/i, /\btata\s*mutual\s*fund\b/i, /\bpgim\s*india\b/i,
    ] },

  // [ADD — this pass, found via corpus test] Lump-sum Mutual Fund purchase
  // — a genuinely common template ("Mutual Fund purchase of Rs.X in <Fund
  // Name> successful, debited from A/c Y on DATE") had ZERO coverage: no
  // "sip" wording (this isn't a SIP), and most real fund scheme names
  // ("HDFC Top 100 Fund", "Axis Bluechip Fund", "SBI Small Cap Fund",
  // "Kotak Flexicap Fund", "ICICI Pru Value Discovery", "Nippon India
  // Growth Fund") don't contain "mutual fund"/"mf" the way the AMC-name
  // patterns above require. Matching on the phrase "Mutual Fund purchase"
  // itself is unambiguous and doesn't require enumerating every scheme
  // name. Separate sub_category from SIP since this is a one-off
  // lump-sum contribution, not a recurring installment — the distinction
  // matters if Investment Rate scoring ever wants to treat the two
  // differently (e.g. a 3-month rolling average is a poor fit for an
  // irregular lump-sum the way it fits a fixed monthly SIP).
  { type: 'Investment', category: 'Mutual Funds', sub_category: 'Lumpsum',
    direction: 'debit',
    patterns: [/\bmutual\s+fund\s+purchase\b/i] },

  // [ADD — this pass] Mutual Fund redemption — money moving OUT of a fund
  // back to the bank account. Previously uncategorized entirely, which
  // matters beyond a missing label: an uncategorized credit is exactly the
  // shape Income Stability scoring would need to treat carefully — a
  // redemption is a portfolio reallocation, not earned income, and
  // shouldn't inflate an income-stability calculation the way a real
  // salary/freelance credit should. Giving it an explicit category at
  // least makes it identifiable and excludable, rather than an
  // unexplained credit that could get swept into "Income" by whatever
  // downstream logic eventually handles null-category credits.
  { type: 'Investment', category: 'Mutual Funds', sub_category: 'Redemption',
    direction: 'credit',
    patterns: [/\bredemption\s+of\b/i, /\bredeemed\b/i] },

  // [FIX — this pass] direction: 'debit' added. Real data showed a Zerodha
  // "quarterly settlement payout" credit (unused margin returned to the
  // user, not a stock trade) matching this bare merchant-name pattern and
  // getting tagged as Investment > Stocks > Equity Purchase with a
  // POSITIVE amount — self-contradictory, since a "purchase" by definition
  // costs money. A genuine equity purchase is always a debit; a credit
  // from a broker is a settlement, withdrawal, or dividend (dividends are
  // already separately handled by the Income > Dividends entry above).
  // Same root-cause class as the PPF/SSY direction fix above.
  //
  // [FIX — this pass] ambiguous: true added, plus expanded platform list
  // (taxonomy doc's full broker roster). Root-cause fix: a bare debit to
  // any of these platforms ("UPI debit to ZERODHA BROKING LTD") carries NO
  // text signal distinguishing equity purchase from an MF-via-Coin SIP,
  // a bond purchase, F&O margin, or gold — the SMS structurally cannot
  // say which. Previously this entry guessed "Equity Purchase" every
  // time and auto-approved it. 'Equity Purchase' is kept as the label
  // (best available default — most broker debits genuinely are equity),
  // but ambiguous:true now forces pending_review instead of a silent,
  // possibly-wrong auto-approval. The real fix is a Table-X-style
  // registration ("what do you primarily use this broker for?") so this
  // never has to guess per-transaction once the user has told us once —
  // not implemented in this pass.
  { type: 'Investment', category: 'Stocks', sub_category: 'Equity Purchase',
    direction: 'debit',
    ambiguous: true,
    patterns: [
      /\bzerodha\b/i, /\bgroww\b/i, /\bupstox\b/i,
      /\bangelone\b/i, /\bangel\s+one\b/i, /\bdhan\b/i,
      // [ADD — this pass] rest of taxonomy doc's broker roster.
      /\b5paisa\b/i, /\bicici\s*direct\b/i, /\bhdfc\s*sec(?:urities)?\b/i,
      /\bkotak\s*sec(?:urities)?\b/i, /\bmotilal\s+oswal\b/i,
      /\biifl\s*sec(?:urities)?\b/i, /\bsharekhan\b/i,
      /\bpaytm\s*money\b/i, /\bindmoney\b/i, /\baxis\s*direct\b/i,
      /\bsbi\s*sec(?:urities)?\b/i, /\bfyers\b/i, /\balice\s*blue\b/i,
    ] },

  // [ADD — this pass] Investment > Gold. Augmont added per taxonomy doc
  // (digital gold provider behind PhonePe/GPay/Paytm gold purchases).
  { type: 'Investment', category: 'Gold', sub_category: null,
    patterns: [
      /\bsafegold\b/i, /\bdigital\s+gold\b/i, /\bpaytm\s+gold\b/i,
      /\bsovereign\s+gold\s+bond\b/i, /\bgold\s+bond\b/i, /\baugmont\b/i,
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
  // [ADD — this pass] Named bond platforms from taxonomy doc — additive to
  // the existing generic \bbond\b pattern, doesn't replace it.
  { type: 'Investment', category: 'Bonds', sub_category: 'Bond Purchase',
    patterns: [
      /\bbond\b/i, /\bindiabonds\b/i, /\bwint\s*wealth\b/i, /\bgoldenpi\b/i,
    ] },

  // [FIX] Removed \bbajaj\s+finserv\b — Bajaj Finserv is primarily EMI/lending.
  // Bajaj Allianz kept (insurance-only entity, unambiguous).
  // [ADD] shriramlife — Shriram Life Insurance.
  // [ADD — this pass] Full life-insurer roster from taxonomy doc.
  { type: 'Investment', category: 'Insurance', sub_category: 'Life Insurance',
    patterns: [
      /\blic\s+(premium|policy)\b/i, /\bterm\s+(plan|insurance)\b/i,
      // [FIX — this pass, found via corpus test] 'LIC of India' — the
      // literal name of India's largest life insurer, appearing in NACH
      // mandate and premium-debit templates — matched NEITHER this list nor
      // any other entry. Unlike ICICI Prudential (which is genuinely
      // ambiguous — also an AMC brand), LIC is unambiguously life insurance
      // only, so this is safe to resolve directly via REGEX rather than
      // routing through registered_facts.
      /\blic\s+of\s+india\b/i,
      /\binsurance\s+premium\b/i, /\bpolicy\s+premium\b/i,
      /\bbajaj\s+allianz\s+life\b/i,
      /\bshriram\s*life\b/i, /\bshriramlife\b/i,
      /\bhdfc\s*life\b/i, /\bicici\s*prudential\s*life\b/i,
      /\bsbi\s*life\b/i, /\bmax\s*life\b/i, /\btata\s*aia\b/i,
      /\bpnb\s*metlife\b/i, /\bkotak\s*life\b/i,
      /\baditya\s*birla\s*sun\s*life\s*insurance\b/i,
      /\bcanara\s*hsbc\s*life\b/i, /\bstar\s*union\s*dai.?ichi\b/i,
      /\bfuture\s*generali\s*life\b/i,
    ] },

  // [ADD] manipalcigna — ManipalCigna Health Insurance.
  // [ADD — this pass] Full health-insurer roster from taxonomy doc.
  { type: 'Investment', category: 'Insurance', sub_category: 'Health Insurance',
    patterns: [
      /\bhealth\s+insurance\b/i, /\bmediclaim\b/i, /\bstar\s+health\b/i,
      /\bmanipal\s*cigna\b/i, /\bmanipalcigna\b/i,
      /\bniva\s*bupa\b/i, /\bmax\s*bupa\b/i, /\bcare\s*health\b/i,
      /\bhdfc\s*ergo\s*health\b/i, /\bicici\s*lombard\s*health\b/i,
      /\baditya\s*birla\s*health\b/i, /\breliance\s*health\b/i,
      /\bbajaj\s*allianz\s*health\b/i, /\bnational\s*insurance\b/i,
    ] },

  // [ADD — this pass] Investment > Insurance > Motor Insurance. No prior
  // category existed for vehicle insurance at all.
  // [ADD — this pass] Public-sector general insurers — New India Assurance,
  // Oriental Insurance, United India Insurance, Reliance General — flagged
  // as gaps. Filed here rather than under Health: this codebase has no
  // separate "General Insurance" bucket (only Life/Health/Motor/Other), and
  // in the real corpus these four write mostly motor-policy premium debits
  // for retail customers, matching Motor's existing convention of also
  // hosting the general-purpose insurers (ICICI Lombard, HDFC Ergo, Bajaj
  // Allianz General, Tata AIG) rather than duplicating them under Health.
  // [FLAG] National Insurance is currently only wired under the Health
  // entry above, despite also being a public-sector general insurer in the
  // same family as these four — inconsistent, but left as-is here rather
  // than moved/duplicated without seeing which policy type it actually
  // shows up as in this user's real SMS corpus; a bare debit to any of
  // these five names is genuinely ambiguous between motor/health/fire
  // without more context, same ambiguity class already documented for the
  // broker-platform entries above.
  { type: 'Investment', category: 'Insurance', sub_category: 'Motor Insurance',
    patterns: [
      /\bmotor\s+insurance\b/i, /\bvehicle\s+insurance\b/i,
      /\bcar\s+insurance\b/i, /\bbike\s+insurance\b/i,
      /\bicici\s+lombard\b/i, /\bhdfc\s+ergo\b/i, /\bbajaj\s+allianz\s+general\b/i,
      // [ADD — this pass] "digit" and "acko" are common-enough word/name
      // roots (e.g. "6-digit OTP" footers) that a bare pattern risks the
      // same collision class as the existing dhan/spa denylist entries —
      // required qualifying context ("insurance"/"policy") to stay safe,
      // at the cost of missing bare-brand-name SMS if any exist. Revisit
      // against real data before loosening, per this file's own testing
      // convention for exactly this risk class.
      /\btata\s*aig\b/i,
      /\bdigit\s+(insurance|policy)\b/i, /\backo\s+(insurance|policy)\b/i,
      /\bnew\s*india\s*assurance\b/i, /\boriental\s+insurance\b/i,
      /\bunited\s+india\s+insurance\b/i, /\breliance\s+general\b/i,
    ] },

  // [ADD — this pass] Annuity/pension plan premiums — new sub-category.
  // Named providers only (per taxonomy doc); a bare "annuity" or "pension
  // plan" word is too generic/rare to be a safe standalone signal, so this
  // stays narrow rather than risking false positives.
  { type: 'Investment', category: 'Insurance', sub_category: 'Annuity/Pension',
    patterns: [
      /\bjeevan\s*shanti\b/i, /\bclick\s*2\s*retire\b/i,
      /\bclick2retire\b/i,
    ] },

  // ── Liability ─────────────────────────────────────────────────────────────
  // [FIX — this pass, real classification bug found via scoring-doc
  // cross-check] Removed /\bnach\s+debit\b/i from this entry's patterns.
  // "NACH debit" is purpose-agnostic bank terminology — it only says "this
  // is a mandate-based auto-debit," identically for a loan EMI, a SIP, or
  // an insurance premium. Keeping it here meant ANY unnamed NACH debit with
  // no other identifying text (no lender/AMC/insurer name, no "sip"/
  // "premium" wording) matched THIS entry — via the taxonomy loop, which
  // runs before the registered_facts check in classify() — and got
  // silently auto-labeled "Loan EMI" (Liability/debt), never reaching
  // registered_facts at all. This is precisely the "classic ambiguous
  // case" pileap_module_merchant_taxonomy.md says Table X exists to solve
  // — a generic NACH SIP or insurance-premium debit with no lender/AMC/
  // insurer name in the text — and the pattern here was quietly routing it
  // around that mechanism entirely.
  // Confirmed with a synthetic test: a bare "NACH Debit of Rs.5000... A/c
  // XX1234 debited" message (no other signal) scored 1 on this entry and 0
  // on every Investment/Insurance entry, so it resolved as Loan EMI outright
  // — corrupting Debt Ratio (phantom debt added), Investment Rate (real SIP
  // never counted), and Insurance Cover (real premium never counted) all at
  // once, exactly the failure mode pileap_scoring_reality_check flags for
  // Debt Ratio's secured/unsecured-EMI weighting to even be meaningful — it
  // can't weight what shouldn't have been EMI in the first place.
  // The remaining three patterns are kept: "EMI deducted/debited/paid" and
  // "loan emi" both explicitly name EMI/loan, and "auto debit emi" contains
  // "emi" explicitly too — none of these are purpose-agnostic the way bare
  // "NACH debit" is, so they're safe to keep resolving directly via regex.
  // A truly bare NACH debit (no "emi"/"loan"/lender/AMC/insurer wording at
  // all) now correctly falls through this loop entirely and reaches the
  // channel-gated registered_facts check further down, as designed.
  // [FIX — this pass, found via corpus test] Moved ahead of the generic
  // "Loan EMI" entry below. Real "Home Loan EMI" text (e.g. "Your Home Loan
  // EMI of Rs.X has been debited...") matches BOTH this entry's
  // \bhome\s+loan\b pattern AND the generic entry's \bloan\s+emi\b pattern
  // (since "Home Loan EMI" contains "Loan EMI" as a substring) — a 1-1
  // score tie. classify()'s tie-break is strict-greater-than, so whichever
  // entry appears FIRST in this array wins ties. With the generic entry
  // first (as it originally was), every Home/Personal/Auto/Education/Gold
  // loan message that also happens to say "Loan EMI" (which is most of
  // them, per the corpus) silently collapsed into the generic bucket,
  // losing exactly the secured-vs-unsecured signal
  // pileap_scoring_reality_check's Debt Ratio weighting needs. Reordering
  // so specific lender/loan-type entries are tried first — and therefore
  // win ties — fixes this without needing to touch the scoring logic at all.
  // [ADD] Named HFC/lender roster from taxonomy doc, additive to the
  // existing generic home/housing loan pattern.
  // [ADD — this pass] Remaining housing-finance NBFC roster from taxonomy
  // doc — LIC HFL/ICICI Home Finance were already covered; PNB Housing,
  // Bajaj Housing Finance, Aavas, and Indiabulls Housing were flagged as
  // gaps during a cross-check against a broader Indian-lender reference
  // list and had zero prior coverage.
  { type: 'Liability', category: 'Loans', sub_category: 'Home Loan',
    patterns: [
      /\bhome\s+loan\b/i, /\bhousing\s+loan\b/i, /\bmortgage\b/i,
      /\blic\s*hfl\b/i, /\bicici\s*home\s*finance\b/i,
      /\bpnb\s*housing\b/i, /\bbajaj\s*housing\s*finance\b/i,
      /\baavas\b/i, /\bindiabulls\s*housing\b/i,
    ] },

  // [ADD — this pass] Named NBFC/fintech lender roster from taxonomy doc.
  // [ADD — this pass] Remaining digital-lender roster from taxonomy doc —
  // Fibe (formerly EarlySalary, both names still appear in live SMS
  // depending on when the loan was taken), PaySense, Slice, Kissht, and
  // mPokket/Home Credit were flagged as gaps. "slice" and "navi" are both
  // short, dictionary-adjacent words — kept \b-bounded only, no additional
  // qualifying context added here since these are the exact spellings the
  // taxonomy doc lists as the lenders' own brand names, same risk class as
  // the existing bare "navi"/"cashe" patterns already shipped in this
  // entry — revisit against real corpus data if a collision turns up.
  { type: 'Liability', category: 'Loans', sub_category: 'Personal Loan',
    patterns: [
      /\bpersonal\s+loan\b/i, /\binstant\s+loan\b/i,
      /\bbajaj\s*finserv\b/i, /\bfullerton\b/i, /\bidfc\s*first\b/i,
      /\btata\s*capital\b/i, /\bnavi\b/i, /\bkreditbee\b/i,
      /\bmoneytap\b/i, /\bcashe\b/i,
      /\bfibe\b/i, /\bearlysalary\b/i, /\bearly\s*salary\b/i,
      /\bpaysense\b/i, /\bslice\b/i, /\bkissht\b/i,
      /\bmpokket\b/i, /\bhome\s*credit\b/i,
    ] },

  // [ADD — this pass] Auto/car loan — new sub-category, no prior coverage.
  // [ADD — this pass] Cholamandalam Finance — a major auto-loan NBFC,
  // flagged as a gap during the same cross-check.
  { type: 'Liability', category: 'Loans', sub_category: 'Auto Loan',
    patterns: [
      /\bauto\s+loan\b/i, /\bcar\s+loan\b/i, /\bvehicle\s+loan\b/i,
      /\bsundaram\s*finance\b/i, /\bmahindra\s*finance\b/i,
      /\btvs\s*credit\b/i, /\bcholamandalam\b/i,
    ] },

  // [ADD — this pass] Education loan — new sub-category, no prior coverage.
  { type: 'Liability', category: 'Loans', sub_category: 'Education Loan',
    patterns: [
      /\bedu(?:cation)?\s*loan\b/i, /\bavanse\b/i,
      /\bhdfc\s*credila\b/i, /\bauxilo\b/i,
    ] },

  // [ADD — this pass] Gold loan — new sub-category, no prior coverage.
  { type: 'Liability', category: 'Loans', sub_category: 'Gold Loan',
    patterns: [
      /\bgold\s+loan\b/i, /\bmuthoot\b/i, /\bmanappuram\b/i,
    ] },

  // [ADD — this pass] BNPL — new category. Deliberately kept separate from
  // EMI/Loans since these are typically shorter-term, smaller-ticket, and
  // product teams often want to track them distinctly from formal lending.
  { type: 'Liability', category: 'BNPL', sub_category: null,
    direction: 'debit',
    patterns: [
      /\blazypay\b/i, /\bsimpl\b/i, /\bzestmoney\b/i,
      /\bamazon\s*pay\s*later\b/i,
    ] },

  // [FIX — this pass] Real classification bug found via scoring-doc
  // cross-check. Removed /\bnach\s+debit\b/i from this entry's patterns.
  // "NACH debit" is purpose-agnostic bank terminology — it only says "this
  // is a mandate-based auto-debit," identically for a loan EMI, a SIP, or
  // an insurance premium. Keeping it here meant ANY unnamed NACH debit with
  // no other identifying text (no lender/AMC/insurer name, no "sip"/
  // "premium" wording) matched THIS entry — via the taxonomy loop, which
  // runs before the registered_facts check in classify() — and got
  // silently auto-labeled "Loan EMI" (Liability/debt), never reaching
  // registered_facts at all. This is precisely the "classic ambiguous
  // case" pileap_module_merchant_taxonomy.md says Table X exists to solve
  // — a generic NACH SIP or insurance-premium debit with no lender/AMC/
  // insurer name in the text — and the pattern here was quietly routing it
  // around that mechanism entirely.
  // Also moved to the END of the Liability/Loans block (see comment above
  // Home Loan) so specific lender matches win array-order ties instead of
  // this generic bucket.
  // The remaining three patterns are kept: "EMI deducted/debited/paid" and
  // "loan emi" both explicitly name EMI/loan, and "auto debit emi" contains
  // "emi" explicitly too — none of these are purpose-agnostic the way bare
  // "NACH debit" is, so they're safe to keep resolving directly via regex.
  { type: 'Liability', category: 'EMI', sub_category: 'Loan EMI',
    patterns: [/\bemi\s+(deducted|debited|paid)\b/i, /\bloan\s+emi\b/i,
               /\bauto\s+debit\s+emi\b/i,
               // [FIX — this pass, found via corpus test] Real template
               // "EMI of Rs.X debited from A/c Y towards Loan A/c Z on
               // DATE." matched neither existing pattern — "emi" and
               // "debited" aren't adjacent (the amount clause sits
               // between them), and there's no "loan emi" or "auto debit
               // emi" phrase either. Bounded-distance pattern tying "emi"
               // to a nearby "loan a/c" reference catches this without
               // loosening to a bare \bemi\b (which risks false positives
               // elsewhere per this file's own established caution around
               // that word).
               /\bemi\s+of\b.{0,60}\bloan\s+a\/?c\b/i] },

  // ── Asset ─────────────────────────────────────────────────────────────────
  // [FIX — this pass, resolves a previously-flagged open question] Every
  // entry below (Fixed Deposit, Recurring Deposit, NPS, SCSS/NSC/KVP,
  // PPF/SSY) used to be `type: 'Asset'`, while SIP/Mutual Funds/Stocks/Gold/
  // Bonds above are `type: 'Investment'`. That split was never a deliberate
  // product decision — a prior comment here flagged it as unresolved. It
  // matters because pileap_module_merchant_taxonomy.md's Module 4
  // (Investment Rate) explicitly lists FD/RD/PPF/NPS/SCSS as feeding that
  // score, same as SIP. If Investment Rate's rollup logic (not yet built)
  // ends up summing `type === 'Investment'`, leaving these as `'Asset'`
  // would silently exclude every rupee put into a fixed deposit, PPF, NPS,
  // RD, or SCSS from the score — understating genuine saving/investing
  // behaviour for exactly the users who favour guaranteed-return
  // instruments over market-linked ones.
  //
  // Retyped to `'Investment'` to match the taxonomy doc. `category`/
  // `sub_category` are unchanged, so nothing downstream loses the ability
  // to tell a Fixed Deposit apart from a SIP — this only changes the
  // top-level bucket used for "money set aside for the future" rollups
  // (Investment Rate). `type: 'Asset'` is no longer used anywhere in this
  // file as of this fix; if a genuine balance-sheet "Asset" concept is
  // needed later (Module 7, Net Worth), that's explicitly [NOT SMS] per the
  // taxonomy doc anyway — it needs a valuation snapshot, not a transaction
  // category, so re-introducing `'Asset'` here wouldn't have served it.
  { type: 'Investment', category: 'Bank Deposits', sub_category: 'Fixed Deposit',
    // [FIX — this pass, found via corpus test] The real, extremely common
    // bank template is "FD of Rs.X booked successfully, A/c Y, FD No Z,
    // Interest Rate W% p.a., Maturity DATE" — 'FD' and 'booked' are NOT
    // adjacent (the amount clause sits between them), so the original
    // \bfd\s+(created|booked|opened)\b pattern never matched it at all.
    // Added a bounded-distance variant plus the 'FD No' signal (present on
    // every real FD-booking SMS in the corpus, low collision risk).
    patterns: [
      /\bfixed\s+deposit\b/i,
      /\bfd\s+(created|booked|opened)\b/i,
      /\bfd\b.{0,40}\bbooked\s+successfully\b/i,
      /\bfd\s+no\.?\s*\d/i,
    ] },

  // [ADD — this pass] Recurring Deposit — taxonomy doc explicitly flagged
  // this had zero pattern coverage today. Filed as its own sub_category
  // under Bank Deposits, parallel to Fixed Deposit.
  { type: 'Investment', category: 'Bank Deposits', sub_category: 'Recurring Deposit',
    direction: 'debit',
    patterns: [
      /\brecurring\s+deposit\b/i, /\brd\s+(installment|instalment)\b/i,
      /\brd\s+(created|booked|opened)\b/i,
    ] },

  { type: 'Investment', category: 'Government Schemes', sub_category: 'NPS',
    patterns: [/\bnps\b/i, /\bnational\s+pension\s+(scheme|system)\b/i] },

  // [ADD — this pass] SCSS/NSC/KVP — no prior coverage at all.
  { type: 'Investment', category: 'Government Schemes', sub_category: 'SCSS/NSC/KVP',
    direction: 'debit',
    patterns: [
      /\bscss\b/i, /\bsenior\s+citizen\s+savings\s+scheme\b/i,
      /\bnsc\b/i, /\bnational\s+savings\s+certificate\b/i,
      /\bkvp\b/i, /\bkisan\s+vikas\s+patra\b/i,
    ] },

  // [ADD — this pass] Government Schemes > PPF/SSY. Also acts as a safety
  // net for transactions.ts's DEFINITIONAL_CONTRA_RULES (GENERIC_PPF_SSY),
  // which currently has no Layer-2 rule feeding it that we can see from
  // this file — if Layer 2 never sets matched_rule to GENERIC_PPF_SSY, this
  // at least gets the transaction categorized instead of falling through
  // uncategorized.
  // [FIX — this pass] direction: 'debit' added. Without it, an incoming
  // transfer whose narration happens to say "PPF" (real example: a
  // person's own transfers, some captioned "PPF", others "House expenses",
  // same person/amount, only the PPF-captioned ones were affected) got
  // classified as if the money arriving WAS a PPF contribution. PPF/SSY is
  // only ever a real contribution event when money is actually moving OUT
  // to the scheme, never on the credit side — an incoming credit that
  // happens to mention PPF is not itself a contribution. Matters beyond
  // mislabeling: health-module scoring reads this category, so an
  // unrestricted credit match would double-count the same PPF contribution
  // (once when it arrives from wherever, again when it's actually moved
  // into PPF).
  { type: 'Investment', category: 'Government Schemes', sub_category: 'PPF/SSY',
    direction: 'debit',
    patterns: [
      /\bppf\b/i, /\bpublic\s+provident\s+fund\b/i,
      /\bsukanya\s+samriddhi\b/i, /\bssy\b/i,
    ] },

  // ── Liability ─────────────────────────────────────────────────────────────
  // [ADD — this pass] Credit Card bill payment. Previously this had NO
  // taxonomy entry at all — layer2_ruleset.js's GENERIC_CC_PAYMENT rule
  // correctly keeps it out of Expense (possible_contra: true, so
  // transactions.ts marks it is_contra and it's never double-counted as
  // spend) but sets merchant: null and channel: 'Net Banking', so it never
  // reached the registered_facts mandate-shape gate either. Result: it
  // resolved to category: null, type: null — invisible to Debt Ratio (Module
  // 3) even though the taxonomy doc explicitly calls this out as a
  // debt-servicing signal ("this is a *transfer*, not an expense; must not
  // double-count as spend" — the doc's intent was "keep out of Expense,
  // not "erase entirely"). Patterns mirror GENERIC_CC_PAYMENT's own
  // proximity-based text matching so this only fires on genuine bill-payment
  // language, not ordinary "spent on my credit card at X" POS purchases
  // (which say "Spent"/"Txn" near "Card", never "bill"/"payment towards").
  { type: 'Liability', category: 'Credit Card', sub_category: 'Bill Payment',
    direction: 'debit',
    patterns: [
      /credit\s*card.{0,40}bill\s*payment/i,
      /paid.{0,20}towards.{0,20}credit\s*card/i,
      /payment.{0,20}towards.{0,20}credit\s*card/i,
      /paid.{0,20}for.{0,20}credit\s*card/i,
      /(?:credited|received|paid).{0,40}credit\s*card.{0,30}bill\s*payment/i,
    ] },
];

// ─── merchant_key normaliser ──────────────────────────────────────────────────
// Produces a stable, case-insensitive, truncation-safe key for custom category
// lookup. Strips everything except alphanumeric and @ (to preserve VPA handles).
// Max 40 chars to match the DB column length.
// Use this key — not the display merchant string — when reading/writing
// customCatData, both on-device and in the backend.

// [CHANGED — this pass] Exported. customCategories.ts needs to build the
// exact same key when the user confirms a category via the contextual
// prompt (RegisterFactPrompt), so the write and every future read agree on
// what "the same merchant" means. Single source of truth, rather than a
// third independent copy of this normalization living in the API layer —
// same failure class as the categories.ts/transactionCategories.ts mismatch
// this codebase already hit once.
export function normaliseMerchantKey(merchant: string | null): string | null {
  if (!merchant) return null;
  return merchant
    .toLowerCase()
    .replace(/[^a-z0-9@]/g, '')   // keep only alphanum + @ for VPAs
    .substring(0, 40)             // max 40 chars
    || null;                      // return null if result is empty string
}

// ─── Main export ──────────────────────────────────────────────────────────────

// [ADD — this pass] Optional second param. Callers that don't yet fetch
// registered_facts/custom_categories can omit it entirely — every existing
// call site keeps working unchanged; matchContext just defaults to
// undefined, and matchCustomCategory()/matchRegisteredFact() both already
// no-op on an empty/missing list.
// [ADD] `logs` is optional and additive. Existing callers that don't pass
// it get identical behavior and output to before this change — nothing is
// collected, nothing is sent anywhere, no status or parse_failure value on
// any returned row is touched by this. Passing `logs` only causes entries
// to accumulate into the arrays the caller provided.
export function parseSmsMessages(
  messages: RawMessage[],
  matchContext?: MatchContext,
  logs?: ParseLogs,
): (ParsedTransaction | BalanceUpdate)[] {
  return messages.map(msg => parseSingleSms(msg, matchContext, logs));
}

// ─── Single message orchestrator ─────────────────────────────────────────────

function parseSingleSms(msg: RawMessage, matchContext?: MatchContext, logs?: ParseLogs): ParsedTransaction | BalanceUpdate {
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
    // [ADD — Log B, shadow only] Confidence gate runs here because this is
    // exactly the case it exists for: Layer 2 "successfully" matched
    // (amount/direction non-null, so matchMessage() didn't self-reject),
    // but nothing has verified the rest of the extraction is actually
    // right. Deliberately scoped to ONLY this branch — see confidenceGate.js
    // header on why it hasn't been validated against the taxonomy-fallback
    // path below. This block only ever pushes to `logs`; it must never be
    // allowed to influence needsReview, status, or parse_failure below —
    // that wiring is a separate, later decision once shadow data backs it.
    if (logs) {
      const gateResult = assessConfidence(l2);
      if (gateResult.flagged) {
        logs.lowConfidence.push({
          raw_sms_id:   msg.id,
          raw_text:     body,
          txn_date:     msgDate,
          matched_rule: l2.matched_rule,
          l2_bank:      l2.bank,
          l2_merchant:  l2.merchant,
          l2_amount:    l2.amount,
          l2_direction: l2.direction,
          confidence_gate_reasons: gateResult.reasons,
          logged_at: new Date().toISOString(),
        });
      }
    }

    const isCredit = l2.direction === 'credit';
    const classification = l2.suggested_category
      ? parseSuggestedCategory(l2.suggested_category)
      : classify(body.toLowerCase(), isCredit, l2.amount, l2.channel, l2.merchant, l2.txn_date || msgDate, l2.reference_value, matchContext);

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
    // [FIX] l2.requires_classification is derived once from the VPA handle
    // in ruleset.js's GENERIC_CREDIT rule, independent of what classify()
    // later resolves — so a saved custom_categories entry for a person/
    // unknown VPA (matchCustomCategory() returning resolvedFrom:
    // 'custom_category', ambiguous:false, meant as "confirm once, forever")
    // never actually cleared the review requirement; only the
    // classification?.ambiguous path was being overridden. Confirmed via
    // real data: narasimhanpr48@okaxis stayed pending_review on every
    // future credit even after being saved as a custom category, while the
    // equivalent debit-side case (e.g. Zerodha, ambiguous:true on the
    // taxonomy entry) correctly stopped needing review once resolved.
    const isCustomResolved = classification?.resolvedFrom === 'custom_category';
    const needsReview =
      !l2.account_number_masked   ||
      Math.abs(l2.amount) >= 5000 ||
      (l2.requires_classification && !isCustomResolved) ||
      classification?.ambiguous   === true;

    // [FIX] classify()'s NACH fallback no longer returns a placeholder
    // category (see classify() comment) — recompute the same "unresolved
    // mandate debit, still needs the registered-fact prompt" signal
    // directly off l2.channel and the absence of any real classification,
    // instead of pattern-matching a category string that no longer exists.
    const isUnconfidentNachGuess =
      !isCredit && l2.channel === 'NACH' && !classification;

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
      requires_classification: (l2.requires_classification && !isCustomResolved) || isUnconfidentNachGuess || classification?.ambiguous === true,
      possible_contra:        l2.possible_contra,
      txn_group_id:           null,
      is_infrastructure:      isInfra,
      health_module_tag:      null,
      // [FIX] Was hardcoded null. This is now the only place "unresolved
      // mandate debit, category deliberately withheld pending the
      // registered-fact prompt" is recorded on the persisted row — same
      // convention transactions.ts already uses for
      // 'awaiting_bank_confirmation' (a different "flagged, needs special
      // handling later" case). TransactionRow.tsx's qualifiesForRegisteredFact
      // reads this instead of category/sub_category to decide whether to
      // show the "What's this?" callout.
      parse_failure:          isUnconfidentNachGuess ? 'unresolved_mandate' : null,
      resolvedFrom:            classification?.resolvedFrom,
      raw_text:               body,
    };
  }

  // ── TAXONOMY FALLBACK ─────────────────────────────────────────────────────
  const extracted = extractFields(body);

  if (extracted.amount === null) {
    logHaikuCandidate(logs, msg, msgDate, extracted, 'missing_amount');
    return buildEscalated(msg, msgDate, isInfra, extracted, 'missing_amount');
  }
  if (extracted.isCredit === null) {
    logHaikuCandidate(logs, msg, msgDate, extracted, 'unknown_direction');
    return buildEscalated(msg, msgDate, isInfra, extracted, 'unknown_direction');
  }

  const classification = classify(body.toLowerCase(), extracted.isCredit, extracted.amount, extracted.channel, extracted.merchant, msgDate, extracted.reference_value, matchContext);

  if (!classification) {
    logHaikuCandidate(logs, msg, msgDate, extracted, 'escalated_to_haiku');
    return buildEscalated(msg, msgDate, isInfra, extracted, 'escalated_to_haiku');
  }

  const signedAmount = extracted.isCredit
    ? Math.abs(extracted.amount)
    : -Math.abs(extracted.amount);

  const needsReview =
    !extracted.accountLast4 ||
    Math.abs(extracted.amount) >= 5000 ||
    classification.ambiguous === true;

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
    requires_classification: classification.ambiguous === true,
    possible_contra:         false,
    txn_group_id:            null,
    is_infrastructure:       isInfra,
    health_module_tag:       null,
    parse_failure:           null,
    resolvedFrom:            classification.resolvedFrom,
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

// [ADD — Log A, logging only] Records that this message is headed toward
// the existing pending_review/parse_failure escalation path — it does not
// create the escalation (buildEscalated already does that, unchanged) and
// does not call Haiku. No-op if `logs` wasn't passed in.
function logHaikuCandidate(
  logs: ParseLogs | undefined,
  msg: RawMessage,
  msgDate: string,
  extracted: ExtractedFields,
  reason: 'missing_amount' | 'unknown_direction' | 'escalated_to_haiku',
): void {
  if (!logs) return;
  logs.haikuCandidates.push({
    raw_sms_id: msg.id,
    raw_text:   msg.body,
    txn_date:   msgDate,
    reason,
    extracted_amount:    extracted.amount,
    extracted_is_credit: extracted.isCredit,
    extracted_merchant:  extracted.merchant,
    extracted_bank:      extracted.bank,
    extracted_channel:   extracted.channel,
    logged_at: new Date().toISOString(),
  });
}

// [ADD] Layer 1 candidate logging. Takes raw SMS that Layer 1 dropped as
// no_direction (currency present, direction verb not recognized — see
// SmsReaderModule.kt/layer1sim.js's getLayer1Candidates/isLayer1Candidate)
// and logs them into the SAME Log A pipeline Layer 2/3 already use, so the
// existing syncParseLogs() call uploads them with zero new plumbing.
// Deliberately does NOT run these through classify() or create a
// ParsedTransaction — Layer 1 candidates never become pending_review rows
// directly here; only a future Haiku drain job (not built yet) does that,
// after actually confirming they're real transactions and not noise the
// current direction-signal list just doesn't recognize yet.
export function logLayer1Candidates(candidates: RawMessage[], logs: ParseLogs): void {
  for (const msg of candidates) {
    const msgDate    = new Date(msg.date).toISOString().split('T')[0];
    const extracted  = extractFields(msg.body);
    logs.haikuCandidates.push({
      raw_sms_id: msg.id,
      raw_text:   msg.body,
      txn_date:   msgDate,
      // 'unknown_direction' is the existing enum value that matches this
      // case exactly — amount extractable, direction isn't. No DB
      // migration needed; matches haiku_candidate_log's check constraint.
      reason:     'unknown_direction',
      extracted_amount:    extracted.amount,
      extracted_is_credit: extracted.isCredit,
      extracted_merchant:  extracted.merchant,
      extracted_bank:      extracted.bank,
      extracted_channel:   extracted.channel,
      logged_at: new Date().toISOString(),
    });
  }
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
    reference_value: extractReferenceValue(body),
  };
}

// [ADD] Local mirror of layer2_ruleset.js's extractReferenceValue() — this
// file's own convention (see extractRefNumber below, already duplicated
// independently for the same reason) is to keep the Layer-2 and taxonomy-
// fallback extractors independent rather than importing across the
// boundary, so this pattern is duplicated deliberately, not by oversight.
// Same generic-label design as the Layer 2 version: UMRN/Mandate ID/Policy
// No/Folio No/etc. all captured as one unlabeled reference_value, since
// registered_facts doesn't care what the bank called it, only that it's a
// stable, reusable identifier.
const REFERENCE_LABELS =
  /\b(?:UMRN|Mandate\s*ID|Policy\s*No\.?|Folio\s*No\.?|Loan\s*A\/c\.?|Mandate\s*Ref(?:erence)?)\s*[:\s]\s*([A-Za-z0-9]{4,25})\b/i;

function extractReferenceValue(body: string): string | null {
  const m = body.match(REFERENCE_LABELS);
  return m ? m[1] : null;
}

function extractAmount(body: string): number | null {
  // [FIX — this pass, found via corpus test] Same Lakh/Crore multiplier bug
  // as layer2_ruleset.js's extractAmount() — see that file's comment for
  // the full explanation. Fixed here too since this file's own convention
  // (see extractReferenceValue() above) is to keep the two independent
  // extractors in sync rather than importing across the Layer 2 /
  // taxonomy-fallback boundary.
  const lakhCrore = body.match(/(?:Rs\.?|INR|₹)\s*([\d,]+(?:\.\d+)?)\s*(lakhs?|crores?)\b/i);
  if (lakhCrore) {
    const raw = parseFloat(lakhCrore[1].replace(/,/g, ''));
    if (raw > 0) {
      const multiplier = /crore/i.test(lakhCrore[2]) ? 10000000 : 100000;
      return raw * multiplier;
    }
  }

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
    // [FIX — this pass, found via corpus test] 'has been paid from A/c' —
    // the whole "Your insurance premium Rs.X towards <insurer> Policy...
    // has been paid from A/c Y" template family (used across every insurer
    // in the corpus: SBI Life, HDFC Life, ICICI Prudential Life, LIC of
    // India, Max Life) has no Layer 2 rule at all, and this fallback didn't
    // recognize "paid from" as distinct from "paid to/via/for/towards" —
    // was escalating as unknown_direction regardless of which insurer was
    // named, i.e. this wasn't actually an LIC-specific gap, it was a
    // whole-template-family miss that the earlier LIC-only regex fix
    // didn't fully close on its own.
    'paid from',
    // [FIX — this pass] 'FD of Rs.X booked
    // successfully...' has neither a Layer 2 rule nor a debit keyword this
    // fallback recognized — it was escalating with parse_failure:
    // 'unknown_direction' instead of resolving as the debit it actually is
    // (money leaving the account into the new FD/RD). 'booked successfully'
    // is specific to deposit-booking confirmations in this corpus, low
    // collision risk in a financial-SMS-only fallback.
    'booked successfully',
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
  // [ADD] "Sent Rs.X\nFrom BANK A/C *NNNN\nTo NAME\nOn DD/MM/YY\nRef ..." —
  // a real P2P UPI template (bank-transfer style "Sent" SMS) with no VPA
  // domain, no "at", and no "towards" — none of the three patterns above
  // match it, so merchant was silently coming back null for every message
  // of this shape (confirmed against real data: e.g. "To Pradap R\nOn
  // 25/07/26" — extractMerchant() returned null, which meant
  // matchCustomCategory() could never fire for it either, since it
  // short-circuits on a missing merchant). Anchored on the following
  // "On DD/MM/YY" line specifically, so this doesn't fire on unrelated "to"
  // phrases elsewhere in a message that aren't this template.
  const sentToMatch = body.match(/\bTo\s+([A-Za-z0-9 &._-]{2,40})\s*[\r\n]+\s*On\s+\d{1,2}\/\d{1,2}\/\d{2,4}/i);
  if (sentToMatch) return sentToMatch[1].trim();
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

// [REMOVED — this pass] This file used to carry a "loose match" fallback:
// every \b-bounded TAXONOMY pattern also got tested, boundary-stripped,
// against the isolated merchant field alone — added because some SMS
// templates glue merchant names together with no separators (UPI-handle/
// POS-terminal style: "adyaranandabhavanswe.6325"), where a normal \b...\b
// pattern structurally can't match even though the real merchant is right
// there in the text.
//
// Removed after a real-data test (1,127 deduped messages across two users'
// full history) found it was responsible for exactly ONE classification in
// the entire corpus — and that one case turned out to be a plain
// pluralization gap (\brefund\b vs "refunds"), fixed directly above by
// adding the plural pattern, not a genuine need for substring matching.
// Meanwhile every pattern in TAXONOMY (414 of 416, once the length-based
// LOOSE_MATCH_DENYLIST safeguard is factored in) was eligible for this
// fallback — a wide, open-ended collision surface for one confirmed
// benefit. It already caused one real bug (\bspa\b matching inside
// "flipkart.hypg@yespay", mislabeling a refund credit as a personal-care
// debit) before being patched with a denylist entry + a minimum-length
// floor. Decision: direct \b...\b matches only from here on. A glued/
// no-separator merchant name that no direct pattern recognizes now falls
// through to pending_review, same as any other unrecognized message —
// resolvable via custom_categories once, remembered forever after, which
// didn't exist yet when the loose-match fallback was first built and is a
// strictly better fit for "genuinely novel merchant text" than a regex
// guessing at fused strings ever was.

// [ADD] custom_categories lookup — direct merchant_key match. Takes priority
// over everything else in classify(): if the user already told us once what
// a merchant means (either a [CUSTOM] case like a P2P payee, or an
// [ambiguous] case like Zerodha), that stands, regardless of what the regex
// would otherwise guess. This is the "confirm once, forever" mechanism.
// [CHANGED — this pass] Exported. transactions.ts's reconcilePendingTransactions()
// needs to re-run this same check against already-stored pending rows, not
// just at parse time — single source of truth for "what counts as a match,"
// same reasoning as normaliseMerchantKey() being shared rather than
// duplicated.
export function matchCustomCategory(
  merchant: string | null | undefined,
  customCategories?: CustomCategoryEntry[],
): Classification | null {
  if (!customCategories?.length || !merchant) return null;
  const key = normaliseMerchantKey(merchant);
  if (!key) return null;
  const match = customCategories.find(c => c.merchant_key === key);
  if (!match) return null;
  return {
    type:         match.type,
    category:     match.category,
    sub_category: match.sub_category,
    ambiguous:    false,
    resolvedFrom: 'custom_category',
  };
}

// [ADD] registered_facts lookup — for the case custom_categories can't
// handle: merchant identity itself is unrecoverable from the SMS (generic
// NACH debit via a clearing house). Three tiers, in order:
//   1. reference_value exact match — if the SMS carried a UMRN/Mandate ID/
//      Policy No/etc. and it matches a stored fact exactly, that's certain.
//   2. [CHANGED] amount + merchant_key, both required — a recurring
//      payment can be weekly/monthly/quarterly, so a day-of-month window
//      was never a reliable "same fact" signal on its own; merchant_key
//      is the stronger pairing with amount. If more than one fact matches
//      within tolerance, deliberately do NOT guess between them —
//      ambiguous matches return null, same as "no match", and fall
//      through to the generic guess / eventual Haiku escalation rather
//      than picking wrong. (Caveat: two genuinely different facts routed
//      through the same clearing-house gateway could in principle share
//      an identical generic merchant string, collapsing their
//      merchant_key — amount still has to also match for a false
//      collision here, so this is unlikely in practice, but worth knowing
//      if it ever comes up in real data.)
//   3. no match — return null, caller falls back to the generic NACH-guess
//      label (still forces pending_review, same as before this existed).
//
// [KEPT — unused by matchRegisteredFact() below, retained in case
// day-tolerance matching ever needs to be revisited]
function dayOfMonthFrom(txnDate?: string | null): number | null {
  if (!txnDate) return null;
  const day = new Date(txnDate).getUTCDate();
  return isNaN(day) ? null : day;
}

// [FIX — found during audit] Plain Math.abs(day1 - day2) breaks at every
// month boundary: a NACH mandate set to debit on the 1st that actually
// processes on the 29th (3 days early, having slipped into the previous
// month around a weekend/bank holiday — a routine, common pattern, not an
// edge case) computed as 28 days apart instead of 3, so it never matched
// even a generous day_tolerance. Treats the day-of-month as circular
// (cycle length 31, the max possible month length) so wraparound distances
// resolve correctly. Slightly generous near shorter months (e.g. Feb) but
// that only ever makes tolerance MORE liberal, never less — consistent
// with the project's "liberal matching" decision, and the failure mode of
// being too liberal here is "asks to confirm one fewer time," not
// "silently miscategorizes," since a single match is still required.
function dayDistance(day1: number, day2: number): number {
  const diff = Math.abs(day1 - day2);
  return Math.min(diff, 31 - diff);
}

// [CHANGED — this pass] Exported, same reasoning as matchCustomCategory()
// above — reused by transactions.ts's reconcilePendingTransactions().
export function matchRegisteredFact(
  amount: number,
  merchant: string | null | undefined,
  referenceValue: string | null | undefined,
  registeredFacts?: RegisteredFact[],
): Classification | null {
  if (!registeredFacts?.length) return null;

  // [CHANGED — this pass] Tier 1 — reference match. Previously assumed a
  // UMRN/Mandate ID collision between two different real-world facts would
  // be "vanishingly unlikely" and matched on reference_value ALONE via
  // .find(), returning whichever fact happened to come back first from the
  // query (fetchActiveRegisteredFacts() has no .order(), so that's not even
  // deterministic). Confirmed as a real, reachable bug against actual test
  // data: three registered facts sharing one reused UMRN caused every debit
  // against that reference — regardless of its actual amount — to resolve
  // to whichever fact's row order won, once even mapping a ₹500 EMI onto a
  // "Mutual Funds" fact. Now requires amount to also fall within tolerance,
  // and — same discipline as Tier 2 below — if more than one fact still
  // qualifies, that's genuine ambiguity: don't guess, return null and let
  // it fall through instead of silently picking one.
  if (referenceValue) {
    const refCandidates = registeredFacts.filter(f => {
      if (f.reference_value !== referenceValue) return false;
      return (
        f.expected_amount == null ||
        Math.abs(amount - f.expected_amount) <= f.amount_tolerance
      );
    });
    if (refCandidates.length === 1) {
      const exact = refCandidates[0];
      return {
        type:         exact.resolved_type,
        category:     exact.resolved_category,
        sub_category: exact.resolved_sub_category,
        ambiguous:    false,
        resolvedFrom: 'registered_fact',
      };
    }
    // refCandidates.length > 1 (genuine reference collision at this
    // amount) falls through to Tier 2 below, which may still disambiguate
    // via merchant_key even where amount+reference alone couldn't.
  }

  // [CHANGED] Tier 2 — amount + merchant_key, both required. Day-of-month
  // dropped (see this function's header comment above for why). Collect
  // ALL candidates that qualify on both; only resolve if exactly one does.
  const merchantKey = normaliseMerchantKey(merchant ?? null);
  const candidates = registeredFacts.filter(f => {
    const amountOk =
      f.expected_amount == null ||
      Math.abs(amount - f.expected_amount) <= f.amount_tolerance;
    // A fact with no merchant_key on file (confirmed before this field
    // existed, or a transaction with no merchant text at all) can't be
    // matched on this tier — falls through to "no match" rather than
    // silently matching on amount alone, which would reintroduce exactly
    // the ambiguity this tier exists to avoid.
    const merchantOk =
      !!f.merchant_key && !!merchantKey && f.merchant_key === merchantKey;
    return amountOk && merchantOk;
  });

  if (candidates.length === 1) {
    const f = candidates[0];
    return {
      type:         f.resolved_type,
      category:     f.resolved_category,
      sub_category: f.resolved_sub_category,
      ambiguous:    false,
      resolvedFrom: 'registered_fact',
    };
  }

  // Zero or multiple candidates — don't guess. Falls through to the
  // existing generic NACH-guess label below.
  return null;
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
//
// [ADD — this pass] Added optional `txnDate`, `referenceValue`, and
// `matchContext` params. All optional, all default to no-op when omitted —
// [ADD] VPA local-part fallback — narrowly scoped substring match, only for
// UPI-style messages (text containing '<local-part>@<handle>'), and only
// against the local-part BEFORE the '@' — never the handle/PSP suffix
// after it. This deliberately excludes the exact text region where the
// only historically-confirmed collision bug happened (\bspa\b matching
// inside "yespay", which is the PSP handle AFTER '@', not the merchant
// identifier before it) — scoping here structurally can't reproduce that
// specific bug, not just makes it less likely.
//
// UPI VPA local-parts commonly glue a merchant name directly onto a
// sequence number ("swiggy1", "kfcindia53") with no character-level
// boundary between them — digits are word characters, so no \b...\b
// pattern can ever bridge that gap regardless of how it's authored.
// Strip digits/punctuation from the local-part first, then test each
// pattern's un-boundaried core as a substring against what's left.
//
// [FLAG] This still carries the same class of collision risk the removed
// loose-matching had, just scoped far narrower (before-@ text only, UPI
// messages only, verified against 6,127 real messages before shipping —
// see commit notes). That verification doesn't transfer automatically to
// future patterns: re-check against real data whenever a new short
// pattern is added to TAXONOMY. It also assumes TAXONOMY patterns stay in
// the simple \bword\b literal shape that's dominant today — if patterns
// shift toward heavier alternations/lookaheads, toLooseVariant() below
// may stop extracting a meaningful core from them and this should be
// revisited.
function extractVpaLocalPart(body: string): string {
  const m = body.match(/\b([a-z0-9][a-z0-9._:+-]{1,40})@[a-z0-9.]+\b/i);
  if (!m) return '';
  return m[1].toLowerCase().replace(/[^a-z]/g, '');
}

function toLooseVariant(pattern: RegExp): RegExp {
  const looseSource = pattern.source
    .replace(/\\b/g, '')
    .replace(/\\s\+/g, '')
    .replace(/\\s\*/g, '');
  return new RegExp(looseSource, pattern.flags);
}

// [Layer 2 / TAXONOMY fallback boundary — classify() below is the entry
// every existing call site keeps working unchanged if it doesn't pass them.
// See matchCustomCategory()/matchRegisteredFact() above for what each does.
function classify(
  bodyLower: string,
  isCredit: boolean,
  amount: number,
  channel?: string | null,
  merchant?: string | null,
  txnDate?: string | null,
  referenceValue?: string | null,
  matchContext?: MatchContext,
): Classification | null {
  // [ADD] custom_categories always wins first — a past user decision
  // overrides any regex guess, ambiguous or not.
  const customMatch = matchCustomCategory(merchant, matchContext?.customCategories);
  if (customMatch) return customMatch;

  const direction = isCredit ? 'credit' : 'debit';
  const vpaLocalPart = extractVpaLocalPart(bodyLower);
  let bestEntry: TaxonomyEntry | null = null;
  let bestScore = 0;

  for (const entry of TAXONOMY) {
    if (entry.direction && entry.direction !== direction) continue;
    if (entry.maxAmount !== undefined && amount > entry.maxAmount) continue;
    if (entry.minAmount !== undefined && amount < entry.minAmount) continue;
    const score = entry.patterns.filter(p => {
      if (p.test(bodyLower)) return true;
      if (!vpaLocalPart) return false;
      return toLooseVariant(p).test(vpaLocalPart);
    }).length;
    if (score > bestScore) { bestScore = score; bestEntry = entry; }
  }

  if (bestEntry) {
    return {
      type:         bestEntry.type,
      category:     bestEntry.category,
      sub_category: bestEntry.sub_category,
      ambiguous:    bestEntry.ambiguous || false,
    };
  }

  // [FIX — corrected after a real regression, audit this carefully before
  // touching again] registered_facts fallback — precisely scoped to
  // recurring-mandate-shaped debits, NOT "any debit regex failed to
  // classify."
  //
  // History of getting this gate right took two attempts:
  //   1st: gated on channel === 'NACH' only — too narrow, missed UPI
  //        Mandate execution SMS (extractChannel() deliberately tags these
  //        channel:'UPI', not 'NACH') and the separate 'EMI' channel value.
  //   2nd: removed the channel check entirely ("any unclassified debit") —
  //        too broad. Confirmed via real-corpus regression: ordinary P2P
  //        transfers and shop purchases (a payment to "B SHAM KUMAR", a
  //        purchase at "NEW RAHMAN PLAZA") started resolving as "Mutual
  //        Funds/SIP" purely because their amount+day coincidentally fell
  //        within tolerance — these have perfectly identifiable merchant
  //        text, they just lack a regex pattern. That's custom_categories'
  //        job (the [CUSTOM] bucket), not registered_facts' — registered_
  //        facts exists ONLY for debits that are structurally
  //        mandate/recurring-shaped but withhold WHO, not for "any
  //        merchant regex hasn't been taught yet."
  //   3rd (this one): explicit allowlist of recurring-mandate shapes —
  //        NACH, the bare 'EMI' channel, or a UPI Mandate execution SMS
  //        (re-derived here via the same "UPI Mandate:" prefix
  //        extractChannel() uses to route these to channel:'UPI' in the
  //        first place — that routing decision was made for its own
  //        reason and isn't being undone, just recognized here too).
  const isRecurringMandateShape =
    channel === 'NACH' ||
    channel === 'EMI' ||
    /^upi mandate:/im.test(bodyLower);

  if (!isCredit && isRecurringMandateShape) {
    const factMatch = matchRegisteredFact(amount, merchant, referenceValue, matchContext?.registeredFacts);
    if (factMatch) return factMatch;
  }

  // [ADD — this pass] NACH fallback. No text pattern matched anything, and
  // no registered_facts match resolved it either, but Layer 2 (or
  // extractFields()) already told us this is a NACH mandate debit — a
  // real, recurring, non-P2P payment to a registered entity (typically a
  // clearing house acting on behalf of a SIP/insurance/EMI mandate; live
  // data showed "INDIAN CLEARING CORP LTD" as 100% of NACH matches, 20 of
  // 259 transactions in one 90-day sample, all previously uncategorized).
  // Rather than leave this fully blank, return a generic label — the
  // caller (parseSingleSms) still forces pending_review for this specific
  // classification via isUnconfidentNachGuess, so this is a helpful
  // default label, not a confident auto-approval. Deliberately stays
  // NACH-only — unlike the registered_facts check above, this label would
  // be a FALSE statement for a UPI/EMI-channel debit, so it must not
  // apply there; those simply return null below and fall through to
  // whatever downstream handling already exists for unclassified debits
  // (same as before this feature existed).
  // [FIX] Previously returned a placeholder { type: 'Liability', category:
  // 'Recurring Payment', sub_category: 'NACH Mandate' } here instead of
  // null — meant as "don't leave it fully blank," but this actively
  // corrupts health-module scoring (Debt Ratio, Investment Rate, Income
  // Stability all read type/category straight off the transactions table
  // per pileap_scoring_reality_check.pdf's weighted_emi/investment-rate/
  // income-CV formulas). An unresolved SIP, insurance premium, or even a
  // non-financial subscription mandate (e.g. a SaaS auto-pay) would get
  // counted as debt in Debt Ratio while simultaneously NOT counting toward
  // Investment Rate — a double-direction error on the same money, and for
  // exactly the transactions still awaiting the user's own answer via
  // RegisterFactPrompt. Returns null now, same treatment as any other
  // genuinely uncategorized debit; parseSingleSms tracks "this still needs
  // the registered-fact prompt" via isUnconfidentNachGuess (recomputed off
  // l2.channel there, not off this return value) instead of via a fake
  // category.
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