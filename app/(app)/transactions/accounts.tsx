import {
  View, Text, StyleSheet, TouchableOpacity,
} from 'react-native';
import Svg, { Path, Rect, Polyline } from 'react-native-svg';
import { colors, spacing, fontSize, fontWeight, radius, shadows } from '@/constants/theme';

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

// ─── Component ────────────────────────────────────────────────────────────────
// Shows data sources that feed the transactions table only:
//   • Bank SMS (live, Android)
//   • Email Forwarding (live, all platforms)
//   • Bank PDF statement (upload)
//   • CAMS / NSDL CAS PDF (upload — SIP & lumpsum rows → transactions)
//
// EPF, NPS, PPF/FD, Insurance → Modules → Data Inputs (balance-only, no txn rows)

export default function AccountsTab() {
  return (
    <View style={s.wrap}>

      {/* ── Live sources ── */}
      <Text style={s.sectionLabel}>Live Data Sources</Text>

      {/* Bank SMS */}
      <View style={s.card}>
        <View style={s.cardHead}>
          <Text style={s.cardTitle}>Bank SMS</Text>
          <View style={[s.badge, { backgroundColor: 'rgba(59,130,246,0.1)' }]}>
            <Text style={[s.badgeText, { color: colors.blue }]}>Android</Text>
          </View>
        </View>
        <Text style={s.cardDesc}>
          Parses bank SMS every 30 min and on app open. Covers 40+ Indian banks —
          UPI, NEFT, card swipes, ATM, EMI debits.
        </Text>
        <View style={s.steps}>
          {[
            'Open Pileap Android app',
            'Settings → Data Sources → Enable SMS',
            'Parsing begins automatically',
          ].map((step, i) => (
            <View key={i} style={s.stepRow}>
              <Text style={s.stepNum}>{i + 1}</Text>
              <Text style={s.stepText}>{step}</Text>
            </View>
          ))}
        </View>
        <TouchableOpacity style={s.btnPrimary} activeOpacity={0.8}>
          <Text style={s.btnPrimaryText}>Enable SMS →</Text>
        </TouchableOpacity>
      </View>

      {/* Email Forwarding */}
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
        <View style={s.steps}>
          {[
            'Open your bank email account settings',
            'Add forwarding rule → parse@pileap.com',
            'All future statements parse automatically',
          ].map((step, i) => (
            <View key={i} style={s.stepRow}>
              <Text style={s.stepNum}>{i + 1}</Text>
              <Text style={s.stepText}>{step}</Text>
            </View>
          ))}
        </View>
        <TouchableOpacity style={s.btnGhost} activeOpacity={0.8}>
          <Text style={s.btnGhostText}>Copy email address →</Text>
        </TouchableOpacity>
      </View>

      {/* ── Upload: only docs that generate transaction rows ── */}
      <Text style={[s.sectionLabel, { marginTop: spacing.lg }]}>
        Upload Past Statements
      </Text>
      <Text style={s.sectionSub}>
        Only documents that generate transaction rows. EPF, NPS, PPF/FD, and
        Insurance are balance inputs — add them under Modules → Data Inputs.
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

      <TouchableOpacity style={[s.btnPrimary, { marginTop: spacing.sm }]} activeOpacity={0.8}>
        <Text style={s.btnPrimaryText}>Upload Statements →</Text>
      </TouchableOpacity>

    </View>
  );
}

// ─── Styles ───────────────────────────────────────────────────────────────────

const s = StyleSheet.create({
  wrap: { width: '100%' },

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

  steps: { gap: 6, marginBottom: spacing.md },
  stepRow: { flexDirection: 'row', alignItems: 'flex-start', gap: 8 },
  stepNum: {
    fontSize: fontSize.xs,
    fontWeight: fontWeight.bold,
    color: colors.brand,
    width: 14,
  },
  stepText: {
    fontSize: fontSize.xs,
    color: colors.mid,
    flex: 1,
    lineHeight: 17,
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
});