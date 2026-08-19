/**
 * app/(app)/profile/accounts.tsx
 * Replaces app/(app)/transactions/accounts.tsx — delete that file after
 * this lands, and remove any in-app link that pointed at
 * '/transactions/accounts' (check transactions/index.tsx and
 * budget-vs-actual.tsx for a button/link to it — not in scope here since
 * those files weren't shared, grep the route string to find it).
 *
 * [RESTORED — this pass] The per-account track/untrack Switch. The
 * uploaded version of this file had it removed ("[REMOVED] handleToggle()
 * — was wired to the per-account Switch below, which is also removed for
 * now"), with is_active/setAccountActive left in place unused. This
 * restores the UI half — the backend half (accounts.is_active,
 * setAccountActive() in src/lib/api/accounts.ts) already existed and is
 * unchanged.
 *
 * [SCOPE — deliberately not done here, same gap accounts.ts's own
 * docblock already flagged] Untracking an account here only changes its
 * is_active flag. Nothing yet reads that flag on the way back out —
 * fetchTransactions() (src/lib/api/transactions.ts) and the score
 * calculation queries (packages/core/src/scoring/*) still include every
 * account regardless of is_active. That's the next piece, not this one:
 * this pass is "give the user a working toggle," not "make every read
 * path respect it." Flagging clearly so this isn't mistaken for done.
 *
 * [SCOPE — also not done here] The "new account detected, review it"
 * prompt discussed early on (a needs_review flag on first sight of an
 * account) needs a small migration this pass doesn't add. This screen
 * currently shows every account with its current tracked state — a
 * newly-detected account just shows up here already tracked (is_active
 * defaults true on insert, per resolveAccountId() in transactions.ts),
 * with no separate "new" callout. Worth building next if wanted.
 *
 * [FIX — this pass] Removed the eager resolveCashAccountId() call from
 * loadAccounts() — see that function's comment. Cash now only appears
 * in this list once it's genuinely been used at least once via manual
 * transaction entry, not just because this screen was opened.
 */
import {
  View, Text, StyleSheet, TouchableOpacity, ActivityIndicator, ScrollView, Switch, Alert,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useFocusEffect } from '@react-navigation/native';
import Svg, { Path, Rect, Polyline } from 'react-native-svg';
import { useCallback, useState } from 'react';
import { colors, spacing, fontSize, fontWeight, radius, shadows } from '@/constants/theme';
import { fetchAccounts, setAccountActive, type Account } from '@/lib/api/accounts';

// ─── Icons ────────────────────────────────────────────────────────────────────

function BankIcon() {
  return (
    <Svg width={14} height={14} viewBox="0 0 24 24" fill="none" stroke="#3B82F6" strokeWidth={2}>
      <Rect x={2} y={7} width={20} height={14} rx={2} />
      <Path d="M16 7V5a2 2 0 0 0-2-2h-4a2 2 0 0 0-2 2v2" />
    </Svg>
  );
}

function FileIcon() {
  return (
    <Svg width={14} height={14} viewBox="0 0 24 24" fill="none" stroke="#7C3AED" strokeWidth={2}>
      <Path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
      <Polyline points="14 2 14 8 20 8" />
    </Svg>
  );
}

const ACCOUNT_TYPE_LABELS: Record<Account['account_type'], string> = {
  bank: 'Bank Account',
  credit_card: 'Credit Card',
  loan: 'Loan',
  mf: 'Mutual Fund',
  equity: 'Equity / Demat',
  insurance: 'Insurance',
  epf: 'EPF',
  nps: 'NPS',
  ppf: 'PPF',
  fd: 'Fixed Deposit',
  real_estate: 'Real Estate',
  cash: 'Cash',
};

// Same reasoning as the original file: data-source cards are demo/mockup
// content with no wired onPress handlers. Kept hidden by default so the
// account-tracking list is the thing actually visible. Flip to true once
// those cards are wired up to real functionality.
const SHOW_DATA_SOURCE_CARDS = false;

