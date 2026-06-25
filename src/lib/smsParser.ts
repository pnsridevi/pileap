/**
 * smsParser.ts
 * Location: packages/core/smsParser.ts
 *
 * Input:  RawMessage[] — platform-agnostic; satisfied by SmsMessage (mobile)
 *         and future EmailMessage (web/email parser)
 * Output: ParsedTransaction[] — ready to upsert into transactions table
 *
 * Arch ref: Sections 4.4, 4.5, 4.8, 5.3, 5.7, 10.2
 *
 * Changes from v1:
 *   - RawMessage replaces SmsMessage (platform-agnostic, arch 10.2)
 *   - Score-based direction detection (debit/credit keyword counts, not first-match)
 *   - bank detection from message body
 *   - channel detection (UPI/NEFT/IMPS/POS/ATM/NACH etc.)
 *   - balance extraction (available balance from SMS)
 *   - parse_failure reason on partial results instead of silent null drop
 *   - Full India-tuned taxonomy with word-boundary regex (ported from classifier.py)
 *     Covers: quick commerce, groceries, ride hailing, fuel, transit, fashion,
 *     electronics, electricity/water/gas, telecom, OTT, gaming, education brands,
 *     flights, hotels (with amount threshold), govt taxes, salons, fitness,
 *     FD/RD, stocks/brokers, crypto, NPS/PPF/SGB, BNPL, home/vehicle/education loans
 *   - UPI VPA domain → bank/wallet mapping
 *   - Amount-threshold disambiguation (hotel < ₹2000 = restaurant, ≥ ₹2000 = lodging)
 *   - Direction constraint on income entries (salary, rent received etc.)
 */

// ─── Platform-agnostic input (arch 10.2) ─────────────────────────────────────

export interface RawMessage {
  id:      string;   // idempotency key
  address: string;   // SMS shortcode or email sender domain
  body:    string;   // raw message text
  date:    number;   // epoch milliseconds
}

// ─── Output type (maps to transactions table) ─────────────────────────────────

export interface ParsedTransaction {
  raw_sms_id:            string;
  txn_date:              string;        // YYYY-MM-DD
  amount:                number | null; // null only on parse_failure
  type:                  TxnType | null;
  category:              string | null;
  sub_category:          string | null;
  merchant:              string | null;
  source:                'sms';
  status:                'approved' | 'pending_review';

  // Enrichment
  account_number_masked: string | null;
  bank:                  string | null;
  channel:               string | null;
  balance:               number | null; // available balance from SMS

  // Ref number (arch 5.3.6 v3.1)
  ref_number:            string | null;
  ref_type:              'upi_rrn' | 'neft_utr' | 'unknown' | null;

  // Deferred / post-insert
  txn_group_id:          null;
  is_infrastructure:     boolean;
  health_module_tag:     null;

  // Failure tracking (replaces silent null drop — routes to pending_review)
  parse_failure:         string | null; // 'missing_amount' | 'unknown_direction' | 'unclassified'

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
  type:        TxnType;
  category:    string;
  sub_category: string | null;
}

// ─── UPI infrastructure senders ──────────────────────────────────────────────

const UPI_INFRA_SENDERS = ['NPCI', 'UPITRN', 'UPITXN', 'SBIPSG', 'HDFCPAY'];

// ─── Bank keyword map ─────────────────────────────────────────────────────────

const BANK_MAP: Record<string, string> = {
  'HDFC':        'HDFC Bank',
  'ICICI':       'ICICI Bank',
  'SBI':         'State Bank of India',
  'AXIS':        'Axis Bank',
  'KOTAK':       'Kotak Mahindra Bank',
  'YES BANK':    'Yes Bank',
  'YESBANK':     'Yes Bank',
  'PNB':         'Punjab National Bank',
  'BOB':         'Bank of Baroda',
  'CANARA':      'Canara Bank',
  'IDFC':        'IDFC First Bank',
  'INDUSIND':    'IndusInd Bank',
  'FEDERAL':     'Federal Bank',
  'RBL':         'RBL Bank',
  'UNION BANK':  'Union Bank of India',
  'PAYTM':       'Paytm Payments Bank',
  'AIRTEL':      'Airtel Payments Bank',
  'AU BANK':     'AU Small Finance Bank',
  'AUBANK':      'AU Small Finance Bank',
  'BANDHAN':     'Bandhan Bank',
  'JANA':        'Jana Small Finance Bank',
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
  slice:       'Slice',
  jupiter:     'Jupiter',
  fi:          'Fi Money',
  airtel:      'Airtel Payments Bank',
  jio:         'Jio Payments Bank',
};

// ─── Channel keyword map ──────────────────────────────────────────────────────

const CHANNEL_MAP: Record<string, string> = {
  'UPI':                  'UPI',
  'NEFT':                 'NEFT',
  'RTGS':                 'RTGS',
  'IMPS':                 'IMPS',
  'ATM':                  'ATM',
  'POS':                  'POS',
  'NACH':                 'NACH',
  'ECS':                  'ECS',
  'ACH':                  'ACH',
  'NET BANKING':          'Net Banking',
  'NETBANKING':           'Net Banking',
  'MOBILE BANKING':       'Mobile Banking',
  'CREDIT CARD':          'Credit Card',
  'DEBIT CARD':           'Debit Card',
  'WALLET':               'Wallet',
  'STANDING INSTRUCTION': 'Standing Instruction',
  'AUTO DEBIT':           'Auto Debit',
};

