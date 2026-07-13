import { useState } from 'react';
import {
  View, Text, StyleSheet, TouchableOpacity,
  ScrollView, ActivityIndicator, Platform, PermissionsAndroid, Alert,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { File, Paths } from 'expo-file-system';
import * as Sharing from 'expo-sharing';
import { colors, spacing, fontSize, fontWeight, radius } from '@/constants/theme';
import { SmsReader, SmsMessage } from '../../modules/sms-reader/src/index';
import { parseSmsMessages, ParsedTransaction, BalanceUpdate, isBalanceUpdate } from '@/lib/smsParser';
import { ingestParsedMessages, IngestResult } from '@/lib/api/transactions';

type Status = 'idle' | 'loading' | 'done' | 'error';
type Mode = 'filtered' | 'debug' | 'parsed';

const DATE_WINDOWS = [
  { label: '0 → 90 days',    fromDays: 0,   toDays: 90  },
  { label: '90 → 180 days',  fromDays: 90,  toDays: 180 },
  { label: '180 → 270 days', fromDays: 180, toDays: 270 },
  { label: '270 → 360 days', fromDays: 270, toDays: 360 },
];

export default function TestSmsScreen() {
  const [status, setStatus]             = useState<Status>('idle');
  const [messages, setMessages]         = useState<SmsMessage[]>([]);
  const [senders, setSenders]           = useState<string[]>([]);
  const [parsed, setParsed]             = useState<ParsedTransaction[]>([]);
  const [balanceUpdates, setBalanceUpdates] = useState<BalanceUpdate[]>([]);
  const [rawMsgs, setRawMsgs]           = useState<SmsMessage[]>([]);
  const [error, setError]               = useState<string | null>(null);
  const [hasPerm, setHasPerm]           = useState<boolean | null>(null);
  const [mode, setMode]                 = useState<Mode>('filtered');
  const [rawCount, setRawCount]         = useState<number | null>(null);
  const [activeWindow, setActiveWindow] = useState<string | null>(null);
  // [ADD] ingestParsedMessages() needs the ORIGINAL (ParsedTransaction |
  // BalanceUpdate)[] union — `parsed` and `balanceUpdates` above were split
  // apart purely for display purposes and can't be recombined losslessly
  // (order doesn't matter for ingest, but keeping a single source of truth
  // avoids ever having to reconstruct it). Kept separate from `parsed` so
  // fixing the earlier type error didn't require touching this at all.
  const [rawParseResults, setRawParseResults] = useState<(ParsedTransaction | BalanceUpdate)[]>([]);
  const [syncStatus, setSyncStatus] = useState<'idle' | 'syncing' | 'done' | 'error'>('idle');
  const [syncResult, setSyncResult] = useState<IngestResult | null>(null);

  async function requestPermission() {
    if (Platform.OS !== 'android') { setError('SMS reading is Android only.'); return; }
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
    setMode('filtered'); setStatus('loading'); setError(null);
    setMessages([]); setSenders([]); setParsed([]); setBalanceUpdates([]); setRawMsgs([]);
    setRawCount(null); setActiveWindow(null);
    try {
      const result = await SmsReader.getMessages(0, 90);
      setMessages(result);
      setStatus('done');
    } catch (e: any) { setError(e.message ?? 'Unknown error'); setStatus('error'); }
  }

  async function fetchDebug() {
    if (!hasPerm) { await requestPermission(); return; }
    setMode('debug'); setStatus('loading'); setError(null);
    setMessages([]); setSenders([]); setParsed([]); setBalanceUpdates([]); setRawMsgs([]);
    setRawCount(null); setActiveWindow(null);
    try {
      const result = await SmsReader.getAllSenders();
      setRawCount(result.totalCount);
      setSenders(result.senders);
      setStatus('done');
    } catch (e: any) { setError(e.message ?? 'Unknown error'); setStatus('error'); }
  }

  async function fetchParsed(fromDays: number, toDays: number, label: string) {
    if (!hasPerm) { await requestPermission(); return; }
    setMode('parsed'); setStatus('loading'); setError(null);
    setMessages([]); setSenders([]); setParsed([]); setBalanceUpdates([]); setRawMsgs([]);
    setRawCount(null); setActiveWindow(label);
    try {
      const msgs = await SmsReader.getMessages(fromDays, toDays);
      // Yield to UI thread before heavy parsing so the loading spinner renders
      await new Promise(resolve => setTimeout(resolve, 0));
      const results = parseSmsMessages(msgs);
      setRawParseResults(results);
      setSyncResult(null);
      setSyncStatus('idle');
      // [FIX] parseSmsMessages() returns (ParsedTransaction | BalanceUpdate)[]
      // since smsParser.ts added the BalanceUpdate branch (pure balance-
      // disclosure SMS never become a transaction row). setParsed() is typed
      // ParsedTransaction[], so passing the raw union straight through was a
      // real type error, not just a strictness nitpick — a BalanceUpdate
      // genuinely doesn't have txn_date/amount/type/category/etc. Split the
      // union with the existing isBalanceUpdate() guard instead of widening
      // the state type and pushing the problem into every render call below
      // that reads txn.amount/txn.category/etc.
      const txns = results.filter((r): r is ParsedTransaction => !isBalanceUpdate(r));
      const balances = results.filter(isBalanceUpdate);
      setParsed(txns);
      setBalanceUpdates(balances);
      setRawMsgs(msgs);
      setStatus('done');
    } catch (e: any) { setError(e.message ?? 'Unknown error'); setStatus('error'); }
  }

  async function exportReport() {
    if (parsed.length === 0) { Alert.alert('Nothing to export', 'Run the parser first.'); return; }

    const report = {
      generated_at: new Date().toISOString(),
      window: activeWindow,
      summary: {
        total:          parsed.length,
        approved:       parsed.filter(p => p.status === 'approved').length,
        pending_review: parsed.filter(p => p.status === 'pending_review').length,
        parse_failures: parsed.filter(p => p.parse_failure !== null).length,
        balance_updates: balanceUpdates.length,
        failure_breakdown: parsed.reduce<Record<string, number>>((acc, p) => {
          if (p.parse_failure) acc[p.parse_failure] = (acc[p.parse_failure] ?? 0) + 1;
          return acc;
        }, {}),
        category_breakdown: parsed.reduce<Record<string, number>>((acc, p) => {
          const key = p.category ?? 'unclassified';
          acc[key] = (acc[key] ?? 0) + 1;
          return acc;
        }, {}),
      },
      transactions: parsed,
      balance_updates: balanceUpdates,
    };

    try {
      const file = new File(Paths.cache, 'pileap_parser_report.json');
      file.write(JSON.stringify(report, null, 2));
      if (await Sharing.isAvailableAsync()) {
        await Sharing.shareAsync(file.uri, {
          mimeType: 'application/json',
          dialogTitle: 'Save Parser Report',
        });
      } else {
        Alert.alert('Saved', `Report saved to:\n${file.uri}`);
      }
    } catch (e: any) {
      Alert.alert('Export failed', e.message ?? 'Unknown error');
    }
  }

  async function syncToSupabase() {
    if (rawParseResults.length === 0) {
      Alert.alert('Nothing to sync', 'Run the parser first.');
      return;
    }

    // [FLAG] No idempotency key exists on `transactions` yet (see the
    // KNOWN GAPS note at the top of src/lib/api/transactions.ts) —
    // re-syncing the same window WILL insert duplicate rows. This confirm
    // step is a manual guard for testing only, not a real dedup solution.
    // Deliberately deferred per project decision until the parsing →
    // review → edit/split flow is confirmed working end-to-end.
    Alert.alert(
      'Sync to Supabase?',
      `This will insert ${parsed.length} transaction(s) and apply ${balanceUpdates.length} balance update(s). ` +
      `There is no duplicate-detection yet — re-syncing the same window will create duplicate rows. Continue?`,
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Sync',
          style: 'destructive',
          onPress: async () => {
            setSyncStatus('syncing');
            setSyncResult(null);
            try {
              const result = await ingestParsedMessages(rawParseResults);
              setSyncResult(result);
              setSyncStatus('done');
              Alert.alert(
                'Sync complete',
                `${result.transactionsInserted} transaction(s) inserted, ` +
                `${result.balancesUpdated} balance update(s) applied` +
                (result.errors.length > 0 ? `, ${result.errors.length} error(s) — see details below.` : '.'),
              );
            } catch (e: any) {
              setSyncStatus('error');
              Alert.alert('Sync failed', e.message ?? 'Unknown error');
            }
          },
        },
      ],
    );
  }


  async function exportRawSms(fromDays: number, toDays: number, label: string) {
    if (!hasPerm) { await requestPermission(); return; }
    try {
      setStatus('loading');
      setError(null);

      const allMsgs = await SmsReader.getAllMessages(fromDays, toDays);

      const output = {
        generated_at:  new Date().toISOString(),
        window:        label,
        from_days_ago: fromDays,
        to_days_ago:   toDays,
        total_count:   allMsgs.length,
        messages: allMsgs.map((msg: any) => ({
          id:      msg.id,
          address: msg.address,
          date:    new Date(msg.date).toISOString().split('T')[0],
          body:    msg.body,
        })),
      };

      const filename = `raw_text_${label.replace(/[\s→]+/g, '_')}.json`;
      const file = new File(Paths.cache, filename);
      file.write(JSON.stringify(output, null, 2));

      setStatus('done');

      if (await Sharing.isAvailableAsync()) {
        await Sharing.shareAsync(file.uri, {
          mimeType: 'application/json',
          dialogTitle: `Save ${filename}`,
        });
      } else {
        Alert.alert('Saved', `File saved to:\n${file.uri}`);
      }
    } catch (e: any) {
      setError(e.message ?? 'Export failed');
      setStatus('error');
    }
  }

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

      <ScrollView style={s.scroll} contentContainerStyle={s.scrollInner}>

        {/* ── Permission + Fetch filtered ── */}
        <View style={s.btnRow}>
          <TouchableOpacity style={s.btnSecondary} onPress={requestPermission} activeOpacity={0.8}>
            <Text style={s.btnSecondaryText}>Request Permission</Text>
          </TouchableOpacity>
          <TouchableOpacity style={s.btnPrimary} onPress={fetchFiltered} activeOpacity={0.8}>
            <Text style={s.btnPrimaryText}>Fetch Bank SMS</Text>
          </TouchableOpacity>
        </View>

        <TouchableOpacity style={s.debugBtn} onPress={fetchDebug} activeOpacity={0.8}>
          <Text style={s.debugBtnText}>🔍 Debug — Show All Senders in Inbox</Text>
        </TouchableOpacity>

        {/* ── Parse buttons — one per 90-day window ── */}
        <View style={s.sectionHeader}>
          <Text style={s.sectionTitle}>⚡ PARSE SMS — Filter + parse by window</Text>
        </View>

        {DATE_WINDOWS.map(({ label, fromDays, toDays }) => (
          <TouchableOpacity
            key={label}
            style={[
              s.parseBtn,
              activeWindow === label && status === 'done' && s.parseBtnActive,
            ]}
            onPress={() => fetchParsed(fromDays, toDays, label)}
            activeOpacity={0.8}
          >
            <Text style={s.parseBtnText}>
              ⚡ Parse {label}
              {activeWindow === label && status === 'done' ? `  ·  ${parsed.length} txns` : ''}
            </Text>
          </TouchableOpacity>
        ))}

        {/* Export parsed report — only shown after parsing */}
        {mode === 'parsed' && status === 'done' && (
          <TouchableOpacity style={s.exportBtn} onPress={exportReport} activeOpacity={0.8}>
            <Text style={s.exportBtnText}>📥 Export Report — {activeWindow}</Text>
          </TouchableOpacity>
        )}

        {/* Sync to Supabase — manual, no dedup yet (see syncToSupabase comment) */}
        {mode === 'parsed' && status === 'done' && (
          <TouchableOpacity
            style={[s.syncBtn, syncStatus === 'syncing' && s.syncBtnDisabled]}
            onPress={syncToSupabase}
            disabled={syncStatus === 'syncing'}
            activeOpacity={0.8}
          >
            {syncStatus === 'syncing' ? (
              <ActivityIndicator color="#065f46" />
            ) : (
              <Text style={s.syncBtnText}>☁️ Sync to Supabase — {activeWindow}</Text>
            )}
          </TouchableOpacity>
        )}

        {syncResult && (
          <View style={s.syncResultBox}>
            <Text style={s.syncResultText}>
              ✅ {syncResult.transactionsInserted} inserted · 🏦 {syncResult.balancesUpdated} balance updates
              {syncResult.errors.length > 0 ? ` · ⚠️ ${syncResult.errors.length} errors` : ''}
            </Text>
            {syncResult.errors.slice(0, 5).map((err, i) => (
              <Text key={i} style={s.syncErrorText}>#{err.raw_sms_id}: {err.message}</Text>
            ))}
          </View>
        )}

        {/* ── Raw SMS export buttons ── */}
        <View style={s.sectionHeader}>
          <Text style={s.sectionTitle}>📤 EXPORT RAW SMS — All messages, no filter</Text>
        </View>

        {DATE_WINDOWS.map(({ label, fromDays, toDays }) => (
          <TouchableOpacity
            key={label}
            style={s.rawBtn}
            onPress={() => exportRawSms(fromDays, toDays, label)}
            activeOpacity={0.8}
          >
            <Text style={s.rawBtnText}>Export {label}</Text>
          </TouchableOpacity>
        ))}

        {/* ── Permission badge ── */}
        {hasPerm !== null && (
          <View style={[s.permBadge, { backgroundColor: hasPerm ? '#dcfce7' : '#fee2e2' }]}>
            <Text style={{ color: hasPerm ? '#166534' : '#991b1b', fontSize: fontSize.sm, fontWeight: fontWeight.semibold }}>
              READ_SMS: {hasPerm ? 'GRANTED ✅' : 'DENIED ❌'}
            </Text>
          </View>
        )}

        {/* ── Status ── */}
        {status === 'loading' && (
          <View style={s.center}>
            <ActivityIndicator size="large" color={colors.brand} />
            <Text style={s.loadingText}>
              {mode === 'debug'
                ? 'Reading all senders...'
                : mode === 'parsed'
                ? `Parsing ${activeWindow}...`
                : 'Reading SMS...'}
            </Text>
          </View>
        )}

        {status === 'error' && (
          <View style={s.errorBox}><Text style={s.errorText}>Error: {error}</Text></View>
        )}

        {/* ── Result headers ── */}
        {status === 'done' && mode === 'filtered' && (
          <View style={s.resultHeader}>
            <Text style={s.resultCount}>{messages.length} bank SMS found (last 90 days)</Text>
          </View>
        )}

        {status === 'done' && mode === 'debug' && (
          <View style={s.resultHeader}>
            <Text style={s.resultCount}>
              {rawCount} total SMS in inbox · {senders.length} unique senders
            </Text>
            <Text style={s.resultSub}>Search for PNBSMS or "Punjab" below to confirm if PNB is present</Text>
          </View>
        )}

        {status === 'done' && mode === 'parsed' && (
          <View style={s.resultHeader}>
            <Text style={s.resultCount}>
              {activeWindow} · {parsed.length} parsed · ✅ {approved} approved · ⏳ {needReview} review · ⚠️ {failures} failed
            </Text>
            {balanceUpdates.length > 0 && (
              <Text style={s.resultSub}>🏦 {balanceUpdates.length} balance-disclosure SMS (not transactions, routed to accounts.balance_latest)</Text>
            )}
          </View>
        )}

        {/* ── Message lists ── */}
        {mode === 'debug' && senders.map((sender, i) => (
          <View key={i} style={[
            s.senderRow,
            (sender.toUpperCase().includes('PNB') || sender.toUpperCase().includes('PUNJAB')) && s.senderRowHighlight,
          ]}>
            <Text style={[
              s.senderText,
              (sender.toUpperCase().includes('PNB') || sender.toUpperCase().includes('PUNJAB')) && s.senderTextHighlight,
            ]}>
              {sender}
            </Text>
          </View>
        ))}

        {mode === 'filtered' && messages.map((msg, i) => (
          <View key={msg.id} style={s.msgCard}>
            <View style={s.msgCardHead}>
              <Text style={s.msgSender}>{msg.address}</Text>
              <Text style={s.msgDate}>
                {new Date(msg.date).toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' })}
              </Text>
            </View>
            <Text style={s.msgBody}>{msg.body}</Text>
            <Text style={s.msgIndex}>#{i + 1}</Text>
          </View>
        ))}

        {mode === 'parsed' && parsed.map((txn, i) => {
          const isOk      = txn.status === 'approved';
          const isFailed  = txn.parse_failure !== null;
          const cardColor = isFailed ? '#fff7ed' : isOk ? '#f0fdf4' : '#fefce8';
          const badge     = isFailed ? `⚠️ ${txn.parse_failure}` : isOk ? '✅ approved' : '⏳ review';

          return (
            <View key={txn.raw_sms_id} style={[s.parsedCard, { backgroundColor: cardColor }]}>
              <View style={s.parsedHead}>
                <Text style={s.parsedBank}>{txn.bank ?? '—'}</Text>
                <Text style={s.parsedDate}>{txn.txn_date}</Text>
              </View>
              {txn.amount !== null && (
                <Text style={[s.parsedAmount, { color: txn.amount > 0 ? '#16a34a' : '#dc2626' }]}>
                  {txn.amount > 0 ? '+' : ''}₹{Math.abs(txn.amount).toLocaleString('en-IN')}
                </Text>
              )}
              <Text style={s.parsedCategory}>
                {[txn.type, txn.category, txn.sub_category].filter(Boolean).join(' › ')}
              </Text>
              {(txn.merchant || txn.channel) && (
                <Text style={s.parsedMeta}>{[txn.merchant, txn.channel].filter(Boolean).join(' · ')}</Text>
              )}
              {(txn.account_number_masked || txn.ref_number) && (
                <Text style={s.parsedMeta}>
                  {txn.account_number_masked ? `A/C ••••${txn.account_number_masked}` : ''}
                  {txn.ref_number ? `  Ref: ${txn.ref_number}` : ''}
                </Text>
              )}
              {txn.balance !== null && (
                <Text style={s.parsedMeta}>Bal: ₹{txn.balance.toLocaleString('en-IN')}</Text>
              )}
              <Text style={s.parsedBadge}>{badge}</Text>
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
  safe:         { flex: 1, backgroundColor: colors.white },
  header:       { paddingHorizontal: spacing.lg, paddingVertical: spacing.md, borderBottomWidth: 1, borderBottomColor: colors.border },
  title:        { fontSize: fontSize.lg, fontWeight: fontWeight.bold, color: colors.dark },
  subtitle:     { fontSize: fontSize.sm, color: colors.muted, marginTop: 2 },
  scroll:       { flex: 1 },
  scrollInner:  { padding: spacing.lg, paddingBottom: 40, gap: spacing.xs },

  btnRow:           { flexDirection: 'row', gap: spacing.sm },
  btnPrimary:       { flex: 1, backgroundColor: colors.brand, paddingVertical: 10, borderRadius: radius.md, alignItems: 'center' },
  btnPrimaryText:   { fontSize: fontSize.sm, fontWeight: fontWeight.semibold, color: colors.white },
  btnSecondary:     { flex: 1, backgroundColor: colors.surface, borderWidth: 1, borderColor: colors.border, paddingVertical: 10, borderRadius: radius.md, alignItems: 'center' },
  btnSecondaryText: { fontSize: fontSize.sm, fontWeight: fontWeight.semibold, color: colors.dark },

  parseBtn:       { backgroundColor: '#eff6ff', borderWidth: 1, borderColor: '#93c5fd', paddingVertical: 10, borderRadius: radius.md, alignItems: 'center' },
  parseBtnActive: { backgroundColor: '#dbeafe', borderColor: '#3b82f6' },
  parseBtnText:   { fontSize: fontSize.sm, color: '#1d4ed8', fontWeight: fontWeight.semibold },

  exportBtn:     { backgroundColor: '#f0fdf4', borderWidth: 1, borderColor: '#86efac', paddingVertical: 10, borderRadius: radius.md, alignItems: 'center' },
  exportBtnText: { fontSize: fontSize.sm, color: '#15803d', fontWeight: fontWeight.semibold },

  syncBtn:         { backgroundColor: '#d1fae5', borderWidth: 1, borderColor: '#34d399', paddingVertical: 10, borderRadius: radius.md, alignItems: 'center' },
  syncBtnDisabled: { opacity: 0.6 },
  syncBtnText:     { fontSize: fontSize.sm, color: '#065f46', fontWeight: fontWeight.bold },

  syncResultBox:  { padding: spacing.sm, backgroundColor: '#ecfdf5', borderRadius: radius.md, borderWidth: 1, borderColor: '#a7f3d0' },
  syncResultText: { fontSize: fontSize.xs, fontWeight: fontWeight.semibold, color: '#065f46' },
  syncErrorText:  { fontSize: 10, color: '#b91c1c', marginTop: 2 },

  debugBtn:     { backgroundColor: '#f3f4f6', borderWidth: 1, borderColor: '#d1d5db', paddingVertical: 10, borderRadius: radius.md, alignItems: 'center' },
  debugBtnText: { fontSize: fontSize.sm, color: '#374151', fontWeight: fontWeight.medium },

  sectionHeader: { marginTop: spacing.md, marginBottom: spacing.xs },
  sectionTitle:  { fontSize: fontSize.xs, fontWeight: fontWeight.semibold, color: colors.muted, letterSpacing: 0.5 },

  rawBtn:     { backgroundColor: '#fdf4ff', borderWidth: 1, borderColor: '#d8b4fe', paddingVertical: 10, borderRadius: radius.md, alignItems: 'center' },
  rawBtnText: { fontSize: fontSize.sm, color: '#7c3aed', fontWeight: fontWeight.semibold },

  permBadge:   { padding: spacing.sm, borderRadius: radius.md },
  center:      { alignItems: 'center', paddingTop: spacing.xl },
  loadingText: { marginTop: spacing.md, fontSize: fontSize.sm, color: colors.muted },
  errorBox:    { padding: spacing.md, backgroundColor: '#fee2e2', borderRadius: radius.md },
  errorText:   { fontSize: fontSize.sm, color: '#991b1b' },

  resultHeader: { paddingBottom: spacing.xs },
  resultCount:  { fontSize: fontSize.sm, fontWeight: fontWeight.semibold, color: colors.brand },
  resultSub:    { fontSize: fontSize.xs, color: colors.muted, marginTop: 2 },

  msgCard:     { backgroundColor: colors.surface, borderRadius: radius.md, borderWidth: 1, borderColor: colors.border, padding: spacing.md },
  msgCardHead: { flexDirection: 'row', justifyContent: 'space-between', marginBottom: spacing.xs },
  msgSender:   { fontSize: fontSize.xs, fontWeight: fontWeight.bold, color: colors.brand },
  msgDate:     { fontSize: fontSize.xs, color: colors.muted },
  msgBody:     { fontSize: fontSize.xs, color: colors.dark, lineHeight: 18 },
  msgIndex:    { fontSize: 10, color: colors.muted, marginTop: 4, textAlign: 'right' },

  senderRow:           { paddingVertical: 6, paddingHorizontal: spacing.sm, borderRadius: radius.sm, backgroundColor: colors.surface },
  senderRowHighlight:  { backgroundColor: '#fef9c3', borderWidth: 1, borderColor: '#fbbf24' },
  senderText:          { fontSize: fontSize.xs, color: colors.dark },
  senderTextHighlight: { fontWeight: fontWeight.bold, color: '#92400e' },

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