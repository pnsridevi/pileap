/**
 * ruleset.js — Layer 2 Regex Ruleset
 * Location: apps/mobile/layer2/ruleset.js
 *
 * Architecture reference: Pileap Product Architecture V3.2 Section 4.4
 *
 * Change log:
 *   - BUG FIX: UPI Mandate channel — "UPI Mandate:" SMS body was matching
 *     GENERIC_NACH (mandate keyword) and returning channel='NACH'. These are
 *     UPI mandate executions, not NACH debits. extractChannel() now checks
 *     for the "UPI Mandate:" prefix before the NACH keyword check.
 *   - BUG FIX: Reversal merchant garbage — GENERIC_CREDIT was extracting
 *     "technical problem (UPI" as merchant from reversal SMS. extractMerchant()
 *     now returns null for reversal/refund SMS since the merchant is the
 *     original payee (not recoverable from the reversal SMS alone).
 *   - FIX: extractMerchant() — added null guards for IB Funds Transfer,
 *     RWallet, Pluxee credit timestamp, CC payment credit strings.
 *   - FIX: extractChannel() — added Credit Card detection for Txn Rs. format.
 *   - ADD: GENERIC_CC_SPEND_TXN — catches "Txn Rs.\nOn HDFC Bank Card" and
 *     "Spent Rs. On HDFC Bank Card" formats (43 messages previously missed).
 *   - ADD: GENERIC_CC_PAYMENT — catches CC bill payment debit from bank account.
 *   - ADD: GENERIC_WALLET_SPEND — Amazon Pay / Paytm / PhonePe wallet spends.
 *   - ADD: GENERIC_NETBANKING_PAYMENT — "Payment Successful! Rs.X from A/c to
 *     PAYEE via HDFC Bank NetBanking" and similar.
 *   - ADD: PLUXEE_SPEND — benefit card spend with merchant + channel from SMS.
 *   - ADD: PLUXEE_CREDIT — employer meal wallet credit, possible_contra:true.
 *   - ADD: NCMC_LOAD — transit card top-up, possible_contra:true.
 */

// ─────────────────────────────────────────────────────────────────────────────
// BANK EXTRACTOR
// ─────────────────────────────────────────────────────────────────────────────

const BANK_TOKENS = [
  { token: 'punjabnationalbank',    name: 'Punjab National Bank' },
  { token: 'statebankofindia',      name: 'State Bank of India' },
  { token: 'bankofmaharashtra',     name: 'Bank of Maharashtra' },
  { token: 'bankofbaroda',          name: 'Bank of Baroda' },
  { token: 'bankofindore',          name: 'Bank of Indore' },
  { token: 'centralbankofindia',    name: 'Central Bank of India' },
  { token: 'indianoverseasbank',    name: 'Indian Overseas Bank' },
  { token: 'tamilnadmercantilebank',name: 'Tamilnad Mercantile Bank' },
  { token: 'karurvysyabank',        name: 'Karur Vysya Bank' },
  { token: 'cityunionbank',         name: 'City Union Bank' },
  { token: 'southindianbank',       name: 'South Indian Bank' },
  { token: 'lakshmivilasbank',      name: 'Lakshmi Vilas Bank' },
  { token: 'dhanlaxmibank',         name: 'Dhanlaxmi Bank' },
  { token: 'airtelpaymentbank',     name: 'Airtel Payments Bank' },
  { token: 'paytmpaymentbank',      name: 'Paytm Payments Bank' },
  { token: 'jiopaymentbank',        name: 'Jio Payments Bank' },
  { token: 'finopaymentbank',       name: 'Fino Payments Bank' },
  { token: 'nsdlpaymentbank',       name: 'NSDL Payments Bank' },
  { token: 'ausmallfinancebank',    name: 'AU Small Finance Bank' },
  { token: 'equitasbank',           name: 'Equitas Small Finance Bank' },
  { token: 'ujjivanbank',           name: 'Ujjivan Small Finance Bank' },
  { token: 'esafbank',              name: 'ESAF Small Finance Bank' },
  { token: 'suryodaybank',          name: 'Suryoday Small Finance Bank' },
  { token: 'idfcfirstbank',         name: 'IDFC First Bank' },
  { token: 'kotakbank',             name: 'Kotak Mahindra Bank' },
  { token: 'kotakmahindra',         name: 'Kotak Mahindra Bank' },
  // [FIX] Was 'induslndbank' (typo — "lnd" instead of "ind"); never matched
  // any real message, so IndusInd Bank could never be detected. Confirmed
  // 100% miss rate across every IndusInd sample in testing.
  { token: 'indusindbank',          name: 'IndusInd Bank' },
  { token: 'federalbank',           name: 'Federal Bank' },
  { token: 'saraswatbank',          name: 'Saraswat Bank' },
  { token: 'karnatkabank',          name: 'Karnataka Bank' },
  { token: 'nainitalbank',          name: 'Nainital Bank' },
  { token: 'hdfcbank',              name: 'HDFC Bank' },
  { token: 'icicibank',             name: 'ICICI Bank' },
  { token: 'axisbank',              name: 'Axis Bank' },
  { token: 'yesbank',               name: 'Yes Bank' },
  { token: 'rblbank',               name: 'RBL Bank' },
  { token: 'dcbbank',               name: 'DCB Bank' },
  { token: 'canarabank',            name: 'Canara Bank' },
  { token: 'unionbank',             name: 'Union Bank of India' },
  { token: 'indianbank',            name: 'Indian Bank' },
  { token: 'hdfcbk',               name: 'HDFC Bank' },
  { token: 'icicibk',               name: 'ICICI Bank' },
  { token: 'indusind',              name: 'IndusInd Bank' },  // [FIX] was 'induslnd' typo
  { token: 'utibbank',              name: 'Axis Bank' },
  { token: 'aubank',                name: 'AU Small Finance Bank' },
  { token: 'idfc',                  name: 'IDFC First Bank' },
  { token: 'sbi',  name: 'State Bank of India' },
  { token: 'pnb',  name: 'Punjab National Bank' },
  { token: 'bob',  name: 'Bank of Baroda' },
  { token: 'iob',  name: 'Indian Overseas Bank' },
  { token: 'kvb',  name: 'Karur Vysya Bank' },
  { token: 'tmb',  name: 'Tamilnad Mercantile Bank' },
  { token: 'cub',  name: 'City Union Bank' },
  { token: 'sib',  name: 'South Indian Bank' },
];

// [FIX] VPA-hijack — a counterparty's UPI handle (e.g. "divya.iyer@okhdfcbank")
// contains another bank's token as a substring. Scanning the raw body let that
// hijack the result: "...to divya.iyer@okhdfcbank...-Canara Bank" was returning
// "HDFC Bank" instead of the actual sender bank "Canara Bank" stated in the
// message's own signature. Strip VPA handles (anything after @) before scanning.
function extractBank(body) {
  const stripped = body.replace(/\S+@\S+/g, ' ');
  const n = stripped.toLowerCase().replace(/[\s\-_/\.]/g, '');
  for (const b of BANK_TOKENS) {
    if (n.includes(b.token)) return b.name;
  }
  return null;
}

// ─────────────────────────────────────────────────────────────────────────────
// CHANNEL EXTRACTOR
//
// BUG FIX: UPI Mandate SMS (e.g. "UPI Mandate:\nSent Rs.2.00\nfrom HDFC Bank
// A/c 2759\nTo Google Play") was returning 'NACH' because the word "mandate"
// appeared in the body and NACH check ran first.
// Fix: Check for "UPI Mandate" prefix before the NACH keyword block.
// These are UPI mandate executions, not NACH/ECS debits.
//
// [ADD]: "Txn Rs.\nOn HDFC Bank Card XXXX" format — credit card spend.
// Must be checked before the generic Card check to ensure correct channel.
// ─────────────────────────────────────────────────────────────────────────────

function extractChannel(body) {
  // [FIX] UPI Mandate execution — must come BEFORE the NACH check.
  // "UPI Mandate:" appears at the start of HDFC UPI mandate debit SMS.
  // These are UPI channel despite containing the word "mandate".
  if (/^UPI Mandate:/im.test(body)) {
    return 'UPI';
  }

  // NACH/mandate — autopay, ECS, standing instruction
  if (/\bNACH\b|\bUMRN\b|\bmandate\b|\bstanding instruction\b|\bECS\b|\bauto.?pay\b/i.test(body)) {
    return 'NACH';
  }

  // ATM withdrawal
  if (/\bATM\b|cash withdrawal|Withdrawn/i.test(body)) {
    return 'ATM';
  }

  // [ADD] CC spend — "Txn Rs.\nOn HDFC Bank Card" or "Spent Rs. On HDFC Bank Card"
  // Must be before generic Card check — these are explicitly credit card spends.
  if (/(?:Txn\s+Rs\.|Spent\s+Rs\.)\s*[\d,]+.*On\s+(?:HDFC|ICICI|SBI|Axis|Kotak|Yes|IndusInd|RBL|IDFC|Federal)\s+Bank\s+Card/is.test(body)) {
    return 'Credit Card';
  }

  // Card transactions
  if (/credit card|debit card|Card x\d|Card \d{4}|Spent\b/i.test(body)) {
    return 'Card';
  }

  // NEFT/RTGS/IMPS
  if (/\bNEFT\b|\bRTGS\b|\bIMPS\b|\bUTR\b/i.test(body)) {
    return 'NEFT';
  }

  // Net Banking / Online Banking
  if (/net\s*banking|online\s+banking|internet\s+banking/i.test(body)) {
    return 'Net Banking';
  }

  // IB Fund Transfer (HDFC internet banking = IMPS)
  if (/\bIB\s+(?:SS\s+)?FUNDS\s+TRANSFER\b/i.test(body)) {
    return 'IMPS';
  }

  // Cheque deposit
  if (/\bCHQ\s+DEP\b|\bCTS\s+CLG\b|\bcheque\s+deposit\b/i.test(body)) {
    return 'Cheque';
  }

  // UPI — VPA present or explicit UPI keyword
  if (/\bUPI\b|VPA|UPI Ref|RRN|@[a-z]+\b/i.test(body)) {
    return 'UPI';
  }

  // Wallet
  if (/wallet/i.test(body)) {
    return 'Wallet';
  }

  if (/\bEMI\b/i.test(body)) {
    return 'EMI';
  }

  return 'UPI';
}

