import { useState } from 'react';
import {
  View, Text, StyleSheet, TouchableOpacity,
  ScrollView, ActivityIndicator, Platform, PermissionsAndroid,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { colors, spacing, fontSize, fontWeight, radius } from '@/constants/theme';
import { SmsReader, SmsMessage } from '../../modules/sms-reader/src/index';
import { parseSmsMessages, ParsedTransaction } from '@/lib/smsParser';

type Status = 'idle' | 'loading' | 'done' | 'error';
type Mode = 'filtered' | 'debug' | 'parsed';

export default function TestSmsScreen() {
  const [status, setStatus]       = useState<Status>('idle');
  const [messages, setMessages]   = useState<SmsMessage[]>([]);
  const [senders, setSenders]     = useState<string[]>([]);
  const [parsed, setParsed]       = useState<ParsedTransaction[]>([]);
  const [error, setError]         = useState<string | null>(null);
  const [hasPerm, setHasPerm]     = useState<boolean | null>(null);
  const [mode, setMode]           = useState<Mode>('filtered');
  const [rawCount, setRawCount]   = useState<number | null>(null);

  async function requestPermission() {
    if (Platform.OS !== 'android') {
      setError('SMS reading is Android only.');
      return;
    }
    try {
      const result = await PermissionsAndroid.request(
        PermissionsAndroid.PERMISSIONS.READ_SMS,
        {
          title: 'Pileap needs SMS access',
          message: 'Pileap reads bank SMS to automatically track your transactions.',
          buttonPositive: 'Allow',
          buttonNegative: 'Deny',
        }
      );
      const granted = result === PermissionsAndroid.RESULTS.GRANTED;
      setHasPerm(granted);
      if (!granted) setError('Permission denied.');
    } catch (e: any) {
      setError(e.message ?? 'Permission request failed');
    }
  }

  async function fetchFiltered() {
    if (!hasPerm) { await requestPermission(); return; }
    setMode('filtered');
    setStatus('loading');
    setError(null);
    setMessages([]);
    setSenders([]);
    setParsed([]);
    setRawCount(null);
    try {
      const result = await SmsReader.getMessages();
      setMessages(result);
      setStatus('done');
    } catch (e: any) {
      setError(e.message ?? 'Unknown error');
      setStatus('error');
    }
  }

  async function fetchDebug() {
    if (!hasPerm) { await requestPermission(); return; }
    setMode('debug');
    setStatus('loading');
    setError(null);
    setMessages([]);
    setSenders([]);
    setParsed([]);
    setRawCount(null);
    try {
      const result = await SmsReader.getAllSenders();
      setRawCount(result.totalCount);
      setSenders(result.senders);
      setStatus('done');
    } catch (e: any) {
      setError(e.message ?? 'Unknown error');
      setStatus('error');
    }
  }

  async function fetchParsed() {
    if (!hasPerm) { await requestPermission(); return; }
    setMode('parsed');
    setStatus('loading');
    setError(null);
    setMessages([]);
    setSenders([]);
    setParsed([]);
    setRawCount(null);
    try {
      const msgs = await SmsReader.getMessages();
      const results = parseSmsMessages(msgs);
      setParsed(results);
      setStatus('done');
    } catch (e: any) {
      setError(e.message ?? 'Unknown error');
      setStatus('error');
    }
  }

  // Summary counts for parsed mode
  const approved   = parsed.filter(p => p.status === 'approved').length;
  const needReview = parsed.filter(p => p.status === 'pending_review').length;
  const failures   = parsed.filter(p => p.parse_failure !== null).length;

  return (
    <SafeAreaView style={s.safe} edges={['top']}>
      <View style={s.header}>
        <Text style={s.title}>SMS Reader — Test</Text>
        <Text style={s.subtitle}>
          Platform: {Platform.OS} {Platform.OS === 'android' ? '✅' : '❌'}
        </Text>
      </View>

      <View style={s.btnRow}>
        <TouchableOpacity style={s.btnSecondary} onPress={requestPermission} activeOpacity={0.8}>
          <Text style={s.btnSecondaryText}>Request Permission</Text>
        </TouchableOpacity>
        <TouchableOpacity style={s.btnPrimary} onPress={fetchFiltered} activeOpacity={0.8}>
          <Text style={s.btnPrimaryText}>Fetch Bank SMS</Text>
        </TouchableOpacity>
      </View>

      {/* Parser test button */}
      <TouchableOpacity style={s.parseBtn} onPress={fetchParsed} activeOpacity={0.8}>
        <Text style={s.parseBtnText}>⚡ Test Parser — Parse All SMS</Text>
      </TouchableOpacity>

      <TouchableOpacity style={s.debugBtn} onPress={fetchDebug} activeOpacity={0.8}>
        <Text style={s.debugBtnText}>🔍 Debug — Show All Senders in Inbox</Text>
      </TouchableOpacity>

      {hasPerm !== null && (
        <View style={[s.permBadge, { backgroundColor: hasPerm ? '#dcfce7' : '#fee2e2' }]}>
          <Text style={{ color: hasPerm ? '#166534' : '#991b1b', fontSize: fontSize.sm, fontWeight: fontWeight.semibold }}>
            READ_SMS: {hasPerm ? 'GRANTED ✅' : 'DENIED ❌'}
          </Text>
        </View>
      )}

      {status === 'loading' && (
        <View style={s.center}>
          <ActivityIndicator size="large" color={colors.brand} />
          <Text style={s.loadingText}>
            {mode === 'debug' ? 'Reading all senders...' : mode === 'parsed' ? 'Parsing SMS...' : 'Reading bank SMS...'}
          </Text>
        </View>
      )}

      {status === 'error' && (
        <View style={s.errorBox}>
          <Text style={s.errorText}>Error: {error}</Text>
        </View>
      )}

      {status === 'done' && mode === 'filtered' && (
        <View style={s.resultHeader}>
          <Text style={s.resultCount}>{messages.length} bank SMS found in last 90 days</Text>
        </View>
      )}

      {status === 'done' && mode === 'debug' && (
        <View style={s.resultHeader}>
          <Text style={s.resultCount}>
            {rawCount} total SMS in inbox · {senders.length} unique senders
          </Text>
          <Text style={s.resultSub}>
            Search for PNBSMS or "Punjab" below to confirm if PNB is present
          </Text>
        </View>
      )}

      {status === 'done' && mode === 'parsed' && (
        <View style={s.resultHeader}>
          <Text style={s.resultCount}>
            {parsed.length} parsed · ✅ {approved} approved · ⏳ {needReview} review · ⚠️ {failures} failed
          </Text>
        </View>
      )}

      <ScrollView style={s.scroll} contentContainerStyle={s.scrollInner}>

        {/* Debug mode */}
        {mode === 'debug' && senders.map((sender, i) => (
          <View key={i} style={[
            s.senderRow,
            (sender.toUpperCase().includes('PNB') ||
             sender.toUpperCase().includes('PUNJAB')) && s.senderRowHighlight,
          ]}>
            <Text style={[
              s.senderText,
              (sender.toUpperCase().includes('PNB') ||
               sender.toUpperCase().includes('PUNJAB')) && s.senderTextHighlight,
            ]}>
              {sender}
            </Text>
          </View>
        ))}

        {/* Filtered mode — raw SMS */}
        {mode === 'filtered' && messages.map((msg, i) => (
          <View key={msg.id} style={s.msgCard}>
            <View style={s.msgCardHead}>
              <Text style={s.msgSender}>{msg.address}</Text>
              <Text style={s.msgDate}>
                {new Date(msg.date).toLocaleDateString('en-IN', {
                  day: '2-digit', month: 'short', year: 'numeric',
                })}
              </Text>
            </View>
            <Text style={s.msgBody}>{msg.body}</Text>
            <Text style={s.msgIndex}>#{i + 1}</Text>
          </View>
        ))}

        {/* Parsed mode — parser output */}
        {mode === 'parsed' && parsed.map((txn, i) => {
          const isOk      = txn.status === 'approved';
          const isFailed  = txn.parse_failure !== null;
          const cardColor = isFailed ? '#fff7ed' : isOk ? '#f0fdf4' : '#fefce8';
          const badge     = isFailed ? `⚠️ ${txn.parse_failure}` : isOk ? '✅ approved' : '⏳ review';

          return (
            <View key={txn.raw_sms_id} style={[s.parsedCard, { backgroundColor: cardColor }]}>
              {/* Row 1 — bank + date */}
              <View style={s.parsedHead}>
                <Text style={s.parsedBank}>{txn.bank ?? txn.raw_sms_id}</Text>
                <Text style={s.parsedDate}>{txn.txn_date}</Text>
              </View>

              {/* Row 2 — amount + direction */}
              {txn.amount !== null && (
                <Text style={[s.parsedAmount, { color: txn.amount > 0 ? '#16a34a' : '#dc2626' }]}>
                  {txn.amount > 0 ? '+' : ''}₹{Math.abs(txn.amount).toLocaleString('en-IN')}
                </Text>
              )}

              {/* Row 3 — type / category / subcategory */}
              <Text style={s.parsedCategory}>
                {[txn.type, txn.category, txn.sub_category].filter(Boolean).join(' › ')}
              </Text>

              {/* Row 4 — merchant + channel */}
              {(txn.merchant || txn.channel) && (
                <Text style={s.parsedMeta}>
                  {[txn.merchant, txn.channel].filter(Boolean).join(' · ')}
                </Text>
              )}

              {/* Row 5 — account + ref */}
              {(txn.account_number_masked || txn.ref_number) && (
                <Text style={s.parsedMeta}>
                  {txn.account_number_masked ? `A/C ••••${txn.account_number_masked}` : ''}
                  {txn.ref_number ? `  Ref: ${txn.ref_number}` : ''}
                </Text>
              )}

              {/* Row 6 — balance */}
              {txn.balance !== null && (
                <Text style={s.parsedMeta}>Bal: ₹{txn.balance.toLocaleString('en-IN')}</Text>
              )}

              {/* Status badge */}
              <Text style={s.parsedBadge}>{badge}</Text>

              {/* Raw body — collapsed */}
              <Text style={s.parsedRaw} numberOfLines={2}>{txn.raw_text}</Text>

              <Text style={s.msgIndex}>#{i + 1}</Text>
            </View>
          );
        })}

      </ScrollView>
    </SafeAreaView>
  );
}

const s = StyleSheet.create({
  safe: { flex: 1, backgroundColor: colors.white },
  header: {
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.md,
    borderBottomWidth: 1,
    borderBottomColor: colors.border,
  },
  title:    { fontSize: fontSize.lg, fontWeight: fontWeight.bold, color: colors.dark },
  subtitle: { fontSize: fontSize.sm, color: colors.muted, marginTop: 2 },
  btnRow: { flexDirection: 'row', gap: spacing.sm, padding: spacing.lg, paddingBottom: spacing.sm },
  btnPrimary: {
    flex: 1, backgroundColor: colors.brand,
    paddingVertical: 10, borderRadius: radius.md, alignItems: 'center',
  },
  btnPrimaryText: { fontSize: fontSize.sm, fontWeight: fontWeight.semibold, color: colors.white },
  btnSecondary: {
    flex: 1, backgroundColor: colors.surface,
    borderWidth: 1, borderColor: colors.border,
    paddingVertical: 10, borderRadius: radius.md, alignItems: 'center',
  },
  btnSecondaryText: { fontSize: fontSize.sm, fontWeight: fontWeight.semibold, color: colors.dark },
  parseBtn: {
    marginHorizontal: spacing.lg,
    marginBottom: spacing.xs,
    backgroundColor: '#eff6ff',
    borderWidth: 1,
    borderColor: '#93c5fd',
    paddingVertical: 10,
    borderRadius: radius.md,
    alignItems: 'center',
  },
  parseBtnText: { fontSize: fontSize.sm, color: '#1d4ed8', fontWeight: fontWeight.semibold },
  debugBtn: {
    marginHorizontal: spacing.lg,
    marginBottom: spacing.sm,
    backgroundColor: '#f3f4f6',
    borderWidth: 1,
    borderColor: '#d1d5db',
    paddingVertical: 10,
    borderRadius: radius.md,
    alignItems: 'center',
  },
  debugBtnText: { fontSize: fontSize.sm, color: '#374151', fontWeight: fontWeight.medium },
  permBadge: {
    marginHorizontal: spacing.lg, padding: spacing.sm,
    borderRadius: radius.md, marginBottom: spacing.sm,
  },
  center:      { alignItems: 'center', paddingTop: spacing.xl },
  loadingText: { marginTop: spacing.md, fontSize: fontSize.sm, color: colors.muted },
  errorBox:    { margin: spacing.lg, padding: spacing.md, backgroundColor: '#fee2e2', borderRadius: radius.md },
  errorText:   { fontSize: fontSize.sm, color: '#991b1b' },
  resultHeader: { paddingHorizontal: spacing.lg, paddingBottom: spacing.xs },
  resultCount:  { fontSize: fontSize.sm, fontWeight: fontWeight.semibold, color: colors.brand },
  resultSub:    { fontSize: fontSize.xs, color: colors.muted, marginTop: 2 },
  scroll:       { flex: 1 },
  scrollInner:  { padding: spacing.lg, paddingBottom: 40, gap: spacing.xs },

  // Raw SMS cards (filtered mode)
  msgCard: {
    backgroundColor: colors.surface, borderRadius: radius.md,
    borderWidth: 1, borderColor: colors.border, padding: spacing.md,
  },
  msgCardHead: { flexDirection: 'row', justifyContent: 'space-between', marginBottom: spacing.xs },
  msgSender:   { fontSize: fontSize.xs, fontWeight: fontWeight.bold, color: colors.brand },
  msgDate:     { fontSize: fontSize.xs, color: colors.muted },
  msgBody:     { fontSize: fontSize.xs, color: colors.dark, lineHeight: 18 },
  msgIndex:    { fontSize: 10, color: colors.muted, marginTop: 4, textAlign: 'right' },

  // Sender rows (debug mode)
  senderRow:          { paddingVertical: 6, paddingHorizontal: spacing.sm, borderRadius: radius.sm, backgroundColor: colors.surface },
  senderRowHighlight: { backgroundColor: '#fef9c3', borderWidth: 1, borderColor: '#fbbf24' },
  senderText:         { fontSize: fontSize.xs, color: colors.dark },
  senderTextHighlight:{ fontWeight: fontWeight.bold, color: '#92400e' },

  // Parsed cards (parsed mode)
  parsedCard:     { borderRadius: radius.md, borderWidth: 1, borderColor: colors.border, padding: spacing.md },
  parsedHead:     { flexDirection: 'row', justifyContent: 'space-between', marginBottom: 2 },
  parsedBank:     { fontSize: fontSize.xs, fontWeight: fontWeight.bold, color: colors.brand },
  parsedDate:     { fontSize: fontSize.xs, color: colors.muted },
  parsedAmount:   { fontSize: fontSize.md, fontWeight: fontWeight.bold, marginVertical: 2 },
  parsedCategory: { fontSize: fontSize.xs, color: colors.dark, marginBottom: 2 },
  parsedMeta:     { fontSize: fontSize.xs, color: colors.muted },
  parsedBadge:    { fontSize: fontSize.xs, fontWeight: fontWeight.semibold, marginTop: 4 },
  parsedRaw:      { fontSize: 10, color: colors.muted, marginTop: 4, fontStyle: 'italic' },
});