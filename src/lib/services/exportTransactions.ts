/**
 * src/lib/services/exportTransactions.ts
 * Location: apps/mobile/src/lib/services/exportTransactions.ts
 *
 * Builds an .xlsx of the user's synced transactions and hands it to the
 * native share sheet. Client-side generation (SheetJS) — no backend
 * involved, works off whatever's already in Supabase.
 *
 * [UPDATE — this pass] Three changes:
 *
 *   1. Per-tab summary block. Every sheet (both "All Transactions" and
 *      each per-account tab) now starts with a small summary — total
 *      credits, total debits, net, transaction count, date range, and
 *      how many still need review — before the transaction table below
 *      it. "All Transactions" summarizes everything in the export;
 *      each account tab summarizes ONLY that account's own rows, not the
 *      overall totals. Built via aoa_to_sheet() for the summary rows,
 *      then sheet_add_json() to append the transaction table starting
 *      right after — json_to_sheet() alone can't produce a header block
 *      before the column headers.
 *
 *   2. Calendar-year range, with year/month drill-down. The existing
 *      "Last 12 Months" preset is a ROLLING window from today (e.g. on
 *      Aug 18, covers Aug last year -> Aug this year) — genuinely useful
 *      for "recent activity," but NOT the same as "this calendar year"
 *      (Jan -> Aug) or a specific past year (e.g. all of 2025), which is
 *      what most people mean by "last year's report" for taxes/
 *      accounting. Added { kind: 'year', year } — 'YYYY', matched by
 *      txn_date prefix, so a past year naturally covers Jan-Dec and the
 *      current year naturally covers Jan through whatever's actually
 *      happened so far (no separate "is this the current year" branch
 *      needed — there's simply no future data to accidentally include).
 *      getAvailableExportYears()/getAvailableExportMonthsForYear() power
 *      a year-then-month drill-down in the UI, replacing the flat
 *      "every month that has data" list with something closer to a
 *      normal year/month dropdown pair.
 *
 *   3. Untracked-account exclusion is INHERITED, not reimplemented — this
 *      file calls fetchTransactions() (transactions.ts), which already
 *      excludes transactions on any account with is_active = false. No
 *      separate check needed here; confirmed by tracing the call chain,
 *      not assumed.
 *
 * Requires: xlsx (SheetJS). Already present: expo-file-system, expo-sharing.
 */
import * as XLSX from 'xlsx';
import { File, Paths } from 'expo-file-system';
import * as Sharing from 'expo-sharing';
import { fetchTransactions, type Transaction } from '@/lib/api/transactions';

const EXPORT_PAGE_SIZE = 500;

// Only these statuses represent transactions the user has actually
// reviewed or that are live in their feed — declined placeholders are
// already excluded by fetchTransactions() itself (parse_failure filter).
const EXPORT_STATUSES: Transaction['status'][] = [
  'approved', 'pending_review', 'user_reviewed', 'haiku_suggested',
];

export type ExportRange =
  | { kind: 'all' }
  | { kind: 'lastMonths'; months: 3 | 6 | 12 }
  | { kind: 'month'; month: string }  // 'YYYY-MM'
  | { kind: 'year'; year: string };   // 'YYYY'

/**
 * Fetches every synced transaction for the user, unfiltered by date.
 * Exported so sync.tsx can call this ONCE, cache the result, and reuse
 * it both to populate the year/month pickers and to run the actual
 * export — avoids re-fetching the full transaction set every time the
 * user opens the export panel or changes their selection.
 */
export async function fetchAllTransactionsForExport(): Promise<Transaction[]> {
  const all: Transaction[] = [];
  let page = 0;
  // eslint-disable-next-line no-constant-condition
  while (true) {
    const { transactions, totalCount } = await fetchTransactions({
      statuses: EXPORT_STATUSES,
      page,
      pageSize: EXPORT_PAGE_SIZE,
    });
    all.push(...transactions);
    if (all.length >= totalCount || transactions.length === 0) break;
    page += 1;
  }
  return all;
}

/** Distinct 'YYYY-MM' values present in the given transactions, newest
 * first. Still exported/used for the specific-month picker. */
export function getAvailableExportMonths(transactions: Transaction[]): string[] {
  const months = new Set<string>();
  for (const txn of transactions) {
    if (txn.txn_date) months.add(txn.txn_date.slice(0, 7));
  }
  return Array.from(months).sort().reverse();
}

/** Distinct 'YYYY' values present in the given transactions, newest
 * first — powers the year dropdown. */
export function getAvailableExportYears(transactions: Transaction[]): string[] {
  const years = new Set<string>();
  for (const txn of transactions) {
    if (txn.txn_date) years.add(txn.txn_date.slice(0, 4));
  }
  return Array.from(years).sort().reverse();
}

/** Distinct 'YYYY-MM' values for ONE specific year, in calendar order
 * (Jan first) — powers the month dropdown once a year is picked, so the
 * two read together top-to-bottom the way a normal date picker would. */