export default function AccountsScreen() {
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [loadingAccounts, setLoadingAccounts] = useState(true);
  const [accountsError, setAccountsError] = useState<string | null>(null);
  // Per-account id set for "toggle request in flight" — disables that row's
  // Switch while the write is happening, so a slow network can't let the
  // user fire a second toggle before the first one lands.
  const [togglingIds, setTogglingIds] = useState<Set<string>>(new Set());

  const loadAccounts = useCallback(async () => {
    setLoadingAccounts(true);
    setAccountsError(null);
    try {
      // [FIX — this pass] No longer calls resolveCashAccountId() here.
      // That eagerly created a Cash account row every time this screen
      // was opened, regardless of whether the user had ever actually
      // used Cash — see app/(app)/transactions/add.tsx's matching fix.
      // Cash now only appears here once it's been genuinely used at
      // least once (created lazily, at manual-transaction submit time).
      const rows = await fetchAccounts();
      // [FIX — this pass] Cash is deliberately excluded from this list.
      // Per product decision: Cash is just a payment-mode tag a user can
      // attach to a manual transaction, not a real trackable account —
      // there's no institution, no balance, nothing meaningful to
      // track/untrack about it, so it has no business cluttering the
      // Accounts management screen. This applies unconditionally,
      // regardless of whether a Cash row exists in the database yet (it
      // gets created lazily on first manual Cash entry — see add.tsx —
      // but even once it exists, it stays hidden here). Filtered at
      // display time only; fetchAccounts() itself is untouched since
      // other callers (add.tsx's own Cash-detection check) still need
      // the real Cash row back.
      setAccounts(rows.filter((a) => a.account_type !== 'cash'));
    } catch (e) {
      setAccountsError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoadingAccounts(false);
    }
  }, []);

  // [FIX] Was `useEffect(() => { loadAccounts(); }, [loadAccounts]);` —
  // fetched once at mount and never again. If an account gets created
  // AFTER this screen last loaded (e.g. a new bank's SMS gets parsed by
  // a background sync, or the on-app-open sync, while you're on a
  // different screen), it would never appear here until a full app
  // restart — confirmed against real data: an account created 5 minutes
  // after this screen's last load simply wasn't in the list. useFocusEffect
  // refetches every time this screen is navigated TO (including the
  // first time, same as the old useEffect did), so leaving and coming
  // back always shows what's actually in the database right now.
  useFocusEffect(
    useCallback(() => {
      loadAccounts();
    }, [loadAccounts])
  );

  async function handleToggle(account: Account, nextValue: boolean) {
    // Optimistic update — flip it in local state immediately so the
    // Switch feels responsive, then confirm against the backend. On
    // failure, revert and surface the error rather than leaving the UI
    // showing a state that was never actually saved.
    setAccounts(prev => prev.map(a => a.id === account.id ? { ...a, is_active: nextValue } : a));
    setTogglingIds(prev => new Set(prev).add(account.id));
    try {
      await setAccountActive(account.id, nextValue);
    } catch (e) {
      setAccounts(prev => prev.map(a => a.id === account.id ? { ...a, is_active: account.is_active } : a));
      Alert.alert('Couldn\u2019t update', e instanceof Error ? e.message : String(e));
    } finally {
      setTogglingIds(prev => {
        const next = new Set(prev);
        next.delete(account.id);
        return next;
      });
    }
  }

  return (
    <SafeAreaView style={s.safe} edges={['top']}>
      <View style={s.header}>
        <Text style={s.title}>Accounts</Text>
        <Text style={s.subtitle}>Manage which accounts feed your transactions and score</Text>
      </View>

      <ScrollView contentContainerStyle={s.wrap} showsVerticalScrollIndicator={false}>

      {SHOW_DATA_SOURCE_CARDS && (
      <>
      <Text style={s.sectionLabel}>Live Data Sources</Text>

      <View style={s.card}>
        <View style={s.cardHead}>
          <Text style={s.cardTitle}>Bank SMS</Text>
          <View style={[s.badge, { backgroundColor: 'rgba(59,130,246,0.1)' }]}>
            <Text style={[s.badgeText, { color: colors.blue }]}>Android</Text>
          </View>
        </View>
        <Text style={s.cardDesc}>
          Parses bank SMS automatically — on app open, and every hour in the background.
        </Text>
      </View>

      <View style={s.card}>
        <View style={s.cardHead}>
          <Text style={s.cardTitle}>Email Forwarding</Text>
          <View style={[s.badge, { backgroundColor: colors.greenLight }]}>
            <Text style={[s.badgeText, { color: '#059669' }]}>All platforms</Text>
          </View>
        </View>
        <Text style={s.cardDesc}>
          Forward bank emails to parse@pileap.com. Captures statements, SIP
          confirmations, CC bills, and EMI receipts.
        </Text>
      </View>

      <Text style={[s.sectionLabel, { marginTop: spacing.lg }]}>
        Upload Past Statements
      </Text>
      <View style={s.uploadRow}>
        <View style={s.uploadCard}>
          <View style={[s.uploadIcon, { backgroundColor: 'rgba(59,130,246,0.1)' }]}>
            <BankIcon />
          </View>
          <Text style={s.uploadTitle}>Bank PDF Statement</Text>
          <Text style={s.uploadDesc}>All major banks · debit/credit rows</Text>
        </View>
        <View style={s.uploadCard}>
          <View style={[s.uploadIcon, { backgroundColor: 'rgba(124,58,237,0.1)' }]}>
            <FileIcon />
          </View>
          <Text style={s.uploadTitle}>CAMS / NSDL CAS PDF</Text>
          <Text style={s.uploadDesc}>MF portfolio · SIP & lumpsum rows</Text>
        </View>
      </View>
      </>
      )}

      <Text style={[s.sectionLabel, { marginTop: spacing.lg }]}>Your Accounts</Text>
      <Text style={s.sectionSub}>
        Turn an account off if you don't want its future transactions tracked or counted toward your score. Past transactions already recorded aren't affected.
      </Text>

      {accountsError && <Text style={s.accountsErrorText}>{accountsError}</Text>}

      {loadingAccounts ? (
        <ActivityIndicator color={colors.brand} style={{ marginTop: spacing.md }} />
      ) : accounts.length === 0 ? (
        <Text style={s.emptyAccountsText}>No accounts detected yet.</Text>
      ) : (
        accounts.map((item) => (
          <View key={item.id} style={s.accountRow}>
            <View style={s.accountRowLeft}>
              <Text style={s.cardTitle}>
                {item.institution_name ?? ACCOUNT_TYPE_LABELS[item.account_type]}
              </Text>
              <Text style={s.meta}>
                {ACCOUNT_TYPE_LABELS[item.account_type]}
                {item.account_number_masked ? ` · ${item.account_number_masked}` : ''}
              </Text>
            </View>
            <Switch
              value={item.is_active ?? true}
              onValueChange={(next) => handleToggle(item, next)}
              disabled={togglingIds.has(item.id)}
              trackColor={{ false: colors.border, true: colors.brand }}
              thumbColor={colors.white}
            />
          </View>
        ))
      )}

    </ScrollView>
    </SafeAreaView>
  );
}

