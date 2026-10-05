/**
 * rules_source.js — the 30 Layer 2 rules as parse_rules rows.
 *
 * Source of truth for the seed migration (build_migration.js turns this
 * into SQL + JSON). Written with JS regex LITERALS and converted via
 * .source/.flags at build time, so no regex is ever hand-escaped into a
 * JSON/SQL string.
 *
 * match_patterns for the 23 rules whose bundled `pattern` is a plain
 * RegExp are NOT written here — build_migration.js reads them straight
 * from ruleset.js (FROM_BUNDLED). Only the 7 test() rules are transcribed.
 */

'use strict';

const rx = (r) => ({ re: r.source, flags: r.flags });
const re = (r, extra = {}) => ({ re: r.source, flags: r.flags, ...extra });
const num = (r) => re(r, { as: 'number' });
const helper = (name, extra = {}) => ({ helper: name, ...extra });
const value = (v) => ({ value: v });
const f = (...steps) => ({ steps });

const FROM_BUNDLED = Symbol('from bundled ruleset.js');

// Shared across the three vendor-notice rules.
const TRAILING_VENDOR_SIGNATURE = /-\s*([A-Za-z][A-Za-z .&]{2,30})\s*$/;
const BANK_SIDE_VERBS = /\b(?:credited|deposited|received|refunded|reversed|debited|deducted|withdrawn|spent|sent)\b/i;
const NO_REF = { ref_number: null, ref_type: null };

