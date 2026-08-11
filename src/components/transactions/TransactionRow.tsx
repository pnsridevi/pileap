/**
 * src/components/transactions/TransactionRow.tsx
 *
 * Single row in the Transactions tab.
 *
 * IMPORTANT: TransactionRowData is a display-simplified shape, NOT the raw
 * `transactions` row. The DB has no debit/credit column — `type` there is
 * Expense/Income/Investment/Liability/Asset (arch doc 5.3.6) and `amount` is
 * signed (5.3.4: positive = credit, negative = debit). Use
 * mapTransactionToRow() below to derive this shape from a real Transaction
 * before rendering — don't pass a raw DB row's `type` straight through.
 *
 * Badge logic stays sparse per the original design: a normal approved,
 * non-contra, unedited row shows NO badge — badges only appear when
 * something needs the user's attention (pending review, an edited-but-
 * unsubmitted draft, or a transfer waiting on confirmation).
 *
 * NOTE: date/currency formatting stays inline here rather than importing
 * from src/utils/currency.ts / date.ts, since I don't have those files'
 * exact export signatures in this pass. Swap formatAmount/formatDate below
 * for them if they already cover this — flagging so it isn't mistaken for
 * a considered choice to duplicate logic.
 */
import { useEffect, useState } from 'react';
import { Pressable, View, Text, StyleSheet, ActivityIndicator } from 'react-native';
import { colors, spacing, fontSize, fontWeight } from '@/constants/theme';
import { getCategory } from '@/constants/categories';
import { Badge } from '@/components/ui/Badge';
import {
  fetchTransactionById,
  confirmContraPair,
  confirmContraAgainstHistoryMatch,
  dismissContraPair,
  confirmDuplicate,
  dismissDuplicate,
  type Transaction,
} from '@/lib/api/transactions';

export interface TransactionRowData {
  id: string;
  txn_date: string;           // 'YYYY-MM-DD'
  // [FIX] Was `number`. `null` = a declined/failed-transaction placeholder
  // (buildDiscarded in smsParser.ts — amount was never captured because the
  // transaction itself never completed). Always positive when non-null;
  // direction comes from `type`.
  amount: number | null;
  // [FIX] Added 'declined' — was 'debit' | 'credit' only, which forced
  // mapTransactionToRow() to call Math.abs(null) and coerce a declined
  // transaction's amount to 0, then classify it as 'credit' (null < 0 is
  // false) — rendering it as a green "+₹0.00", i.e. fake incoming money.
  // See mapTransactionToRow() below and its render branch in TransactionRow.
  type: 'debit' | 'credit' | 'declined';
  category: string | null;
  sub_category: string | null;
  merchant: string | null;
  status: 'pending_review' | 'approved' | 'user_reviewed' | 'haiku_suggested';
  is_contra: boolean;
  possible_contra_of: string | null;
  // [ADD] Were sitting fully unused in this component despite being real,
  // already-written columns on the Transaction row (transactions.ts's
  // findDuplicateCandidate()/computeDuplicateConfidence() set them on
  // every insert that finds a same-account/date/amount candidate, and
  // confirmDuplicate()/dismissDuplicate() already exist to resolve them)
  // — the backend detection was firing silently with no UI ever reading
  // the result. See DuplicateResolutionRow below.
  possible_duplicate_of: string | null;
  duplicate_confidence: number | null;
  // Optional — not on the original shape, added for draft-workspace /
  // split display. Omit entirely for callers that don't need them.
  split_from_id?: string | null;
  added_late?: boolean;
  after_report_month?: string | null;
  // [ADD] Both were sitting unused on the real Transaction row this whole
  // time — raw_text was always selected via fetchTransactions()'s
  // select('*'), just never mapped into this display shape. resolved_from
  // needed a DB column + insert-payload fix first (see add_resolved_from.sql
  // and transactions.ts) since it was never persisted at all before now.
  // Both optional so draft-split-child rows (which aren't real DB rows and
  // don't have either) don't need to fake a value.
  raw_text?: string | null;
  resolved_from?: 'custom_category' | 'registered_fact' | null;
  // [ADD] Needed so qualifiesForRegisteredFact (below) can detect an
  // unresolved NACH-mandate debit without relying on category/sub_category
  // — see smsParser.ts's classify() and the change log there for why that
  // placeholder category was removed (it was corrupting health-module
  // scoring). Optional, same reasoning as raw_text/resolved_from above.
  parse_failure?: string | null;
  // [ADD] Last-4 account display, sourced from fetchTransactions()'s
  // embedded accounts join. Optional — omitted for draft split-child rows.
  // Distinguish two null-but-different cases at render time: `undefined`
  // (this caller never provided the field, e.g. a draft row) vs `null`
  // (a real transaction whose account genuinely isn't resolved — shows
  // "Account not identified" rather than nothing, per product decision:
  // an unresolved account is worth surfacing, not hiding, since it's a
  // real fact about the row, not an absence of a feature).
  account_last4?: string | null;
}

