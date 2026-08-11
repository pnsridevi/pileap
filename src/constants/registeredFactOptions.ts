/**
 * src/constants/registeredFactOptions.ts
 *
 * Dropdown option lists for RegisterFactPrompt.tsx — the contextual "what
 * is this recurring debit?" card shown for pending_review rows the parser
 * couldn't classify (generic NACH debits, ambiguous broker platforms).
 * Sourced directly from the same lender/AMC/insurer rosters already
 * committed into smsParser.ts's TAXONOMY regex patterns, not invented
 * independently — per the explicit design requirement that this list and
 * the regex patterns must stay in exact sync, or a registered fact could
 * point at a name the regex doesn't recognize. Same failure class as the
 * categories.ts/transactionCategories.ts/transactionTaxonomy.ts three-way
 * mismatch this codebase already hit once and fixed.
 *
 * [FLAG — scope not fully closed out] Which modules genuinely need
 * registered-fact resolution was raised mid-design as needing a pass
 * against the scoring reality-check doc, and that pass was never finished
 * — the doc wasn't available in that session. What ships here matches
 * what actually got built into smsParser.ts/registeredFacts.ts (the 4
 * fact_type values in registered_facts' CHECK constraint: emi, sip,
 * insurance_premium, salary), not a fresh re-derivation from the
 * reality-check doc. Revisit if that doc turns up a 5th case or rules one
 * of these out.
 */

export interface LoanCategoryOption {
  /** Shown to the user. */
  label: string;
  /** Written as resolved_sub_category. Uses the exact spelling already
   * live in smsParser.ts's TAXONOMY (e.g. 'Auto Loan', not 'Car Loan') so
   * a registered fact and a regex-matched row can never disagree on the
   * category name for the same underlying thing. */
  subCategory: string;
  /** Debt Ratio's secured/unsecured weighting (scoring reality-check doc).
   * null for 'Other' — genuinely unknown, must be treated as unclassified
   * by the scoring layer, not silently defaulted to one side. */
  isSecuredDebt: boolean | null;
  /** Scoped dropdown, sourced from the taxonomy doc's lender lists. The UI
   * always appends an "Other / not listed" choice on top of this — not
   * stored here since it's free text, not a canonical name. */
  lenders: string[];
}

export const LOAN_CATEGORIES: LoanCategoryOption[] = [
  {
    label: 'Home',
    subCategory: 'Home Loan',
    isSecuredDebt: true,
    // [ADD — this pass] PNB Housing, Aavas, Indiabulls Housing — mirrors
    // smsParser.ts's TAXONOMY additions for this sub_category. Bajaj
    // Housing Finance was already listed here despite having no matching
    // regex pattern in smsParser.ts until this pass — now genuinely in
    // sync on both sides.
    lenders: ['LIC Housing Finance', 'ICICI Home Finance', 'HDFC', 'SBI', 'Axis Bank', 'Bajaj Housing Finance', 'PNB Housing', 'Aavas Financiers', 'Indiabulls Housing'],
  },
  {
    label: 'Personal',
    subCategory: 'Personal Loan',
    isSecuredDebt: false,
    // [ADD — this pass] Fibe (EarlySalary), PaySense, Slice, Kissht,
    // mPokket, Home Credit — mirrors smsParser.ts's TAXONOMY additions.
    lenders: ['Bajaj Finserv', 'Fullerton', 'IDFC First', 'Tata Capital', 'Navi', 'KreditBee', 'MoneyTap', 'CASHe', 'Fibe (EarlySalary)', 'PaySense', 'Slice', 'Kissht', 'mPokket', 'Home Credit'],
  },
  {
    label: 'Car',
    subCategory: 'Auto Loan',
    isSecuredDebt: true,
    // [ADD — this pass] Cholamandalam Finance — mirrors smsParser.ts.
    lenders: ['Sundaram Finance', 'Mahindra Finance', 'TVS Credit', 'Cholamandalam Finance'],
  },
  {
    label: 'Education',
    subCategory: 'Education Loan',
    isSecuredDebt: false,
    lenders: ['Avanse', 'HDFC Credila', 'Auxilo'],
  },
  {
    label: 'Gold',
    subCategory: 'Gold Loan',
    isSecuredDebt: true,
    lenders: ['Muthoot', 'Manappuram'],
  },
  {
    label: 'BNPL',
    subCategory: 'BNPL',
    isSecuredDebt: false,
    lenders: ['LazyPay', 'Simpl', 'ZestMoney', 'Amazon Pay Later'],
  },
  {
    label: 'Other',
    subCategory: 'Other Loan',
    isSecuredDebt: null,
    lenders: [],
  },
];

