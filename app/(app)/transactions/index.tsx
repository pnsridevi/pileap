/**
 * app/(app)/transactions/index.tsx
 *
 * Main Transactions tab (the "Feed" sub-tab per arch doc 10.3.2).
 *
 * [CHANGED — migration pass] Previously kept all state local (useState)
 * rather than reaching into src/store/transactionStore.ts + the sibling
 * src/hooks/useTransactionFeed.ts, since those files weren't in this
 * screen's original code path and their existing shape was unknown. Now
 * that useTransactionFeed's History branch is about to get a real second
 * screen, this migrates onto the shared store/hook rather than leaving two
 * divergent "fetch and paginate transactions" implementations in the repo —
 * one filter vocabulary, one pagination model, shared between Active and
 * History. See useTransactionFeed.ts's docblock for the two real bugs that
 * migration would have reintroduced (haiku_suggested invisibility, and the
 * hook's own lossy display-mapping breaking the edit/split flow) and how
 * they were fixed there before this file touched it.
 *
 * What stays local, deliberately:
 *   - needsReviewCount / hasAny: screen-level counts, not feed/pagination
 *     state, and not filtered by category or status the way the feed is —
 *     no reason for the hook to own them.
 *   - draftEdits / draftSplits / editingTxn / splittingTxn: page-scoped
 *     ephemeral UI state (arch doc 5.3.3 — nothing written until Submit).
 *     transactionStore holds filter selections shared across screens;
 *     an unsaved draft is not that, so it stays local here.
 *
 * Data flow (unchanged):
 *   - EditModal / SplitFlow only produce draft objects held in local state
 *     — arch doc 5.3.3, nothing written until Submit.
 *   - Submit calls transactions.ts:submitTransactionPage(), which requires
 *     the submit_transaction_page RPC migration to be applied first (see
 *     supabase/migrations/submit_transaction_page.sql).
 *
 * [ADD] ManageMenu — "⋯" icon next to SubTabs, added this session. Custom
 * Categories / Budget vs Actual / Accounts existed as route files with NO
 * way to navigate to them from the UI before this — see ManageMenu.tsx's
 * docblock. Added to all three render branches below (both empty-state
 * returns and the main return) so it's reachable regardless of whether
 * this screen currently has any transactions to show.
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import { useFocusEffect } from '@react-navigation/native';
import { View, Text, FlatList, TouchableOpacity, StyleSheet, ActivityIndicator, RefreshControl } from 'react-native';
import { useRouter } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { colors, radius, spacing, fontSize, fontWeight } from '@/constants/theme';
import { TransactionRow, mapTransactionToRow } from '@/components/transactions/TransactionRow';
import { EditModal } from '@/components/transactions/EditModal';
import { SplitFlow } from '@/components/transactions/SplitFlow';
import { RegisterFactPrompt } from '@/components/transactions/RegisterFactPrompt';
import { ManageMenu } from '@/components/transactions/ManageMenu';
// [ADD] "+" button — reaches the new Add Transaction screen (manual entry).
import { Button } from '@/components/ui/Button';
import { useTransactionFeed } from '@/hooks/useTransactionFeed';
import { useTransactionStore } from '@/store/transactionStore';
import {
  fetchNeedsReviewCount,
  hasAnyTransactions,
  submitTransactionPage,
  reconcilePendingTransactions,
  type Transaction,
  type TransactionEdit,
  type TransactionSplit,
} from '@/lib/api/transactions';
import { TAXONOMY, TxnType } from '@/constants/transactionTaxonomy';
import { saveCustomCategory } from '@/lib/api/customCategories';

export default function TransactionsFeedScreen() {
  const router = useRouter();
  const insets = useSafeAreaInsets();

  const {
    transactions: rows,   // raw Transaction[] for the current page — see useTransactionFeed.ts docblock
    totalCount,
    loading,
    refreshing: feedRefreshing,
    page,
    totalPages,
    goToNextPage,
    goToPreviousPage,
    refresh: refreshFeed,
  } = useTransactionFeed('active');

  const {
    statusFilter,
    setStatusFilter,
  } = useTransactionStore();
  // [REMOVED] Used to pin the shared transactionStore's activeTab to
  // 'active' here on mount. That shared value caused a real bug — see
  // useTransactionFeed.ts's docblock — since History pinning it to
  // 'history' on ITS mount silently redirected this still-mounted
  // screen's own hook to History's filters too. useTransactionFeed now
  // takes 'active' as a direct argument above instead, so this screen no
  // longer depends on that shared flag at all.


  const [needsReviewCount, setNeedsReviewCount] = useState(0);
  const [hasAny, setHasAny] = useState<boolean | null>(null); // null = not yet known
  const [pullRefreshing, setPullRefreshing] = useState(false);
  const [submitting, setSubmitting] = useState(false);

  // Draft workspace — nothing here is written to Supabase until Submit.
  const [draftEdits, setDraftEdits] = useState<Record<string, TransactionEdit>>({});
  const [draftSplits, setDraftSplits] = useState<Record<string, TransactionSplit>>({});

  const [editingTxn, setEditingTxn] = useState<Transaction | null>(null);
  const [splittingTxn, setSplittingTxn] = useState<Transaction | null>(null);
  const [registeringTxn, setRegisteringTxn] = useState<Transaction | null>(null);

  const allCategories = useMemo(
    () => Object.values(TAXONOMY).flat().map((c) => c.category),
    [],
  );

  const loadCounts = useCallback(async () => {
    const [reviewCount, any] = await Promise.all([fetchNeedsReviewCount(), hasAnyTransactions()]);
    setNeedsReviewCount(reviewCount);
    setHasAny(any);
  }, []);

  // [FIX] Was `useEffect(() => { loadCounts(); }, [loadCounts]);` — ran
  // once at mount and never again. totalCount (above, from
  // useTransactionFeed) and needsReviewCount (here) are two SEPARATE data
  // paths on this screen with different refresh behavior — confirmed
  // bug report: totalCount stayed accurate through a sync (100), while
  // needsReviewCount stayed stuck at its mount-time value (3) the whole
  // time. useFocusEffect refetches every time this screen is navigated TO
  // (including the first time, same as the old useEffect did) — so
  // switching back to this tab after a sync completes on the Sync tab, or
  // after a background sync runs, always shows the real current count
  // instead of whatever it was when this screen last mounted.
  useFocusEffect(
    useCallback(() => {
      loadCounts();
    }, [loadCounts])
  );

  // [ADD] Runs once per mount — i.e. every time this screen loads, including
  // app reopen — to catch up any transaction that was left pending_review
  // BEFORE a custom category or registered fact that would resolve it was
  // confirmed. See transactions.ts's reconcilePendingTransactions() for why
  // this doesn't happen anywhere else (matching only ever runs at SMS parse
  // time otherwise). Doesn't block the initial render — runs alongside it —
  // and only triggers a refetch if it actually resolved something, so a
  // clean pass costs one extra read, not an extra render cycle.
  useEffect(() => {
    reconcilePendingTransactions()
      .then(({ resolved }) => {
        if (resolved > 0) {
          refreshFeed();
          loadCounts();
        }
      })
      .catch((e) => console.error('reconcilePendingTransactions failed:', e));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const onRefresh = async () => {
    setPullRefreshing(true);
    // Matches original: refetches the CURRENT page (not page 0) — see
    // useTransactionFeed.ts's refresh() docblock for why that's deliberate.
    await Promise.all([refreshFeed(), loadCounts()]);
    setPullRefreshing(false);
  };

  // [FIX] Original called local load() here, which refetched the page AND
  // needsReviewCount/hasAny together. A first pass at this migration only
  // refreshed the feed — but resolving a contra pair changes a row's
  // status (e.g. clears pending_review), which can move needsReviewCount.
  // Dropping the counts refresh here would have been a real regression.
  const handleContraResolved = useCallback(async () => {
    await Promise.all([refreshFeed(), loadCounts()]);
  }, [refreshFeed, loadCounts]);

  // [ADD] confirmRegisteredFact() resolves the triggering row out of
  // pending_review (same category of change as contra resolution above),
  // so this needs the same counts+feed refresh, not just the feed alone.
  const handleFactConfirmed = useCallback(async () => {
    setRegisteringTxn(null);
    await Promise.all([refreshFeed(), loadCounts()]);
  }, [refreshFeed, loadCounts]);

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

  const hasDraftChanges = Object.keys(draftEdits).length > 0 || Object.keys(draftSplits).length > 0;

  const handleSaveEdit = async (edit: TransactionEdit, shouldSaveCustomCategory: boolean) => {
    setDraftEdits((prev) => ({ ...prev, [edit.id]: edit }));
    setEditingTxn(null);

    if (shouldSaveCustomCategory && edit.merchant && edit.type && edit.category) {
      try {
        // [FIX] excludeTransactionId keeps this specific row untouched in
        // the DB (still draft-only until page Submit — arch doc 5.3.3),
        // while still letting saveCustomCategory() retroactively fix this
        // merchant's OTHER Feed transactions right now. Refetching the
        // feed afterward is what makes those fixes visible immediately —
        // previously they only became visible on next app reopen.
        const { retroactivelyUpdated } = await saveCustomCategory({
          merchant: edit.merchant,
          type: edit.type,
          category: edit.category,
          subCategory: edit.sub_category ?? null,
          excludeTransactionId: edit.id,
        });
        if (retroactivelyUpdated > 0) {
          await refreshFeed();
        }
      } catch (e) {
        console.error('Failed to save custom category preference:', e);
      }
    }
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
      await Promise.all([refreshFeed(), loadCounts()]);
    } finally {
      setSubmitting(false);
    }
  };

  if (hasAny === false) {
    return (
      <View style={[styles.container, { paddingTop: insets.top + spacing.sm }]}>
        <View style={styles.topBar}>
          <View style={{ flex: 1 }}>
            <SubTabs active="feed" onSwitch={() => router.push('/(app)/transactions/history')} />
          </View>
          <TouchableOpacity onPress={() => router.push('/(app)/transactions/add')} hitSlop={10} style={styles.addBtn}>
            <Text style={styles.addBtnText}>+</Text>
          </TouchableOpacity>
          <ManageMenu />
        </View>
        <EmptyState
          title="No transactions yet"
          subtitle="Connect a data source or upload past bank statements to see your transactions here."
        />
      </View>
    );
  }

  if (hasAny === true && !loading && totalCount === 0 && needsReviewCount === 0 && rows.length === 0) {
    return (
      <View style={[styles.container, { paddingTop: insets.top + spacing.sm }]}>
        <View style={styles.topBar}>
          <View style={{ flex: 1 }}>
            <SubTabs active="feed" onSwitch={() => router.push('/(app)/transactions/history')} />
          </View>
          <TouchableOpacity onPress={() => router.push('/(app)/transactions/add')} hitSlop={10} style={styles.addBtn}>
            <Text style={styles.addBtnText}>+</Text>
          </TouchableOpacity>
          <ManageMenu />
        </View>
        <EmptyState
          title="All transactions reviewed"
          subtitle="Every transaction has been confirmed. View your Transaction History to see past activity."
          actionLabel="View Transaction History →"
          onAction={() => router.push('/(app)/transactions/history')}
        />
      </View>
    );
  }

  return (
    <View style={[styles.container, { paddingTop: insets.top + spacing.sm }]}>
      <View style={styles.topBar}>
        <View style={{ flex: 1 }}>
          <SubTabs active="feed" onSwitch={() => router.push('/(app)/transactions/history')} />
        </View>
        <TouchableOpacity onPress={() => router.push('/(app)/transactions/add')} hitSlop={10} style={styles.addBtn}>
          <Text style={styles.addBtnText}>+</Text>
        </TouchableOpacity>
        <ManageMenu />
      </View>

      <View style={styles.headerRow}>
        <Text style={styles.headerCount}>
          {totalCount} transactions this month · <Text style={styles.headerCountStrong}>{needsReviewCount} need review</Text>
        </Text>
      </View>

      <View style={styles.filterRow}>
        <FilterChip label="All" active={statusFilter === 'all'} onPress={() => setStatusFilter('all')} />
        <FilterChip label="Needs review" active={statusFilter === 'pending_review'} onPress={() => setStatusFilter('pending_review')} />
      </View>

      <View style={styles.banner}>
        <Text style={styles.bannerText}>
          Transactions ≥ ₹5,000, or that look like a possible duplicate of another transaction, always need
          review. Tap Edit to correct any row, then Submit to save your changes for this page.
        </Text>
      </View>

      <FlatList
        data={displayRows}
        keyExtractor={(item) => item.txn.id}
        refreshControl={<RefreshControl refreshing={pullRefreshing || feedRefreshing} onRefresh={onRefresh} />}
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
            onContraResolved={item.isDraftSplitChild ? undefined : handleContraResolved}
            onRegisterFactPress={item.isDraftSplitChild ? undefined : () => setRegisteringTxn(item.txn)}
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
            onPress={goToPreviousPage}
          />
          <Button
            label="Next →"
            variant="ghost"
            size="sm"
            disabled={page >= totalPages - 1}
            onPress={goToNextPage}
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
      <RegisterFactPrompt
        visible={!!registeringTxn}
        transaction={registeringTxn}
        onCancel={() => setRegisteringTxn(null)}
        onConfirmed={handleFactConfirmed}
      />
    </View>
  );
}

// Segmented Feed/History control — visually two tabs, but sits inside the
// Stack (not a second native Tabs bar) so it doesn't stack a second bottom
// tab bar under the app-level one in app/(app)/_layout.tsx. 'feed' here
// maps to this screen (app/(app)/transactions/index.tsx); 'history' maps
// to app/(app)/transactions/history.tsx, which renders the mirror-image
// version of this same control via its own local copy.
function SubTabs({ active, onSwitch }: { active: 'feed' | 'history'; onSwitch: () => void }) {
  return (
    <View style={styles.subTabRow}>
      <View style={[styles.subTab, active === 'feed' && styles.subTabActive]}>
        <Text style={[styles.subTabText, active === 'feed' && styles.subTabTextActive]}>Feed</Text>
      </View>
      <TouchableOpacity
        style={[styles.subTab, active === 'history' && styles.subTabActive]}
        activeOpacity={0.7}
        onPress={onSwitch}
      >
        <Text style={[styles.subTabText, active === 'history' && styles.subTabTextActive]}>History</Text>
      </TouchableOpacity>
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

function EmptyState({
  title, subtitle, actionLabel, onAction,
}: {
  title: string;
  subtitle: string;
  actionLabel?: string;
  onAction?: () => void;
}) {
  return (
    <View style={styles.emptyState}>
      <Text style={styles.emptyTitle}>{title}</Text>
      <Text style={styles.emptySubtitle}>{subtitle}</Text>
      {actionLabel && onAction && (
        <TouchableOpacity onPress={onAction} activeOpacity={0.7} style={styles.emptyActionBtn}>
          <Text style={styles.emptyActionText}>{actionLabel}</Text>
        </TouchableOpacity>
      )}
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
  // [ADD] Row wrapping SubTabs + ManageMenu — SubTabs keeps its own
  // internal flex:1-per-side layout, this just gives the "⋯" icon a
  // fixed-width slot to its right.
  topBar: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    marginBottom: spacing.sm,
  },
  // [ADD] "+" button — reaches app/(app)/transactions/add.tsx (manual entry).
  addBtn: {
    width: 32,
    height: 32,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: radius.md,
    backgroundColor: colors.brand,
  },
  addBtnText: {
    fontSize: 18,
    lineHeight: 18,
    color: colors.white,
    fontWeight: fontWeight.bold,
  },
  subTabRow: {
    flexDirection: 'row',
    backgroundColor: colors.surface,
    borderRadius: radius.md,
    padding: 3,
  },
  subTab: {
    flex: 1,
    paddingVertical: 8,
    borderRadius: radius.sm,
    alignItems: 'center',
  },
  subTabActive: {
    backgroundColor: colors.white,
    shadowColor: '#000',
    shadowOpacity: 0.06,
    shadowRadius: 3,
    shadowOffset: { width: 0, height: 1 },
    elevation: 1,
  },
  subTabText: { fontSize: fontSize.sm, fontWeight: fontWeight.semibold, color: colors.muted },
  subTabTextActive: { color: colors.dark },
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
  emptyActionBtn: { marginTop: spacing.md },
  emptyActionText: { fontSize: fontSize.sm, color: colors.brand, fontWeight: fontWeight.semibold },
});