// ─── Taxonomy ─────────────────────────────────────────────────────────────────
// Order matters — more specific entries before generic ones
// direction: 'credit' | 'debit' — if set, only matches in that direction
// maxAmount / minAmount — for hotel/restaurant disambiguation

interface TaxonomyEntry {
  type:        TxnType;
  category:    string;
  sub_category: string | null;
  patterns:    RegExp[];
  direction?:  'credit' | 'debit';
  minAmount?:  number;
  maxAmount?:  number;
}

const TAXONOMY: TaxonomyEntry[] = [

  // ══ EXPENSE — Food & Dining ══════════════════════════════════════════════

  { type: 'Expense', category: 'Food & Dining', sub_category: 'Quick Commerce',
    patterns: [/\bblinkit\b/i, /\bzepto\b/i, /\bswiggy\s+instamart\b/i,
               /\binstamart\b/i, /\bbbdaily\b/i, /\bdunzo\b/i, /\btata\s+now\b/i] },

  { type: 'Expense', category: 'Food & Dining', sub_category: 'Restaurants',
    patterns: [/\bzomato\b/i, /\bswiggy\b/i, /\brestaurant\b/i, /\bbistro\b/i,
               /\bdhaba\b/i, /\bpizza\s+hut\b/i, /\bdomino'?s?\b/i, /\bkfc\b/i,
               /\bmcdonald'?s?\b/i, /\bsubway\b/i, /\bburger\s+king\b/i,
               /\bstarbucks\b/i, /\bbarista\b/i, /\bdunkin\b/i,
               /\bbarbeque\s+nation\b/i, /\bcafe\b/i, /\bdining\b/i,
               /\bfood\s+court\b/i, /\btaco\s+bell\b/i, /\bhaldiram\b/i,
               /\bsaravana\s+bhavan\b/i],
    maxAmount: 2000 },

  { type: 'Expense', category: 'Food & Dining', sub_category: 'Cafes & Beverages',
    patterns: [/\bccd\b/i, /\bcafe\s+coffee\s+day\b/i, /\bblue\s+tokai\b/i,
               /\bthird\s+wave\b/i, /\bjuice\s+(bar|junction|cafe)\b/i,
               /\bbeverages?\b/i] },

  { type: 'Expense', category: 'Food & Dining', sub_category: 'Alcohol & Liquor',
    patterns: [/\bliquor\b/i, /\bwine\s+shop\b/i, /\btasmac\b/i,
               /\bbrewery\b/i, /\bpub\b/i, /\bcraft\s+beer\b/i,
               /\bwhisky\b/i, /\bwhiskey\b/i, /\bvodka\b/i, /\brum\b/i,
               /\bbar\s+&\s+grill\b/i] },

  { type: 'Expense', category: 'Food & Dining', sub_category: 'Groceries',
    patterns: [/\bbigbasket\b/i, /\bgrofers\b/i, /\bjiomart\b/i,
               /\bd[\s-]?mart\b/i, /\bmore\s+supermarket\b/i,
               /\breliance\s+(fresh|smart|retail)\b/i, /\bspencer'?s?\b/i,
               /\bsupermarket\b/i, /\bhypermarket\b/i, /\bkirana\b/i,
               /\bgrocery\b/i, /\bbig\s+bazaar\b/i] },

  // ══ EXPENSE — Transportation ═════════════════════════════════════════════

  { type: 'Expense', category: 'Transportation', sub_category: 'Tolls & FASTag',
    patterns: [/\bfastag\b/i, /\bnetc\b/i, /\bnhai\b/i,
               /\btoll\s+(plaza|gate|debit|charge|payment)\b/i,
               /\btoll\s+tax\b/i] },

  { type: 'Expense', category: 'Transportation', sub_category: 'Parking',
    patterns: [/\bparking\s+(fee|charge|payment)\b/i,
               /\bpark\s+(and\s+ride|fee)\b/i, /\bsmart\s+parking\b/i] },

  { type: 'Expense', category: 'Transportation', sub_category: 'Ride Hailing',
    patterns: [/\buber\b/i, /\bola\b/i, /\brapido\b/i, /\bmeru\b/i,
               /\bblusmart\b/i, /\bnamma\s+yatri\b/i, /\byatri\b/i,
               /\bjugnoo\b/i] },

  { type: 'Expense', category: 'Transportation', sub_category: 'Fuel',
    patterns: [/\bpetrol\s+(pump|station|bunk)\b/i, /\bdiesel\s+(pump|fill)\b/i,
               /\bfuel\s+(station|fill|charge)\b/i, /\bhpcl\b/i,
               /\bindian\s+oil\b/i, /\biocl\b/i,
               /\bbharat\s+petroleum\b/i, /\bbpcl\b/i,
               /\bnayara\s+energy\b/i] },

  { type: 'Expense', category: 'Transportation', sub_category: 'Public Transit',
    patterns: [/\bmetro\s+(rail|card|recharge|fare)\b/i, /\birctc\b/i,
               /\bindian\s+railways?\b/i, /\bredbus\b/i,
               /\bksrtc\b/i, /\bapsrtc\b/i, /\bmsrtc\b/i,
               /\bbus\s+ticket\b/i, /\btrain\s+ticket\b/i] },

  // ══ EXPENSE — Shopping ═══════════════════════════════════════════════════

  { type: 'Expense', category: 'Shopping', sub_category: 'Online Shopping',
    patterns: [/\bamazon\b/i, /\bflipkart\b/i, /\bmyntra\b/i,
               /\bajio\b/i, /\bnykaa\b/i, /\bmeesho\b/i,
               /\bsnapdeal\b/i, /\btata\s*cliq\b/i, /\bfkinternet\b/i] },

  { type: 'Expense', category: 'Shopping', sub_category: 'Fashion & Apparel',
    patterns: [/\bzara\b/i, /\bh\s*&\s*m\b/i, /\bwestside\b/i,
               /\bmax\s+fashion\b/i, /\bpantaloons\b/i,
               /\blifestyle\s+(store|fashion)\b/i, /\bshoppers\s+stop\b/i,
               /\bfabindia\b/i, /\blevis\b/i, /\bpepe\s+jeans\b/i] },

  { type: 'Expense', category: 'Shopping', sub_category: 'Electronics',
    patterns: [/\bcroma\b/i, /\bvijay\s+sales\b/i,
               /\breliance\s+digital\b/i, /\bapple\s+(store|india)\b/i,
               /\bsamsung\s+(store|plaza|exclusive)\b/i,
               /\blenovo\b/i, /\bdell\b/i, /\basus\b/i, /\boneplus\b/i] },

  // ══ EXPENSE — Utilities ══════════════════════════════════════════════════

  { type: 'Expense', category: 'Utilities', sub_category: 'Electricity',
    patterns: [/\electricity\s+(bill|payment)\b/i, /\bbescom\b/i,
               /\btneb\b/i, /\bmseb\b/i, /\bmsedcl\b/i,
               /\btata\s+power\b/i, /\bbses\b/i,
               /\badani\s+electricity\b/i, /\buppcl\b/i,
               /\bpower\s+(bill|payment)\b/i] },

  { type: 'Expense', category: 'Utilities', sub_category: 'Water',
    patterns: [/\bwater\s+(bill|tax|charge|board|payment)\b/i,
               /\bbwssb\b/i, /\bhmwssb\b/i, /\bcwss\b/i] },

  { type: 'Expense', category: 'Utilities', sub_category: 'Gas',
    patterns: [/\bgas\s+(bill|payment|connection)\b/i,
               /\bpiped\s+(gas|natural\s+gas)\b/i,
               /\bindraprastha\s+gas\b/i, /\bigl\b/i,
               /\bmahanagar\s+gas\b/i, /\bmgl\b/i,
               /\badani\s+(total\s+)?gas\b/i,
               /\blpg\s+(cylinder|booking|payment)\b/i,
               /\bindane\b/i, /\bbharat\s+gas\b/i, /\bhp\s+gas\b/i] },

  // ══ EXPENSE — Telecom ════════════════════════════════════════════════════

  { type: 'Expense', category: 'Telecom', sub_category: 'Mobile Recharge',
    patterns: [/\bjio\s+(recharge|prepaid)\b/i, /\bairtel\s+(recharge|prepaid)\b/i,
               /\bvi\s+(recharge|prepaid)\b/i, /\bbsnl\s+recharge\b/i,
               /\bmobile\s+(recharge|topup|top-up)\b/i,
               /\bprepaid\s+(recharge|topup)\b/i, /\btalktime\b/i] },

  { type: 'Expense', category: 'Telecom', sub_category: 'Broadband',
    patterns: [/\bbroadband\s+(bill|payment|plan)\b/i,
               /\bwifi\s+(bill|payment|recharge)\b/i,
               /\binternet\s+(bill|payment|plan)\b/i,
               /\bjio\s+fiber\b/i, /\bairtel\s+fiber\b/i,
               /\bact\s+fibernet\b/i, /\bhathway\b/i, /\bexcitel\b/i] },

  // ══ EXPENSE — Healthcare ═════════════════════════════════════════════════

  { type: 'Expense', category: 'Healthcare', sub_category: 'Pharmacy',
    patterns: [/\bapollo\s+pharmacy\b/i, /\bmedplus\b/i,
               /\bnetmeds\b/i, /\bpharmeasy\b/i, /\b1mg\b/i,
               /\bwellness\s+forever\b/i, /\bchemist\b/i,
               /\bpharmacy\b/i, /\bmedical\s+(store|hall|shop)\b/i,
               /\bdrug\s+store\b/i] },

  { type: 'Expense', category: 'Healthcare', sub_category: 'Hospital & Clinic',
    patterns: [/\bhospital\b/i, /\bclinic\b/i, /\bdiagnostics?\b/i,
               /\blal\s+(path|pathlabs?)\b/i, /\bthyrocare\b/i,
               /\bfortis\b/i, /\bmax\s+hospital\b/i,
               /\bapollo\s+hospitals?\b/i, /\bnarayana\s+health\b/i,
               /\bconsultation\s+fee\b/i, /\bopd\s+fee\b/i] },

  // ══ EXPENSE — Entertainment ══════════════════════════════════════════════

  { type: 'Expense', category: 'Entertainment', sub_category: 'OTT Subscriptions',
    patterns: [/\bnetflix\b/i, /\bhotstar\b/i, /\bdisney\+?\s*hotstar\b/i,
               /\bamazon\s+prime\b/i, /\bprime\s+video\b/i,
               /\bsonyliv\b/i, /\bsony\s+liv\b/i,
               /\bzee5\b/i, /\bvoot\b/i, /\bjio\s+cinema\b/i,
               /\bdiscovery\+\b/i, /\bapple\s+tv\+\b/i] },

  { type: 'Expense', category: 'Entertainment', sub_category: 'Movies & Events',
    patterns: [/\bbookmyshow\b/i, /\bpvr\b/i, /\binox\b/i,
               /\bcinepolis\b/i, /\bmovie\s+ticket\b/i,
               /\bevent\s+ticket\b/i, /\bspi\s+cinema\b/i] },

  { type: 'Expense', category: 'Entertainment', sub_category: 'Gaming & Fantasy Sports',
    patterns: [/\bdream\s*11\b/i, /\bdream11\b/i, /\bmpl\b/i,
               /\bwinzo\b/i, /\brummy\s+(circle|culture|passion|time)\b/i,
               /\bjunglee\s+rummy\b/i, /\bmy11circle\b/i,
               /\bfantasy\s+(cricket|sports)\b/i,
               /\bpoker\b/i, /\bonline\s+gaming\b/i,
               /\bsteam\s+(games|wallet)\b/i] },

  // ══ EXPENSE — Education ══════════════════════════════════════════════════

  { type: 'Expense', category: 'Education', sub_category: 'Tuition & Courses',
    patterns: [/\bbyju'?s?\b/i, /\bunacademy\b/i, /\bvedantu\b/i,
               /\bcoursera\b/i, /\budemy\b/i, /\bupgrad\b/i,
               /\bsimplilearn\b/i, /\bphysics\s+wallah\b/i,
               /\bschool\s+fee\b/i, /\bcollege\s+fee\b/i,
               /\btuition\s+fee\b/i, /\bexamination\s+fee\b/i,
               /\badmission\s+fee\b/i] },

  // ══ EXPENSE — Travel ═════════════════════════════════════════════════════

  { type: 'Expense', category: 'Travel', sub_category: 'Flight',
    patterns: [/\bindigo\b/i, /\bair\s+india\b/i, /\bspicejet\b/i,
               /\bgo\s*air\b/i, /\bakasa\s+air\b/i, /\bvistara\b/i,
               /\bmakemytrip\s+flight\b/i, /\bcleartrip\b/i,
               /\bixigo\s+flight\b/i, /\beasemytrip\b/i,
               /\bflight\s+ticket\b/i, /\bairfare\b/i] },

  { type: 'Expense', category: 'Travel', sub_category: 'Hotel',
    patterns: [/\boyorooms?\b/i, /\btreebo\b/i, /\bfabhotel\b/i,
               /\bhotel\s+booking\b/i, /\bmakemytrip\s+hotel\b/i,
               /\bgoibibo\b/i, /\bbooking\.com\b/i, /\bairbnb\b/i,
               /\btaj\s+hotels?\b/i, /\boberoi\s+hotels?\b/i,
               /\bmarriott\b/i, /\bhyatt\b/i],
    minAmount: 2000 },

  // ══ EXPENSE — Rent & Housing ═════════════════════════════════════════════

  { type: 'Expense', category: 'Rent & Housing', sub_category: 'House Rent',
    patterns: [/\bhouse\s+rent\b/i, /\bflat\s+rent\b/i,
               /\bpg\s+(rent|fee)\b/i, /\bpaying\s+guest\b/i,
               /\brent\s+(payment|paid|transfer)\b/i,
               /\bmonthly\s+rent\b/i, /\btenancy\b/i] },

  { type: 'Expense', category: 'Rent & Housing', sub_category: 'Maintenance & Society',
    patterns: [/\bsociety\s+(maintenance|charges?|fee)\b/i,
               /\bmaintenance\s+(fee|charge|payment)\b/i,
               /\bapartment\s+(maintenance|association)\b/i,
               /\brwa\s+(fee|charge)\b/i, /\bhousing\s+society\b/i] },

  // ══ EXPENSE — Personal Care ══════════════════════════════════════════════

  { type: 'Expense', category: 'Personal Care', sub_category: 'Salons & Spas',
    patterns: [/\bsalon\b/i, /\bspa\b/i, /\bhaircut\b/i,
               /\bbeauty\s+parlour\b/i, /\burban\s+company\b/i,
               /\burban\s+clap\b/i, /\bvlcc\b/i,
               /\bjawed\s+habib\b/i] },

  { type: 'Expense', category: 'Personal Care', sub_category: 'Fitness',
    patterns: [/\bgym\s+(fee|membership|subscription)\b/i,
               /\bfitness\s+(centre|center|club|studio)\b/i,
               /\bcult\.?fit\b/i, /\bcure\.?fit\b/i,
               /\banytime\s+fitness\b/i, /\bcross\s*fit\b/i,
               /\byoga\s+(class|centre|studio)\b/i, /\bzumba\b/i] },

  // ══ EXPENSE — Government & Taxes ════════════════════════════════════════

  { type: 'Expense', category: 'Government & Taxes', sub_category: 'Challan & Fines',
    patterns: [/\bechallan\b/i, /\be-challan\b/i, /\bparivahan\b/i,
               /\btraffic\s+(fine|challan|penalty)\b/i,
               /\bpolice\s+(challan|fine)\b/i,
               /\bchallan\s+(payment|paid)\b/i] },

  { type: 'Expense', category: 'Government & Taxes', sub_category: 'Property & Municipality Tax',
    patterns: [/\bproperty\s+tax\b/i, /\bhouse\s+tax\b/i,
               /\bmunicipality\s+tax\b/i, /\bbmc\s+(tax|payment)\b/i,
               /\bbbmp\s+(tax|payment)\b/i] },

  { type: 'Expense', category: 'Government & Taxes', sub_category: 'Income Tax & GST',
    patterns: [/\bincome\s+tax\s+(payment|challan|tds)\b/i,
               /\btds\s+(payment|challan|deduction)\b/i,
               /\bgst\s+(payment|challan|filing)\b/i,
               /\badvance\s+tax\b/i, /\bnsdl\s+challan\b/i] },

  // ══ EXPENSE — Finance Charges ════════════════════════════════════════════

  { type: 'Expense', category: 'Finance Charges', sub_category: 'Cash Withdrawal',
    patterns: [/\batm\s+(debit|withdrawal|wdl|cash)\b/i,
               /\bcash\s+(withdrawal|withdrawn|dispensed)\b/i,
               /\batm\s+wdl\b/i, /\bcash\s+at\s+atm\b/i] },

  { type: 'Expense', category: 'Finance Charges', sub_category: 'Bank Charges',
    patterns: [/\bbank\s+charge\b/i, /\bservice\s+charge\b/i,
               /\bsms\s+(charge|alert\s+charge)\b/i,
               /\bannual\s+(fee|charge)\b/i, /\brenewal\s+fee\b/i,
               /\bpenalty\b/i, /\blate\s+(payment\s+)?fee\b/i,
               /\bprocessing\s+fee\b/i] },

  { type: 'Expense', category: 'Finance Charges', sub_category: 'Rent via Card',
    patterns: [/\bcred\s+(pay|rent|travel)\b/i, /\bcheq\b/i,
               /\bnobroker\s+pay\b/i, /\brentpay\b/i] },

  { type: 'Expense', category: 'Finance Charges', sub_category: 'Credit Card Payment',
    patterns: [/\bcredit\s+card\s+(payment|bill|due)\b/i,
               /\bcc\s+(payment|bill)\b/i,
               /\bcard\s+outstanding\b/i,
               /\bminimum\s+(amount\s+)?due\b/i,
               /\btotal\s+(amount\s+)?due\b/i] },

  // ══ INCOME ═══════════════════════════════════════════════════════════════

  { type: 'Income', category: 'Salary', sub_category: 'Monthly Salary',
    direction: 'credit',
    patterns: [/\bsalary\b/i, /\bsal\s+credit\b/i, /\bsalary\s+credited\b/i,
               /\bpayroll\b/i, /\bwages?\b/i, /\bctc\b/i,
               /\bneft[\s_-]?cr\b/i, /\bach\s+(credit|cr)\b/i,
               /\bcms\s+credit\b/i, /\bcorporate\s+credit\b/i] },

  { type: 'Income', category: 'Salary', sub_category: 'Bonus & Incentives',
    direction: 'credit',
    patterns: [/\bbonus\s+(credit|credited|paid)\b/i,
               /\bincentive\s+(credit|credited)\b/i,
               /\bvariable\s+pay\b/i, /\bperformance\s+(pay|bonus)\b/i,
               /\bjoining\s+bonus\b/i, /\bex\s+gratia\b/i] },

  { type: 'Income', category: 'Business Income', sub_category: 'Client Payment',
    direction: 'credit',
    patterns: [/\bclient\s+payment\b/i, /\binvoice\s+payment\b/i,
               /\bconsulting\s+fee\b/i, /\bprofessional\s+fee\b/i,
               /\bfreelance\b/i, /\bgig\s+payment\b/i] },

  { type: 'Income', category: 'Rental Income', sub_category: 'Property Rent',
    direction: 'credit',
    patterns: [/\brent\s+(received|credit|credited)\b/i,
               /\brental\s+income\b/i, /\btenant\s+payment\b/i] },

  { type: 'Income', category: 'Passive Income', sub_category: 'Interest Income',
    direction: 'credit',
    patterns: [/\binterest\s+(credit|credited|received|earned)\b/i,
               /\bfd\s+interest\b/i, /\brd\s+interest\b/i,
               /\bsavings\s+interest\b/i, /\bbank\s+interest\b/i] },

  { type: 'Income', category: 'Passive Income', sub_category: 'Dividend',
    direction: 'credit',
    patterns: [/\bdividend\b/i, /\bdiv\s+credit\b/i,
               /\bdividend\s+(received|credited|paid)\b/i] },

  { type: 'Income', category: 'Refunds', sub_category: 'Purchase Refund',
    patterns: [/\brefund\b/i, /\bcashback\b/i, /\breversal\b/i,
               /\bchargeback\b/i, /\bamount\s+reversed\b/i,
               /\bmoney\s+returned\b/i, /\brefunded\b/i] },

  { type: 'Income', category: 'Transfers Received', sub_category: 'Peer Transfer',
    direction: 'credit',
    patterns: [/\breceived\s+from\b/i, /\btransfer\s+from\b/i,
               /\bmoney\s+received\b/i, /\bupi\s+(cr|credit)\b/i,
               /\bimps\s+cr\b/i, /\bneft\s+(cr|credit)\s+from\b/i] },

  // ══ ASSET ════════════════════════════════════════════════════════════════

  { type: 'Asset', category: 'Bank Deposits', sub_category: 'Fixed Deposit',
    patterns: [/\bfixed\s+deposit\b/i, /\bfd\s+(created|booked|opened|opening|of|for)\b/i,
               /\bterm\s+deposit\b/i, /\bdeposit\s+booked\b/i] },

  { type: 'Asset', category: 'Bank Deposits', sub_category: 'Recurring Deposit',
    patterns: [/\brecurring\s+deposit\b/i,
               /\brd\s+(created|opened|installment|debit|opening)\b/i] },

  { type: 'Asset', category: 'Gold', sub_category: 'Digital Gold',
    patterns: [/\bdigital\s+gold\b/i, /\bmmtc.?pamp\b/i,
               /\baugmont\b/i, /\bpaytm\s+gold\b/i, /\bgpay\s+gold\b/i] },

  { type: 'Asset', category: 'Gold', sub_category: 'Physical Gold',
    patterns: [/\bgold\s+(purchase|jewellery|coins?|bar)\b/i,
               /\bjewellery\s+purchase\b/i, /\bsovereign\s+gold\b/i] },

  { type: 'Asset', category: 'Real Estate', sub_category: 'Property Purchase',
    patterns: [/\bproperty\s+registration\b/i, /\bstamp\s+duty\b/i,
               /\bhome\s+purchase\b/i, /\bflat\s+registration\b/i,
               /\breal\s+estate\b/i, /\bregistration\s+charges\b/i] },

  // ══ LIABILITY ════════════════════════════════════════════════════════════

  { type: 'Liability', category: 'Loans', sub_category: 'Home Loan',
    patterns: [/\bhome\s+loan\b/i, /\bhousing\s+loan\b/i,
               /\bmortgage\b/i, /\blic\s+housing\b/i,
               /\bpnb\s+housing\b/i, /\blic\s+hfl\b/i,
               /\bfloating\s+rate\s+(home\s+)?loan\b/i] },

  { type: 'Liability', category: 'Loans', sub_category: 'Personal Loan',
    patterns: [/\bpersonal\s+loan\b/i, /\bpl\s+disbursal\b/i,
               /\bconsumer\s+loan\b/i, /\binstant\s+loan\b/i,
               /\bsalary\s+loan\b/i] },

  { type: 'Liability', category: 'Loans', sub_category: 'Vehicle Loan',
    patterns: [/\bcar\s+loan\b/i, /\bauto\s+loan\b/i,
               /\bbike\s+loan\b/i, /\bvehicle\s+loan\b/i,
               /\btwo[\s-]?wheeler\s+loan\b/i] },

  { type: 'Liability', category: 'Loans', sub_category: 'Education Loan',
    patterns: [/\beducation\s+loan\b/i, /\bstudent\s+loan\b/i] },

  { type: 'Liability', category: 'BNPL / EMI', sub_category: 'Buy Now Pay Later',
    patterns: [/\bbnpl\b/i, /\bbuy\s+now\s+pay\s+later\b/i,
               /\blazypay\b/i, /\bsimpl\b/i, /\bslice\b/i,
               /\bpostpe\b/i, /\bkreditbee\b/i,
               /\bzestmoney\b/i, /\baxio\b/i, /\bfibe\b/i] },

  { type: 'Liability', category: 'EMI', sub_category: 'Loan EMI',
    patterns: [/\bemi\s+(deducted|debited|paid|payment)\b/i,
               /\bloan\s+emi\b/i, /\bequated\s+monthly\b/i,
               /\bnach\s+debit\b/i, /\brepayment\s+(of|for)\s+(loan|emi)\b/i,
               /\bauto\s+debit\s+emi\b/i] },

  // ══ INVESTMENT ═══════════════════════════════════════════════════════════

  { type: 'Investment', category: 'Mutual Funds', sub_category: 'SIP',
    patterns: [/\b(mutual\s+fund\s+)?sip\b/i, /\bsystematic\s+investment\s+plan\b/i,
               /\bsip\s+(debit|installment|payment)\b/i, /\bmf\s+sip\b/i] },

  { type: 'Investment', category: 'Mutual Funds', sub_category: 'Lump Sum',
    patterns: [/\bmutual\s+fund\b/i, /\bmf\s+purchase\b/i,
               /\bnfo\b/i, /\bnew\s+fund\s+offer\b/i,
               /\blump\s*sum\s+(mf|mutual|investment)\b/i,
               /\bfund\s+investment\b/i, /\bamfi\b/i] },

  { type: 'Investment', category: 'Stocks', sub_category: 'Equity Purchase',
    patterns: [/\bzerodha\b/i, /\bgroww\b/i, /\bupstox\b/i,
               /\bangelone\b/i, /\bangel\s+one\b/i, /\bangel\s+broking\b/i,
               /\bhdfc\s+securities\b/i, /\bicici\s+direct\b/i,
               /\bkotak\s+securities\b/i, /\bmotilal\s+oswal\b/i,
               /\bdhan\b/i, /\bfyers\b/i, /\b5paisa\b/i,
               /\bshares?\s+purchase\b/i, /\bstock\s+purchase\b/i,
               /\bdemat\s+(account|transfer)\b/i] },

  { type: 'Investment', category: 'Stocks', sub_category: 'IPO',
    patterns: [/\bipo\s+(application|allotment|refund|subscription)\b/i,
               /\basba\b/i, /\bblocked\s+for\s+ipo\b/i] },

  { type: 'Investment', category: 'Insurance', sub_category: 'Life Insurance',
    patterns: [/\blic\s+(premium|policy|payment)\b/i,
               /\blife\s+insurance\s+(premium|payment)\b/i,
               /\bterm\s+(plan|insurance|policy)\b/i,
               /\bulip\b/i, /\bjeevan\s+\w+\b/i,
               /\binsurance\s+premium\b/i, /\bpolicy\s+premium\b/i,
               /\bmax\s+life\b/i, /\bhdfc\s+life\b/i,
               /\bicici\s+(pru|prudential)\s+life\b/i,
               /\bsbi\s+life\b/i, /\bkotak\s+life\b/i] },

  { type: 'Investment', category: 'Insurance', sub_category: 'Health Insurance',
    patterns: [/\bhealth\s+insurance\b/i, /\bmediclaim\b/i,
               /\bstar\s+health\b/i, /\bniva\s+bupa\b/i,
               /\bcare\s+health\b/i, /\bhdfc\s+ergo\s+health\b/i,
               /\bnavi\s+(health\s+)?insurance\b/i,
               /\bcritical\s+illness\b/i] },

  { type: 'Investment', category: 'Insurance', sub_category: 'Vehicle Insurance',
    patterns: [/\bvehicle\s+insurance\b/i, /\bcar\s+insurance\b/i,
               /\bbike\s+insurance\b/i, /\bmotor\s+insurance\b/i,
               /\backo\b/i, /\bgo\s+digit\b/i,
               /\bthird\s+party\s+insurance\b/i] },

  { type: 'Investment', category: 'Crypto', sub_category: 'Cryptocurrency',
    patterns: [/\bbitcoin\b/i, /\bethereum\b/i, /\bcrypto\b/i,
               /\bcoinswitch\b/i, /\bwazirx\b/i,
               /\bcoindcx\b/i, /\bzebpay\b/i, /\bbinance\b/i] },

  { type: 'Investment', category: 'Government Schemes', sub_category: 'NPS',
    patterns: [/\bnps\b/i, /\bnational\s+pension\s+(scheme|system)\b/i,
               /\bnps\s+contribution\b/i, /\bpran\b/i] },

  { type: 'Investment', category: 'Government Schemes', sub_category: 'PPF',
    patterns: [/\bppf\b/i, /\bpublic\s+provident\s+fund\b/i,
               /\bppf\s+(deposit|account|contribution)\b/i] },

  { type: 'Investment', category: 'Government Schemes', sub_category: 'EPF',
    patterns: [/\bepf\b/i, /\bemployee\s+provident\b/i,
               /\bpf\s+contribution\b/i, /\bprovident\s+fund\b/i,
               /\bepfo\b/i] },

  { type: 'Investment', category: 'Government Schemes', sub_category: 'Bonds & SGB',
    patterns: [/\bgovernment\s+bond\b/i, /\brbi\s+(bond|retail)\b/i,
               /\bsgb\b/i, /\bsovereign\s+gold\s+bond\b/i,
               /\bcorporate\s+bond\b/i, /\bdebenture\b/i,
               /\b54ec\s+bond\b/i] },

  { type: 'Investment', category: 'Government Schemes', sub_category: 'Sukanya / SSY',
    patterns: [/\bsukanya\s+samriddhi\b/i, /\bssy\b/i,
               /\bpost\s+office\s+(scheme|mis|td)\b/i,
               /\bkisan\s+vikas\s+patra\b/i, /\bkvp\b/i,
               /\bnsc\b/i, /\bnational\s+savings\s+certificate\b/i] },
];