// ─── Styles ───────────────────────────────────────────────────────────────────

const s = StyleSheet.create({
  safe: { flex: 1, backgroundColor: colors.surface },
  header: { paddingHorizontal: spacing.lg, paddingVertical: spacing.md, borderBottomWidth: 1, borderBottomColor: colors.border, backgroundColor: colors.white },
  title: { fontSize: fontSize.lg, fontWeight: fontWeight.bold, color: colors.dark },
  subtitle: { fontSize: fontSize.sm, color: colors.muted, marginTop: 2 },
  wrap: { width: '100%', padding: spacing.md, paddingBottom: spacing.xl },

  sectionLabel: {
    fontSize: fontSize.xs,
    fontWeight: fontWeight.semibold,
    color: colors.muted,
    textTransform: 'uppercase',
    letterSpacing: 0.5,
    marginBottom: spacing.sm,
  },
  sectionSub: {
    fontSize: fontSize.xs,
    color: colors.muted,
    lineHeight: 17,
    marginBottom: spacing.md,
    marginTop: -spacing.xs,
  },

  card: {
    backgroundColor: colors.white,
    borderRadius: radius.lg,
    borderWidth: 1,
    borderColor: colors.border,
    padding: spacing.md,
    marginBottom: spacing.md,
    ...shadows.sm,
  },
  cardHead: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: spacing.xs,
  },
  cardTitle: {
    fontSize: fontSize.base,
    fontWeight: fontWeight.semibold,
    color: colors.dark,
  },
  cardDesc: {
    fontSize: fontSize.xs,
    color: colors.muted,
    lineHeight: 17,
  },

  badge: {
    paddingHorizontal: 7,
    paddingVertical: 2,
    borderRadius: radius.full,
  },
  badgeText: {
    fontSize: 10,
    fontWeight: fontWeight.semibold,
  },

  uploadRow: {
    flexDirection: 'row',
    gap: spacing.sm,
    marginBottom: spacing.xs,
  },
  uploadCard: {
    flex: 1,
    backgroundColor: colors.white,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.border,
    padding: spacing.sm,
    ...shadows.sm,
  },
  uploadIcon: {
    width: 28,
    height: 28,
    borderRadius: 6,
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: 6,
  },
  uploadTitle: {
    fontSize: fontSize.xs,
    fontWeight: fontWeight.semibold,
    color: colors.dark,
    marginBottom: 2,
  },
  uploadDesc: {
    fontSize: 10,
    color: colors.muted,
    lineHeight: 14,
  },

  accountRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    backgroundColor: colors.white,
    borderRadius: radius.lg,
    borderWidth: 1,
    borderColor: colors.border,
    padding: spacing.md,
    marginBottom: spacing.sm,
    ...shadows.sm,
  },
  accountRowLeft: { flex: 1, paddingRight: spacing.sm },
  meta: { fontSize: fontSize.xs, color: colors.muted, marginTop: 2 },
  accountsErrorText: { fontSize: fontSize.xs, color: colors.red, marginBottom: spacing.sm },
  emptyAccountsText: { fontSize: fontSize.sm, color: colors.muted, textAlign: 'center', marginTop: spacing.md },
});