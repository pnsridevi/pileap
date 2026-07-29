/**
 * app/(app)/transactions/history.tsx
 *
 * Read-only view of reviewed transactions (status: 'user_reviewed'),
 * referenced since the very first Active-feed pass as "not built in this
 * pass" and flagged in the useTransactionFeed/transactionStore
 * duplication review as the reason to migrate index.tsx onto the shared
 * hook/store before building this. That migration is done — this screen
 * is close to free as a result:
 *
 *   - useTransactionFeed's activeTab === 'history' branch already exists
 *     and was exercised (not just written) via that migration.
 *   - transactionStore's categoryFilter is shared across both screens by
 *     design — a category chosen here or on the Active feed carries over
 *     to the other. That's a deliberate consequence of one shared store,
 *     not an oversight; flag if you'd rather each screen keep its own.
 *   - No draft workspace, no Edit/Split, no Submit — reviewed rows are a
 *     historical record, not something this screen mutates. TransactionRow
 *     is used with onPress/onSplitPress both omitted (both optional props)
 *     to render it fully non-interactive. [NOTE — carried decision from
 *     this session] Edit/Split for History was scoped and then explicitly
 *     put on hold: it depends on whether monthly report-card scores are
 *     computed live or cached/snapshotted, which isn't decided until
 *     scores.ts actually exists. Revisit once that's built.
 *   - Page-based Prev/Next, matching the Active feed's pattern (confirmed
 *     with user for Active; carried over here for one consistent
 *     pagination model rather than introducing a second one — flag if you
 *     want infinite scroll here instead, the hook already supports both).
 *
 * [ADD] ManageMenu — same "⋯" icon as index.tsx (Feed), added this
 * session so Custom Categories / Budget vs Actual / Accounts are
 * reachable from History too, not just Feed.
 *
 * Data flow: transactions table (status = user_reviewed) -> useTransactionFeed.
 */
import { View, Text, FlatList, TouchableOpacity, StyleSheet, ActivityIndicator, RefreshControl } from 'react-native';
import { useRouter } from 'expo-router';
import { colors, radius, spacing, fontSize, fontWeight } from '@/constants/theme';
import { TransactionRow, mapTransactionToRow } from '@/components/transactions/TransactionRow';
import { ManageMenu } from '@/components/transactions/ManageMenu';
import { Button } from '@/components/ui/Button';
import { useTransactionFeed } from '@/hooks/useTransactionFeed';
import { useTransactionStore } from '@/store/transactionStore';

export default function TransactionHistoryScreen() {
  const router = useRouter();

  const {
    transactions: rows,
    totalCount,
    loading,
    refreshing,
    page,
    totalPages,
    goToNextPage,
    goToPreviousPage,
    refresh,
  } = useTransactionFeed('history');

  const { categoryFilter, setCategoryFilter } = useTransactionStore();
  // [REMOVED] Used to pin the shared transactionStore's activeTab to
  // 'history' here on mount — see useTransactionFeed.ts's docblock for
  // the real bug this caused (it silently redirected Feed's still-
  // mounted hook to History's filters too, since Feed's own pin never
  // re-fires after its first mount). useTransactionFeed now takes
  // 'history' as a direct argument above instead.

  return (
    <View style={styles.container}>
      <View style={styles.topBar}>
        <View style={{ flex: 1 }}>
          <SubTabs
            active="history"
            onSwitch={() => (router.canGoBack() ? router.back() : router.replace('/(app)/transactions'))}
          />
        </View>
        <ManageMenu />
      </View>

      <View style={styles.headerRow}>
        <Text style={styles.headerCount}>{totalCount} reviewed transactions</Text>
      </View>

      <View style={styles.filterRow}>
        <FilterChip
          label="All categories"
          active={categoryFilter === null}
          onPress={() => setCategoryFilter(null)}
        />
      </View>

      <FlatList
        data={rows}
        keyExtractor={(item) => item.id}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={refresh} />}
        contentContainerStyle={{ paddingBottom: spacing.xl }}
        ListEmptyComponent={
          loading ? (
            <ActivityIndicator color={colors.brand} style={{ marginTop: spacing.xl }} />
          ) : (
            <EmptyState
              title="No reviewed transactions yet"
              subtitle="Transactions move here once you submit them from the Feed tab."
            />
          )
        }
        renderItem={({ item }) => (
          <TransactionRow transaction={mapTransactionToRow(item)} />
        )}
      />

      {totalCount > 0 && (
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
          </View>
        </View>
      )}
    </View>
  );
}

// Segmented Feed/History control — see index.tsx's copy of this component
// for the full rationale. This is the mirror-image version: 'history' is
// always the active side here since this file only ever renders as the
// History screen.
function SubTabs({ active, onSwitch }: { active: 'feed' | 'history'; onSwitch: () => void }) {
  return (
    <View style={styles.subTabRow}>
      <TouchableOpacity
        style={[styles.subTab, active === 'feed' && styles.subTabActive]}
        activeOpacity={0.7}
        onPress={onSwitch}
      >
        <Text style={[styles.subTabText, active === 'feed' && styles.subTabTextActive]}>Feed</Text>
      </TouchableOpacity>
      <View style={[styles.subTab, active === 'history' && styles.subTabActive]}>
        <Text style={[styles.subTabText, active === 'history' && styles.subTabTextActive]}>History</Text>
      </View>
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
  // [ADD] Same topBar wrapper as index.tsx — SubTabs + ManageMenu side by
  // side.
  topBar: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    marginBottom: spacing.sm,
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
  filterRow: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.xs, marginBottom: spacing.sm },
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