// ─── Main export ──────────────────────────────────────────────────────────────

export function parseSmsMessages(messages: RawMessage[]): ParsedTransaction[] {
  const results: ParsedTransaction[] = [];
  for (const msg of messages) {
    results.push(parseSingleSms(msg));
  }
  return results;
}

// ─── Single message parser ────────────────────────────────────────────────────

function parseSingleSms(msg: RawMessage): ParsedTransaction {
  const body      = msg.body;
  const bodyLower = body.toLowerCase();
  const bodyUpper = body.toUpperCase();

  const isInfra = UPI_INFRA_SENDERS.some(s => msg.address.toUpperCase().includes(s));
  const extracted = extractFields(body, bodyLower, bodyUpper);

  // Determine parse failure reason (partial results still returned — arch 4.4)
  let parse_failure: string | null = null;
  if (extracted.amount === null)   parse_failure = 'missing_amount';
  else if (extracted.isCredit === null) parse_failure = 'unknown_direction';

  // Sign convention (arch 5.3.4)
  const signedAmount = extracted.amount === null
    ? null
    : extracted.isCredit
      ? Math.abs(extracted.amount)
      : -Math.abs(extracted.amount);

  // Classify — only if we have direction
  let classification: Classification | null = null;
  if (extracted.isCredit !== null && extracted.amount !== null) {
    classification = classify(bodyLower, extracted.isCredit, extracted.amount);
    if (!classification) parse_failure = parse_failure ?? 'unclassified';
  }

  // Status (arch 5.3.1 + 4.6)
  const needsReview =
    parse_failure !== null ||
    extracted.accountLast4 === null ||
    (signedAmount !== null && Math.abs(signedAmount) >= 5000);

  const txnDate = new Date(msg.date).toISOString().split('T')[0];

  return {
    raw_sms_id:            msg.id,
    txn_date:              txnDate,
    amount:                signedAmount,
    type:                  classification?.type ?? null,
    category:              classification?.category ?? null,
    sub_category:          classification?.sub_category ?? null,
    merchant:              extracted.merchant,
    source:                'sms',
    status:                needsReview ? 'pending_review' : 'approved',
    account_number_masked: extracted.accountLast4,
    bank:                  extracted.bank,
    channel:               extracted.channel,
    balance:               extracted.balance,
    ref_number:            extracted.ref_number,
    ref_type:              extracted.ref_type,
    txn_group_id:          null,
    is_infrastructure:     isInfra,
    health_module_tag:     null,
    parse_failure,
    raw_text:              body,
  };
}

