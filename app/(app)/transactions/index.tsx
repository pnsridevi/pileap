/**
 * app/(app)/transactions/index.tsx
 *
 * Main Transactions tab (the "Feed" sub-tab per arch doc 10.3.2). Was empty.
 *
 * Data flow:
 *   - fetchTransactions({ statuses: ['pending_review','approved'], ... })
 *     for the Active feed — History (user_reviewed) is a separate screen,
 *     not built in this pass (not listed in the file inventory you gave me).
 *   - EditModal / SplitFlow only produce draft objects held in local state
 *     (draftEdits, draftSplits) — arch doc 5.3.3, nothing written until
 *     Submit.
 *   - Submit calls transactions.ts:submitTransactionPage(), which requires
 *     the submit_transaction_page RPC migration to be applied first (see
 *     supabase/migrations/submit_transaction_page.sql).
 *
 * State management: kept local (useState) rather than reaching into
 * src/store/transactionStore.ts, since I don't know that store's existing
 * shape and didn't want to guess-overwrite it. If it's meant to own this
 * screen's state, that's a follow-up wiring task.
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import { View, Text, FlatList, TouchableOpacity, StyleSheet, ActivityIndicator, RefreshControl } from 'react-native';
import { colors, radius, spacing, fontSize, fontWeight } from '@/constants/theme';
import { TransactionRow, mapTransactionToRow } from '@/components/transactions/TransactionRow';
import { EditModal } from '@/components/transactions/EditModal';
import { SplitFlow } from '@/components/transactions/SplitFlow';
import { Button } from '@/components/ui/Button';
import {
  fetchTransactions,
  fetchNeedsReviewCount,
  hasAnyTransactions,
  submitTransactionPage,
  type Transaction,
  type TransactionEdit,
  type TransactionSplit,
} from '@/lib/api/transactions';
import { TAXONOMY, TxnType } from '@/constants/transactionTaxonomy';

const PAGE_SIZE = 20;
type StatusFilter = 'all' | 'review';

export default function TransactionsFeedScreen() {
  const [rows, setRows] = useState<Transaction[]>([]);
  const [totalCount, setTotalCount] = useState(0);
  const [needsReviewCount, setNeedsReviewCount] = useState(0);
  const [hasAny, setHasAny] = useState<boolean | null>(null); // null = not yet known
  const [page, setPage] = useState(0);
  const [statusFilter, setStatusFilter] = useState<StatusFilter>('all');
  const [categoryFilter, setCategoryFilter] = useState<string>('all');
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [submitting, setSubmitting] = useState(false);

  // Draft workspace — nothing here is written to Supabase until Submit.
  const [draftEdits, setDraftEdits] = useState<Record<string, TransactionEdit>>({});
  const [draftSplits, setDraftSplits] = useState<Record<string, TransactionSplit>>({});

  const [editingTxn, setEditingTxn] = useState<Transaction | null>(null);
  const [splittingTxn, setSplittingTxn] = useState<Transaction | null>(null);

  const allCategories = useMemo(
    () => Object.values(TAXONOMY).flat().map((c) => c.category),
    [],
  );

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [feed, reviewCount, any] = await Promise.all([
        fetchTransactions({
          statuses: ['pending_review', 'approved'],
          category: categoryFilter === 'all' ? undefined : categoryFilter,
          page,
          pageSize: PAGE_SIZE,
        }),
        fetchNeedsReviewCount(),
        hasAnyTransactions(),
      ]);
      const filtered = statusFilter === 'review'
        ? feed.transactions.filter((t) => t.status === 'pending_review')
        : feed.transactions;
      setRows(filtered);
      setTotalCount(feed.totalCount);
      setNeedsReviewCount(reviewCount);
      setHasAny(any);
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, [page, statusFilter, categoryFilter]);

  useEffect(() => { load(); }, [load]);

  const onRefresh = () => { setRefreshing(true); load(); };

  // Rows as actually rendered: edited rows show their draft values inline,
  // and a split original is replaced by its (not-yet-real) draft children.
  const displayRows = useMemo(() => {
    const out: { txn: Transaction; isEdited: boolean; isDraftSplitChild: boolean }[] = [];
    for (const row of rows) {
      const split = draftSplits[row.id];
      if (split) {
        split.lines.forEach((line, i) => {
          out.push({
            txn: {
              ...row,
              id: `draft-split-${row.id}-${i}`,
              amount: line.amount,
              type: line.type,
              category: line.category,
              sub_category: line.sub_category ?? null,
              merchant: line.merchant ?? row.merchant,
              split_from_id: row.id,
              status: row.status,
            },
            isEdited: false,
            isDraftSplitChild: true,
          });
        });
        continue;
      }
      const edit = draftEdits[row.id];
      out.push({
        txn: edit ? { ...row, ...edit, sub_category: edit.sub_category ?? row.sub_category } : row,
        isEdited: !!edit,
        isDraftSplitChild: false,
      });
    }
    return out;
  }, [rows, draftEdits, draftSplits]);

  const totalPages = Math.max(1, Math.ceil(totalCount / PAGE_SIZE));
  const hasDraftChanges = Object.keys(draftEdits).length > 0 || Object.keys(draftSplits).length > 0;

  const handleSaveEdit = (edit: TransactionEdit, _saveCustomCategory: boolean) => {
    setDraftEdits((prev) => ({ ...prev, [edit.id]: edit }));
    setEditingTxn(null);
    // _saveCustomCategory intentionally unused past this point — see
    // EditModal.tsx docblock / transactions.ts KNOWN GAPS #8.
  };

  const handleSubmitSplit = (split: TransactionSplit) => {
    setDraftSplits((prev) => ({ ...prev, [split.originalId]: split }));
    setSplittingTxn(null);
  };

  const handleSubmitPage = async () => {
    if (!hasDraftChanges && rows.length === 0) return;
    setSubmitting(true);
    try {
      await submitTransactionPage({
        pageTransactionIds: rows.map((r) => r.id),
        edits: Object.values(draftEdits),
        splits: Object.values(draftSplits),
      });
      setDraftEdits({});
      setDraftSplits({});
      await load();
    } finally {
      setSubmitting(false);
    }
  };

  if (hasAny === false) {
    return (
      <View style={styles.container}>
        <EmptyState
          title="No transactions yet"
          subtitle="Connect a data source or upload past bank statements to see your transactions here."
        />
      </View>
    );
  }

  if (hasAny === true && !loading && totalCount === 0 && needsReviewCount === 0 && rows.length === 0) {
    return (
      <View style={styles.container}>
        <EmptyState
          title="All transactions reviewed"
          subtitle="Every transaction has been confirmed. View your Transaction History to see past activity."
        />
      </View>
    );
  }

  return (
    <View style={styles.container}>
      <View style={styles.headerRow}>
        <Text style={styles.headerCount}>
          {totalCount} transactions this month · <Text style={styles.headerCountStrong}>{needsReviewCount} need review</Text>
        </Text>
      </View>

      <View style={styles.filterRow}>
        <FilterChip label="All" active={statusFilter === 'all'} onPress={() => { setStatusFilter('all'); setPage(0); }} />
        <FilterChip label="Needs review" active={statusFilter === 'review'} onPress={() => { setStatusFilter('review'); setPage(0); }} />
        <FilterChip label="All categories" active={categoryFilter === 'all'} onPress={() => { setCategoryFilter('all'); setPage(0); }} />
      </View>

      <View style={styles.banner}>
        <Text style={styles.bannerText}>
          Transactions ≥ ₹5,000 always need review, regardless of source. Tap Edit to correct any row, then Submit
          to save your changes for this page.
        </Text>
      </View>

      <FlatList
        data={displayRows}
        keyExtractor={(item) => item.txn.id}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} />}
        contentContainerStyle={{ paddingBottom: spacing.xl }}
        ListEmptyComponent={
          loading ? (
            <ActivityIndicator color={colors.brand} style={{ marginTop: spacing.xl }} />
          ) : (
            <Text style={styles.emptyFilterText}>No transactions match this filter.</Text>
          )
        }
        renderItem={({ item }) => (
          <TransactionRow
            transaction={mapTransactionToRow(item.txn)}
            isEdited={item.isEdited}
            onPress={item.isDraftSplitChild ? undefined : () => setEditingTxn(item.txn)}
            onSplitPress={item.isDraftSplitChild ? undefined : () => setSplittingTxn(item.txn)}
            onContraResolved={item.isDraftSplitChild ? undefined : load}
          />
        )}
      />

      <View style={styles.footer}>
        <Text style={styles.pageInfo}>Page {page + 1} of {totalPages}</Text>
        <View style={styles.footerActions}>
          <Button
            label="← Previous"
            variant="ghost"
            size="sm"
            disabled={page <= 0}
            onPress={() => setPage((p) => Math.max(0, p - 1))}
          />
          <Button
            label="Next →"
            variant="ghost"
            size="sm"
            disabled={page >= totalPages - 1}
            onPress={() => setPage((p) => Math.min(totalPages - 1, p + 1))}
          />
          <Button
            label="Submit Changes"
            variant="primary"
            size="sm"
            loading={submitting}
            disabled={rows.length === 0}
            onPress={handleSubmitPage}
          />
        </View>
      </View>

      <EditModal
        visible={!!editingTxn}
        transaction={editingTxn}
        onCancel={() => setEditingTxn(null)}
        onSave={handleSaveEdit}
      />
      <SplitFlow
        visible={!!splittingTxn}
        transaction={splittingTxn}
        onCancel={() => setSplittingTxn(null)}
        onSubmit={handleSubmitSplit}
      />
    </View>
  );
}

function FilterChip({ label, active, onPress }: { label: string; active: boolean; onPress: () => void }) {
  return (
    <TouchableOpacity onPress={onPress} style={[chipStyles.chip, active && chipStyles.chipActive]}>
      <Text style={[chipStyles.text, active && chipStyles.textActive]}>{label}</Text>
    </TouchableOpacity>
  );
}

function EmptyState({ title, subtitle }: { title: string; subtitle: string }) {
  return (
    <View style={styles.emptyState}>
      <Text style={styles.emptyTitle}>{title}</Text>
      <Text style={styles.emptySubtitle}>{subtitle}</Text>
    </View>
  );
}

const chipStyles = StyleSheet.create({
  chip: {
    paddingHorizontal: spacing.sm,
    paddingVertical: spacing.xs,
    borderRadius: radius.full,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.white,
  },
  chipActive: { backgroundColor: colors.brand, borderColor: colors.brand },
  text: { fontSize: fontSize.xs, color: colors.mid, fontWeight: fontWeight.medium },
  textActive: { color: colors.white },
});

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.surface, padding: spacing.md },
  headerRow: { marginBottom: spacing.sm },
  headerCount: { fontSize: fontSize.sm, color: colors.muted },
  headerCountStrong: { color: colors.dark, fontWeight: fontWeight.semibold },
  filterRow: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.xs, marginBottom: spacing.sm },
  banner: {
    backgroundColor: colors.amberLight,
    borderWidth: 1,
    borderColor: '#FCD34D',
    borderRadius: radius.md,
    padding: spacing.sm,
    marginBottom: spacing.md,
  },
  bannerText: { fontSize: fontSize.xs, color: '#92400E' },
  emptyFilterText: { textAlign: 'center', color: colors.muted, fontSize: fontSize.sm, marginTop: spacing.xl },
  footer: {
    borderTopWidth: 1,
    borderTopColor: colors.border,
    paddingTop: spacing.sm,
  },
  pageInfo: { fontSize: fontSize.xs, color: colors.muted, marginBottom: spacing.xs },
  footerActions: { flexDirection: 'row', gap: spacing.sm, justifyContent: 'flex-end' },
  emptyState: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    padding: spacing.xl,
  },
  emptyTitle: { fontSize: fontSize.lg, fontWeight: fontWeight.bold, color: colors.dark, marginBottom: spacing.xs },
  emptySubtitle: { fontSize: fontSize.sm, color: colors.muted, textAlign: 'center', maxWidth: 320, lineHeight: 20 },
});