export function getAvailableExportMonthsForYear(transactions: Transaction[], year: string): string[] {
  const months = new Set<string>();
  for (const txn of transactions) {
    if (txn.txn_date?.startsWith(year)) months.add(txn.txn_date.slice(0, 7));
  }
  return Array.from(months).sort();
}

export function monthLabel(month: string): string {
  const [year, mon] = month.split('-').map(Number);
  return new Date(year, mon - 1, 1).toLocaleDateString('en-IN', { month: 'short', year: 'numeric' });
}

function filterByRange(transactions: Transaction[], range: ExportRange): Transaction[] {
  if (range.kind === 'all') return transactions;

  if (range.kind === 'month') {
    return transactions.filter(t => t.txn_date?.startsWith(range.month));
  }

  if (range.kind === 'year') {
    // Prefix match naturally covers Jan-Dec for a past year and Jan
    // through "whatever's happened so far" for the current year — no
    // separate current-year branch needed, since there's no future data
    // to accidentally include either way.
    return transactions.filter(t => t.txn_date?.startsWith(range.year));
  }

  // lastMonths — rolling window from today, not calendar-aligned (e.g.
  // "last 3 months" on Aug 17 includes mid-May onward, not just Jun/Jul/Aug).
  // Deliberately kept alongside the calendar-year option above — "recent
  // activity" and "this/that calendar year" are genuinely different
  // questions people ask for different reasons (spend review vs.
  // taxes/accounting).
  const cutoff = new Date();
  cutoff.setMonth(cutoff.getMonth() - range.months);
  const cutoffStr = cutoff.toISOString().slice(0, 10);
  return transactions.filter(t => t.txn_date && t.txn_date >= cutoffStr);
}

function toRow(txn: Transaction) {
  return {
    Date: txn.txn_date,
    Type: txn.type ?? '',
    Category: txn.category ?? '',
    'Sub-category': txn.sub_category ?? '',
    Merchant: txn.merchant ?? '',
    // Signed amount kept as-is (debit negative / credit positive) —
    // matches how `amount` is already stored and read everywhere else.
    Amount: txn.amount ?? '',
    Account: txn.accounts?.institution_name ?? '',
    'Account (masked)': txn.accounts?.account_number_masked ?? '',
    Status: txn.status,
    'Reference No.': txn.ref_number ?? '',
    Source: txn.source,
  };
}

/** Excel sheet names: max 31 chars, and can't contain : \ / ? * [ ].
 * Also must be unique within the workbook — the loop below dedupes by
 * appending a suffix if two accounts would otherwise collide. */
function sanitizeSheetName(name: string): string {
  return name.replace(/[:\\/?*[\]]/g, '-').slice(0, 31) || 'Account';
}

function accountLabel(txn: Transaction): string {
  const institution = txn.accounts?.institution_name;
  const masked = txn.accounts?.account_number_masked;
  if (institution && masked) return `${institution} ••${masked}`;
  if (institution) return institution;
  if (masked) return `••${masked}`;
  return 'Unknown Account';
}

interface TabSummary {
  label: string;
  totalCredits: number;
  totalDebits: number;
  transactionCount: number;
  dateRangeStart: string | null;
  dateRangeEnd: string | null;
}

/** Computes the summary block for one sheet's worth of transactions —
 * called once for the full export ("All Transactions") and once per
 * account, each time scoped to ONLY the rows going into that specific
 * sheet, never the workbook-wide totals. */
function computeSummary(transactions: Transaction[], label: string): TabSummary {
  let totalCredits = 0;
  let totalDebits = 0;
  let dateRangeStart: string | null = null;
  let dateRangeEnd: string | null = null;

  for (const txn of transactions) {
    const amount = txn.amount ?? 0;
    if (amount > 0) totalCredits += amount;
    else totalDebits += Math.abs(amount);

    if (txn.txn_date) {
      if (!dateRangeStart || txn.txn_date < dateRangeStart) dateRangeStart = txn.txn_date;
      if (!dateRangeEnd || txn.txn_date > dateRangeEnd) dateRangeEnd = txn.txn_date;
    }
  }

  return {
    label,
    totalCredits,
    totalDebits,
    transactionCount: transactions.length,
    dateRangeStart,
    dateRangeEnd,
  };
}

/** Turns a TabSummary into the raw rows a sheet's header block should
 * show — array-of-arrays, one row per [label, value] pair, ending in a
 * blank row so the transaction table below has clear visual separation. */
function summaryToRows(summary: TabSummary): (string | number)[][] {
  const periodText = summary.dateRangeStart && summary.dateRangeEnd
    ? (summary.dateRangeStart === summary.dateRangeEnd ? summary.dateRangeStart : `${summary.dateRangeStart} to ${summary.dateRangeEnd}`)
    : '—';

  const rows: (string | number)[][] = [
    [summary.label],
    [],
    ['Period', periodText],
    ['Transactions', summary.transactionCount],
    ['Total Credits (₹)', Math.round(summary.totalCredits * 100) / 100],
    ['Total Debits (₹)', Math.round(summary.totalDebits * 100) / 100],
  ];
  // [FIX] "Net (₹)" row removed entirely — was Total Credits minus Total
  // Debits across EVERY transaction regardless of Type, which conflates
  // real spending with investment outflow and loan repayment (an SIP debit
  // and a restaurant bill counted identically). A correct net figure needs
  // per-Type breakdown, which isn't reliable here either — any transaction
  // still pending_review has no Type assigned yet (see the blank Type
  // column for plenty of rows in a typical export), so even a Type-based
  // breakdown would be wrong for anything not yet reviewed. Rather than
  // show a number that reads as "you lost this much" when it isn't that,
  // don't show one — Total Credits/Debits alone are unambiguous.
  rows.push([]); // blank separator before the transaction table

  return rows;
}