const RULE_ROWS = [
  {
    rule_key: 'GENERIC_DECLINED',
    // Bundled test(): reversed → false; negation → true; else declined regex.
    // = NOT reversed AND (negation OR declined).
    match_patterns: [
      rx(/\bno\s+(?:money|amount)\s+(?:has\s+been\s+)?(?:deducted|debited)\b|\bamount\s+not\s+debited\b|\bnot\s+been\s+debited\b/i),
      rx(/declined|txn.*fail|transaction.*fail|payment.*fail|could\s+not\s+be\s+processed/im),
    ],
    exclude_patterns: [rx(/\breversed\b|\breversal\s+of\b|\bhas\s+been\s+reversed\b/i)],
    fixed_fields: { direction: 'declined', confidence: 0.99 },
    field_overrides: {},
  },
  {
    rule_key: 'GENERIC_CC_EMI_CONVERSION',
    match_patterns: FROM_BUNDLED,
    // Bundled discard output carries no account/bank/balance for this rule.
    fixed_fields: { discard_reason: 'cc_emi_conversion_not_new_txn', account_number_masked: null, bank: null, balance: null },
    field_overrides: {},
  },
  {
    rule_key: 'BALANCE_ALERT_ONLY',
    match_patterns: [
      rx(/\bbalance\s+is\s+low\b/i),
      rx(/\bbal\s+is\b.{0,20}\bbelow\b/i),
      rx(/\bavailable\s+bal(?:ance)?\b.{0,80}\bis\b/i),
      rx(/\bminimum\s+balance\b/i),
    ],
    exclude_patterns: [
      rx(/\bdebited\b|\bcredited\b|\bdeducted\b|\bwithdrawn\b|\bwithdrawal\b|\bspent\b|\bpaid\b|\btransferred\b|\breceived\b|\brefunded\b|\bdisbursed\b|\bNEFT\b|\bIMPS\b|\bRTGS\b|\bUPI\b|\bEMI\b/i),
    ],
    fixed_fields: { discard_reason: 'balance_disclosure_no_transaction' },
    field_overrides: { balance: f(helper('extractAmount')) },
  },
  {
    rule_key: 'GENERIC_CC_SPEND_TXN',
    match_patterns: [
      rx(/Txn\s+Rs\.[\d,]+.*On\s+\w[\w\s]+Bank\s+Card\s+\d{4}/is),
      rx(/Spent\s+Rs\.[\d,]+\s+On\s+\w[\w\s]+Bank\s+Card\s+\d{4}/i),
      rx(/Paid\s+(?:USD|GBP|EUR|SGD|AED|JPY|AUD|CAD)\s*[\d,.]+.*On\s+\w[\w\s]+Bank\s+Card\s+\d{4}/is),
    ],
    fixed_fields: { direction: 'debit', channel: 'Credit Card', balance: null, possible_contra: false, confidence: 0.88 },
    field_overrides: {
      amount: f(
        num(/(?:Txn|Spent)\s+Rs\.([\d,]+(?:\.\d{1,2})?)/i),
        num(/Paid\s+(?:USD|GBP|EUR|SGD|AED|JPY|AUD|CAD)\s*([\d,]+(?:\.\d{1,2})?)/i),
        helper('extractAmount'),
      ),
      account_number_masked: f(re(/Card\s+(\d{4})\b/i), helper('extractAccount')),
      txn_date: f(
        helper('extractDate'),
        re(/\bOn\s+(\d{1,2})-(\d{2})\b/i, { as: 'date_dm_envelope_year' }),
      ),
      merchant: {
        steps: [re(/\bAt\s+(.{2,40}?)(?:\s*\n|\s+by\s+UPI|\s+On\s+\d|\s+Not\s+You)/i)],
        // Random UPI QR id (q + 9 digits @handle) is not a merchant.
        null_if: [rx(/^q\d{9}[a-z0-9.]*@[a-z]+$/i)],
      },
      ref_number: f(re(/by\s+UPI\s+(\d{12})\b/i)),
      ref_type: f({ lookup: 'ref_number', default: 'upi_rrn' }),
    },
  },
  {
    rule_key: 'GENERIC_CC_PAYMENT',
    match_patterns: FROM_BUNDLED,
    fixed_fields: { direction: 'debit', channel: 'Net Banking', merchant: null, balance: null, possible_contra: true, confidence: 0.90 },
    field_overrides: {
      amount: f(num(/(?:[Pp]aid|[Pp]ayment\s+of)\s+(?:Rs\.?|INR)\s*([\d,]+(?:\.\d{1,2})?)/i), helper('extractAmount')),
    },
  },
  {
    rule_key: 'PLUXEE_SPEND',
    match_patterns: FROM_BUNDLED,
    fixed_fields: { direction: 'debit', bank: null, ...NO_REF, possible_contra: false, confidence: 0.88 },
    field_overrides: {
      amount: f(num(/Rs\.?\s*([\d,]+(?:\.\d{1,2})?)\s+spent\s+from/i), helper('extractAmount')),
      merchant: f(helper('extractBenefitCardMerchant')),
      channel: f(helper('extractBenefitCardChannel')),
      account_number_masked: f(re(/card\s+no\.?\s*[xX*]{0,4}(\d{4})\b/i)),
      requires_classification: f({ lookup: 'merchant', null_value: true, default: false }),
    },
  },
  {
    rule_key: 'PLUXEE_CREDIT',
    match_patterns: FROM_BUNDLED,
    fixed_fields: {
      direction: 'credit', bank: null, channel: 'Wallet', account_number_masked: null, merchant: null,
      ...NO_REF, possible_contra: true, requires_classification: false, confidence: 0.88,
    },
    field_overrides: {
      amount: f(num(/credited\s+with\s+Rs\.?\s*([\d,]+(?:\.\d{1,2})?)/i), helper('extractAmount')),
    },
  },
  {
    rule_key: 'NCMC_LOAD',
    match_patterns: FROM_BUNDLED,
    fixed_fields: {
      direction: 'debit', channel: 'Card', merchant: null, ...NO_REF,
      possible_contra: true, requires_classification: false, confidence: 0.88,
    },
    field_overrides: {
      amount: f(num(/loaded\s+with\s+Rs\.?\s*([\d,]+(?:\.\d{1,2})?)/i), helper('extractAmount')),
      account_number_masked: f(re(/\d{6}[X*]+(\d{4})/i), helper('extractAccount')),
    },
  },
  {
    rule_key: 'GENERIC_WALLET_SPEND',
    match_patterns: FROM_BUNDLED,
    fixed_fields: { direction: 'debit', bank: null, channel: 'Wallet', possible_contra: false, confidence: 0.85 },
    field_overrides: {
      merchant: {
        steps: [
          re(/paid\s+to\s+(.{2,40}?)\s+from\s+your\b/i),
          re(/\bat\s+(.{2,40}?)(?:\s*\n|\s+[Oo]n\s+\d|\s+[Nn]ot\s+[Yy]ou|$)/i),
          helper('extractMerchant'),
        ],
        // 'A.in' is Amazon.in abbreviated in Apay/Pine Labs POS SMS.
        rewrite: [{ ...rx(/^a\.in\.?$/i), value: 'Amazon.in' }],
      },
    },
  },
  {
    rule_key: 'GENERIC_NETBANKING_PAYMENT',
    match_patterns: FROM_BUNDLED,
    fixed_fields: { direction: 'debit', channel: 'Net Banking', possible_contra: false, confidence: 0.85 },
    field_overrides: { merchant: f(re(/\bto\s+(.{3,50}?)\s+via\s+/i)) },
  },
  {
    rule_key: 'GENERIC_NACH',
    match_patterns: [rx(/\bNACH\b|\bUMRN\b|\bmandate\b|\bstanding instruction\b|\bECS\b|\bauto.?pay\b/im)],
    exclude_patterns: [rx(/^UPI Mandate:/im)],
    // direction was implicit in bundled code (rule id has no 'CREDIT' → debit).
    fixed_fields: { direction: 'debit', channel: 'NACH', possible_contra: false, confidence: 0.85 },
    field_overrides: {},
  },
  {
    rule_key: 'MUTUAL_FUND_SIP_BILL',
    match_patterns: FROM_BUNDLED,
    fixed_fields: { direction: 'debit', channel: 'NACH', possible_contra: false, confidence: 0.85 },
    field_overrides: {
      merchant: f(re(/\b(?:Bill payment|Processed payment)\s+of\s+(?:INR|Rs\.?)\s*[\d,]+(?:\.\d{1,2})?\s+for\s+(.+?)(?:\s+is\s+scheduled\s+for|\s+with\s+ref\s+no\.|\.|$)/i)),
    },
  },
  {
    rule_key: 'GENERIC_PPF_SSY',
    match_patterns: FROM_BUNDLED,
    fixed_fields: { direction: 'debit', channel: 'NEFT', merchant: 'PPF-SSY Account', possible_contra: true, confidence: 0.92 },
    field_overrides: {},
  },
  {
    rule_key: 'LOAN_DISBURSEMENT',
    match_patterns: FROM_BUNDLED,
    fixed_fields: { direction: 'credit', merchant: 'Loan Disbursement', possible_contra: false, confidence: 0.9 },
    field_overrides: {},
  },
  {
    rule_key: 'CHEQUE_CLEARED_DEBIT',
    match_patterns: FROM_BUNDLED,
    fixed_fields: { direction: 'debit', channel: 'Cheque', possible_contra: false, confidence: 0.85 },
    field_overrides: {
      merchant: f(re(/cheque\s+no[.\s]+(\d+)/i, { template: 'Cheque #{1}' })),
      ref_number: f(re(/cheque\s+no[.\s]+(\d+)/i)),
      ref_type: f({ lookup: 'ref_number', default: 'cheque_number' }),
    },
  },
  {
    rule_key: 'CARD_POS_USED_FOR',
    match_patterns: FROM_BUNDLED,
    fixed_fields: { direction: 'debit', channel: 'Card', possible_contra: false, confidence: 0.85 },
    field_overrides: { merchant: f(re(/\bat\s+(.{2,40}?)(?:\s+on\s+\d|\s*\.|\s*$)/i)) },
  },
  {
    rule_key: 'GENERIC_CHARGED',
    match_patterns: FROM_BUNDLED,
    fixed_fields: { direction: 'debit', possible_contra: false, confidence: 0.82 },
    field_overrides: {
      merchant: f(re(/charged\s+for\s+your\s+(.{2,40}?)(?:\s+on\s+\d|\.|$)/i), helper('extractMerchant')),
    },
  },
  {
    rule_key: 'CASH_DEPOSIT',
    match_patterns: FROM_BUNDLED,
    fixed_fields: { direction: 'credit', merchant: 'Cash Deposit', possible_contra: true, confidence: 0.85 },
    field_overrides: { channel: f({ test: rx(/\bATM\b|\bCDM\b/i), value: 'ATM' }, value('Cash')) },
  },
  {
    rule_key: 'WALLET_LOAD',
    match_patterns: FROM_BUNDLED,
    fixed_fields: { direction: 'credit', channel: 'Wallet', possible_contra: true, confidence: 0.85 },
    field_overrides: {
      merchant: f(
        re(/added\s+to\s+your\s+(.{2,30}?)\s+(?:wallet|balance)/i, { template: '{1} Wallet Load' }),
        re(/added\s+to\s+your\s+(.{2,30}?)\s+on\s+\d/i, { template: '{1} Wallet Load' }),
        value('Wallet Load'),
      ),
    },
  },
  {
    rule_key: 'GENERIC_PAID_TO',
    match_patterns: FROM_BUNDLED,
    fixed_fields: { direction: 'debit', confidence: 0.82 },
    field_overrides: {
      merchant: f(
        re(/\bto\s+([A-Za-z][A-Za-z .]{2,40}?)\s+(?:using|from|on|via)\b/i),
        re(/\bpaid\s+for\s+(.{2,40}?)\s+(?:renewal|membership|on\s+\d)/i),
        re(/\bpaid\s+at\s+(.{2,40}?)\s+(?:via|on\s+\d)/i),
        re(/\bparking\s+at\s+(.{2,40}?)\s+via\b/i),
        re(/^Your\s+(.{2,30}?)\s+(?:electricity|gas|water|mobile|broadband)?\s*bill\b/i),
      ),
      ref_number: f(re(/UPI\s+transaction\s+ID\s*[:\s]*(\d{8,})/i), helper('refNumber')),
      ref_type: f({ test: rx(/UPI\s+transaction\s+ID\s*[:\s]*(\d{8,})/i), value: 'upi_rrn' }, helper('refType')),
      possible_contra: f(helper('isPossibleSelfTransfer')),
    },
  },
  {
    rule_key: 'GENERIC_PURCHASE_CONFIRMATION',
    match_patterns: FROM_BUNDLED,
    fixed_fields: { direction: 'debit', bank: null, balance: null, ...NO_REF, possible_contra: false, confidence: 0.75 },
    field_overrides: {
      merchant: f(
        re(/^([A-Za-z][A-Za-z0-9 ]{2,30}?):/),
        re(/paid\s+via\s+(\w+)/i),
        re(/for\s+your\s+(\w+)\s+order/i),
        re(/^(\w+)\s+(?:DTH|Mobile)\s+Recharge/i),
        re(/Rs\.?[\d,]+(?:\.\d{1,2})?\s+([A-Za-z][A-Za-z0-9 ]{2,30}?)\s+Gift\s+Card/i),
        re(/^([A-Za-z][A-Za-z0-9 ]{2,30}?)\s+Smart\s+Card\s+recharged/i),
        re(/\bvia\s+([A-Za-z][A-Za-z0-9 ]{2,30}?)\s+on\s+\d/i),
      ),
    },
  },
  {
    rule_key: 'DEMAND_DRAFT_ISSUED',
    match_patterns: FROM_BUNDLED,
    fixed_fields: { direction: 'debit', channel: 'DD', balance: null, possible_contra: false, confidence: 0.85 },
    field_overrides: {
      merchant: f(re(/demand\s+draft\s+no[.\s]+(\d+)/i, { template: 'Demand Draft #{1}' })),
      ref_number: f(re(/demand\s+draft\s+no[.\s]+(\d+)/i)),
      ref_type: f({ lookup: 'ref_number', default: 'dd_number' }),
    },
  },
  {
    rule_key: 'LEGACY_DR_CR_FORMAT',
    match_patterns: FROM_BUNDLED,
    fixed_fields: { channel: 'UPI', merchant: null, ...NO_REF, possible_contra: false, confidence: 0.8 },
    field_overrides: {
      direction: f(
        re(/\bAC\s+[Xx*]{1,4}\d{4}\s+(DR|CR)\s+RS\.?\s*\d/i, { map: { cr: 'credit', dr: 'debit' } }),
        value('debit'),
      ),
    },
  },
  {
    rule_key: 'COURIER_COD_PAYMENT',
    match_patterns: FROM_BUNDLED,
    fixed_fields: {
      direction: 'debit', bank: null, channel: 'Cash', account_number_masked: null,
      balance: null, ...NO_REF, possible_contra: false, confidence: 0.7,
    },
    field_overrides: { merchant: f(re(/^([A-Za-z][A-Za-z0-9 ]{2,20}?):/)) },
  },
  {
    rule_key: 'REFUND_INITIATED',
    match_patterns: FROM_BUNDLED,
    fixed_fields: { direction: 'credit', channel: 'Refund', balance: null, ...NO_REF, possible_contra: false, confidence: 0.6 },
    field_overrides: { merchant: f(re(/returned\s+(.{2,30}?)\s+order/i)) },
  },
  {
    rule_key: 'VENDOR_SETTLEMENT_NOTICE',
    // Bundled test(): NOT bank-verb AND settlement/payout AND processed.
    // The AND of two positives is one regex with a lookahead.
    match_patterns: [
      rx(/^(?=[\s\S]*\b(?:settlement|payout)\b)[\s\S]*(?:\bis\s+processed\b|\bhas\s+been\s+processed\b)/i),
    ],
    exclude_patterns: [rx(BANK_SIDE_VERBS)],
    fixed_fields: { direction: 'credit', channel: 'Vendor Settlement', balance: null, ...NO_REF, possible_contra: false, confidence: 0.5 },
    field_overrides: { merchant: f(re(TRAILING_VENDOR_SIGNATURE)) },
  },
  {
    rule_key: 'PROVISIONAL_CREDIT_NOTICE',
    match_patterns: [rx(/will\s+be\s+(?:credited|refunded|processed)/i)],
    fixed_fields: { direction: 'credit', channel: 'Provisional Credit', balance: null, ...NO_REF, possible_contra: false, confidence: 0.5 },
    field_overrides: { merchant: f(re(TRAILING_VENDOR_SIGNATURE)) },
  },
  {
    rule_key: 'PAYMENT_CONFIRMATION_NOTICE',
    match_patterns: [rx(/\bconfirm(?:ed)?\s+receipt\s+of\s+(?:Rs\.?|INR|₹)/i)],
    exclude_patterns: [rx(BANK_SIDE_VERBS)],
    fixed_fields: { direction: 'debit', channel: 'Payment Confirmation', balance: null, ...NO_REF, possible_contra: false, confidence: 0.5 },
    field_overrides: {
      merchant: f(
        re(TRAILING_VENDOR_SIGNATURE),
        re(/towards\s+([A-Za-z][A-Za-z0-9 .&]{2,40}?)(?:\s+proposal|\s+policy|,|\.|$)/i),
      ),
    },
  },
  {
    rule_key: 'GENERIC_DEBIT',
    match_patterns: FROM_BUNDLED,
    fixed_fields: { direction: 'debit', confidence: 0.80 },
    field_overrides: { possible_contra: f(helper('isPossibleSelfTransfer')) },
  },
  {
    rule_key: 'GENERIC_CREDIT',
    match_patterns: FROM_BUNDLED,
    fixed_fields: { direction: 'credit' },
    field_overrides: {
      _vpa: f(re(/from VPA\s+([\w.\-@]+)/i)),
      vpa_type: f(helper('classifyVpa', { input_field: '_vpa' })),
      merchant: {
        steps: [{ lookup: '_vpa' }, helper('extractMerchant')],
        null_if: [
          rx(/your\s+(credit\s+)?card\s+ending/i),
          rx(/YOUR\s+CREDIT\s+CARD\s+ENDING\s+WITH/i),
          rx(/your\s+rwallet/i),
          rx(/Meal\s+Wallet\s+on\s+/i),
        ],
      },
      requires_classification: f({ lookup: 'vpa_type', map: { person: true, unknown: true }, null_value: false, default: false }),
      possible_contra: f(helper('isPossibleSelfTransfer')),
      confidence: f({ lookup: 'vpa_type', map: { merchant: 0.85, person: 0.75 }, null_value: 0.80, default: 0.80 }),
    },
  },
];

module.exports = { RULE_ROWS, FROM_BUNDLED };