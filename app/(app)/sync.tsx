/**
 * app/(app)/sync.tsx
 * Replaces app/(app)/test-sms.tsx as the tab's route file — delete
 * test-sms.tsx after this lands (see app/(app)/_layout.tsx for the tab
 * bar entry rename that goes with this).
 *
 * [REDESIGN — this pass] Was a manual test harness (pick a day window,
 * tap Parse, tap Sync). Automatic sync (on app open + hourly background
 * task, see smsSync.ts / backgroundSync.ts) now handles the real flow,
 * so this screen becomes a status view for the end user:
 *   - SMS access + last-synced status card
 *   - "Sync Now" — manual trigger, for demo/troubleshooting
 *   - "Export All Transactions" — Excel download
 *   - New-account review (unchanged data model, just relocated UI is a
 *     separate, later change — not part of this pass)
 *
 * The old manual parse-by-window / raw-SMS-export / detailed per-message
 * debug view is NOT deleted — it's still genuinely useful for tuning the
 * parser — but it's moved behind a collapsed "Debug Tools" section, off
 * by default, so a client demo shows a finished product rather than a
 * dev screen. All of that logic (fetchParsed/exportReport/syncToSupabase/
 * exportRawSms) is unchanged from test-sms.tsx.
 */
import { useState, useEffect, useRef, useCallback } from 'react';
import {
  View, Text, StyleSheet, TouchableOpacity,
  ScrollView, ActivityIndicator, Platform, PermissionsAndroid, Alert, Linking,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { File, Paths } from 'expo-file-system';
import * as Sharing from 'expo-sharing';
import { useNavigation } from 'expo-router';
import { colors, spacing, fontSize, fontWeight, radius } from '@/constants/theme';
import { SmsReader, SmsMessage } from '../../modules/sms-reader/src/index';
import { parseSmsMessages, logLayer1Candidates, ParsedTransaction, BalanceUpdate, isBalanceUpdate, MatchContext, ParseLogs } from '@/lib/smsParser';
import { ingestParsedMessages, IngestResult, fetchTransactions } from '@/lib/api/transactions';
import { fetchActiveRegisteredFacts } from '@/lib/api/registeredFacts';
import { fetchCustomCategories } from '@/lib/api/customCategories';
import { syncParseLogs, ParseLogSyncResult } from '@/lib/api/parseLogs';
import {
  syncRecentSmsMessages, getLastSyncedAt, subscribeSyncStatus,
  type SmsSyncResult, type SyncProgressUpdate,
} from '@/lib/services/smsSync';
import {
  exportTransactionsToExcel, fetchAllTransactionsForExport,
  getAvailableExportYears, getAvailableExportMonthsForYear,
  monthLabel, type ExportRange,
} from '@/lib/services/exportTransactions';
import type { Transaction } from '@/lib/api/transactions';

type Status = 'idle' | 'loading' | 'done' | 'error';

// [ADD] Three-way permission state, replacing the old boolean. Android's
// PermissionsAndroid.request() can return a THIRD outcome beyond granted/
// denied — 'never_ask_again', once the user has denied twice (or checked
// "don't ask again"). Previously that state was indistinguishable from a
// plain first-time "not yet granted" — tapping "Enable" would silently
// do nothing (the OS stops showing its own dialog once never_ask_again
// is reached), a dead end with no explanation and no way forward.
type PermState = 'unknown' | 'granted' | 'denied' | 'never_ask_again';

const DATE_WINDOWS = [
  { label: '0 → 90 days',    fromDays: 0,   toDays: 90  },
  { label: '90 → 180 days',  fromDays: 90,  toDays: 180 },
];

function formatRelativeTime(date: Date | null): string {
  if (!date) return 'Never';
  const diffMs = Date.now() - date.getTime();
  const mins = Math.floor(diffMs / 60000);
  if (mins < 1) return 'Just now';
  if (mins < 60) return `${mins} minute${mins === 1 ? '' : 's'} ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours} hour${hours === 1 ? '' : 's'} ago`;
  const days = Math.floor(hours / 24);
  return `${days} day${days === 1 ? '' : 's'} ago`;
}

export default function SyncScreen() {
  // ── Status-card state ──
  const [permState, setPermState] = useState<PermState>('unknown');
  const [lastSyncedAt, setLastSyncedAt] = useState<Date | null>(null);
  // [ADD] Reflects ANY sync in progress — app-open, background task, or
  // this screen's own "Sync Now" — via smsSync.ts's pub/sub signal. See
  // that file's docblock for why this exists separately from
  // manualSyncing below.
  const [syncingAnywhere, setSyncingAnywhere] = useState(false);
  const [manualSyncing, setManualSyncing] = useState(false);
  // [ADD] `manualSyncing` state only reflects reality AFTER React commits
  // the re-render `setManualSyncing(true)` triggers — it does not update
  // synchronously. A fast double-tap can fire both onPress calls before
  // that commit happens, so both read the same stale `false` and both
  // pass the `if (manualSyncing...) return;` guard below. A ref updates
  // immediately, in the same tick, with no render dependency — closing
  // that race at the source instead of relying on the button's `disabled`
  // prop (which has the identical stale-render problem) to prevent the
  // second tap from ever reaching handleSyncNow in the first place.
  const manualSyncingRef = useRef(false);
  const [manualSyncResult, setManualSyncResult] = useState<SmsSyncResult | null>(null);
  // [ADD] Live progress during a manual sync — populated via the
  // [CHANGE] Now holds the full staged update, not just a flat
  // (processed, total) pair — see smsSync.ts's SyncProgressUpdate.
  const [manualSyncProgress, setManualSyncProgress] = useState<SyncProgressUpdate | null>(null);
  const [exporting, setExporting] = useState(false);
  const [showDebugTools, setShowDebugTools] = useState(false);
  // [ADD] Total synced transaction count for the status card.
  const [txnCount, setTxnCount] = useState<number | null>(null);

  // ── Export panel state ──
  // exportCache holds the one full fetch shared between populating the
  // "pick a month" list and running the actual export — see
  // fetchAllTransactionsForExport()'s docblock for why this is cached
  // here rather than re-fetched per action.
  const [exportPanelOpen, setExportPanelOpen] = useState(false);
  const [exportCache, setExportCache] = useState<Transaction[] | null>(null);
  const [loadingMonths, setLoadingMonths] = useState(false);

  const refreshLastSynced = useCallback(async () => {
    setLastSyncedAt(await getLastSyncedAt());
  }, []);

  // [ADD] Refreshes the status card's transaction count. Cheap — reuses
  // fetchTransactions()'s own count:'exact' query with pageSize:1, same
  // pattern exportTransactions.ts and other call sites already use rather
  // than a separate dedicated count endpoint.
  const refreshTxnCount = useCallback(async () => {
    try {
      const { totalCount } = await fetchTransactions({
        statuses: ['approved', 'pending_review', 'user_reviewed', 'haiku_suggested'],
        page: 0,
        pageSize: 1,
      });
      setTxnCount(totalCount);
    } catch {
      // Non-critical display data — a failed count fetch shouldn't show
      // an error banner over the whole screen, just leave it blank.
      setTxnCount(null);
    }
  }, []);

  useEffect(() => {
    refreshLastSynced();
    refreshTxnCount();

    if (Platform.OS === 'android') {
      PermissionsAndroid.check(PermissionsAndroid.PERMISSIONS.READ_SMS).then((granted) => {
        setPermState(granted ? 'granted' : 'denied');
      });
    }

    // [ADD] Subscribe to the shared sync-status signal — reflects a sync
    // this screen didn't itself trigger (app-open effect, background
    // task), not just this.manualSyncing.
    const unsubscribe = subscribeSyncStatus((syncing) => {
      setSyncingAnywhere(syncing);
      // A sync that just finished (anywhere) is a good moment to refresh
      // the displayed watermark/count without the user having to do
      // anything — e.g. the app-open auto-sync completing while they're
      // sitting on this screen.
      if (!syncing) {
        refreshLastSynced();
        refreshTxnCount();
      }
    });
    return unsubscribe;
  }, [refreshLastSynced, refreshTxnCount]);

  async function handleRequestPermission() {
    if (Platform.OS !== 'android') return;

    if (permState === 'never_ask_again') {
      // [ADD] The OS won't show its own dialog again at this point — the
      // only real path forward is the app's Settings page.
      Linking.openSettings();
      return;
    }

    const result = await PermissionsAndroid.request(
      PermissionsAndroid.PERMISSIONS.READ_SMS,
      {
        title: 'Pileap needs SMS access',
        message: 'Pileap reads bank SMS to automatically track your transactions.',
        buttonPositive: 'Allow',
        buttonNegative: 'Deny',
      }
    );
    if (result === PermissionsAndroid.RESULTS.GRANTED) setPermState('granted');
    else if (result === PermissionsAndroid.RESULTS.NEVER_ASK_AGAIN) setPermState('never_ask_again');
    else setPermState('denied');
  }

  async function handleSyncNow() {
    // [FIX] Checked on the ref, not the `manualSyncing` state value — see
    // the ref's docblock above for why the state read alone isn't safe
    // against a fast double-tap.
    if (manualSyncingRef.current || syncingAnywhere) return;
    manualSyncingRef.current = true;
    setManualSyncing(true);
    setManualSyncResult(null);
    setManualSyncProgress(null);
    try {
      const result = await syncRecentSmsMessages(true, (update) => {
        setManualSyncProgress(update);
      });
      setManualSyncResult(result);
      await refreshLastSynced();
      await refreshTxnCount();
    } catch (e: any) {
      Alert.alert('Sync failed', e.message ?? 'Unknown error');
    } finally {
      manualSyncingRef.current = false;
      setManualSyncing(false);
      setManualSyncProgress(null);
    }
  }

  // [ADD] Turns a SyncProgressUpdate into a human sentence — the actual
  // "narrate what's happening" piece. Each stage reads as a distinct,
  // reassuring step rather than one number slowly climbing.
  function describeSyncProgress(update: SyncProgressUpdate | null): string | null {
    if (!update) return null;
    if (update.stage === 'reading') return 'Reading your messages…';
    if (update.stage === 'parsing') {
      return update.messagesScanned
        ? `Found ${update.messagesScanned} messages, checking for transactions…`
        : 'Checking for transactions…';
    }
    if (update.stage === 'saving') {
      return update.total
        ? `Saving transactions… ${update.processed ?? 0}/${update.total}`
        : 'Saving transactions…';
    }
    return null;
  }

  async function handleOpenExportPanel() {
    if (exportPanelOpen) { setExportPanelOpen(false); setSelectedYear(null); return; }
    setExportPanelOpen(true);
    if (exportCache) return; // already fetched this session
    setLoadingMonths(true);
    try {
      setExportCache(await fetchAllTransactionsForExport());
    } catch (e: any) {
      Alert.alert('Couldn\u2019t load transactions', e.message ?? 'Unknown error');
      setExportPanelOpen(false);
    } finally {
      setLoadingMonths(false);
    }
  }

  async function handleExport(range: ExportRange) {
    if (exporting) return;
    setExporting(true);
    try {
      const { rowCount } = await exportTransactionsToExcel(range, exportCache ?? undefined);
      if (rowCount === 0) Alert.alert('Nothing to export', 'No transactions in that range.');
      else { setExportPanelOpen(false); setSelectedYear(null); }
    } catch (e: any) {
      Alert.alert('Export failed', e.message ?? 'Unknown error');
    } finally {
      setExporting(false);
    }
  }

  // [ADD] Year/month drill-down state — replaces the old flat "every
  // month that has data" list as the primary specific-date picker. Year
  // selection is local UI state (not part of ExportRange itself) since
  // picking a year alone doesn't export anything — it just reveals
  // "Whole Year" + that year's months to choose from underneath it.
  const [selectedYear, setSelectedYear] = useState<string | null>(null);
  const availableYears = exportCache ? getAvailableExportYears(exportCache) : [];
  const monthsForSelectedYear = exportCache && selectedYear
    ? getAvailableExportMonthsForYear(exportCache, selectedYear)
    : [];

  return (
    <SafeAreaView style={s.safe} edges={['top']}>
      <View style={s.header}>
        <Text style={s.title}>Sync</Text>
        <Text style={s.subtitle}>Your transactions, kept up to date automatically</Text>
      </View>

      <ScrollView style={s.scroll} contentContainerStyle={s.scrollInner}>

        {/* ── First-sync anticipatory banner ── */}
        {/* [ADD] Only shown before the very first sync has ever completed
            (lastSyncedAt still null) and nothing is currently running —
            sets the expectation UP FRONT that this one will take longer,
            so the wait reads as "expected" rather than "is this stuck."
            Disappears permanently after the first successful sync.
            [FIX] Deliberately gives NO specific duration ("under a
            minute" etc.) — confirmed in practice that syncing 200
            messages to Supabase alone can take well over a minute, so
            any concrete number risks being wrong and undermining trust
            exactly when this banner is trying to build it. Explains WHY
            it's slower instead of promising HOW LONG — true regardless
            of message volume or connection speed. */}
        {!lastSyncedAt && !syncingAnywhere && !manualSyncing && (
          <View style={s.firstSyncBanner}>
            <Text style={s.firstSyncBannerTitle}>👋 First sync</Text>
            <Text style={s.firstSyncBannerText}>
              We'll scan your last 90 days of bank messages — this one-time setup takes a little longer than usual. After that, syncing is much faster.
            </Text>
          </View>
        )}

        {/* ── Status card ── */}
        <View style={s.statusCard}>
          <View style={s.statusRow}>
            <Text style={s.statusLabel}>SMS Access</Text>
            {permState === 'unknown' ? (
              <ActivityIndicator size="small" color={colors.brand} />
            ) : permState === 'granted' ? (
              <Text style={s.statusValueGood}>Enabled ✅</Text>
            ) : permState === 'never_ask_again' ? (
              // [ADD] Distinct copy + action for the "OS won't ask again"
              // case — see PermState's docblock above. Deep-links to the
              // app's own Settings page instead of re-prompting, since
              // re-prompting silently does nothing at this point.
              <TouchableOpacity onPress={handleRequestPermission}>
                <Text style={s.statusValueAction}>Open Settings →</Text>
              </TouchableOpacity>
            ) : (
              <TouchableOpacity onPress={handleRequestPermission}>
                <Text style={s.statusValueAction}>Enable →</Text>
              </TouchableOpacity>
            )}
          </View>
          {permState === 'never_ask_again' && (
            <Text style={s.statusFootnoteWarn}>
              SMS access was denied. Enable it under Settings → Apps → Pileap → Permissions to resume automatic syncing.
            </Text>
          )}
          <View style={s.statusRow}>
            <Text style={s.statusLabel}>Last synced</Text>
            <Text style={s.statusValue}>
              {syncingAnywhere ? 'Syncing…' : formatRelativeTime(lastSyncedAt)}
            </Text>
          </View>
          {/* [ADD] Transaction count — was designed early on, never built. */}
          <View style={s.statusRow}>
            <Text style={s.statusLabel}>Transactions synced</Text>
            <Text style={s.statusValue}>{txnCount === null ? '—' : txnCount.toLocaleString('en-IN')}</Text>
          </View>
          <Text style={s.statusFootnote}>Auto-syncs every hour, and whenever you open the app</Text>
        </View>

        {/* ── Primary actions ── */}
        <TouchableOpacity
          style={[s.primaryBtn, (manualSyncing || syncingAnywhere) && s.btnDisabled]}
          onPress={handleSyncNow}
          disabled={manualSyncing || syncingAnywhere}
          activeOpacity={0.8}
        >
          {manualSyncing || syncingAnywhere ? (
            <ActivityIndicator color={colors.white} />
          ) : (
            <Text style={s.primaryBtnText}>Sync Now</Text>
          )}
        </TouchableOpacity>

        {/* [ADD] Staged progress narration, replacing the old bare X/Y
            counter — see describeSyncProgress() above. Sits below the
            button rather than inside it, since a full sentence doesn't
            fit comfortably inline with a spinner. */}
        {(manualSyncing || syncingAnywhere) && manualSyncProgress && (
          <Text style={s.progressNarration}>{describeSyncProgress(manualSyncProgress)}</Text>
        )}

        {/* [ADD] Explicit permission to leave — most people don't know
            this keeps running in the background. Only shown while a
            sync this screen triggered is actually in flight. */}
        {manualSyncing && (
          <Text style={s.leaveScreenHint}>You can leave this screen — we'll keep syncing in the background.</Text>
        )}

        {/* [CHANGE] Checklist-style completion summary, replacing the
            single flat sentence. Each line is its own small "done" beat
            rather than one dense run-on sentence — reads as a short list
            of accomplishments, not a status dump. */}
        {manualSyncResult && (
          <View style={s.resultBox}>
            {manualSyncResult.skippedConcurrentSync ? (
              <Text style={s.resultText}>A sync is already running — try again in a moment.</Text>
            ) : manualSyncResult.skippedDeferredFirstSync ? (
              <Text style={s.resultText}>First sync deferred — reopen the app to run it.</Text>
            ) : (
              <>
                <View style={s.resultLine}>
                  <Text style={s.resultCheck}>✓</Text>
                  <Text style={s.resultLineText}>
                    {manualSyncResult.transactionsInserted} new transaction{manualSyncResult.transactionsInserted === 1 ? '' : 's'} added
                  </Text>
                </View>
                {manualSyncResult.skippedAlreadySynced > 0 && (
                  <View style={s.resultLine}>
                    <Text style={s.resultCheck}>✓</Text>
                    <Text style={s.resultLineText}>{manualSyncResult.skippedAlreadySynced} already up to date</Text>
                  </View>
                )}
                {manualSyncResult.errors.length > 0 && (
                  <View style={s.resultLine}>
                    <Text style={[s.resultCheck, { color: colors.red }]}>!</Text>
                    <Text style={s.resultLineText}>{manualSyncResult.errors.length} error{manualSyncResult.errors.length === 1 ? '' : 's'} — try syncing again</Text>
                  </View>
                )}
              </>
            )}
          </View>
        )}

        <TouchableOpacity
          style={[s.secondaryBtn, exporting && s.btnDisabled]}
          onPress={handleOpenExportPanel}
          disabled={exporting}
          activeOpacity={0.8}
        >
          <Text style={s.secondaryBtnText}>Export Transactions</Text>
          <Text style={s.secondaryBtnSubtext}>Download as Excel (.xlsx)</Text>
        </TouchableOpacity>

        {exportPanelOpen && (
          <View style={s.exportPanel}>
            {loadingMonths ? (
              <ActivityIndicator color={colors.brand} style={{ marginVertical: spacing.md }} />
            ) : exporting ? (
              <ActivityIndicator color={colors.brand} style={{ marginVertical: spacing.md }} />
            ) : (
              <>
                <Text style={s.exportPanelLabel}>Quick ranges</Text>
                <View style={s.exportChipRow}>
                  <TouchableOpacity style={s.exportChip} onPress={() => handleExport({ kind: 'all' })} activeOpacity={0.8}>
                    <Text style={s.exportChipText}>All Time</Text>
                  </TouchableOpacity>
                  <TouchableOpacity style={s.exportChip} onPress={() => handleExport({ kind: 'lastMonths', months: 3 })} activeOpacity={0.8}>
                    <Text style={s.exportChipText}>Last 3 Months</Text>
                  </TouchableOpacity>
                  <TouchableOpacity style={s.exportChip} onPress={() => handleExport({ kind: 'lastMonths', months: 6 })} activeOpacity={0.8}>
                    <Text style={s.exportChipText}>Last 6 Months</Text>
                  </TouchableOpacity>
                  {/* [CHANGE] Relabeled from "Last 1 Year" to "Last 12
                      Months" — this is still a ROLLING window from today
                      (e.g. Aug last year -> Aug this year), which is a
                      genuinely different thing from the new "Year" picker
                      below (calendar year, Jan-Dec). Keeping the old label
                      next to the new calendar-year option would've been
                      actively confusing about which one a person was
                      picking. */}
                  <TouchableOpacity style={s.exportChip} onPress={() => handleExport({ kind: 'lastMonths', months: 12 })} activeOpacity={0.8}>
                    <Text style={s.exportChipText}>Last 12 Months</Text>
                  </TouchableOpacity>
                </View>

                {/* [CHANGE] Year -> Month drill-down, replacing the old
                    flat "every month that has data" list. Picking a year
                    reveals a "Whole Year" option (Jan-Dec, or Jan-to-date
                    for the current year) plus that year's individual
                    months — closer to how a normal date picker reads,
                    and it's what lets a full calendar-year report (e.g.
                    "all of 2025" for taxes) be requested directly rather
                    than only being reachable by exporting All Time and
                    filtering afterward. */}
                {availableYears.length > 0 && (
                  <>
                    <Text style={[s.exportPanelLabel, { marginTop: spacing.sm }]}>Or choose a year</Text>
                    <View style={s.exportChipRow}>
                      {availableYears.map((year) => (
                        <TouchableOpacity
                          key={year}
                          style={[s.exportChip, selectedYear === year && s.exportChipActive]}
                          onPress={() => setSelectedYear(prev => prev === year ? null : year)}
                          activeOpacity={0.8}
                        >
                          <Text style={[s.exportChipText, selectedYear === year && s.exportChipTextActive]}>{year}</Text>
                        </TouchableOpacity>
                      ))}
                    </View>

                    {selectedYear && (
                      <>
                        <TouchableOpacity
                          style={s.exportWholeYearRow}
                          onPress={() => handleExport({ kind: 'year', year: selectedYear })}
                          activeOpacity={0.8}
                        >
                          <Text style={s.exportWholeYearText}>Whole {selectedYear} →</Text>
                        </TouchableOpacity>
                        {monthsForSelectedYear.map((month) => (
                          <TouchableOpacity
                            key={month}
                            style={s.exportMonthRow}
                            onPress={() => handleExport({ kind: 'month', month })}
                            activeOpacity={0.8}
                          >
                            <Text style={s.exportMonthText}>{monthLabel(month)}</Text>
                          </TouchableOpacity>
                        ))}
                      </>
                    )}
                  </>
                )}
              </>
            )}
          </View>
        )}

        {/* ── Debug tools (collapsed by default) ── */}
        <TouchableOpacity onPress={() => setShowDebugTools(v => !v)} style={s.debugToggle} activeOpacity={0.7}>
          <Text style={s.debugToggleText}>{showDebugTools ? 'Hide' : 'Show'} debug tools</Text>
        </TouchableOpacity>

        {showDebugTools && <DebugTools />}

      </ScrollView>
    </SafeAreaView>
  );
}

/**
 * Everything from the old test-sms.tsx debug flow, unchanged in behavior
 * — manual per-window parse, raw JSON export, raw-SMS export, and the
 * per-message result list. Only difference from the original file: this
 * no longer IS the screen, it's rendered inside SyncScreen's collapsible
 * section.
 */
function DebugTools() {
  const [status, setStatus]             = useState<Status>('idle');
  const [parsed, setParsed]             = useState<ParsedTransaction[]>([]);
  const [balanceUpdates, setBalanceUpdates] = useState<BalanceUpdate[]>([]);
  const [rawMsgs, setRawMsgs]           = useState<SmsMessage[]>([]);
  const [error, setError]               = useState<string | null>(null);
  const [hasPerm, setHasPerm]           = useState<boolean | null>(null);
  const [activeWindow, setActiveWindow] = useState<string | null>(null);
  const [rawParseResults, setRawParseResults] = useState<(ParsedTransaction | BalanceUpdate)[]>([]);
  const [syncStatus, setSyncStatus] = useState<'idle' | 'syncing' | 'done' | 'error'>('idle');
  const [syncResult, setSyncResult] = useState<IngestResult | null>(null);
  const [syncProgress, setSyncProgress] = useState<{ processed: number; total: number } | null>(null);
  const [matchContextInfo, setMatchContextInfo] = useState<{ facts: number; customCats: number } | null>(null);
  const parseLogsRef = useRef<ParseLogs>({ haikuCandidates: [], lowConfidence: [] });
  const [logSyncResult, setLogSyncResult] = useState<ParseLogSyncResult | null>(null);

  const navigation = useNavigation();
  useEffect(() => {
    const unsubscribe = navigation.addListener('beforeRemove', (e: any) => {
      if (syncStatus !== 'syncing') return;
      e.preventDefault();
      Alert.alert(
        'Sync in progress',
        'Leaving now is safe — messages already synced are saved, and the rest will pick up automatically next time you sync. Leave anyway?',
        [
          { text: 'Stay', style: 'cancel' },
          { text: 'Leave', style: 'destructive', onPress: () => navigation.dispatch(e.data.action) },
        ],
      );
    });
    return unsubscribe;
  }, [navigation, syncStatus]);

  async function requestPermission() {
    if (Platform.OS !== 'android') { setError('SMS reading is Android only.'); return; }
    try {
      const result = await PermissionsAndroid.request(
        PermissionsAndroid.PERMISSIONS.READ_SMS,
        { title: 'Pileap needs SMS access', message: 'Pileap reads bank SMS to automatically track your transactions.', buttonPositive: 'Allow', buttonNegative: 'Deny' }
      );
      const granted = result === PermissionsAndroid.RESULTS.GRANTED;
      setHasPerm(granted);
      if (!granted) setError('Permission denied.');
    } catch (e: any) {
      setError(e.message ?? 'Permission request failed');
    }
  }

  async function fetchParsed(fromDays: number, toDays: number, label: string) {
    if (!hasPerm) { await requestPermission(); return; }
    if (status === 'loading') return;
    setStatus('loading'); setError(null);
    setParsed([]); setBalanceUpdates([]); setRawMsgs([]);
    setActiveWindow(label); setMatchContextInfo(null);
    parseLogsRef.current = { haikuCandidates: [], lowConfidence: [] };
    try {
      const msgs = await SmsReader.getMessages(fromDays, toDays);
      await new Promise(resolve => setTimeout(resolve, 0));

      try {
        const layer1Candidates = await SmsReader.getLayer1Candidates(fromDays, toDays);
        logLayer1Candidates(layer1Candidates, parseLogsRef.current);
      } catch (l1Err: any) {
        console.warn('getLayer1Candidates failed — continuing without Layer 1 candidate logging:', l1Err?.message ?? l1Err);
      }

      let matchContext: MatchContext = {};
      try {
        const [registeredFacts, customCategories] = await Promise.all([
          fetchActiveRegisteredFacts(),
          fetchCustomCategories(),
        ]);
        matchContext = { registeredFacts, customCategories };
        setMatchContextInfo({ facts: registeredFacts.length, customCats: customCategories.length });
      } catch (fetchErr: any) {
        console.warn('registered_facts/custom_categories fetch failed — parsing without match context:', fetchErr?.message ?? fetchErr);
        setMatchContextInfo({ facts: 0, customCats: 0 });
      }

      const results = parseSmsMessages(msgs, matchContext, parseLogsRef.current);
      setRawParseResults(results);
      setSyncResult(null);
      setSyncStatus('idle');
      setSyncProgress(null);
      setLogSyncResult(null);
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
      match_context: matchContextInfo,
      summary: {
        total: parsed.length,
        approved: parsed.filter(p => p.status === 'approved').length,
        pending_review: parsed.filter(p => p.status === 'pending_review').length,
        parse_failures: parsed.filter(p => p.parse_failure !== null).length,
        balance_updates: balanceUpdates.length,
        resolved_via_custom_category: parsed.filter(p => p.resolvedFrom === 'custom_category').length,
        resolved_via_registered_fact: parsed.filter(p => p.resolvedFrom === 'registered_fact').length,
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
        await Sharing.shareAsync(file.uri, { mimeType: 'application/json', dialogTitle: 'Save Parser Report' });
      } else {
        Alert.alert('Saved', `Report saved to:\n${file.uri}`);
      }
    } catch (e: any) {
      Alert.alert('Export failed', e.message ?? 'Unknown error');
    }
  }

  async function syncToSupabase() {
    if (rawParseResults.length === 0) { Alert.alert('Nothing to sync', 'Run the parser first.'); return; }
    Alert.alert(
      'Sync to Supabase?',
      `This will insert ${parsed.length} transaction(s) and apply ${balanceUpdates.length} balance update(s). Messages already synced from this device will be skipped automatically. Continue?`,
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Sync',
          style: 'destructive',
          onPress: async () => {
            setSyncStatus('syncing');
            setSyncResult(null);
            setSyncProgress(null);
            try {
              const result = await ingestParsedMessages(
                rawParseResults,
                (processedCount, total) => setSyncProgress({ processed: processedCount, total }),
              );
              setSyncResult(result);
              setSyncStatus('done');
              Alert.alert(
                'Sync complete',
                `${result.transactionsInserted} transaction(s) inserted, ${result.balancesUpdated} balance update(s) applied` +
                (result.skippedAlreadySynced > 0 ? `, ${result.skippedAlreadySynced} already synced (skipped)` : '') +
                (result.recoveredViaServerCheck > 0 ? `, ${result.recoveredViaServerCheck} recovered via server check` : '') +
                (result.errors.length > 0 ? `, ${result.errors.length} error(s) — see details below.` : '.'),
              );
            } catch (e: any) {
              setSyncStatus('error');
              Alert.alert('Sync failed', e.message ?? 'Unknown error');
            }
            try {
              const logResult = await syncParseLogs(parseLogsRef.current);
              setLogSyncResult(logResult);
            } catch (e: any) {
              console.warn('syncParseLogs threw unexpectedly:', e?.message ?? e);
            }
          },
        },
      ],
    );
  }

  async function exportRawSms(fromDays: number, toDays: number, label: string) {
    setStatus('loading'); setError(null);
    try {
      const allMsgs = await SmsReader.getMessages(fromDays, toDays);
      const output = {
        window: label,
        from_days_ago: fromDays,
        to_days_ago: toDays,
        total_count: allMsgs.length,
        messages: allMsgs.map((msg: any) => ({
          id: msg.id,
          address: msg.address,
          date: new Date(msg.date).toISOString().split('T')[0],
          body: msg.body,
        })),
      };
      const filename = `raw_text_${label.replace(/[\s→]+/g, '_')}.json`;
      const file = new File(Paths.cache, filename);
      file.write(JSON.stringify(output, null, 2));
      setStatus('done');
      if (await Sharing.isAvailableAsync()) {
        await Sharing.shareAsync(file.uri, { mimeType: 'application/json', dialogTitle: `Save ${filename}` });
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
    <View style={{ marginTop: spacing.md }}>
      {/* [REMOVED — this pass] Standalone "Request Permission" button —
          redundant with the status card's own "Enable →" / "Open
          Settings →" link above, which already handles this (including
          the never_ask_again case this button never distinguished). The
          requestPermission() function below is kept — fetchParsed() still
          calls it automatically if permission is missing when the user
          taps Parse, just no separate dedicated button for it here. */}

      <View style={s.sectionHeader}>
        <Text style={s.sectionTitle}>PARSE SMS — Filter + parse by window</Text>
      </View>

      {DATE_WINDOWS.map(({ label, fromDays, toDays }) => (
        <TouchableOpacity
          key={label}
          style={[s.parseBtn, activeWindow === label && status === 'done' && s.parseBtnActive, status === 'loading' && s.btnDisabled]}
          onPress={() => fetchParsed(fromDays, toDays, label)}
          disabled={status === 'loading'}
          activeOpacity={0.8}
        >
          <Text style={s.parseBtnText}>
            Parse {label}{activeWindow === label && status === 'done' ? `  ·  ${parsed.length} txns` : ''}
          </Text>
        </TouchableOpacity>
      ))}

      {matchContextInfo && (
        <View style={s.matchContextBadge}>
          <Text style={s.matchContextText}>
            {matchContextInfo.facts} registered fact(s) · {matchContextInfo.customCats} saved categor{matchContextInfo.customCats === 1 ? 'y' : 'ies'} loaded for this run
          </Text>
        </View>
      )}

      {status === 'done' && (
        <TouchableOpacity style={s.exportBtn} onPress={exportReport} activeOpacity={0.8}>
          <Text style={s.exportBtnText}>Export Report — {activeWindow}</Text>
        </TouchableOpacity>
      )}

      {status === 'done' && (
        <TouchableOpacity
          style={[s.syncBtn, (syncStatus === 'syncing' || syncStatus === 'done') && s.btnDisabled]}
          onPress={syncToSupabase}
          disabled={syncStatus === 'syncing' || syncStatus === 'done'}
          activeOpacity={0.8}
        >
          {syncStatus === 'syncing' ? (
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
              <ActivityIndicator color="#065f46" />
              {syncProgress && <Text style={s.syncBtnText}>{syncProgress.processed}/{syncProgress.total}</Text>}
            </View>
          ) : (
            <Text style={s.syncBtnText}>Sync to Supabase — {activeWindow}</Text>
          )}
        </TouchableOpacity>
      )}

      {syncResult && (
        <View style={s.resultBox}>
          <Text style={s.resultText}>
            {syncResult.transactionsInserted} inserted · {syncResult.balancesUpdated} balance updates
            {syncResult.skippedAlreadySynced > 0 ? ` · ${syncResult.skippedAlreadySynced} already synced` : ''}
            {syncResult.recoveredViaServerCheck > 0 ? ` · ${syncResult.recoveredViaServerCheck} recovered` : ''}
            {syncResult.errors.length > 0 ? ` · ${syncResult.errors.length} errors` : ''}
          </Text>
          {syncResult.errors.slice(0, 5).map((err, i) => (
            <Text key={i} style={s.syncErrorText}>#{err.raw_sms_id}: {err.message}</Text>
          ))}
        </View>
      )}

      {logSyncResult && (
        <View style={s.resultBox}>
          <Text style={s.resultText}>
            logs: {logSyncResult.haikuCandidatesInserted} haiku-candidate · {logSyncResult.lowConfidenceInserted} low-confidence
          </Text>
          {logSyncResult.errors.map((err, i) => <Text key={i} style={s.syncErrorText}>{err}</Text>)}
        </View>
      )}

      <View style={s.sectionHeader}>
        <Text style={s.sectionTitle}>EXPORT RAW SMS — All messages, no filter</Text>
      </View>

      {DATE_WINDOWS.map(({ label, fromDays, toDays }) => (
        <TouchableOpacity key={label} style={s.rawBtn} onPress={() => exportRawSms(fromDays, toDays, label)} activeOpacity={0.8}>
          <Text style={s.rawBtnText}>Export {label}</Text>
        </TouchableOpacity>
      ))}

      {hasPerm !== null && (
        <View style={[s.permBadge, { backgroundColor: hasPerm ? '#dcfce7' : '#fee2e2' }]}>
          <Text style={{ color: hasPerm ? '#166534' : '#991b1b', fontSize: fontSize.sm, fontWeight: fontWeight.semibold }}>
            READ_SMS: {hasPerm ? 'GRANTED' : 'DENIED'}
          </Text>
        </View>
      )}

      {status === 'loading' && (
        <View style={s.center}>
          <ActivityIndicator size="large" color={colors.brand} />
          <Text style={s.loadingText}>Parsing {activeWindow}...</Text>
        </View>
      )}

      {status === 'error' && (
        <View style={s.errorBox}><Text style={s.errorText}>Error: {error}</Text></View>
      )}

      {status === 'done' && (
        <View style={s.resultHeader}>
          <Text style={s.resultCount}>
            {activeWindow} · {parsed.length} parsed · {approved} approved · {needReview} review · {failures} failed
          </Text>
          {balanceUpdates.length > 0 && (
            <Text style={s.resultSub}>{balanceUpdates.length} balance-disclosure SMS (not transactions, routed to accounts.balance_latest)</Text>
          )}
        </View>
      )}

      {parsed.map((txn, i) => {
        const isOk      = txn.status === 'approved';
        const isFailed  = txn.parse_failure !== null;
        const cardColor = isFailed ? '#fff7ed' : isOk ? '#f0fdf4' : '#fefce8';
        const badge     = isFailed ? `⚠️ ${txn.parse_failure}` : isOk ? 'approved' : 'review';
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
              {txn.resolvedFrom === 'custom_category' ? '  saved' : ''}
              {txn.resolvedFrom === 'registered_fact' ? '  matched' : ''}
            </Text>
            {(txn.merchant || txn.channel) && <Text style={s.parsedMeta}>{[txn.merchant, txn.channel].filter(Boolean).join(' · ')}</Text>}
            {(txn.account_number_masked || txn.ref_number) && (
              <Text style={s.parsedMeta}>
                {txn.account_number_masked ? `A/C ••••${txn.account_number_masked}` : ''}
                {txn.ref_number ? `  Ref: ${txn.ref_number}` : ''}
              </Text>
            )}
            {txn.balance !== null && <Text style={s.parsedMeta}>Bal: ₹{txn.balance.toLocaleString('en-IN')}</Text>}
            <Text style={s.parsedBadge}>{badge}</Text>
            <Text style={s.parsedRaw} numberOfLines={2}>{txn.raw_text}</Text>
            <Text style={s.msgIndex}>#{i + 1}</Text>
          </View>
        );
      })}
    </View>
  );
}

