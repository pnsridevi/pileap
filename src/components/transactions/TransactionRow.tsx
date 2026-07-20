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
  status: 'pending_review' | 'approved' | 'user_reviewed';
  is_contra: boolean;
  possible_contra_of: string | null;
  // Optional — not on the original shape, added for draft-workspace /
  // split display. Omit entirely for callers that don't need them.
  split_from_id?: string | null;
  added_late?: boolean;
  after_report_month?: string | null;
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
    split_from_id: txn.split_from_id,
    added_late: txn.added_late,
    after_report_month: txn.after_report_month,
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
  /** Called after the user resolves a contra prompt (confirm/dismiss) so
   * the parent can refetch. Omit to hide the confirm/dismiss controls
   * entirely (e.g. for draft split-child rows). */
  onContraResolved?: () => void;
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

export function TransactionRow({ transaction: txn, onPress, onSplitPress, isEdited, onContraResolved }: TransactionRowProps) {
  const category = getCategory(txn.category);
  const needsTransferConfirmation = !!txn.possible_contra_of && !txn.is_contra;

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
          </View>

          {txn.split_from_id ? <Text style={styles.metaTag}>Split from original transaction</Text> : null}
          {txn.added_late ? (
            <Text style={styles.metaTag}>Added late · after {txn.after_report_month} report</Text>
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
          ) : needsTransferConfirmation ? (
            <Badge variant="transfer" label="Confirm transfer?" />
          ) : null}
        </View>
      </Pressable>

      {onContraResolved && needsTransferConfirmation && (
        <ContraResolutionRow txn={txn} onResolved={onContraResolved} />
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
});