// ─────────────────────────────────────────────────────────────────────────────
// AMOUNT EXTRACTOR
// ─────────────────────────────────────────────────────────────────────────────

function extractAmount(body) {
  const inr = body.match(/INR\s+([\d,]+(?:\.\d{1,2})?)/i);
  if (inr) { const v = parseFloat(inr[1].replace(/,/g, '')); if (v > 0) return v; }

  const rs = body.match(/Rs\.?\s*([\d,]+(?:\.\d{1,2})?)/i);
  if (rs) { const v = parseFloat(rs[1].replace(/,/g, '')); if (v > 0) return v; }

  const sym = body.match(/₹\s*([\d,]+(?:\.\d{1,2})?)/);
  if (sym) { const v = parseFloat(sym[1].replace(/,/g, '')); if (v > 0) return v; }

  const bare = body.match(/transaction of\s+([\d,]+(?:\.\d{1,2})?)/i);
  if (bare) { const v = parseFloat(bare[1].replace(/,/g, '')); if (v > 0) return v; }

  return null;
}

// ─────────────────────────────────────────────────────────────────────────────
// DATE EXTRACTOR
// ─────────────────────────────────────────────────────────────────────────────

const MONTH_MAP = {
  jan:1, feb:2, mar:3, apr:4, may:5, jun:6,
  jul:7, aug:8, sep:9, oct:10, nov:11, dec:12
};

function extractDate(body) {
  let m = body.match(/(\d{4})-(\d{2})-(\d{2})/);
  if (m) return `${m[1]}-${m[2]}-${m[3]}`;

  m = body.match(/(\d{2})\/(\d{2})\/(\d{4})/);
  if (m) return `${m[3]}-${m[2]}-${m[1]}`;

  m = body.match(/(\d{2})[-/](\d{2})[-/](\d{2})\b/);
  if (m) return `${parseInt(m[3]) + 2000}-${m[2]}-${m[1]}`;

  // [FIX] DD-Mon-YYYY with a 4-digit year (e.g. "26-Apr-2026") was never
  // handled — only the 2-digit-year variant below matched, so this format
  // fell through to `null` and every caller silently substituted the SMS's
  // arrival date instead of the actual transaction date in the text.
  // Confirmed on 385/1000 messages across two independent test datasets
  // (UPI app payments, bookings, rent, and more all use this format).
  // Must be checked before the 2-digit-year pattern below.
  m = body.match(/(\d{1,2})[-\s]?([A-Za-z]{3})[-\s]?(\d{4})\b/);
  if (m) {
    const month = MONTH_MAP[m[2].toLowerCase()];
    if (month) {
      return `${m[3]}-${String(month).padStart(2, '0')}-${m[1].padStart(2, '0')}`;
    }
  }

  m = body.match(/(\d{1,2})[-\s]?([A-Za-z]{3})[-\s]?(\d{2})\b/);
  if (m) {
    const month = MONTH_MAP[m[2].toLowerCase()];
    if (month) {
      return `${parseInt(m[3]) + 2000}-${String(month).padStart(2, '0')}-${m[1].padStart(2, '0')}`;
    }
  }

  return null;
}

// ─────────────────────────────────────────────────────────────────────────────
// ACCOUNT EXTRACTOR
// ─────────────────────────────────────────────────────────────────────────────

function extractAccount(body) {
  // [FIX] "Credit Card ending 2536" / "Card ending 2536" — the word "ending"
  // between "card" and the digits broke the old adjacency-only regex below,
  // so every "...Card ending NNNN..." message (very common CC-spend format)
  // lost its card number. Check this first.
  let m = body.match(/(?:account|card)\s+ending\s+(?:with\s+)?[Xx*]{0,4}(\d{4})\b/i);
  if (m) return m[1];

  m = body.match(/[Xx*]{1,2}(\d{4})\b/);
  if (m) return m[1];

  m = body.match(/A\/[Cc](?:\s*No\.?)?\s*[Xx*]{0,2}(\d{4})\b/);
  if (m) return m[1];

  m = body.match(/(?:account|card)\s+[X*]{0,4}(\d{4})\b/i);
  if (m) return m[1];

  return null;
}

// ─────────────────────────────────────────────────────────────────────────────
// MERCHANT EXTRACTOR
//
// BUG FIX: Reversal SMS — extracting garbage text as merchant. Return null.
//
// [ADD] Null guards for known garbage merchant strings:
//   - "IB FUNDS TRANSFER" / "IB SS FUNDS TRANSFER" — raw HDFC IB transfer label
//   - "your RWallet Account" — RWallet balance message leaking as merchant
//   - "Meal Wallet on <timestamp>" — Pluxee credit timestamp leaking as merchant
//   - "your card ending NNNN" — CC payment credit from bank (Cardmember SMS)
//   - "YOUR CREDIT CARD ENDING WITH NNNN ON DD-M-YYYY" — DEAR CARDMEMBER format
// ─────────────────────────────────────────────────────────────────────────────

function extractMerchant(body) {
  // [FIX] Reversal/refund SMS — merchant is the original payee, not present
  // in the reversal message. Return null rather than extracting garbage text.
  if (/\bhas been reversed\b|\bhas been refunded\b|\breversal of\b/i.test(body)) {
    return null;
  }

  // "To MERCHANT\n" or "To MERCHANT On" — HDFC UPI standard format
  // [FIX] Added "successful"/"from A/c" as additional stop tokens — messages
  // like "Fee payment of Rs.X to BITS Pilani successful from A/c XX1354 on..."
  // were capturing "BITS Pilani successful from A/c XX1354" as the merchant
  // instead of stopping cleanly at "successful".
  let m = body.match(/\bTo\s+(.{3,40}?)(?:\s*\n|\s+On\s|\s+Ref\s|\s+via\s|\s+successful\b|\s+from\s+A\/c)/i);
  if (m) {
    const candidate = m[1].trim();
    // [ADD] Null guard: raw IB Funds Transfer label leaking as merchant
    if (/^IB\s+(SS\s+)?FUNDS\s+TRANSFER/i.test(candidate)) return null;
    return candidate;
  }

  // "At MERCHANT On" — card/ATM spend
  m = body.match(/\bAt\s+(.{3,40}?)\s+On\s/i);
  if (m) return m[1].trim();

  // "towards MERCHANT UMRN/Ref/." — NACH/mandate
  m = body.match(/\btowards\s+(.{3,50}?)(?:\s+UMRN|\s+Ref|\s+Mandate|\.)/i);
  if (m) {
    const candidate = m[1].trim();
    // [ADD] Null guard: "your credit card ending NNNN" from CC payment credit
    if (/your\s+(credit\s+)?card\s+ending/i.test(candidate)) return null;
    return candidate;
  }

  // "transfer from NAME Ref" — NEFT credit
  m = body.match(/transfer from\s+([A-Z][A-Z ]{2,40}?)\s+Ref/i);
  if (m) return m[1].trim();

  // "from VPA vpa@bank" — UPI credit
  m = body.match(/from VPA\s+([\w.\-@]+)/i);
  if (m) return m[1].trim();

  // "Info: IB FUNDS TRANSFER..." — HDFC internet banking
  m = body.match(/Info:\s+(.{3,60}?)(?:\.\s*Avl|$)/i);
  if (m) {
    const candidate = m[1].trim();
    // [ADD] Null guard: IB Funds Transfer label (same pattern, different path)
    if (/^IB\s+(SS\s+)?FUNDS\s+TRANSFER/i.test(candidate)) return null;
    return candidate;
  }

  return null;
}

// ─────────────────────────────────────────────────────────────────────────────
// BENEFIT CARD MERCHANT EXTRACTOR
// Used specifically for Pluxee/Zeta/Zaggle spend SMS.
// Extracts merchant from "at MERCHANT. Avl bal" pattern.
// ─────────────────────────────────────────────────────────────────────────────

function extractBenefitCardMerchant(body) {
  // "at MERCHANT. Avl bal" — e.g. "at THENMANI ST CHENNAI. Avl bal Rs.4914.72"
  const m = body.match(/\bat\s+(.{2,50}?)\.\s*[Aa]vl\s+[Bb]al/i);
  if (m) return m[1].trim();

  // Fallback: "at MERCHANT" at end of main clause
  const m2 = body.match(/\bat\s+([A-Z][A-Z0-9\s&._-]{1,50}?)(?:\s*\.|$)/im);
  if (m2) return m2[1].trim();

  return null;
}