const s = StyleSheet.create({
  safe:         { flex: 1, backgroundColor: colors.white },
  header:       { paddingHorizontal: spacing.lg, paddingVertical: spacing.md, borderBottomWidth: 1, borderBottomColor: colors.border },
  title:        { fontSize: fontSize.lg, fontWeight: fontWeight.bold, color: colors.dark },
  subtitle:     { fontSize: fontSize.sm, color: colors.muted, marginTop: 2 },
  scroll:       { flex: 1 },
  scrollInner:  { padding: spacing.lg, paddingBottom: 40, gap: spacing.sm },

  statusCard: {
    backgroundColor: colors.surface,
    borderRadius: radius.lg,
    borderWidth: 1,
    borderColor: colors.border,
    padding: spacing.md,
    gap: 8,
  },
  statusRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  statusLabel: { fontSize: fontSize.sm, color: colors.muted, fontWeight: fontWeight.medium },
  statusValue: { fontSize: fontSize.sm, color: colors.dark, fontWeight: fontWeight.semibold },
  statusValueGood: { fontSize: fontSize.sm, color: '#166534', fontWeight: fontWeight.semibold },
  statusValueAction: { fontSize: fontSize.sm, color: colors.brand, fontWeight: fontWeight.semibold },
  statusFootnote: { fontSize: fontSize.xs, color: colors.muted, marginTop: 4 },
  statusFootnoteWarn: { fontSize: fontSize.xs, color: colors.red, marginTop: 4, lineHeight: 16 },

  primaryBtn: { backgroundColor: colors.brand, paddingVertical: 14, borderRadius: radius.md, alignItems: 'center', marginTop: spacing.sm },
  primaryBtnText: { fontSize: fontSize.base, fontWeight: fontWeight.bold, color: colors.white },

  secondaryBtn: { backgroundColor: colors.white, borderWidth: 1, borderColor: colors.brand, paddingVertical: 12, borderRadius: radius.md, alignItems: 'center' },
  secondaryBtnText: { fontSize: fontSize.sm, fontWeight: fontWeight.semibold, color: colors.brand },
  secondaryBtnSubtext: { fontSize: fontSize.xs, color: colors.muted, marginTop: 2 },

  btnDisabled: { opacity: 0.6 },

  exportPanel: {
    backgroundColor: colors.surface,
    borderRadius: radius.lg,
    borderWidth: 1,
    borderColor: colors.border,
    padding: spacing.md,
  },
  exportPanelLabel: { fontSize: fontSize.xs, fontWeight: fontWeight.semibold, color: colors.muted, textTransform: 'uppercase', letterSpacing: 0.5, marginBottom: spacing.xs },
  exportChipRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  exportChip: { backgroundColor: colors.white, borderWidth: 1, borderColor: colors.brand, borderRadius: radius.full, paddingVertical: 6, paddingHorizontal: 12 },
  exportChipText: { fontSize: fontSize.xs, fontWeight: fontWeight.semibold, color: colors.brand },
  // [ADD] Active/selected state for the year chips.
  exportChipActive: { backgroundColor: colors.brand },
  exportChipTextActive: { color: colors.white },
  // [ADD] "Whole {year}" row — visually distinct from the individual
  // month rows below it (bolder, tinted background) since it's the
  // more likely pick most of the time a year gets selected at all.
  exportWholeYearRow: {
    backgroundColor: '#f5f3ff',
    borderWidth: 1,
    borderColor: '#ddd6fe',
    borderRadius: radius.md,
    paddingVertical: 10,
    paddingHorizontal: spacing.sm,
    marginTop: spacing.xs,
    alignItems: 'center',
  },
  exportWholeYearText: { fontSize: fontSize.sm, fontWeight: fontWeight.bold, color: '#5b21b6' },
  exportMonthRow: { paddingVertical: 8, borderBottomWidth: 1, borderBottomColor: colors.border },
  exportMonthText: { fontSize: fontSize.sm, color: colors.dark, fontWeight: fontWeight.medium },

  resultBox: { padding: spacing.sm, backgroundColor: '#ecfdf5', borderRadius: radius.md, borderWidth: 1, borderColor: '#a7f3d0' },
  resultText: { fontSize: fontSize.xs, fontWeight: fontWeight.semibold, color: '#065f46' },

  // [ADD] First-sync anticipatory banner.
  firstSyncBanner: {
    backgroundColor: '#eff6ff',
    borderWidth: 1,
    borderColor: '#bfdbfe',
    borderRadius: radius.lg,
    padding: spacing.md,
    marginBottom: spacing.sm,
  },
  firstSyncBannerTitle: { fontSize: fontSize.sm, fontWeight: fontWeight.bold, color: '#1d4ed8', marginBottom: 2 },
  firstSyncBannerText: { fontSize: fontSize.xs, color: '#1e40af', lineHeight: 17 },

  // [ADD] Staged progress narration + leave-screen reassurance, both
  // shown below the primary button during a manual sync.
  progressNarration: { fontSize: fontSize.xs, color: colors.muted, textAlign: 'center', marginTop: spacing.xs },
  leaveScreenHint: { fontSize: 11, color: colors.muted, textAlign: 'center', marginTop: 2, fontStyle: 'italic' },

  // [ADD] Checklist-style result lines, replacing the old single
  // resultText sentence for the success case.
  resultLine: { flexDirection: 'row', alignItems: 'flex-start', gap: 6, marginBottom: 2 },
  resultCheck: { fontSize: fontSize.xs, fontWeight: fontWeight.bold, color: '#16a34a', width: 12 },
  resultLineText: { fontSize: fontSize.xs, fontWeight: fontWeight.medium, color: '#065f46', flex: 1 },
  syncErrorText: { fontSize: 10, color: '#b91c1c', marginTop: 2 },

  debugToggle: { alignItems: 'center', paddingVertical: spacing.sm, marginTop: spacing.md },
  debugToggleText: { fontSize: fontSize.xs, color: colors.muted, fontWeight: fontWeight.medium, textDecorationLine: 'underline' },

  btnSecondary:     { backgroundColor: colors.surface, borderWidth: 1, borderColor: colors.border, paddingVertical: 10, borderRadius: radius.md, alignItems: 'center' },
  btnSecondaryText: { fontSize: fontSize.sm, fontWeight: fontWeight.semibold, color: colors.dark },

  parseBtn:       { backgroundColor: '#eff6ff', borderWidth: 1, borderColor: '#93c5fd', paddingVertical: 10, borderRadius: radius.md, alignItems: 'center', marginTop: spacing.xs },
  parseBtnActive: { backgroundColor: '#dbeafe', borderColor: '#3b82f6' },
  parseBtnText:   { fontSize: fontSize.sm, color: '#1d4ed8', fontWeight: fontWeight.semibold },

  matchContextBadge: { backgroundColor: '#f5f3ff', borderWidth: 1, borderColor: '#ddd6fe', borderRadius: radius.md, padding: spacing.sm, alignItems: 'center', marginTop: spacing.xs },
  matchContextText:  { fontSize: fontSize.xs, color: '#5b21b6', fontWeight: fontWeight.semibold },

  exportBtn:     { backgroundColor: '#f0fdf4', borderWidth: 1, borderColor: '#86efac', paddingVertical: 10, borderRadius: radius.md, alignItems: 'center', marginTop: spacing.xs },
  exportBtnText: { fontSize: fontSize.sm, color: '#15803d', fontWeight: fontWeight.semibold },

  syncBtn:         { backgroundColor: '#d1fae5', borderWidth: 1, borderColor: '#34d399', paddingVertical: 10, borderRadius: radius.md, alignItems: 'center', marginTop: spacing.xs },
  syncBtnText:     { fontSize: fontSize.sm, color: '#065f46', fontWeight: fontWeight.bold },

  sectionHeader: { marginTop: spacing.md, marginBottom: spacing.xs },
  sectionTitle:  { fontSize: fontSize.xs, fontWeight: fontWeight.semibold, color: colors.muted, letterSpacing: 0.5 },

  rawBtn:     { backgroundColor: '#fdf4ff', borderWidth: 1, borderColor: '#d8b4fe', paddingVertical: 10, borderRadius: radius.md, alignItems: 'center', marginTop: spacing.xs },
  rawBtnText: { fontSize: fontSize.sm, color: '#7c3aed', fontWeight: fontWeight.semibold },

  permBadge:   { padding: spacing.sm, borderRadius: radius.md, marginTop: spacing.xs },
  center:      { alignItems: 'center', paddingTop: spacing.xl },
  loadingText: { marginTop: spacing.md, fontSize: fontSize.sm, color: colors.muted },
  errorBox:    { padding: spacing.md, backgroundColor: '#fee2e2', borderRadius: radius.md },
  errorText:   { fontSize: fontSize.sm, color: '#991b1b' },

  resultHeader: { paddingBottom: spacing.xs },
  resultCount:  { fontSize: fontSize.sm, fontWeight: fontWeight.semibold, color: colors.brand },
  resultSub:    { fontSize: fontSize.xs, color: colors.muted, marginTop: 2 },

  msgIndex:    { fontSize: 10, color: colors.muted, marginTop: 4, textAlign: 'right' },

  parsedCard:     { borderRadius: radius.md, borderWidth: 1, borderColor: colors.border, padding: spacing.md, marginTop: spacing.xs },
  parsedHead:     { flexDirection: 'row', justifyContent: 'space-between', marginBottom: 2 },
  parsedBank:     { fontSize: fontSize.xs, fontWeight: fontWeight.bold, color: colors.brand },
  parsedDate:     { fontSize: fontSize.xs, color: colors.muted },
  parsedAmount:   { fontSize: fontSize.md, fontWeight: fontWeight.bold, marginVertical: 2 },
  parsedCategory: { fontSize: fontSize.xs, color: colors.dark, marginBottom: 2 },
  parsedMeta:     { fontSize: fontSize.xs, color: colors.muted },
  parsedBadge:    { fontSize: fontSize.xs, fontWeight: fontWeight.semibold, marginTop: 4 },
  parsedRaw:      { fontSize: 10, color: colors.muted, marginTop: 4, fontStyle: 'italic' },
});