/** Builds one sheet: summary block on top, transaction table below it. */
function buildSheetWithSummary(transactions: Transaction[], label: string): XLSX.WorkSheet {
  const summary = computeSummary(transactions, label);
  const summaryRows = summaryToRows(summary);

  const worksheet = XLSX.utils.aoa_to_sheet(summaryRows);
  XLSX.utils.sheet_add_json(worksheet, transactions.map(toRow), {
    origin: summaryRows.length, // append right after the summary block
  });
  return worksheet;
}

function buildWorkbook(transactions: Transaction[]): XLSX.WorkBook {
  const workbook = XLSX.utils.book_new();

  // "All Transactions" tab first — summary covers EVERYTHING in this
  // export, across every account, not any single one.
  const allSheet = buildSheetWithSummary(transactions, 'All Transactions — Summary');
  XLSX.utils.book_append_sheet(workbook, allSheet, 'All Transactions');

  // One tab per account — each summary scoped to ONLY that account's own
  // rows (computeSummary() is called fresh per group below, not shared
  // with the overall totals above).
  // [FIX] No longer creates a separate "Unassigned" tab for transactions
  // with no resolved account_id. Every export realistically has some of
  // these (see resolveAccountId()'s docblock in transactions.ts — a
  // broker settlement note, a refund SMS, etc. often just doesn't state
  // an account number), so treating it as its own account-style tab
  // overstates it as a real account. These rows are still fully present
  // in "All Transactions" above — only the redundant dedicated tab is
  // removed.
  const byAccount = new Map<string, { label: string; rows: Transaction[] }>();
  for (const txn of transactions) {
    if (!txn.account_id) continue;
    const key = txn.account_id;
    const label = accountLabel(txn);
    if (!byAccount.has(key)) byAccount.set(key, { label, rows: [] });
    byAccount.get(key)!.rows.push(txn);
  }

  const usedNames = new Set<string>(['All Transactions']);
  for (const { label, rows } of byAccount.values()) {
    let sheetName = sanitizeSheetName(label);
    // Guard against two accounts sanitizing to the same 31-char name
    // (e.g. two long institution names truncated identically).
    let suffix = 2;
    while (usedNames.has(sheetName)) {
      sheetName = sanitizeSheetName(`${label} (${suffix})`);
      suffix++;
    }
    usedNames.add(sheetName);

    const sheet = buildSheetWithSummary(rows, `${label} — Summary`);
    XLSX.utils.book_append_sheet(workbook, sheet, sheetName);
  }

  return workbook;
}

function filenameFor(range: ExportRange): string {
  const today = new Date().toISOString().slice(0, 10);
  if (range.kind === 'all') return `pileap_transactions_all_${today}.xlsx`;
  if (range.kind === 'month') return `pileap_transactions_${range.month}.xlsx`;
  if (range.kind === 'year') return `pileap_transactions_${range.year}.xlsx`;
  return `pileap_transactions_last${range.months}months_${today}.xlsx`;
}

/**
 * Builds and shares the .xlsx for the given range. Pass `preFetched` (the
 * result of fetchAllTransactionsForExport()) to skip a redundant network
 * round trip when the caller already has the full set cached — sync.tsx
 * does this since it also needs the full set to populate the year/month
 * pickers.
 */
export async function exportTransactionsToExcel(
  range: ExportRange,
  preFetched?: Transaction[],
): Promise<{ rowCount: number }> {
  const allTransactions = preFetched ?? await fetchAllTransactionsForExport();
  const transactions = filterByRange(allTransactions, range);

  if (transactions.length === 0) {
    return { rowCount: 0 };
  }

  const workbook = buildWorkbook(transactions);

  // 'array' output rather than 'buffer'/'base64' — avoids relying on a
  // Node Buffer polyfill and an extra base64-decode step. This is the
  // first binary write in this codebase; everything else so far only
  // wrote text (JSON strings) — confirm File.write(Uint8Array) behaves
  // as expected on your installed expo-file-system version if you
  // haven't already verified this in an earlier pass.
  const bytes = XLSX.write(workbook, { type: 'array', bookType: 'xlsx' }) as number[];
  const uint8 = new Uint8Array(bytes);

  const filename = filenameFor(range);
  const file = new File(Paths.cache, filename);
  file.write(uint8);

  if (await Sharing.isAvailableAsync()) {
    await Sharing.shareAsync(file.uri, {
      mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      dialogTitle: 'Export Transactions',
    });
  }

  return { rowCount: transactions.length };
}