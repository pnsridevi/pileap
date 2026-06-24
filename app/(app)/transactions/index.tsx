import { useState } from 'react';
import {
  View, Text, StyleSheet, TouchableOpacity, ScrollView,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import Svg, { Path, Line, Rect, Circle, Polyline } from 'react-native-svg';
import { colors, spacing, fontSize, fontWeight, radius, shadows } from '@/constants/theme';
import AccountsTab from './accounts';

type SubTab = 'feed' | 'budget' | 'categories' | 'accounts';

const SUBTABS: { key: SubTab; label: string }[] = [
  { key: 'feed',       label: 'Feed' },
  { key: 'budget',     label: 'Budget vs Actual' },
  { key: 'categories', label: 'Custom Categories' },
  { key: 'accounts',   label: 'Accounts' },
];

// ─── Icons ────────────────────────────────────────────────────────────────────

function FileIcon() {
  return (
    <Svg width={40} height={40} viewBox="0 0 24 24" fill="none" stroke={colors.muted} strokeWidth={1.5}>
      <Path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
      <Path d="M14 2v6h6" />
      <Line x1="8" y1="13" x2="16" y2="13" />
      <Line x1="8" y1="17" x2="16" y2="17" />
    </Svg>
  );
}

function CheckIcon() {
  return (
    <Svg width={40} height={40} viewBox="0 0 24 24" fill="none" stroke={colors.muted} strokeWidth={1.5}>
      <Path d="M22 11.08V12a10 10 0 1 1-5.93-9.14" />
      <Polyline points="22 4 12 14.01 9 11.01" />
    </Svg>
  );
}

function WalletIcon() {
  return (
    <Svg width={40} height={40} viewBox="0 0 24 24" fill="none" stroke={colors.muted} strokeWidth={1.5}>
      <Rect x={2} y={7} width={20} height={14} rx={2} />
      <Path d="M16 7V5a2 2 0 0 0-2-2h-4a2 2 0 0 0-2 2v2" />
      <Circle cx={16} cy={14} r={1} />
    </Svg>
  );
}

function TagIcon() {
  return (
    <Svg width={40} height={40} viewBox="0 0 24 24" fill="none" stroke={colors.muted} strokeWidth={1.5}>
      <Path d="M20.59 13.41l-7.17 7.17a2 2 0 0 1-2.83 0L2 12V2h10l8.59 8.59a2 2 0 0 1 0 2.82z" />
      <Line x1="7" y1="7" x2="7.01" y2="7" />
    </Svg>
  );
}

// ─── Feed sub-tab ─────────────────────────────────────────────────────────────
// Two distinct states per arch doc Section 5.3.5:
//   • neverIngested — transactions table has zero rows for this user
//   • allReviewed   — all rows have status = user_reviewed

function FeedNeverIngested({ onGoToAccounts }: { onGoToAccounts: () => void }) {
  return (
    <View style={s.emptyWrap}>
      <View style={s.emptyIconBox}><FileIcon /></View>
      <Text style={s.emptyTitle}>No transactions yet</Text>
      <Text style={s.emptySub}>
        Connect a data source to start tracking your spending, income, and investments.
      </Text>
      <TouchableOpacity style={s.btnPrimary} activeOpacity={0.8} onPress={onGoToAccounts}>
        <Text style={s.btnPrimaryText}>Connect Data Source →</Text>
      </TouchableOpacity>
      <TouchableOpacity style={s.manualLink} activeOpacity={0.7}>
        <Text style={s.manualLinkText}>+ Add transaction manually</Text>
      </TouchableOpacity>
    </View>
  );
}

function FeedAllReviewed() {
  return (
    <View style={s.emptyWrap}>
      <View style={s.emptyIconBox}><CheckIcon /></View>
      <Text style={s.emptyTitle}>All transactions reviewed</Text>
      <Text style={s.emptySub}>
        You're up to date. Reviewed transactions move to your history.
      </Text>
      <TouchableOpacity style={s.btnGhost} activeOpacity={0.8}>
        <Text style={s.btnGhostText}>View Transaction History →</Text>
      </TouchableOpacity>
    </View>
  );
}

// ─── Budget sub-tab ───────────────────────────────────────────────────────────

function BudgetEmpty() {
  return (
    <View style={s.emptyWrap}>
      <View style={s.emptyIconBox}><WalletIcon /></View>
      <Text style={s.emptyTitle}>No budget set up yet</Text>
      <Text style={s.emptySub}>
        Your monthly spending plan will appear here once onboarding is complete.
        Track Fixed, Living, and Investment categories against actual spend.
      </Text>
    </View>
  );
}

// ─── Custom Categories sub-tab ────────────────────────────────────────────────

function CategoriesEmpty() {
  return (
    <View style={s.emptyWrap}>
      <View style={s.emptyIconBox}><TagIcon /></View>
      <Text style={s.emptyTitle}>No custom categories yet</Text>
      <Text style={s.emptySub}>
        When you correct a transaction's category, Pileap remembers it for that
        merchant. Your saved rules will appear here.
      </Text>
    </View>
  );
}

// ─── Screen ───────────────────────────────────────────────────────────────────

// Swap these for real store selectors when wired up.
// neverIngested: transactions table has 0 rows for this user
// allReviewed:   all rows have status = user_reviewed
type FeedState = 'neverIngested' | 'allReviewed' | 'hasTransactions';
const FEED_STATE: FeedState = 'neverIngested';

export default function TransactionsScreen() {
  const [activeTab, setActiveTab] = useState<SubTab>('feed');

  function renderFeed() {
    switch (FEED_STATE) {
      case 'neverIngested':   return <FeedNeverIngested onGoToAccounts={() => setActiveTab('accounts')} />;
      case 'allReviewed':     return <FeedAllReviewed />;
      case 'hasTransactions': return null; // real transaction list goes here
    }
  }

  function renderContent() {
    switch (activeTab) {
      case 'feed':       return renderFeed();
      case 'budget':     return <BudgetEmpty />;
      case 'categories': return <CategoriesEmpty />;
      case 'accounts':   return <AccountsTab />;
    }
  }

  return (
    <SafeAreaView style={s.safe} edges={['top']}>
      <View style={s.header}>
        <Text style={s.headerTitle}>Transactions</Text>
        <TouchableOpacity style={s.addBtn} activeOpacity={0.8}>
          <Text style={s.addBtnText}>+ Add</Text>
        </TouchableOpacity>
      </View>

      <View style={s.subTabBar}>
        <ScrollView
          horizontal
          showsHorizontalScrollIndicator={false}
          contentContainerStyle={s.subTabScroll}
        >
          {SUBTABS.map((tab) => {
            const active = activeTab === tab.key;
            return (
              <TouchableOpacity
                key={tab.key}
                style={[s.subTab, active && s.subTabActive]}
                onPress={() => setActiveTab(tab.key)}
                activeOpacity={0.7}
              >
                <Text style={[s.subTabText, active && s.subTabTextActive]}>
                  {tab.label}
                </Text>
              </TouchableOpacity>
            );
          })}
        </ScrollView>
      </View>

      <ScrollView
        style={s.content}
        contentContainerStyle={s.contentInner}
        showsVerticalScrollIndicator={false}
      >
        {renderContent()}
      </ScrollView>
    </SafeAreaView>
  );
}

// ─── Styles ───────────────────────────────────────────────────────────────────

const s = StyleSheet.create({
  safe: { flex: 1, backgroundColor: colors.white },

  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.md,
    borderBottomWidth: 1,
    borderBottomColor: colors.border,
    backgroundColor: colors.white,
  },
  headerTitle: {
    fontSize: fontSize.lg,
    fontWeight: fontWeight.bold,
    color: colors.dark,
  },
  addBtn: {
    backgroundColor: colors.brand,
    paddingHorizontal: spacing.md,
    paddingVertical: 6,
    borderRadius: radius.md,
  },
  addBtnText: {
    fontSize: fontSize.sm,
    fontWeight: fontWeight.semibold,
    color: colors.white,
  },

  subTabBar: {
    borderBottomWidth: 1,
    borderBottomColor: colors.border,
    backgroundColor: colors.white,
  },
  subTabScroll: {
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    gap: spacing.xs,
  },
  subTab: {
    paddingHorizontal: spacing.md,
    paddingVertical: 6,
    borderRadius: radius.full,
    backgroundColor: colors.surface,
  },
  subTabActive: { backgroundColor: colors.brandLight },
  subTabText: {
    fontSize: fontSize.sm,
    fontWeight: fontWeight.medium,
    color: colors.muted,
  },
  subTabTextActive: {
    color: colors.brand,
    fontWeight: fontWeight.semibold,
  },

  content: { flex: 1, backgroundColor: colors.surface },
  contentInner: { padding: spacing.lg, paddingBottom: 40 },

  emptyWrap: { alignItems: 'center', paddingTop: spacing.xl },
  emptyIconBox: {
    width: 68,
    height: 68,
    borderRadius: radius.lg,
    backgroundColor: colors.white,
    borderWidth: 1,
    borderColor: colors.border,
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: spacing.md,
    ...shadows.sm,
  },
  emptyTitle: {
    fontSize: fontSize.lg,
    fontWeight: fontWeight.bold,
    color: colors.dark,
    marginBottom: spacing.xs,
    textAlign: 'center',
  },
  emptySub: {
    fontSize: fontSize.sm,
    color: colors.muted,
    textAlign: 'center',
    lineHeight: 20,
    maxWidth: 300,
    marginBottom: spacing.lg,
  },

  btnPrimary: {
    backgroundColor: colors.brand,
    paddingVertical: 10,
    paddingHorizontal: spacing.lg,
    borderRadius: radius.md,
    alignItems: 'center',
  },
  btnPrimaryText: {
    fontSize: fontSize.sm,
    fontWeight: fontWeight.semibold,
    color: colors.white,
  },
  btnGhost: {
    backgroundColor: colors.white,
    borderWidth: 1,
    borderColor: colors.brand,
    paddingVertical: 10,
    paddingHorizontal: spacing.lg,
    borderRadius: radius.md,
    alignItems: 'center',
  },
  btnGhostText: {
    fontSize: fontSize.sm,
    fontWeight: fontWeight.semibold,
    color: colors.brand,
  },
  manualLink: { marginTop: spacing.md, paddingVertical: spacing.xs },
  manualLinkText: {
    fontSize: fontSize.sm,
    color: colors.brand,
    fontWeight: fontWeight.medium,
  },
});