/** Bridges a real (signed-amount, taxonomy-typed) Transaction row into the
 * display shape this component expects. Put here rather than in the DB
 * layer — this is a view concern, not a data-fetching one. */
export function mapTransactionToRow(txn: Transaction): TransactionRowData {
  // [FIX] txn.amount is genuinely `number | null` at runtime (declined-
  // transaction placeholders — see the Transaction type fix in
  // transactions.ts). Check for null BEFORE calling Math.abs()/comparing
  // with `<`, instead of letting JS silently coerce null to 0.
  const isDeclined = txn.amount === null;
  return {
    id: txn.id,
    txn_date: txn.txn_date,
    amount: isDeclined ? null : Math.abs(txn.amount as number),
    type: isDeclined ? 'declined' : (txn.amount as number) < 0 ? 'debit' : 'credit',
    category: txn.category,
    sub_category: txn.sub_category,
    merchant: txn.merchant,
    status: txn.status,
    is_contra: txn.is_contra,
    possible_contra_of: txn.possible_contra_of,
    possible_duplicate_of: txn.possible_duplicate_of,
    duplicate_confidence: txn.duplicate_confidence,
    split_from_id: txn.split_from_id,
    added_late: txn.added_late,
    after_report_month: txn.after_report_month,
    raw_text: txn.raw_text,
    resolved_from: txn.resolved_from,
    parse_failure: txn.parse_failure,
    // [ADD] null (not undefined) when the joined account is missing or
    // account_number_masked itself is null — a real transaction with an
    // unresolved account, not a caller that omitted the field. See the
    // TransactionRowData docblock above for why that distinction matters
    // at render time.
    account_last4: txn.accounts?.account_number_masked ?? null,
  };
}

interface TransactionRowProps {
  transaction: TransactionRowData;
  /** Primary tap — wired to Edit in the Transactions tab. */
  onPress?: (transaction: TransactionRowData) => void;
  /** Secondary action link. Omit to hide (e.g. on draft split-child rows,
   * which aren't real rows yet and can't be split themselves). */
  onSplitPress?: (transaction: TransactionRowData) => void;
  /** True while this row has an unsaved draft edit pending page Submit
   * (arch doc 5.3.3). Shows an "Edited · pending submit" badge in place of
   * whatever status badge would otherwise show. */
  isEdited?: boolean;
  /** Called after a contra prompt (confirm/dismiss) so the parent can
   * refetch. Omit to hide the confirm/dismiss controls entirely (e.g. for
   * draft split-child rows). */
  onContraResolved?: () => void;
  /** [ADD] Called when the user taps "What's this?" on a row this
   * component determines qualifies for registered-fact resolution (see
   * qualifiesForRegisteredFact below). Omit to hide the callout entirely
   * — same optional-prop pattern as onSplitPress/onContraResolved, so
   * draft split-child rows (which pass neither) render with no
   * inline registration prompt regardless of their status/category. */
  onRegisterFactPress?: (transaction: TransactionRowData) => void;
  /** [ADD] Called after a duplicate prompt (confirm/dismiss) so the parent
   * can refetch — mirrors onContraResolved exactly. Omit to hide the
   * duplicate-resolution controls entirely (e.g. draft split-child rows,
   * which can't carry possible_duplicate_of in the first place). */
  onDuplicateResolved?: () => void;
}