// ─────────────────────────────────────────────────────────────────────────────
// BENEFIT CARD CHANNEL EXTRACTOR
// Derives channel from SMS text — not hardcoded.
// Rule: if card number present in body → 'Card', else → 'Wallet'
// Applies to Pluxee, Zeta, Zaggle, NCMC, any benefit instrument.
// ─────────────────────────────────────────────────────────────────────────────

function extractBenefitCardChannel(body) {
  // "card no.xxNNNN" or "card no xxNNNN" or "card ending NNNN" or "prepaid card"
  if (/card\s+(?:no\.?\s*[x*]{0,4}\d{4}|ending\s+\d{4})/i.test(body) ||
      /prepaid\s+card/i.test(body)) {
    return 'Card';
  }
  return 'Wallet';
}

// ─────────────────────────────────────────────────────────────────────────────
// REF NUMBER EXTRACTOR
// ─────────────────────────────────────────────────────────────────────────────

function extractRefNumber(body) {
  let m = body.match(/UPI[:\s]+(\d{12})\b/i);
  if (m) return { ref_number: m[1], ref_type: 'upi_rrn' };

  m = body.match(/Ref(?:\s*No\.?|erence)?\s*[:# ]?\s*(\d{12})\b/i);
  if (m) return { ref_number: m[1], ref_type: 'upi_rrn' };

  m = body.match(/RRN[:\s]+(\d{12})\b/i);
  if (m) return { ref_number: m[1], ref_type: 'upi_rrn' };

  m = body.match(/\bRef\s+(\d{12,})\b/i);
  if (m) return { ref_number: m[1], ref_type: 'upi_rrn' };

  m = body.match(/(?:UTR|UMRN)[:\s]+([A-Z]{2,6}\d{10,18})\b/i);
  if (m) return { ref_number: m[1], ref_type: 'neft_utr' };

  return { ref_number: null, ref_type: null };
}

// ─────────────────────────────────────────────────────────────────────────────
// BALANCE EXTRACTOR
//
// BUG FIX: RWallet SMS "Now the Available Balance is Rs.1000.00" was not
// captured. Added pattern: "now the available balance is rs." / "is rs."
// ─────────────────────────────────────────────────────────────────────────────

function extractBalance(body) {
  // "Avl bal INR 54,590.51" / "Avl bal:INR 33,758.71" / "Avl bal Rs.109248.77"
  let m = body.match(/[Aa]vl\.?\s*[Bb]al\.?[:\s]+(?:INR|Rs\.?)\s*([\d,]+(?:\.\d{1,2})?)/i);
  if (m) { const v = parseFloat(m[1].replace(/,/g, '')); if (!isNaN(v)) return v; }

  // "Available Balance Rs.291.40" (Indian Railways wallet)
  m = body.match(/[Aa]vailable\s+[Bb]alance\.?\s*(?:Rs\.?|INR)?\s*([\d,]+(?:\.\d{1,2})?)/i);
  if (m) { const v = parseFloat(m[1].replace(/,/g, '')); if (!isNaN(v)) return v; }

  // [FIX] "Now the Available Balance is Rs.1000.00" (Indian Railways RWallet)
  // Pattern: "balance is rs." — covers slight wording variations
  m = body.match(/[Bb]alance\s+is\s+(?:Rs\.?|INR)\s*([\d,]+(?:\.\d{1,2})?)/i);
  if (m) { const v = parseFloat(m[1].replace(/,/g, '')); if (!isNaN(v)) return v; }

  // "Bal Rs.1180.91" / "Bal INR 54559.19" / "Bal:INR"
  m = body.match(/\bBal[:\s]+(?:Rs\.?|INR)?\s*([\d,]+(?:\.\d{1,2})?)/i);
  if (m) { const v = parseFloat(m[1].replace(/,/g, '')); if (!isNaN(v)) return v; }

  return null;
}

// ─────────────────────────────────────────────────────────────────────────────
// VPA CLASSIFIER
// ─────────────────────────────────────────────────────────────────────────────

function classifyVpa(vpa) {
  if (!vpa) return 'unknown';
  const handle = vpa.split('@')[0].toLowerCase();

  if (/^\d+$/.test(handle)) return 'person';

  const merchantPrefixes = [
    'irctc', 'flipkart', 'amazon', 'swiggy', 'zomato', 'zepto', 'blinkit',
    'bigbasket', 'myntra', 'ajio', 'netflix', 'hotstar', 'jiocinema', 'sonyliv',
    'paytm', 'phonepe', 'gpay', 'airtel', 'jio', 'bsnl', 'tangedco', 'bescom',
    'bookmyshow', 'pvr', 'inox', 'google', 'microsoft', 'anthropic', 'cleartax',
    'zerodha', 'groww', 'upstox', 'shriramlife', 'lic', 'hdfcbank', 'icicibank',
    'sbi', 'axisbank', 'kotak', 'hdfc', 'irctc.payu', 'bbmps',
  ];
  if (merchantPrefixes.some(p => handle.startsWith(p) || handle.includes(p))) {
    return 'merchant';
  }

  if (/[a-z]{3,}/.test(handle) && /\d{4,}/.test(handle)) return 'person';
  if (/^[a-z]+(?:[.\-_][a-z]+)*\d*$/.test(handle)) return 'person';

  return 'unknown';
}

// ─────────────────────────────────────────────────────────────────────────────
// SELF-TRANSFER DETECTION
// ─────────────────────────────────────────────────────────────────────────────

function isPossibleSelfTransfer(body) {
  const b = body.toLowerCase();
  return (
    /ib\s+(?:ss\s+)?funds\s+transfer/i.test(body)          ||
    /\bppf\b|\bssy\b|\bnps\b|\brd\s+a\/c\b|\bfd\s+a\/c\b/i.test(body) ||
    /\bcredit\s+card\s+(?:bill|payment|due)\b/i.test(body)  ||
    /zerodha|groww|upstox|indmoney|kuvera/i.test(b)
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// RULESET
//
// Rule order matters — first match wins.
// Order rationale:
//   1. GENERIC_DECLINED      — discard immediately
//   2. GENERIC_CC_SPEND_TXN  — before GENERIC_DEBIT (both match "Spent")
//   3. GENERIC_CC_PAYMENT    — before GENERIC_DEBIT ("Paid Rs." also matches debit)
//   4. PLUXEE_SPEND          — before GENERIC_DEBIT ("spent from" in body)
//   5. PLUXEE_CREDIT         — before GENERIC_CREDIT ("credited" in body)
//   6. NCMC_LOAD             — before GENERIC_DEBIT
//   7. GENERIC_WALLET_SPEND  — before GENERIC_DEBIT
//   8. GENERIC_NETBANKING_PAYMENT — before GENERIC_DEBIT
//   9. GENERIC_NACH          — specific enough, before GENERIC_DEBIT
//   10. GENERIC_PPF_SSY      — specific enough, before GENERIC_DEBIT
//   11. GENERIC_DEBIT        — broad catch-all for debits
//   12. GENERIC_CREDIT       — broad catch-all for credits
// ─────────────────────────────────────────────────────────────────────────────

const RULES = [

  // ── 1. DECLINED ────────────────────────────────────────────────────────────
  // [FIX] Reversal-credit false discard — "Rs.X reversed to A/c... for a
  // previously failed/declined transaction" was matching on the word
  // "declined" (which describes WHY the reversal happened, not that this
  // message itself is a failed transaction) and being discarded outright.
  // This destroyed 100% of reversal_credit messages in testing (real money
  // credited back to the user, silently deleted with no pending_review trail).
  // Fix: exclude any message containing "reversed"/"reversal" before running
  // the declined/failed check — those are credits, not declines.
  {
    id: 'GENERIC_DECLINED',
    pattern: {
      test(body) {
        if (/\breversed\b|\breversal\s+of\b|\bhas\s+been\s+reversed\b/i.test(body)) return false;
        // [FIX] Negation guard — "Sorry, your payment of Rs.X could not be
        // processed... No money deducted from A/c XX..." was matching
        // GENERIC_DEBIT on the word "deducted" inside the negation "No
        // money deducted", fabricating a real ₹X debit for a transaction
        // that explicitly never happened. Confirmed 5/5 across two
        // datasets, all following this exact "could not be
        // processed...no money deducted" template.
        // Checking the negation phrase directly — rather than chasing this
        // one sentence — generalizes to any future wording using the same
        // "no money/amount deducted/debited" construction.
        if (/\bno\s+(?:money|amount)\s+(?:has\s+been\s+)?(?:deducted|debited)\b|\bamount\s+not\s+debited\b|\bnot\s+been\s+debited\b/i.test(body)) {
          return true;
        }
        return /declined|txn.*fail|transaction.*fail|payment.*fail|could\s+not\s+be\s+processed/im.test(body);
      }
    },
    extract(body, messageDate) {
      return {
        amount:     extractAmount(body),
        direction:  'declined',
        confidence: 0.99,
      };
    },
  },

  // ── 1b. CC EMI CONVERSION (informational — not a new transaction) ──────────
  // [ADD] "Your Credit Card XX7068 purchase of Rs.23,289.48 has been
  // converted to 12-month EMI effective DATE. -Bank" — this does NOT
  // represent new money movement. The original purchase already generated
  // its own SMS and was already captured (as GENERIC_CC_SPEND_TXN or
  // similar); this message just describes a payment-plan change on that
  // same purchase (lump sum -> installments). Recording it as a new debit
  // would double-count the same amount. Discarded explicitly (with its own
  // reason, not lumped into declined_transaction) rather than left
  // unmatched — in one real test run this was 12 of 14 total Haiku
  // escalations (86%), so leaving it unmatched has a real, recurring cost,
  // not just a theoretical one. Must come before GENERIC_CC_SPEND_TXN /
  // GENERIC_CC_PAYMENT so it intercepts first.
  {
    id: 'GENERIC_CC_EMI_CONVERSION',
    pattern: /credit\s*card.*purchase\s+of.*converted\s+to.*month\s+emi/im,
    extract(body, messageDate) {
      return {
        discard_reason: 'cc_emi_conversion_not_new_txn',
        amount:         extractAmount(body),
      };
    },
  },

  // ── 2. CC SPEND (Txn Rs. / Spent Rs. On Card) ─────────────────────────────
  // Catches HDFC CC spend format — 43 messages previously dropped at L2.
  // "Txn Rs.161.00\nOn HDFC Bank Card 4636\nAt airtel-prepaid.paytm@ptyb\nby UPI 120506314239\nOn 24-03"
  // "Spent Rs.2521 On HDFC Bank Card 7231 At ..JONAHS_ On 2026-03-01:13:33:59"
  // Bank-agnostic: pattern works for any bank name in "On <BANK> Bank Card".
  {
    id: 'GENERIC_CC_SPEND_TXN',
    pattern: {
      test(body) {
        return (
          // "Txn Rs.X\nOn <Bank> Card NNNN" — HDFC multi-line format
          /Txn\s+Rs\.[\d,]+.*On\s+\w[\w\s]+Bank\s+Card\s+\d{4}/is.test(body) ||
          // "Spent Rs.X On <Bank> Card NNNN At MERCHANT" — inline format
          /Spent\s+Rs\.[\d,]+\s+On\s+\w[\w\s]+Bank\s+Card\s+\d{4}/i.test(body)
        );
      }
    },
    extract(body, messageDate) {
      // Amount: from "Txn Rs.X" or "Spent Rs.X"
      let amountMatch = body.match(/(?:Txn|Spent)\s+Rs\.([\d,]+(?:\.\d{1,2})?)/i);
      const amount = amountMatch
        ? parseFloat(amountMatch[1].replace(/,/g, ''))
        : extractAmount(body);

      // Card last4: from "Card NNNN"
      const cardMatch = body.match(/Card\s+(\d{4})\b/i);
      const account_number_masked = cardMatch ? cardMatch[1] : extractAccount(body);

      // Merchant: from "At VPA" or "At MERCHANT"
      // For "Txn Rs." format: "At airtel-prepaid.paytm@ptyb"
      // For "Spent Rs." format: "At ..JONAHS_"
      let merchant = null;
      const atMatch = body.match(/\bAt\s+(.{2,40}?)(?:\s*\n|\s+by\s+UPI|\s+On\s+\d|\s+Not\s+You)/i);
      if (atMatch) {
        const candidate = atMatch[1].trim();
        // VPA pattern (@handle) — keep as-is for merchant_key normalisation
        // Pure garbage (q322701317@ybl, paytmqr6yuaum@ptys) — null out
        if (/^[a-z0-9.]+@[a-z]+$/i.test(candidate) && /^[qQ]\d{9}/.test(candidate.split('@')[0])) {
          merchant = null; // random UPI QR code ID, not a merchant name
        } else {
          merchant = candidate;
        }
      }

      // UPI ref: from "by UPI XXXXXXXXXXXX"
      const upiMatch = body.match(/by\s+UPI\s+(\d{12})\b/i);
      const ref_number = upiMatch ? upiMatch[1] : null;
      const ref_type   = ref_number ? 'upi_rrn' : null;

      // Date: try full date first; fallback to "On DD-MM" partial format (HDFC CC SMS)
      // "On 24-03" provides day+month only — infer year from message envelope date.
      let txn_date = extractDate(body);
      if (!txn_date) {
        const onDM = body.match(/\bOn\s+(\d{1,2})-(\d{2})\b/i);
        if (onDM && messageDate && messageDate.length >= 4) {
          const year = messageDate.substring(0, 4);
          txn_date = `${year}-${onDM[2]}-${onDM[1].padStart(2, '0')}`;
        }
      }

      return {
        direction:             'debit',
        amount,
        bank:                  extractBank(body),
        channel:               'Credit Card',
        account_number_masked,
        txn_date,
        merchant,
        balance:               null,
        ref_number,
        ref_type,
        possible_contra:       false,
        confidence:            0.88,
      };
    },
  },

  // ── 3. CC PAYMENT DEBIT (from bank account) ────────────────────────────────
  // "Alert!\nPaid Rs. 4,241.00\nFor: Credit Card payment\nFrom HDFC Bank A/c XX2875\nVia Online Banking."
  // "Alert!\nPaid Rs. 1,570.00\nFor: Credit Card payment\nFrom HDFC Bank A/c XX2875\nVia Online Banking."
  // Also covers SBI/Axis "paid towards/payment towards Credit Card" variants.
  //
  // [FIX] Direction inversion — the extremely common template
  // "Payment of Rs.X received towards <Bank> Credit Card XXNNNN. Thank you."
  // (confirmed on HDFC, ICICI, Yes Bank, PNB) did NOT match this rule's old
  // pattern (which required the literal adjacent phrase "payment towards" —
  // this format has "payment OF X RECEIVED towards", not "payment towards").
  // It fell through to GENERIC_CREDIT, which fires on the word "received" and
  // marks it direction:credit — i.e. paying down your credit card bill was
  // being recorded as INCOME. Confirmed 100% of credit_card_payment messages
  // in testing (across two independent 500-message datasets). Added the
  // "received towards...credit card" pattern below to catch it here instead.
  {
    id: 'GENERIC_CC_PAYMENT',
    // [FIX] "RS11642589 CREDITED TOWARDS CREDIT CARD XX7407 BILL PAYMENT..."
    // (BOB-style legacy/all-caps format) still fell through to the direction
    // inversion bug — the earlier fix only recognized "received towards"/
    // "paid towards" as literal adjacent phrases, not "CREDITED TOWARDS...
    // BILL PAYMENT". Added a proximity-based pattern (any of
    // credited/received/paid within ~40 chars of "credit card" AND "bill
    // payment" within ~30 chars after) so this generalizes to the concept
    // — an amount described near "credit card" + "bill payment" — instead
    // of matching only the exact sentences already seen.
    pattern: /(?:for:\s*credit card payment|paid towards.*credit card|payment towards.*credit card|paid.*for.*credit card|received\s+towards.*credit\s+card|payment\s+of\s+.*received\s+towards.*credit\s+card|(?:credited|received|paid).{0,40}credit\s*card.{0,30}bill\s*payment)/im,
    extract(body, messageDate) {
      // Amount: from "Paid Rs. X" or "Payment of Rs. X ... received"
      const amtMatch = body.match(/(?:[Pp]aid|[Pp]ayment\s+of)\s+(?:Rs\.?|INR)\s*([\d,]+(?:\.\d{1,2})?)/i);
      const amount   = amtMatch
        ? parseFloat(amtMatch[1].replace(/,/g, ''))
        : extractAmount(body);

      return {
        direction:             'debit',
        amount,
        bank:                  extractBank(body),
        channel:               'Net Banking',
        account_number_masked: extractAccount(body),
        txn_date:              extractDate(body),
        merchant:              null,
        balance:               null,
        ...extractRefNumber(body),
        possible_contra:       true,
        confidence:            0.90,
      };
    },
  },

  // ── 4. PLUXEE SPEND (benefit card spend) ───────────────────────────────────
  // "Rs. 350.00 spent from Pluxee  Meal Card wallet, card no.xx9258 on 30-03-2026 17:56:16 at THENMANI ST CHENNAI. Avl bal Rs.4914.72."
  // Generalises to Zeta, Zaggle, EdenRed — any "spent from <BRAND> ... Card ... at MERCHANT" format.
  // Channel derived from SMS text: card number present → 'Card', else → 'Wallet'.
  // Merchant: from "at MERCHANT. Avl bal" clause — the actual POS location.
  // Category: run through normal taxonomy (merchant at POS, not the instrument).
  {
    id: 'PLUXEE_SPEND',
    pattern: /Rs\.?\s*[\d,]+(?:\.\d{1,2})?\s+spent\s+from\s+\w+\s+(?:Meal\s+Card|Gift\s+Card|Food\s+Card|Wallet)/i,
    extract(body, messageDate) {
      // Amount: from "Rs. X spent from"
      const amtMatch = body.match(/Rs\.?\s*([\d,]+(?:\.\d{1,2})?)\s+spent\s+from/i);
      const amount   = amtMatch
        ? parseFloat(amtMatch[1].replace(/,/g, ''))
        : extractAmount(body);

      // Merchant: from "at MERCHANT. Avl bal"
      const merchant = extractBenefitCardMerchant(body);

      // Channel: derived from SMS — card number present → Card, else → Wallet
      const channel = extractBenefitCardChannel(body);

      // Card last4: from "card no.xxNNNN"
      const cardNoMatch = body.match(/card\s+no\.?\s*[xX*]{0,4}(\d{4})\b/i);
      const account_number_masked = cardNoMatch ? cardNoMatch[1] : null;

      // Date: from "on DD-MM-YYYY HH:MM:SS"
      const txn_date = extractDate(body);

      return {
        direction:             'debit',
        amount,
        bank:                  null,
        channel,
        account_number_masked,
        txn_date,
        merchant,
        balance:               extractBalance(body),
        ref_number:            null,
        ref_type:              null,
        possible_contra:       false,
        // merchant is a POS terminal string — taxonomy will classify or pending_review
        requires_classification: merchant === null,
        confidence:            0.88,
      };
    },
  },

  // ── 5. PLUXEE CREDIT (employer benefit card top-up) ────────────────────────
  // "Your Pluxee Card has been successfully credited with Rs.2500 towards Meal Wallet on Mon Mar 30 2026 06:14:15."
  // Not real income — employer topping up meal card. possible_contra:true.
  // Merchant: null — the timestamp is NOT a merchant (extractMerchant guard handles this).
  // Generalises to Zeta, Zaggle, any "successfully credited with Rs.X towards <WALLET>" format.
  {
    id: 'PLUXEE_CREDIT',
    pattern: /successfully\s+credited\s+with\s+Rs\.?\s*[\d,]+.*(?:Meal\s+Wallet|Gift\s+Wallet|Food\s+Wallet|Wallet)/i,
    extract(body, messageDate) {
      // Amount: from "credited with Rs.X"
      const amtMatch = body.match(/credited\s+with\s+Rs\.?\s*([\d,]+(?:\.\d{1,2})?)/i);
      const amount   = amtMatch
        ? parseFloat(amtMatch[1].replace(/,/g, ''))
        : extractAmount(body);

      return {
        direction:             'credit',
        amount,
        bank:                  null,
        channel:               'Wallet',
        account_number_masked: null,
        txn_date:              extractDate(body),
        merchant:              null,  // timestamp is NOT a merchant
        balance:               extractBalance(body),
        ref_number:            null,
        ref_type:              null,
        possible_contra:       true,  // not income — employer benefit top-up
        requires_classification: false,
        confidence:            0.88,
      };
    },
  },

  // ── 6. NCMC LOAD (transit card top-up) ─────────────────────────────────────
  // "Your NCMC Prepaid Card 817453XXXXXX6295 is loaded with Rs. 1000.00 successfully on 25/02/2026 17:55:10. Available balance is Rs. 1100.00. -SBI"
  // Debit from bank account perspective (money left bank to transit card).
  // possible_contra:true — pairs with SBI offline wallet debit messages.
  {
    id: 'NCMC_LOAD',
    pattern: /(?:NCMC|Prepaid\s+Card).*is\s+loaded\s+with\s+Rs\.?\s*[\d,]+/i,
    extract(body, messageDate) {
      // Amount: from "loaded with Rs. X"
      const amtMatch = body.match(/loaded\s+with\s+Rs\.?\s*([\d,]+(?:\.\d{1,2})?)/i);
      const amount   = amtMatch
        ? parseFloat(amtMatch[1].replace(/,/g, ''))
        : extractAmount(body);

      // Card last4: last 4 digits before "is loaded"
      const cardMatch = body.match(/\d{6}[X*]+(\d{4})/i);
      const account_number_masked = cardMatch ? cardMatch[1] : extractAccount(body);

      return {
        direction:             'debit',
        amount,
        bank:                  extractBank(body),
        channel:               'Card',
        account_number_masked,
        txn_date:              extractDate(body),
        merchant:              null,
        balance:               extractBalance(body),
        ref_number:            null,
        ref_type:              null,
        possible_contra:       true,  // pairs with SBI offline wallet debits
        requires_classification: false,
        confidence:            0.88,
      };
    },
  },

  // ── 7. WALLET SPEND (Amazon Pay / Paytm / PhonePe) ─────────────────────────
  // Covers wallet balance spends — distinct from UPI (wallet balance, not bank account).
  // "Amazon Pay balance is successful at MERCHANT"
  // "Paytm Wallet debited Rs.X at MERCHANT"
  {
    id: 'GENERIC_WALLET_SPEND',
    // [FIX] Original pattern assumed "amazon pay" always appears BEFORE
    // "using"/"from" which always appears BEFORE "balance"/"wallet". The most
    // common real template is the opposite order — "Rs.X paid to MERCHANT
    // from your Amazon Pay Balance"/"from your PhonePe Wallet" — where
    // "from" precedes "amazon pay"/"phonepe", not the other way round, and
    // there's no "debited"/"used" keyword at all. Confirmed 100% miss rate
    // for this template (both wallet spends and wallet loads use "from your
    // X Wallet/Balance" — this rule now catches the spend side directly).
    pattern: /(?:paid\s+to\s+.+?\s+from\s+your\s+.{0,30}?(?:wallet|balance)|amazon\s+pay.*(?:using|from).*(?:balance|wallet)|using\s+apay\s+balance|apay\s+balance.*successful|paytm.*wallet.*(?:debited|used)|phonepe.*wallet.*(?:debited|used)|wallet\s+balance.*(?:debited|used|spent))/i,
    extract(body, messageDate) {
      // Merchant: prefer "paid to MERCHANT from your Wallet" clause, then
      // fall back to "at MERCHANT" (older POS-terminal formats).
      let merchant = null;
      const paidToMatch = body.match(/paid\s+to\s+(.{2,40}?)\s+from\s+your\b/i);
      if (paidToMatch) merchant = paidToMatch[1].trim();
      if (!merchant) {
        const atMatch = body.match(/\bat\s+(.{2,40}?)(?:\s*\n|\s+[Oo]n\s+\d|\s+[Nn]ot\s+[Yy]ou|$)/i);
        merchant = atMatch ? atMatch[1].trim() : extractMerchant(body);
      }

      // 'A.in' is Amazon.in abbreviated in Apay/Pine Labs POS SMS
      if (merchant && merchant.toLowerCase().replace(/\.$/,'') === 'a.in') merchant = 'Amazon.in';
      return {
        direction:             'debit',
        amount:                extractAmount(body),
        bank:                  null,
        channel:               'Wallet',
        account_number_masked: extractAccount(body),
        txn_date:              extractDate(body),
        merchant,
        balance:               extractBalance(body),
        ...extractRefNumber(body),
        possible_contra:       false,
        confidence:            0.85,
      };
    },
  },

  // ── 8. NETBANKING PAYMENT ──────────────────────────────────────────────────
  // "Payment Successful!\nRs. 1175.00 from A/c XX2875 to PAYUERPCHENNAICORPOR via HDFC Bank NetBanking."
  // Also: "payment of Rs.X ... is/was successful" (SBI/Axis NetBanking variants)
  // "Your payment of Rs. 1887 was successful. We will share your policy documents..." (ICICI Lombard)
  {
    id: 'GENERIC_NETBANKING_PAYMENT',
    pattern: /(?:payment\s+successful!|payment\s+of\s+Rs\..*(?:is|was)\s+successful|Rs\..*from\s+A\/c.*via.*(?:net\s*banking|online\s+banking))/im,
    extract(body, messageDate) {
      // Payee/merchant: from "to PAYEE via" clause
      let merchant = null;
      const toMatch = body.match(/\bto\s+(.{3,50}?)\s+via\s+/i);
      if (toMatch) merchant = toMatch[1].trim();

      // For "payment was successful" format without explicit payee (e.g. ICICI Lombard)
      // merchant stays null — the sender address is the payee context

      return {
        direction:             'debit',
        amount:                extractAmount(body),
        bank:                  extractBank(body),
        channel:               'Net Banking',
        account_number_masked: extractAccount(body),
        txn_date:              extractDate(body),
        merchant,
        balance:               extractBalance(body),
        ...extractRefNumber(body),
        possible_contra:       false,
        confidence:            0.85,
      };
    },
  },

  // ── 9. NACH DEBIT ─────────────────────────────────────────────────────────
  {
    id: 'GENERIC_NACH',
    // [FIX] UPI Mandate SMS bodies ("UPI Mandate:\nSent Rs...") were matching
    // this rule via the word "mandate" and returning channel='NACH'. They are
    // UPI channel executions. We exclude them here so they fall through to
    // GENERIC_DEBIT, which calls extractChannel() and correctly returns 'UPI'.
    pattern: {
      test(body) {
        // Exclude "UPI Mandate:" SMS from this rule
        if (/^UPI Mandate:/im.test(body)) return false;
        return /\bNACH\b|\bUMRN\b|\bmandate\b|\bstanding instruction\b|\bECS\b|\bauto.?pay\b/im.test(body);
      }
    },
    extract(body, messageDate) {
      return {
        amount:                extractAmount(body),
        bank:                  extractBank(body),
        channel:               'NACH',
        account_number_masked: extractAccount(body),
        txn_date:              extractDate(body),
        merchant:              extractMerchant(body),
        balance:               extractBalance(body),
        ...extractRefNumber(body),
        possible_contra:       false,
        confidence:            0.85,
      };
    },
  },

  // ── 10. PPF / SSY TRANSFER ─────────────────────────────────────────────────
  {
    id: 'GENERIC_PPF_SSY',
    pattern: /transferred to your PPF|transferred to your SSY|PPF\/SSY A\/c|Sukanya.*transfer|Public Provident.*transfer/im,
    extract(body, messageDate) {
      return {
        amount:                extractAmount(body),
        bank:                  extractBank(body),
        channel:               'NEFT',
        account_number_masked: extractAccount(body),
        txn_date:              extractDate(body),
        merchant:              'PPF / SSY Account',
        balance:               extractBalance(body),
        ...extractRefNumber(body),
        possible_contra:       true,
        confidence:            0.92,
      };
    },
  },

  // ── 10b. LOAN DISBURSEMENT ───────────────────────────────────────────────
  // [ADD] "Congratulations! Loan amount Rs.X disbursed/credited to A/c XX...
  // Loan A/c No NNNN. -Bank" — was completely unmatched (neither "disbursed"
  // nor "Loan amount" trip GENERIC_CREDIT, which only checks
  // credited/deposited/received/refunded/reversed). Confirmed 100% miss rate
  // (24/24 and 16/16 in two independent datasets) — every loan payout, often
  // a large one-off credit, was silently lost. Must come before GENERIC_DEBIT/
  // GENERIC_CREDIT.
  {
    id: 'LOAN_DISBURSEMENT',
    // [FIX] "IIFL Finance: Gold Loan of Rs.249,745 disbursed to A/c
    // XX3844..." wasn't matched — the original pattern required "loan
    // amount" or "loan disbursed/disbursal" adjacent, but this says
    // "<Type> Loan of Rs.X disbursed", with "of Rs.X" breaking the
    // adjacency. Broadened to any "Loan...disbursed" or "Loan...credited"
    // regardless of what sits between them, covering Gold Loan, Personal
    // Loan, Business Loan, etc.
    pattern: /\bloan\s+amount\b.*\bdisbursed\b|\bloan\s+amount\b.*\bcredited\b|\bloan\s+disburs(?:ed|al)\b|\bloan\s+of\s+Rs\.?.*\bdisbursed\b|\b\w+\s+loan\b(?:(?!\.).){0,60}\bdisbursed\b/im,
    extract(body, messageDate) {
      return {
        direction:             'credit',
        amount:                extractAmount(body),
        bank:                  extractBank(body),
        channel:               extractChannel(body),
        account_number_masked: extractAccount(body),
        txn_date:              extractDate(body) || messageDate,
        merchant:              'Loan Disbursement',
        balance:               extractBalance(body),
        ...extractRefNumber(body),
        possible_contra:       false,
        confidence:            0.9,
      };
    },
  },

  // ── 10c. CHEQUE CLEARED (ambiguous — no debited/credited keyword) ──────────
  // [ADD] "Cheque No NNN for Rs.X has been cleared from A/c XX... -Bank" has
  // neither "debited" nor "credited" and was unmatched entirely (100% miss
  // rate in testing). "cleared FROM A/c" always means an outgoing cheque you
  // wrote — a debit. ("cleared & credited to A/c" — a cheque you deposited —
  // already matches GENERIC_CREDIT via the word "credited" and needs no
  // change.) Must come before GENERIC_DEBIT.
  {
    id: 'CHEQUE_CLEARED_DEBIT',
    pattern: /cheque\s+no[.\s]+\d+.*\bcleared\b.*\bfrom\s+A\/c/im,
    extract(body, messageDate) {
      const chqMatch = body.match(/cheque\s+no[.\s]+(\d+)/i);
      return {
        direction:             'debit',
        amount:                extractAmount(body),
        bank:                  extractBank(body),
        channel:               'Cheque',
        account_number_masked: extractAccount(body),
        txn_date:              extractDate(body) || messageDate,
        merchant:              chqMatch ? `Cheque #${chqMatch[1]}` : null,
        balance:               extractBalance(body),
        ref_number:            chqMatch ? chqMatch[1] : null,
        ref_type:              chqMatch ? 'cheque_number' : null,
        possible_contra:       false,
        confidence:            0.85,
      };
    },
  },

  // ── 10d. CARD USED FOR (debit/credit card POS, "used for" phrasing) ────────
  // [ADD] "Thank you for using SBI Debit Card X8812 for Rs 1,899.00 at
  // RELIANCE RETAIL..." and "...Card XNNNN used for Rs.X at MERCHANT on
  // DATE..." — neither contains debited/deducted/Sent/Withdrawn/Spent, so
  // GENERIC_DEBIT never matched. Confirmed 100% miss rate. Must come before
  // GENERIC_DEBIT.
  {
    id: 'CARD_POS_USED_FOR',
    pattern: /\bcard\b.{0,20}\bused\s+for\b|\busing\b.{0,20}\bcard\b.{0,20}\bfor\s+Rs/im,
    extract(body, messageDate) {
      const atMatch = body.match(/\bat\s+(.{2,40}?)(?:\s+on\s+\d|\s*\.|\s*$)/i);
      return {
        direction:             'debit',
        amount:                extractAmount(body),
        bank:                  extractBank(body),
        channel:               'Card',
        account_number_masked: extractAccount(body),
        txn_date:              extractDate(body) || messageDate,
        merchant:              atMatch ? atMatch[1].trim() : null,
        balance:               extractBalance(body),
        ...extractRefNumber(body),
        possible_contra:       false,
        confidence:            0.85,
      };
    },
  },

  // ── 10e. GENERIC CHARGED (ride fares, hotel/travel bookings) ───────────────
  // [ADD] "Trip completed. Rs.X charged for your Uber ride..." and "Your
  // Treebo booking... Rs.X charged to your card ending NNNN..." — "charged"
  // alone isn't in GENERIC_DEBIT's trigger list. Confirmed 100% miss rate.
  // Must come before GENERIC_DEBIT.
  {
    id: 'GENERIC_CHARGED',
    pattern: /\bcharged\s+(?:to|for)\b/im,
    extract(body, messageDate) {
      const forMatch = body.match(/charged\s+for\s+your\s+(.{2,40}?)(?:\s+on\s+\d|\.|$)/i);
      return {
        direction:             'debit',
        amount:                extractAmount(body),
        bank:                  extractBank(body),
        channel:               extractChannel(body),
        account_number_masked: extractAccount(body),
        txn_date:              extractDate(body) || messageDate,
        merchant:              forMatch ? forMatch[1].trim() : extractMerchant(body),
        balance:               extractBalance(body),
        ...extractRefNumber(body),
        possible_contra:       false,
        confidence:            0.82,
      };
    },
  },

  // ── 10f. CASH DEPOSIT (self-deposit via CDM/branch) ─────────────────────────
  // [ADD] "Cash deposit of Rs.X in A/c XX... via CDM on DATE. Avl Bal Rs.Y."
  // — noun "deposit", not the verb "deposited" GENERIC_CREDIT checks for.
  // Confirmed 100% miss rate. Treated as possible_contra (you moving your
  // own cash in, not new income). Must come before GENERIC_CREDIT.
  {
    id: 'CASH_DEPOSIT',
    pattern: /\bcash\s+deposit\s+of\b/im,
    extract(body, messageDate) {
      return {
        direction:             'credit',
        amount:                extractAmount(body),
        bank:                  extractBank(body),
        channel:               /\bATM\b|\bCDM\b/i.test(body) ? 'ATM' : 'Cash',
        account_number_masked: extractAccount(body),
        txn_date:              extractDate(body) || messageDate,
        merchant:              'Cash Deposit',
        balance:               extractBalance(body),
        ...extractRefNumber(body),
        possible_contra:       true,
        confidence:            0.85,
      };
    },
  },

  // ── 10g. WALLET LOAD (topping up a wallet from your own bank account) ──────
  // [ADD] "Rs.X added to your PhonePe/Paytm/Amazon Pay Wallet on DATE from
  // linked bank account." — "added to" isn't in GENERIC_CREDIT's trigger
  // list. Confirmed 100% miss rate. This is you moving your own money into
  // a wallet, not new income, so possible_contra:true. Must come before
  // GENERIC_CREDIT.
  {
    id: 'WALLET_LOAD',
    // [FIX] Relaxed — "Rs.X added to your Mobikwik on DATE from linked bank
    // account" names the wallet app directly (Mobikwik) without the literal
    // word "wallet"/"balance" anywhere in the message, so the original
    // pattern missed it. "from linked bank account" is the reliable signal.
    pattern: /\badded\s+to\s+your\b.*\bfrom\s+linked\s+bank\s+account\b/im,
    extract(body, messageDate) {
      let walletMatch = body.match(/added\s+to\s+your\s+(.{2,30}?)\s+(?:wallet|balance)/i);
      // [FIX] fall back to capturing the app name even without "wallet"/
      // "balance" present ("added to your Mobikwik on...")
      if (!walletMatch) walletMatch = body.match(/added\s+to\s+your\s+(.{2,30}?)\s+on\s+\d/i);
      return {
        direction:             'credit',
        amount:                extractAmount(body),
        bank:                  extractBank(body),
        channel:               'Wallet',
        account_number_masked: extractAccount(body),
        txn_date:              extractDate(body) || messageDate,
        merchant:              walletMatch ? `${walletMatch[1].trim()} Wallet Load` : 'Wallet Load',
        balance:               extractBalance(body),
        ...extractRefNumber(body),
        possible_contra:       true,
        confidence:            0.85,
      };
    },
  },

  // ── 10h. PAID TO / PAID TOWARDS (UPI P2P app payments, rent, etc.) ─────────
  // [ADD] Two very common templates were both completely unmatched:
  //   "You paid Rs14,337.14 to Rahul Gupta using WhatsApp Pay on DATE.
  //    UPI transaction ID NNNN." (BHIM/GPay/PhonePe/Paytm/Amazon Pay/
  //    WhatsApp Pay person-to-person payments — one of the single most
  //    common SMS templates in the dataset, ~5% of all messages, and 100%
  //    unmatched at Layer 2 previously)
  //   "Rs.X paid towards house rent to NAME from A/c XX... via UPI. -Bank"
  // Neither contains debited/deducted/Sent/Withdrawn/Spent, so GENERIC_DEBIT
  // never fired; both fell through to Haiku escalation or were lost outright.
  // Must come after the more specific CC_PAYMENT/PLUXEE/WALLET_SPEND rules
  // above (which handle their own "paid" phrasings) and before GENERIC_DEBIT.
  {
    id: 'GENERIC_PAID_TO',
    // [FIX] "paid" and "to"/"towards" are rarely adjacent — the amount sits
    // between them ("paid Rs14,337.14 to Rahul Gupta"). Allow anything short
    // in between. Also added: "...bill of Rs.X has been paid successfully
    // via UPI..." (utility bills — no "to"/"towards" at all), and
    // "paid for"/"paid at" ("Rs.X paid for Talwalkars membership renewal",
    // "Rs.X paid at Bharat Petroleum via card/UPI", "Rs.X paid for parking
    // at Phoenix Mall Parking") — gym memberships, fuel, and parking all use
    // this construction and had zero coverage before.
    pattern: /\bpaid\b.{0,25}?\b(?:to|towards|for|at)\b|\bhas\s+been\s+paid\s+successfully\b/im,
    extract(body, messageDate) {
      let merchant = null;
      const toMatch = body.match(/\bto\s+([A-Za-z][A-Za-z .]{2,40}?)\s+(?:using|from|on|via)\b/i);
      if (toMatch) merchant = toMatch[1].trim();
      // "Rs.X paid for Talwalkars membership renewal on DATE"
      if (!merchant) {
        const forMatch = body.match(/\bpaid\s+for\s+(.{2,40}?)\s+(?:renewal|membership|on\s+\d)/i);
        if (forMatch) merchant = forMatch[1].trim();
      }
      // "Rs.X paid at Bharat Petroleum via card/UPI"
      if (!merchant) {
        const atMatch = body.match(/\bpaid\s+at\s+(.{2,40}?)\s+(?:via|on\s+\d)/i);
        if (atMatch) merchant = atMatch[1].trim();
      }
      // "Rs.X paid for parking at Phoenix Mall Parking via FASTag/UPI"
      if (!merchant) {
        const parkingMatch = body.match(/\bparking\s+at\s+(.{2,40}?)\s+via\b/i);
        if (parkingMatch) merchant = parkingMatch[1].trim();
      }
      // "Your Adani Electricity electricity bill of Rs.X has been paid..."
      if (!merchant) {
        const billMatch = body.match(/^Your\s+(.{2,30}?)\s+(?:electricity|gas|water|mobile|broadband)?\s*bill\b/i);
        if (billMatch) merchant = billMatch[1].trim();
      }

      const txnIdMatch = body.match(/UPI\s+transaction\s+ID\s*[:\s]*(\d{8,})/i);
      const refFields = txnIdMatch
        ? { ref_number: txnIdMatch[1], ref_type: 'upi_rrn' }
        : extractRefNumber(body);

      return {
        direction:             'debit',
        amount:                extractAmount(body),
        bank:                  extractBank(body),
        channel:               extractChannel(body),
        account_number_masked: extractAccount(body),
        txn_date:              extractDate(body) || messageDate,
        merchant,
        balance:               extractBalance(body),
        ...refFields,
        possible_contra:       isPossibleSelfTransfer(body),
        confidence:            0.82,
      };
    },
  },

  // ── 10i. PURCHASE CONFIRMATION (flight/movie/food/recharge/gift-card apps) ──
  // [ADD] Covers a family of "booking/purchase confirmed" merchant-app
  // templates that were all completely unmatched (100% miss rate each):
  //   "Booking confirmed! Rs.X paid via Cleartrip for Air India flight..."
  //   "BookMyShow: Rs.X paid for Kalki 2 tickets. Booking confirmed..."
  //   "Payment of Rs.X successful for your Zepto order..."
  //   "Jio DTH Recharge of Rs.X successful on DATE..."
  //   "Rs.X Google Play Gift Card purchased successfully on DATE..."
  // None contain debited/deducted/Sent/Withdrawn/Spent. These have no bank
  // account number in the SMS (the app is the counterparty, not the bank),
  // so account_number_masked is always null and confidence is intentionally
  // lower (0.75) so they route to pending_review rather than auto-approve.
  {
    id: 'GENERIC_PURCHASE_CONFIRMATION',
    // [FIX] Added two more branches, both confirmed real, zero-coverage
    // templates: "Hyderabad Metro Smart Card recharged with Rs.X on DATE
    // via UPI" (transit card recharge — "recharged with" isn't the same
    // phrasing as "Recharge of Rs.X successful", which was already
    // covered) and "Digital Gold purchase of Xg worth Rs.Y successful via
    // Groww on DATE" (digital gold apps).
    pattern: /paid\s+via\s+\w+.*for|:\s*Rs\.?[\d,]+(?:\.\d{1,2})?\s+paid\s+for|payment\s+of\s+(?:Rs\.?|INR)\s*[\d,]+(?:\.\d{1,2})?\s+successful\s+for|recharge\s+of\s+(?:Rs\.?|INR)\s*[\d,]+(?:\.\d{1,2})?\s+successful|gift\s+card\s+purchased\s+successfully|recharged\s+with\s+(?:Rs\.?|INR)\s*[\d,]+|(?:gold|purchase)\s+(?:purchase\s+)?of\s+[\d.]+\s*g(?:rams?)?\s+worth\s+(?:Rs\.?|INR)\s*[\d,]+.*successful/i,
    extract(body, messageDate) {
      let merchant = null;
      let m = body.match(/^([A-Za-z][A-Za-z0-9 ]{2,30}?):/);           // "BookMyShow:"
      if (m) merchant = m[1].trim();
      if (!merchant) { m = body.match(/paid\s+via\s+(\w+)/i); if (m) merchant = m[1].trim(); }        // "paid via Cleartrip"
      if (!merchant) { m = body.match(/for\s+your\s+(\w+)\s+order/i); if (m) merchant = m[1].trim(); } // "for your Zepto order"
      if (!merchant) { m = body.match(/^(\w+)\s+(?:DTH|Mobile)\s+Recharge/i); if (m) merchant = m[1].trim(); } // "Jio DTH Recharge"
      if (!merchant) { m = body.match(/Rs\.?[\d,]+(?:\.\d{1,2})?\s+([A-Za-z][A-Za-z0-9 ]{2,30}?)\s+Gift\s+Card/i); if (m) merchant = m[1].trim(); } // "Google Play Gift Card"
      if (!merchant) { m = body.match(/^([A-Za-z][A-Za-z0-9 ]{2,30}?)\s+Smart\s+Card\s+recharged/i); if (m) merchant = m[1].trim(); } // "Hyderabad Metro Smart Card recharged"
      if (!merchant) { m = body.match(/\bvia\s+([A-Za-z][A-Za-z0-9 ]{2,30}?)\s+on\s+\d/i); if (m) merchant = m[1].trim(); } // "successful via Groww on DATE"

      return {
        direction:             'debit',
        amount:                extractAmount(body),
        bank:                  null,
        channel:               extractChannel(body),
        account_number_masked: extractAccount(body),
        txn_date:              extractDate(body) || messageDate,
        merchant,
        balance:               null,
        ref_number:            null,
        ref_type:              null,
        possible_contra:       false,
        confidence:            0.75,
      };
    },
  },

  // ── 10j0. DEMAND DRAFT ISSUED ────────────────────────────────────────────
  // [ADD] "Demand Draft No 47222396 for Rs.115,872 has been issued against
  // A/c XX1837 on 04-Feb-2026. -Union Bank of India" — creating a DD moves
  // money out of the account (debit), and neither "issued against" nor
  // "demand draft" trip any existing debit keyword. Confirmed 100% miss
  // rate. ("demand_draft_encashed" — deliberately NOT handled here; the
  // observed samples have no account number and no reliable signal for
  // whose draft it is, so direction can't be determined safely from text
  // alone. Left for a real design decision rather than guessing.)
  {
    id: 'DEMAND_DRAFT_ISSUED',
    pattern: /demand\s+draft\s+no[.\s]+\d+.*\bissued\s+against\b/im,
    extract(body, messageDate) {
      const ddMatch = body.match(/demand\s+draft\s+no[.\s]+(\d+)/i);
      return {
        direction:             'debit',
        amount:                extractAmount(body),
        bank:                  extractBank(body),
        channel:               'DD',
        account_number_masked: extractAccount(body),
        txn_date:              extractDate(body) || messageDate,
        merchant:              ddMatch ? `Demand Draft #${ddMatch[1]}` : null,
        balance:               null,
        ref_number:            ddMatch ? ddMatch[1] : null,
        ref_type:              ddMatch ? 'dd_number' : null,
        possible_contra:       false,
        confidence:            0.85,
      };
    },
  },

  // ── 10j0b. LEGACY DR/CR ABBREVIATED FORMAT ──────────────────────────────
  // [ADD] "AC XX2230 DR RS.77,614 ON 21FEB26 AVBL BAL RS.393,221.57 -YB" —
  // an older, heavily abbreviated bank SMS style (AC instead of A/C, DR/CR
  // instead of debited/credited, AVBL BAL instead of Avl Bal). Confirmed
  // 100% miss rate — none of the generic rules recognize "DR"/"CR" as
  // direction words. Bank is intentionally left to extractBank(body) rather
  // than guessed from single/double-letter suffixes like "-YB"/"-B" — those
  // are too ambiguous to map reliably (many banks could plausibly abbreviate
  // to "B"), so bank stays null here unless the full name is elsewhere in
  // the message rather than risk a wrong attribution.
  {
    id: 'LEGACY_DR_CR_FORMAT',
    pattern: /\bAC\s+[Xx*]{1,4}\d{4}\s+(?:DR|CR)\s+RS\.?\s*\d/i,
    extract(body, messageDate) {
      const dirMatch = body.match(/\bAC\s+[Xx*]{1,4}\d{4}\s+(DR|CR)\s+RS\.?\s*\d/i);
      const direction = dirMatch && dirMatch[1].toUpperCase() === 'CR' ? 'credit' : 'debit';
      return {
        direction,
        amount:                extractAmount(body),
        bank:                  extractBank(body),
        channel:               'UPI',
        account_number_masked: extractAccount(body),
        txn_date:              extractDate(body) || messageDate,
        merchant:              null,
        balance:               extractBalance(body),
        ref_number:            null,
        ref_type:              null,
        possible_contra:       false,
        confidence:            0.8,
      };
    },
  },

  // ── 10j0c. COURIER COD CASH COLLECTION ──────────────────────────────────
  // [ADD — product decision, not a clear-cut bug] "Delhivery: Rs.X
  // collected as COD payment for your shipment delivered on DATE. Thank
  // you!" Unlike prepaid online orders (where a separate bank debit SMS
  // exists and this message would be a duplicate payee-acknowledgment,
  // correctly excluded), cash-on-delivery payments have NO bank SMS at
  // all — this courier message is the only record of that spend that will
  // ever exist. Default here: capture it as a real cash expense at lower
  // confidence (0.7) so it always routes to pending_review rather than
  // auto-approving. If you'd rather exclude COD entirely (treat it like
  // any other payee-ack), delete this rule and add "collected as" to the
  // Kotlin payee-acknowledgment exclusion list instead — that's a one-line
  // change either direction, flagging so it's a deliberate choice.
  {
    id: 'COURIER_COD_PAYMENT',
    pattern: /\bcollected\s+as\s+COD\s+payment\b/i,
    extract(body, messageDate) {
      const courierMatch = body.match(/^([A-Za-z][A-Za-z0-9 ]{2,20}?):/);
      return {
        direction:             'debit',
        amount:                extractAmount(body),
        bank:                  null,
        channel:               'Cash',
        account_number_masked: null,
        txn_date:              extractDate(body) || messageDate,
        merchant:              courierMatch ? courierMatch[1].trim() : null,
        balance:               null,
        ref_number:            null,
        ref_type:              null,
        possible_contra:       false,
        confidence:            0.7,
      };
    },
  },

  // [ADD] "Refund of Rs.X for your returned Y order initiated. Amount will
  // reflect in A/c XX in 5-7 business days." — uses the noun "Refund", not
  // the verb "refunded" that GENERIC_CREDIT checks for, so this never
  // matched. Money hasn't actually landed yet, so this is intentionally
  // lower-confidence than a confirmed credit — it always routes to
  // pending_review (see smsParser.ts needsReview logic) rather than being
  // auto-approved as income.
  {
    id: 'REFUND_INITIATED',
    pattern: /refund\s+of\s+(?:Rs\.?|INR)\s*[\d,]+(?:\.\d{1,2})?.*initiated/i,
    extract(body, messageDate) {
      const merchantMatch = body.match(/returned\s+(.{2,30}?)\s+order/i);
      return {
        direction:             'credit',
        amount:                extractAmount(body),
        bank:                  extractBank(body),
        channel:               'Refund',
        account_number_masked: extractAccount(body),
        txn_date:              extractDate(body) || messageDate,
        merchant:              merchantMatch ? merchantMatch[1].trim() : null,
        balance:               null,
        ref_number:            null,
        ref_type:              null,
        possible_contra:       false,
        confidence:            0.6,
      };
    },
  },

  // ── 11. GENERIC DEBIT ──────────────────────────────────────────────────────
  {
    id: 'GENERIC_DEBIT',
    // [FIX] Added \bWithdrawal\b — "Cash withdrawal of Rs.X from A/c..."
    // (branch/teller withdrawals with no accompanying "debited"/"withdrawn")
    // was passing Layer 1 after the L1 fix but still failing to match any
    // Layer 2 rule, since this pattern only checked the verb form
    // "Withdrawn", not the noun "Withdrawal".
    pattern: /\bdebited\b|\bdeducted\b|\bSent\b|\bWithdrawn\b|\bWithdrawal\b|\bWdl\b|\bSpent\b/im,
    extract(body, messageDate) {
      const merchant = extractMerchant(body);
      return {
        amount:                extractAmount(body),
        bank:                  extractBank(body),
        channel:               extractChannel(body),
        account_number_masked: extractAccount(body),
        txn_date:              extractDate(body),
        merchant,
        balance:               extractBalance(body),
        ...extractRefNumber(body),
        possible_contra:       isPossibleSelfTransfer(body),
        confidence:            0.80,
      };
    },
  },

  // ── 12. GENERIC CREDIT ─────────────────────────────────────────────────────
  {
    id: 'GENERIC_CREDIT',
    pattern: /\bcredited\b|\bdeposited\b|\breceived\b|\brefunded\b|\breversed\b/im,
    extract(body, messageDate) {
      const vpaMatch = body.match(/from VPA\s+([\w.\-@]+)/i);
      const vpa      = vpaMatch ? vpaMatch[1] : null;
      const vpaType  = vpa ? classifyVpa(vpa) : null;

      // [ADD] Null guard for CC payment credit merchant strings
      let merchant = vpa || extractMerchant(body);
      if (merchant) {
        // "your card ending 4636" — from "HDFC Bank Cardmember, Payment of Rs X was credited to your card ending 4636"
        if (/your\s+(credit\s+)?card\s+ending/i.test(merchant)) merchant = null;
        // "YOUR CREDIT CARD ENDING WITH 4636 ON 29-1-2026" — from DEAR CARDMEMBER format
        if (/YOUR\s+CREDIT\s+CARD\s+ENDING\s+WITH/i.test(merchant)) merchant = null;
        // "your RWallet Account" — RWallet balance SMS
        if (/your\s+rwallet/i.test(merchant)) merchant = null;
        // "Meal Wallet on <timestamp>" — Pluxee credit timestamp
        if (/Meal\s+Wallet\s+on\s+/i.test(merchant)) merchant = null;
      }

      return {
        amount:                  extractAmount(body),
        bank:                    extractBank(body),
        channel:                 extractChannel(body),
        account_number_masked:   extractAccount(body),
        txn_date:                extractDate(body),
        merchant,
        balance:                 extractBalance(body),
        vpa_type:                vpaType,
        requires_classification: vpaType === 'person' || vpaType === 'unknown',
        ...extractRefNumber(body),
        possible_contra:         false,
        confidence:              vpaType === 'merchant' ? 0.85
                               : vpaType === 'person'   ? 0.75
                               : 0.80,
      };
    },
  },

];

// ─────────────────────────────────────────────────────────────────────────────
// LAYER 2 MATCHER
// ─────────────────────────────────────────────────────────────────────────────

function matchMessage(body, messageDate) {
  for (const rule of RULES) {
    if (rule.pattern.test(body)) {
      const fields = rule.extract(body, messageDate);
      if (!fields) continue;

      if (fields.direction === 'declined') {
        return { discard: true, reason: 'declined_transaction', rule: rule.id };
      }
      // [FIX] Generalized the discard mechanism — was hardcoded to only
      // handle direction:'declined'. Added a second, explicit discard path
      // for rules that recognize a message as real but NOT a new money
      // movement (e.g. CC EMI conversion notices — see GENERIC_CC_EMI_CONVERSION
      // below). Without this, such messages had no way to signal "I
      // understood this, it's just not a transaction" and fell through to
      // Haiku escalation on every single occurrence.
      if (fields.discard_reason) {
        return { discard: true, reason: fields.discard_reason, rule: rule.id };
      }

      const result = {
        matched_rule:            rule.id,
        bank:                    fields.bank      || null,
        channel:                 fields.channel   || null,
        direction:               fields.direction || (rule.id.includes('CREDIT') ? 'credit' : 'debit'),
        amount:                  fields.amount    || null,
        account_number_masked:   fields.account_number_masked || null,
        txn_date:                fields.txn_date  || messageDate,
        merchant:                fields.merchant  || null,
        balance:                 fields.balance   ?? null,
        ref_number:              fields.ref_number || null,
        ref_type:                fields.ref_type   || null,
        confidence:              fields.confidence,
        possible_contra:         fields.possible_contra         || false,
        requires_classification: fields.requires_classification || false,
        vpa_type:                fields.vpa_type || null,
        escalate_to_haiku:       false,
      };

      if (result.amount === null || result.direction === null) {
        return null;
      }

      return result;
    }
  }

  return null;
}

module.exports = {
  matchMessage,
  extractAmount,
  extractDate,
  extractAccount,
  extractBank,
  extractChannel,
  extractMerchant,
  extractBenefitCardMerchant,
  extractBenefitCardChannel,
  extractRefNumber,
  extractBalance,
  classifyVpa,
  isPossibleSelfTransfer,
  RULES,
};
