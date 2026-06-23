import { useState } from 'react';
import {
  View, Text, StyleSheet, TouchableOpacity, ScrollView,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import Svg, { Path, Line, Rect, Circle } from 'react-native-svg';
import { colors, spacing, fontSize, fontWeight, radius, shadows } from '@/constants/theme';

type SubTab = 'feed' | 'budget' | 'categories' | 'accounts';

const SUBTABS: { key: SubTab; label: string }[] = [
  { key: 'feed',       label: 'Transactions' },
  { key: 'budget',     label: 'Budget vs Actual' },
  { key: 'categories', label: 'Custom Categories' },
  { key: 'accounts',   label: 'Accounts' },
];

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

function BoxIcon() {
  return (
    <Svg width={40} height={40} viewBox="0 0 24 24" fill="none" stroke={colors.muted} strokeWidth={1.5}>
      <Path d="M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z" />
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

function FeedEmpty() {
  return (
    <View style={s.emptyWrap}>
      <View style={s.emptyIconBox}><FileIcon /></View>
      <Text style={s.emptyTitle}>No transactions yet</Text>
      <Text style={s.emptySub}>
        Connect a data source or upload past bank statements to start tracking.
      </Text>

      <View style={s.cardRow}>
        <View style={s.sourceCard}>
          <View style={s.sourceCardHead}>
            <Text style={s.sourceCardTitle}>Bank SMS</Text>
            <View style={[s.badge, { backgroundColor: 'rgba(59,130,246,0.1)' }]}>
              <Text style={[s.badgeText, { color: colors.blue }]}>Android</Text>
            </View>
          </View>
          <Text style={s.sourceCardDesc}>
            Parses bank SMS every 30 min. Covers 40+ Indian banks, UPI, EMI, ATM.
          </Text>
          <TouchableOpacity style={s.btnPrimary} activeOpacity={0.8}>
            <Text style={s.btnPrimaryText}>Enable SMS →</Text>
          </TouchableOpacity>
        </View>

        <View style={s.sourceCard}>
          <View style={s.sourceCardHead}>
            <Text style={s.sourceCardTitle}>Email Forward</Text>
            <View style={[s.badge, { backgroundColor: colors.greenLight }]}>
              <Text style={[s.badgeText, { color: '#059669' }]}>All devices</Text>
            </View>
          </View>
          <Text style={s.sourceCardDesc}>
            Forward bank emails to parse@pileap.com. Captures statements, SIPs, receipts.
          </Text>
          <TouchableOpacity style={s.btnGhost} activeOpacity={0.8}>
            <Text style={s.btnGhostText}>Copy email →</Text>
          </TouchableOpacity>
        </View>
      </View>

      <View style={s.uploadCard}>
        <View style={s.uploadCardHead}>
          <Text style={s.sourceCardTitle}>Upload Past Statements</Text>
          <Text style={s.uploadCardSub}>Score all 9 modules now — no waiting</Text>
        </View>
        <View style={s.uploadTypes}>
          {['Bank PDF', 'CAMS / NSDL', 'EPF Passbook'].map((t) => (
            <View key={t} style={s.uploadChip}>
              <Text style={s.uploadChipText}>{t}</Text>
            </View>
          ))}
        </View>
        <TouchableOpacity style={s.btnPrimary} activeOpacity={0.8}>
          <Text style={s.btnPrimaryText}>Upload Statements →</Text>
        </TouchableOpacity>
      </View>

      <TouchableOpacity style={s.manualLink} activeOpacity={0.7}>
        <Text style={s.manualLinkText}>+ Add transaction manually</Text>
      </TouchableOpacity>
    </View>
  );
}

function BudgetEmpty() {
  return (
    <View style={s.emptyWrap}>
      <View style={s.emptyIconBox}><WalletIcon /></View>
      <Text style={s.emptyTitle}>No budget set up yet</Text>
      <Text style={s.emptySub}>
        Your monthly spending plan will appear here once onboarding is complete. Track Fixed, Living, and Investment categories against actual spend.
      </Text>
    </View>
  );
}

function CategoriesEmpty() {
  return (
    <View style={s.emptyWrap}>
      <View style={s.emptyIconBox}><TagIcon /></View>
      <Text style={s.emptyTitle}>No custom categories yet</Text>
      <Text style={s.emptySub}>
        When you correct a transaction's category, Pileap remembers it for that merchant. Your saved rules will appear here.
      </Text>
    </View>
  );
}

function AccountsEmpty() {
  return (
    <View style={s.emptyWrap}>
      <View style={s.emptyIconBox}><BoxIcon /></View>
      <Text style={s.emptyTitle}>No accounts linked</Text>
      <Text style={s.emptySub}>
        Connect Bank SMS or email forwarding to start seeing your linked accounts and data sources here.
      </Text>
      <TouchableOpacity style={[s.btnPrimary, { marginTop: spacing.sm }]} activeOpacity={0.8}>
        <Text style={s.btnPrimaryText}>Set Up Data Source →</Text>
      </TouchableOpacity>
    </View>
  );
}

export default function TransactionsScreen() {
  const [activeTab, setActiveTab] = useState<SubTab>('feed');

  function renderContent() {
    switch (activeTab) {
      case 'feed':       return <FeedEmpty />;
      case 'budget':     return <BudgetEmpty />;
      case 'categories': return <CategoriesEmpty />;
      case 'accounts':   return <AccountsEmpty />;
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
  subTabActive: {
    backgroundColor: colors.brandLight,
  },
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

  cardRow: {
    flexDirection: 'row',
    gap: spacing.sm,
    width: '100%',
    marginBottom: spacing.md,
  },
  sourceCard: {
    flex: 1,
    backgroundColor: colors.white,
    borderRadius: radius.lg,
    borderWidth: 1,
    borderColor: colors.border,
    padding: spacing.md,
    ...shadows.sm,
  },
  sourceCardHead: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: spacing.xs,
  },
  sourceCardTitle: {
    fontSize: fontSize.base,
    fontWeight: fontWeight.semibold,
    color: colors.dark,
  },
  sourceCardDesc: {
    fontSize: fontSize.xs,
    color: colors.muted,
    lineHeight: 17,
    marginBottom: spacing.md,
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

  btnPrimary: {
    backgroundColor: colors.brand,
    paddingVertical: 8,
    borderRadius: radius.md,
    alignItems: 'center',
  },
  btnPrimaryText: {
    fontSize: fontSize.xs,
    fontWeight: fontWeight.semibold,
    color: colors.white,
  },
  btnGhost: {
    backgroundColor: colors.white,
    borderWidth: 1,
    borderColor: colors.brand,
    paddingVertical: 8,
    borderRadius: radius.md,
    alignItems: 'center',
  },
  btnGhostText: {
    fontSize: fontSize.xs,
    fontWeight: fontWeight.semibold,
    color: colors.brand,
  },

  uploadCard: {
    width: '100%',
    backgroundColor: colors.white,
    borderRadius: radius.lg,
    borderWidth: 1,
    borderColor: colors.border,
    padding: spacing.md,
    marginBottom: spacing.md,
    ...shadows.sm,
  },
  uploadCardHead: { marginBottom: spacing.sm },
  uploadCardSub: {
    fontSize: fontSize.xs,
    color: colors.muted,
    marginTop: 2,
  },
  uploadTypes: {
    flexDirection: 'row',
    gap: spacing.xs,
    marginBottom: spacing.md,
  },
  uploadChip: {
    flex: 1,
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius.md,
    paddingVertical: spacing.xs,
    alignItems: 'center',
  },
  uploadChipText: {
    fontSize: 10,
    fontWeight: fontWeight.semibold,
    color: colors.mid,
    textAlign: 'center',
  },

  manualLink: { marginTop: spacing.sm, paddingVertical: spacing.xs },
  manualLinkText: {
    fontSize: fontSize.sm,
    color: colors.brand,
    fontWeight: fontWeight.medium,
  },
});