// ─── Field extractors ─────────────────────────────────────────────────────────

function extractFields(body: string, bodyLower: string, bodyUpper: string): ExtractedFields {
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

// Amount — Rs./INR/₹ prefix or bare decimal before keyword
function extractAmount(body: string): number | null {
  const patterns = [
    /(?:rs\.?|inr|₹)\s*([\d,]+(?:\.\d{1,2})?)/i,
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

// Direction — score-based (debit/credit keyword counts, not first-match)
function extractDirection(bodyLower: string): boolean | null {
  const debitKw = [
    'debited', 'deducted', 'withdrawn', 'spent', 'payment of',
    'transferred to', 'sent to', 'purchase', 'charged',
    'emi due', 'emi paid', 'emi deducted',
    'fixed deposit of', 'fd created', 'premium of',
  ];
  const creditKw = [
    'credited', 'received', 'deposited', 'refund',
    'salary', 'reversed', 'cashback', 'added to',
    'transfer from', 'neft cr', 'imps cr', 'ach credit',
  ];
  const debitScore  = debitKw.filter(kw  => bodyLower.includes(kw)).length;
  const creditScore = creditKw.filter(kw => bodyLower.includes(kw)).length;
  if (debitScore > creditScore)  return false;
  if (creditScore > debitScore)  return true;
  if (debitScore > 0)            return false; // tie with signal → debit (safer default)
  return null;
}

// Account last-4
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

// Available balance
function extractBalance(body: string): number | null {
  const patterns = [
    /(?:avl\.?\s*bal(?:ance)?|available\s+balance|bal(?:ance)?(?:\s+is)?)[:\s]+(?:inr|rs\.?|₹)?\s*([\d,]+(?:\.\d{1,2})?)/i,
    /(?:a\/c\s+bal|ac\s+balance)[:\s]+(?:inr|rs\.?|₹)?\s*([\d,]+(?:\.\d{1,2})?)/i,
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

// Merchant — UPI VPA, POS "at", "towards"
function extractMerchant(body: string): string | null {
  const upiMatch = body.match(/(?:to|from)\s+([A-Za-z0-9 &._-]{2,40})@[a-z]+/i);
  if (upiMatch) {
    const name = upiMatch[1].trim();
    if (name.length >= 2) return name;
  }
  const atMatch = body.match(/\bat\s+([A-Za-z0-9 &._-]{2,40})(?:\s+on|\s+for|\s+dated|[,.])/i);
  if (atMatch) {
    const name = atMatch[1].trim();
    if (name.length >= 2) return name;
  }
  const towardsMatch = body.match(/towards\s+([A-Za-z0-9 &._-]{2,40})(?:\s+on|\s+for|[,.])/i);
  if (towardsMatch) {
    const name = towardsMatch[1].trim();
    if (name.length >= 2) return name;
  }
  return null;
}

// Bank detection — body keywords + UPI VPA domain fallback
function detectBank(bodyUpper: string, body: string): string | null {
  for (const [kw, name] of Object.entries(BANK_MAP)) {
    if (bodyUpper.includes(kw)) return name;
  }
  // UPI VPA domain tiebreaker
  const vpaMatch = body.match(/[\w.\-]+@(\w+)/i);
  if (vpaMatch) {
    const domain = vpaMatch[1].toLowerCase();
    if (UPI_DOMAIN_MAP[domain]) return UPI_DOMAIN_MAP[domain];
  }
  return null;
}

// Channel detection
function detectChannel(bodyUpper: string): string | null {
  for (const [kw, label] of Object.entries(CHANNEL_MAP)) {
    if (bodyUpper.includes(kw)) return label;
  }
  return null;
}

// Ref number — conservative, NEFT UTR before UPI RRN (arch 14.3)
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

// ─── Classifier ───────────────────────────────────────────────────────────────
// Score-based: counts pattern hits per entry, highest wins
// Respects direction constraints and amount thresholds (hotel disambiguation)

function classify(
  bodyLower: string,
  isCredit: boolean,
  amount: number,
): Classification | null {
  const direction = isCredit ? 'credit' : 'debit';

  let bestEntry: TaxonomyEntry | null = null;
  let bestScore = 0;

  for (const entry of TAXONOMY) {
    // Direction constraint
    if (entry.direction && entry.direction !== direction) continue;

    // Amount thresholds
    if (entry.maxAmount !== undefined && amount > entry.maxAmount) continue;
    if (entry.minAmount !== undefined && amount < entry.minAmount) continue;

    const score = entry.patterns.filter(p => p.test(bodyLower)).length;
    if (score > bestScore) {
      bestScore = score;
      bestEntry = entry;
    }
  }

  if (!bestEntry) return null;
  return {
    type:         bestEntry.type,
    category:     bestEntry.category,
    sub_category: bestEntry.sub_category,
  };
}