/** Mutual Funds > SIP — AMC direct-debit patterns + aggregator platforms.
 * Unlike brokers (Zerodha/Groww/...), an AMC only ever means mutual funds
 * — no "what do you use this for" ambiguity — so this is a flat list, not
 * nested like loans/insurance. */
export const SIP_PLATFORMS: string[] = [
  'HDFC MF', 'SBI MF', 'ICICI Prudential MF', 'Axis MF', 'Nippon India MF',
  'UTI MF', 'Kotak MF', 'Mirae Asset', 'Franklin Templeton', 'DSP',
  'Aditya Birla Sun Life MF', 'Parag Parikh', 'Quant MF',
  'Kuvera', 'ET Money', 'Zerodha Coin',
  // [ADD] Mirrors smsParser.ts's TAXONOMY additions — kept in sync per
  // this file's own docblock requirement. 'PPFAS' shown as its own label
  // since that's the abbreviation real bank SMS actually use, even though
  // it's the same AMC as 'Parag Parikh' above (Parag Parikh Financial
  // Advisory Services) — both entries route to the same underlying
  // category, listed separately here only so the dropdown matches what a
  // user will recognize from their own SMS.
  'Tata Mutual Fund', 'PGIM India', 'PPFAS',
];

export interface InsuranceTypeOption {
  label: string;
  /** Written as resolved_sub_category — see LoanCategoryOption's note on
   * why this must match smsParser.ts's TAXONOMY spelling exactly. */
  subCategory: string;
  insurers: string[];
}

export const INSURANCE_TYPES: InsuranceTypeOption[] = [
  {
    label: 'Life',
    subCategory: 'Life Insurance',
    insurers: [
      'LIC', 'HDFC Life', 'ICICI Prudential Life', 'SBI Life', 'Max Life',
      'Tata AIA', 'Bajaj Allianz Life', 'PNB MetLife', 'Kotak Life',
      'Aditya Birla Sun Life Insurance', 'Canara HSBC Life',
      'Star Union Dai-ichi', 'Future Generali Life',
    ],
  },
  {
    label: 'Health',
    subCategory: 'Health Insurance',
    insurers: [
      'Star Health', 'Niva Bupa', 'Care Health', 'HDFC Ergo Health',
      'ICICI Lombard Health', 'Aditya Birla Health', 'Reliance Health',
      'Manipal Cigna', 'Bajaj Allianz Health', 'National Insurance',
    ],
  },
  {
    label: 'Motor',
    subCategory: 'Motor Insurance',
    // [ADD — this pass] New India Assurance, Oriental Insurance, United
    // India Insurance, Reliance General — mirrors smsParser.ts's TAXONOMY
    // additions. Filed under Motor here for the same reason noted in
    // smsParser.ts: no separate General Insurance bucket exists yet, and
    // these public-sector insurers write mostly motor-policy premiums in
    // the real corpus.
    insurers: ['Tata AIG', 'Digit', 'Acko', 'Bajaj Allianz', 'ICICI Lombard', 'HDFC Ergo', 'New India Assurance', 'Oriental Insurance', 'United India Insurance', 'Reliance General'],
  },
  {
    label: 'Other',
    subCategory: 'Other Insurance',
    insurers: [],
  },
];

/** Sentinel value for "not in the dropdown" — the UI appends this as the
 * last chip in every list above; picking it reveals a free-text field
 * instead of storing this literal string as the entity name. */
export const OTHER_OPTION = 'Other / not listed';