/** Inline callout for rows qualifying for registered-fact resolution (see
 * qualifiesForRegisteredFact in TransactionRow). Deliberately a single
 * "What's this?" tap-through rather than inline dropdowns here — the
 * actual fields (loan category, lender, AMC, insurer) need real screen
 * space and a multi-step flow, which is what RegisterFactPrompt (a modal,
 * rendered by the parent) is for. This row's only job is to surface the
 * option without cluttering every generic-NACH row by default. */
function RegisterFactCallout({ onPress }: { onPress: () => void }) {
  return (
    <View style={styles.contraRow}>
      <Text style={styles.contraLabel}>Recurring payment — recognize this automatically next time?</Text>
      <Pressable onPress={onPress} hitSlop={8}>
        <Text style={styles.contraConfirm}>What's this?</Text>
      </Pressable>
    </View>
  );
}

function formatAmount(amount: number): string {
  return `₹${amount.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function formatDate(dateStr: string): string {
  const d = new Date(dateStr + 'T00:00:00');
  return d.toLocaleDateString('en-IN', { day: 'numeric', month: 'short' });
}

/** Contra confirm/dismiss controls, per arch doc 5.7 — a Tier 2/3 match is
 * "probable, pending confirmation," not automatic. Rendered below the main
 * row (outside the Pressable) so it doesn't interfere with row-tap-to-edit.
 * Does its own single-row lookup of the partner — table is small and page
 * size is 20, so the N+1 here is cheap and buys an accurate label instead
 * of a generic one. */
function ContraResolutionRow({ txn, onResolved }: { txn: TransactionRowData; onResolved: () => void }) {
  const [partner, setPartner] = useState<Transaction | null | 'loading'>('loading');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let cancelled = false;
    if (!txn.possible_contra_of) return;
    setPartner('loading');
    fetchTransactionById(txn.possible_contra_of).then((p) => { if (!cancelled) setPartner(p); });
    return () => { cancelled = true; };
  }, [txn.possible_contra_of]);

  if (!txn.possible_contra_of) return null;
  if (partner === 'loading') {
    return (
      <View style={styles.contraRow}>
        <Text style={styles.contraLabel}>Checking transfer match…</Text>
      </View>
    );
  }
  if (!partner) return null; // partner vanished (deleted/split) — nothing to resolve

  const isHistoryMatch = partner.status === 'user_reviewed';

  const handleConfirm = async () => {
    setBusy(true);
    try {
      if (isHistoryMatch) await confirmContraAgainstHistoryMatch(txn.id);
      else await confirmContraPair(txn.id, partner.id);
      onResolved();
    } finally {
      setBusy(false);
    }
  };

  const handleDismiss = async () => {
    setBusy(true);
    try {
      await dismissContraPair(txn.id);
      onResolved();
    } finally {
      setBusy(false);
    }
  };

  return (
    <View style={styles.contraRow}>
      <Text style={styles.contraLabel}>
        {isHistoryMatch
          ? 'Possible internal transfer — matching transaction already reviewed'
          : 'Possible internal transfer'}
      </Text>
      {busy ? (
        <ActivityIndicator size="small" color={colors.brand} />
      ) : (
        <View style={styles.contraActions}>
          <Pressable onPress={handleConfirm} hitSlop={8}>
            <Text style={styles.contraConfirm}>Confirm</Text>
          </Pressable>
          <Pressable onPress={handleDismiss} hitSlop={8}>
            <Text style={styles.contraDismiss}>Not a transfer</Text>
          </Pressable>
        </View>
      )}
    </View>
  );
}

/** [ADD] Duplicate confirm/dismiss controls — same shape and placement as
 * ContraResolutionRow above (its own row below the Pressable, doesn't
 * interfere with row-tap-to-edit), for the parallel case: transactions.ts's
 * findDuplicateCandidate()/computeDuplicateConfidence() already run on
 * every insert and set possible_duplicate_of/duplicate_confidence when a
 * same-account/date/amount candidate exists, but until now nothing in this
 * component read either field — the detection fired silently and the user
 * had no way to see or act on it (confirmed case: two ₹50 UPI credits from
 * the same person, each arriving as both an HDFC-templated SMS and an
 * SBI-templated SMS sharing one real UPI ref number — see the merchant
 * variant in computeDuplicateConfidence()'s own comments). Does its own
 * single-row lookup of the candidate, same N+1-is-cheap reasoning as
 * ContraResolutionRow. */
function DuplicateResolutionRow({ txn, onResolved }: { txn: TransactionRowData; onResolved: () => void }) {
  const [candidate, setCandidate] = useState<Transaction | null | 'loading'>('loading');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let cancelled = false;
    if (!txn.possible_duplicate_of) return;
    setCandidate('loading');
    fetchTransactionById(txn.possible_duplicate_of).then((c) => { if (!cancelled) setCandidate(c); });
    return () => { cancelled = true; };
  }, [txn.possible_duplicate_of]);

  if (!txn.possible_duplicate_of) return null;
  if (candidate === 'loading') {
    return (
      <View style={styles.duplicateRow}>
        <Text style={styles.duplicateLabel}>Checking for a duplicate…</Text>
      </View>
    );
  }
  if (!candidate) return null; // candidate vanished (deleted/split) — nothing to resolve

  // Label matches the confidence tiers computeDuplicateConfidence() actually
  // produces: 0.95 = exact ref_number match (near-certain), 0.6-0.9 =
  // merchant-similarity-scaled (probable), 0.3 = same amount/date/account
  // but ref_numbers explicitly differ (weak — flagged for the user's eyes,
  // not the system's confidence).
  const confidence = txn.duplicate_confidence ?? 0;
  const label =
    confidence >= 0.95
      ? 'Same reference number as the transaction below — almost certainly the same transfer, reported twice'
      : confidence >= 0.6
      ? 'Same date, amount, and a similar merchant name as another transaction — possible duplicate'
      : 'Same date and amount as another transaction, but reference numbers differ — probably separate, worth a quick check';

  const handleConfirm = async () => {
    setBusy(true);
    try {
      await confirmDuplicate(txn.id);
      onResolved();
    } finally {
      setBusy(false);
    }
  };

  const handleDismiss = async () => {
    setBusy(true);
    try {
      await dismissDuplicate(txn.id);
      onResolved();
    } finally {
      setBusy(false);
    }
  };

  return (
    <View style={styles.duplicateRow}>
      <Text style={styles.duplicateLabel}>{label}</Text>
      {busy ? (
        <ActivityIndicator size="small" color={colors.brand} />
      ) : (
        <View style={styles.contraActions}>
          <Pressable onPress={handleConfirm} hitSlop={8}>
            <Text style={styles.duplicateConfirm}>Yes, duplicate — remove this one</Text>
          </Pressable>
          <Pressable onPress={handleDismiss} hitSlop={8}>
            <Text style={styles.contraDismiss}>No, keep both</Text>
          </Pressable>
        </View>
      )}
    </View>
  );
}

export function TransactionRow({ transaction: txn, onPress, onSplitPress, isEdited, onContraResolved, onRegisterFactPress, onDuplicateResolved }: TransactionRowProps) {
  const category = getCategory(txn.category);
  const needsTransferConfirmation = !!txn.possible_contra_of && !txn.is_contra;

  // [ADD] Qualification for the RegisterFactPrompt callout below. Two
  // documented cases, both real:
  //   - debit: the generic NACH fallback label — smsParser.ts's own
  //     documented behavior when it can't classify a NACH debit at all
  //     ("labeled generically Recurring Payment / NACH Mandate ... always
  //     forced into pending_review, never silently auto-approved"). This
  //     is the primary, well-evidenced case registered_facts exists for.
  //   - credit: a fully unclassified incoming payment (no category at
  //     all) — the salary-confirmation case from the design doc. This
  //     half is an inference, not confirmed against a real persisted row
  //     shape the way the NACH case is — flag if unclassified credits
  //     actually land with some other placeholder category in practice.
  // Deliberately status === 'pending_review' only, not haiku_suggested —
  // a haiku_suggested row already has a real guess to review via
  // EditModal; registered_facts solves the "couldn't guess at all" case,
  // not the "here's a guess, confirm it" case.
  // [FIX] Previously also fired for any pending_review credit with no
  // category — that swept in P2P person-VPA transfers (structurally never
  // categorizable, never recurring in the registered_facts sense) and
  // vendor-settlement/provisional credits (awaiting bank-confirmation
  // reconciliation, may be soft-deleted once the real bank credit lands).
  // registered_facts only supports emi/sip/insurance_premium/salary — none
  // of those apply to an uncategorized credit as such; a genuine recurring
  // salary credit already gets auto-classified as Income/Salary by
  // classify() and so wouldn't hit `!txn.category` in the first place.
  // Scoped down to the one case the pipeline actually produces this
  // guess for: the NACH-fallback debit classification.
  // [FIX] Was matching txn.category === 'Recurring Payment' && sub_category
  // === 'NACH Mandate' — smsParser.ts's classify() no longer stamps that
  // placeholder onto unresolved mandate debits (it was corrupting Debt
  // Ratio/Investment Rate health-module scoring, which reads type/category
  // straight off this table). parse_failure === 'unresolved_mandate' is
  // now the signal: category/sub_category stay genuinely null until the
  // user answers this prompt or a registered_fact resolves it.
  const qualifiesForRegisteredFact =
    txn.status === 'pending_review' &&
    txn.type === 'debit' &&
    txn.parse_failure === 'unresolved_mandate';

  // [ADD] Raw SMS text, expanded by default specifically for pending_review
  // rows per the carry-forward requirement ("the review queue needs to
  // actually show pending_review rows with their raw SMS text visible") —
  // that's the case where seeing the original message actually matters,
  // to judge whether an auto-guess or a flagged-for-review row is correct.
  // Collapsed by default elsewhere so already-approved rows don't get
  // cluttered with a text block nobody asked to see. Toggleable either way.
  const [showRaw, setShowRaw] = useState(txn.status === 'pending_review' || txn.status === 'haiku_suggested');

  // [FIX] Added the 'declined' branch — previously `type` could only be
  // 'debit'/'credit', so a declined transaction (amount: null) fell through
  // to the 'debit' color/prefix behavior by accident of `!== 'credit'`,
  // AFTER already being miscategorized as 'credit' upstream in
  // mapTransactionToRow's old Math.abs(null)/`null < 0` logic. Now explicit.
  const amountColor = txn.is_contra
    ? colors.muted
    : txn.type === 'credit'
    ? colors.green
    : txn.type === 'declined'
    ? colors.muted
    : colors.dark;

  const amountPrefix = txn.type === 'credit' ? '+ ' : txn.type === 'declined' ? '' : '− ';

  // [ADD] Plain-language label for resolved_from — see add_resolved_from.sql
  // and the Transaction/TransactionRowData type changes. Only ever set for
  // rows that auto-resolved via one of the two "confirm once, forever"
  // mechanisms; ordinary regex-matched rows (the majority) have neither.
  const resolvedFromLabel =
    txn.resolved_from === 'custom_category'
      ? 'Matched your saved preference for this merchant'
      : txn.resolved_from === 'registered_fact'
      ? 'Matched a recurring payment you confirmed earlier'
      : null;

  return (
    <View>
      <Pressable
        onPress={() => onPress?.(txn)}
        style={({ pressed }) => [styles.row, pressed && styles.rowPressed]}
      >
        <View style={styles.leftCol}>
          {txn.is_contra ? (
            <Badge variant="transfer" label="Transfer" />
          ) : (
            <Badge color={category.color} label={category.label} />
          )}

          <Text style={styles.merchant} numberOfLines={1}>
            {/* [FIX] txn.merchant is also null on declined rows (nothing to
                extract from a failed-transaction SMS), so this used to fall
                through to category.label — which is ALSO null here, landing
                on getCategory()'s default label ("Uncategorized"). That's
                why every declined row in the same batch rendered as an
                identical, indistinguishable "Uncategorized" title. */}
            {txn.merchant ?? (txn.type === 'declined' ? 'Payment declined' : category.label)}
          </Text>

          <View style={styles.metaRow}>
            <Text style={styles.date}>{formatDate(txn.txn_date)}</Text>
            {txn.sub_category ? (
              <Text style={styles.subCategory} numberOfLines={1}>
                {' · '}{txn.sub_category}
              </Text>
            ) : null}
            {/* [ADD] account_last4 === undefined -> this caller never
                provided account data at all (e.g. a draft split-child
                row) -> render nothing. account_last4 === null -> a real
                transaction whose account genuinely couldn't be resolved
                (see this session's account_id-nullable fix) -> show that
                explicitly rather than silently omitting it, since "which
                account" being unknown is a real fact about the row worth
                surfacing, not something to hide. */}
            {txn.account_last4 !== undefined ? (
              <Text style={styles.metaTag} numberOfLines={1}>
                {' · '}{txn.account_last4 ?? 'Account not identified'}
              </Text>
            ) : null}
          </View>

          {resolvedFromLabel ? (
            <Text style={styles.resolvedFromTag}>✓ {resolvedFromLabel}</Text>
          ) : null}

          {txn.split_from_id ? <Text style={styles.metaTag}>Split from original transaction</Text> : null}
          {txn.added_late ? (
            <Text style={styles.metaTag}>Added late · after {txn.after_report_month} report</Text>
          ) : null}

          {txn.raw_text ? (
            <>
              <Pressable onPress={() => setShowRaw((v) => !v)} hitSlop={8} style={styles.splitLink}>
                <Text style={styles.splitLinkText}>{showRaw ? 'Hide original SMS' : 'View original SMS'}</Text>
              </Pressable>
              {showRaw ? (
                <View style={styles.rawTextBox}>
                  <Text style={styles.rawTextContent}>{txn.raw_text}</Text>
                </View>
              ) : null}
            </>
          ) : null}

          {onSplitPress && (
            <Pressable onPress={() => onSplitPress(txn)} hitSlop={8} style={styles.splitLink}>
              <Text style={styles.splitLinkText}>Split</Text>
            </Pressable>
          )}
        </View>

        <View style={styles.rightCol}>
          <Text style={[styles.amount, { color: amountColor }]}>
            {/* [FIX] Was `formatAmount(txn.amount)` unconditionally — threw
                nothing (JS is permissive) but formatAmount(null) would have
                produced "₹NaN" once amount could no longer silently be 0
                from mapTransactionToRow. txn.amount is genuinely null here
                for declined rows, so branch instead of formatting it. */}
            {txn.amount === null ? 'Declined' : `${amountPrefix}${formatAmount(txn.amount)}`}
          </Text>

          {isEdited ? (
            <Badge color={colors.brand} label="Edited · pending submit" />
          ) : txn.status === 'pending_review' ? (
            <Badge variant="pending" label="Pending Review" />
          ) : txn.status === 'haiku_suggested' ? (
            // [ADD] Per explicit product decision: haiku_suggested renders
            // as "Suggested" in the UI, not the raw status name — this is
            // a Haiku-guessed category awaiting confirmation, distinct from
            // pending_review's "couldn't classify at all, or amount is
            // large enough to double-check" reasons. Reusing the 'pending'
            // Badge variant since that's a value I've confirmed this
            // component already uses safely — if Badge.tsx has (or should
            // get) a visually distinct variant for "suggested," swap this
            // for that instead of adding a variant name I can't verify
            // exists.
            <Badge variant="pending" label="Suggested" />
          ) : needsTransferConfirmation ? (
            <Badge variant="transfer" label="Confirm transfer?" />
          ) : null}
        </View>
      </Pressable>

      {onContraResolved && needsTransferConfirmation && (
        <ContraResolutionRow txn={txn} onResolved={onContraResolved} />
      )}

      {/* [ADD] Independent of the contra/register-fact rows above — a row
          could in principle carry both possible_contra_of AND
          possible_duplicate_of (different questions: "is this a transfer
          between my own accounts?" vs "is this the same SMS/transfer
          reported twice?"), so this deliberately isn't an else-branch. */}
      {onDuplicateResolved && txn.possible_duplicate_of && (
        <DuplicateResolutionRow txn={txn} onResolved={onDuplicateResolved} />
      )}

      {onRegisterFactPress && qualifiesForRegisteredFact && (
        <RegisterFactCallout onPress={() => onRegisterFactPress(txn)} />
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  row: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'flex-start',
    paddingVertical: spacing.md,
    paddingHorizontal: spacing.md,
    borderBottomWidth: 1,
    borderBottomColor: colors.border2,
    backgroundColor: colors.white,
  },
  rowPressed: {
    backgroundColor: colors.surface,
  },
  leftCol: {
    flex: 1,
    gap: 4,
    paddingRight: spacing.sm,
  },
  rightCol: {
    alignItems: 'flex-end',
    gap: 4,
  },
  merchant: {
    fontSize: fontSize.md,
    fontWeight: fontWeight.semibold,
    color: colors.dark,
  },
  metaRow: {
    flexDirection: 'row',
    alignItems: 'center',
  },
  date: {
    fontSize: fontSize.xs,
    color: colors.muted,
  },
  subCategory: {
    fontSize: fontSize.xs,
    color: colors.muted,
  },
  metaTag: {
    fontSize: fontSize.xs,
    color: colors.muted,
  },
  resolvedFromTag: {
    fontSize: fontSize.xs,
    color: '#059669',
    fontWeight: fontWeight.medium,
  },
  rawTextBox: {
    marginTop: 4,
    padding: spacing.sm,
    borderRadius: 6,
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.border2,
  },
  rawTextContent: {
    fontSize: fontSize.xs,
    color: colors.mid,
    lineHeight: 16,
  },
  splitLink: {
    marginTop: 2,
  },
  splitLinkText: {
    fontSize: fontSize.xs,
    color: colors.brand,
    fontWeight: fontWeight.medium,
  },
  amount: {
    fontSize: fontSize.md,
    fontWeight: fontWeight.bold,
  },
  contraRow: {
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    backgroundColor: colors.brandLight,
    borderBottomWidth: 1,
    borderBottomColor: colors.border2,
    gap: 4,
  },
  contraLabel: {
    fontSize: fontSize.xs,
    color: colors.brandDark,
    fontWeight: fontWeight.medium,
  },
  contraActions: {
    flexDirection: 'row',
    gap: spacing.md,
  },
  contraConfirm: {
    fontSize: fontSize.xs,
    fontWeight: fontWeight.semibold,
    color: colors.brand,
  },
  contraDismiss: {
    fontSize: fontSize.xs,
    fontWeight: fontWeight.medium,
    color: colors.muted,
  },
  // [ADD] Distinct background from contraRow (colors.red-tinted rather than
  // brand-tinted) so a duplicate warning doesn't visually read as the same
  // kind of prompt as a routine transfer-confirmation — this one's default
  // action (confirmDuplicate) soft-deletes a row, which is a heavier
  // consequence than confirming an internal transfer.
  duplicateRow: {
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    backgroundColor: '#FEF2F2',
    borderBottomWidth: 1,
    borderBottomColor: colors.border2,
    gap: 4,
  },
  duplicateLabel: {
    fontSize: fontSize.xs,
    color: colors.red,
    fontWeight: fontWeight.medium,
  },
  duplicateConfirm: {
    fontSize: fontSize.xs,
    fontWeight: fontWeight.semibold,
    color: colors.red,
  },
});