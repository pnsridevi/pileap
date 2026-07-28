/**
 * src/hooks/useTransactionFeed.ts
 *
 * Wraps fetchTransactions() with pagination, pull-to-refresh, and both a
 * page-based nav API (Prev/Next, replaces the list) and an infinite-scroll
 * API (loadMore, appends to the list). Re-fetches from page 0 whenever the
 * user changes tab/status/category filters in transactionStore.
 *
 * [CHANGED — migration pass] Previously mapped every row through
 * mapTransactionToRow() before storing it, returning TransactionRowData[].
 * That's a one-way, lossy conversion — signed amount -> unsigned, taxonomy
 * `type` ('Expense'|'Income'|...) -> display `type` ('debit'|'credit'|
 * 'declined'), account_id/merchant_key dropped entirely. Fine for a
 * read-only list, but the Active feed's edit/split/submit flow
 * (draftEdits, draftSplits, EditModal, SplitFlow, submitTransactionPage's
 * payload) all need the raw Transaction shape. This hook is a data/
 * pagination concern, not a view concern, so it now returns raw
 * Transaction[] and leaves the display mapping to each consumer's
 * renderItem — same one-line mapTransactionToRow() call index.tsx already
 * did at render time before this migration.
 *
 * [FIX — migration pass] buildFilters() previously omitted 'haiku_suggested'
 * from both the 'all' and single-status branches. That's the same bug
 * already found and fixed once in index.tsx's local implementation
 * (haiku_suggested rows invisible to the active feed query) — migrating
 * onto this hook as originally written would have silently reintroduced
 * it. Both branches now include it, matching fetchNeedsReviewCount()'s own
 * .in('status', ['pending_review', 'haiku_suggested']) in transactions.ts.
 *
 * [ADD — migration pass] Page-based nav (page/totalPages/goToPage/
 * goToNextPage/goToPreviousPage) added alongside the existing infinite-
 * scroll loadMore/hasMore. The Active feed uses page-based Prev/Next
 * (confirmed with user — matches index.tsx's original UI); a future
 * History screen may want either. Both share the same runFetch — the only
 * difference is whether a page replaces `transactions` or appends to it.
 *
 * [FIX] The initial-fetch useEffect only re-runs when activeTab/
 * statusFilter/categoryFilter change. Under expo-router's tab navigator
 * this screen stays MOUNTED once visited, so switching away to sync SMS
 * (e.g. from the test-sms screen) and back never re-ran that effect —
 * newly-synced rows only appeared after a full app restart forced a
 * remount. Added a useFocusEffect that re-runs runFetch on every focus
 * after the first (the first focus is skipped since the mount effect
 * above already covers it), so returning to this tab always shows
 * whatever's currently in Supabase.
 *
 * [FIX — real bug found in testing] activeTab used to come from the
 * SHARED transactionStore, with each screen "pinning" it on mount
 * (setActiveTab('active') in index.tsx, setActiveTab('history') here).
 * Since BOTH screens stay mounted simultaneously (Stack navigator) and
 * BOTH have their own useTransactionFeed() instance subscribed to that
 * same shared value, visiting History flipped the shared flag to
 * 'history' — which silently changed FEED's still-mounted, still-
 * subscribed hook instance to query History's filters too, and nothing
 * ever flipped it back since each pin only fires once, on that screen's
 * first mount, not on every focus. Result: Feed would show History's
 * rows, or go empty if History had nothing yet. Fixed by having each
 * screen pass its own `tab` argument directly instead of reading a
 * mutable value the other screen can stomp on. categoryFilter stays in
 * the shared store — that cross-screen sharing is intentional (see
 * history.tsx's docblock) and isn't part of this bug.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { useFocusEffect } from 'expo-router';
import { fetchTransactions } from '@/lib/api/transactions';
import type { TransactionFilters, Transaction } from '@/lib/api/transactions';
import { useTransactionStore, type TransactionTab } from '@/store/transactionStore';

const PAGE_SIZE = 20;

type FetchMode = 'initial' | 'more' | 'refresh' | 'goto';

interface UseTransactionFeedResult {
  transactions: Transaction[];
  totalCount: number;
  loading: boolean;      // true only while replacing the current list (initial/goto)
  loadingMore: boolean;  // true while appending the next page (infinite scroll)
  refreshing: boolean;   // true during pull-to-refresh
  error: string | null;

  // Infinite-scroll API
  hasMore: boolean;
  loadMore: () => Promise<void>;

  // Page-based API
  page: number;
  totalPages: number;
  goToPage: (targetPage: number) => Promise<void>;
  goToNextPage: () => Promise<void>;
  goToPreviousPage: () => Promise<void>;

  // Shared
  refresh: () => Promise<void>;
}

export function useTransactionFeed(tab: TransactionTab): UseTransactionFeedResult {
  const { statusFilter, categoryFilter } = useTransactionStore();

  const [transactions, setTransactions] = useState<Transaction[]>([]);
  const [totalCount, setTotalCount] = useState(0);
  const [page, setPage] = useState(0);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Guards against a slow, stale request (e.g. from before the user switched
  // tabs) landing after a newer one and clobbering fresher results.
  const requestIdRef = useRef(0);

  const buildFilters = useCallback((targetPage: number): TransactionFilters => {
    if (tab === 'history') {
      return {
        status: 'user_reviewed',
        category: categoryFilter ?? undefined,
        page: targetPage,
        pageSize: PAGE_SIZE,
      };
    }
    // [FIX] haiku_suggested included in both branches — see file docblock.
    // 'pending_review' as a UI filter means "needs review", and a
    // haiku_suggested row is exactly that from the user's point of view
    // (a guess, not a confirmed match) even though it's a distinct DB
    // status value.
    return statusFilter === 'all'
      ? {
          statuses: ['pending_review', 'approved', 'haiku_suggested'],
          category: categoryFilter ?? undefined,
          page: targetPage,
          pageSize: PAGE_SIZE,
        }
      : {
          statuses: statusFilter === 'pending_review'
            ? ['pending_review', 'haiku_suggested']
            : [statusFilter],
          category: categoryFilter ?? undefined,
          page: targetPage,
          pageSize: PAGE_SIZE,
        };
  }, [tab, statusFilter, categoryFilter]);

  const runFetch = useCallback(async (targetPage: number, mode: FetchMode) => {
    const requestId = ++requestIdRef.current;
    if (mode === 'initial' || mode === 'goto') setLoading(true);
    if (mode === 'more') setLoadingMore(true);
    if (mode === 'refresh') setRefreshing(true);
    setError(null);

    try {
      const { transactions: rows, totalCount: count } = await fetchTransactions(buildFilters(targetPage));
      if (requestId !== requestIdRef.current) return; // a newer request already superseded this one

      setTotalCount(count);
      setPage(targetPage);
      setTransactions(prev => (mode === 'more' ? [...prev, ...rows] : rows));
    } catch (e) {
      if (requestId !== requestIdRef.current) return;
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      if (requestId !== requestIdRef.current) return;
      setLoading(false);
      setLoadingMore(false);
      setRefreshing(false);
    }
  }, [buildFilters]);

  // Filters changed — start over from page 0.
  useEffect(() => {
    runFetch(0, 'initial');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab, statusFilter, categoryFilter]);

  // [FIX] Re-fetch the current page whenever this screen regains focus —
  // see docblock. Skips the very first focus (fires right after mount,
  // which the effect above already handles) so we don't double-fetch on
  // initial load.
  const isFirstFocusRef = useRef(true);
  useFocusEffect(
    useCallback(() => {
      if (isFirstFocusRef.current) {
        isFirstFocusRef.current = false;
        return;
      }
      runFetch(page, 'refresh');
    }, [runFetch, page])
  );

  const hasMore = transactions.length < totalCount;
  const totalPages = Math.max(1, Math.ceil(totalCount / PAGE_SIZE));

  const loadMore = useCallback(() => {
    if (loading || loadingMore || refreshing || !hasMore) return Promise.resolve();
    return runFetch(page + 1, 'more');
  }, [loading, loadingMore, refreshing, hasMore, page, runFetch]);

  // [ADD] Page-based nav — replaces `transactions` instead of appending.
  const goToPage = useCallback((targetPage: number) => {
    if (loading || loadingMore || refreshing) return Promise.resolve();
    if (targetPage < 0 || targetPage > totalPages - 1) return Promise.resolve();
    return runFetch(targetPage, 'goto');
  }, [loading, loadingMore, refreshing, totalPages, runFetch]);

  const goToNextPage = useCallback(() => goToPage(page + 1), [goToPage, page]);
  const goToPreviousPage = useCallback(() => goToPage(page - 1), [goToPage, page]);

  // [KEPT — matches original index.tsx behavior] Refetches the CURRENT
  // page, not page 0. index.tsx's pull-to-refresh and post-Submit reload
  // both relied on this: after Submit, the just-reviewed rows drop out of
  // the active query, so re-running the same page number naturally reveals
  // the next unreviewed batch without resetting the user's position.
  const refresh = useCallback(() => runFetch(page, 'refresh'), [runFetch, page]);

  return {
    transactions, totalCount, loading, loadingMore, refreshing, error,
    hasMore, loadMore,
    page, totalPages, goToPage, goToNextPage, goToPreviousPage,
    refresh,
  };
}