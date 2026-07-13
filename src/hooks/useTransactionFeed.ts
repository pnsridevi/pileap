/**
 * src/hooks/useTransactionFeed.ts
 *
 * Wraps fetchTransactions() with pagination (20/page, matches the demo),
 * pull-to-refresh, and infinite scroll. Re-fetches from page 0 whenever the
 * user changes tab/status/category filters in transactionStore.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { fetchTransactions } from '@/lib/api/transactions';
import type { TransactionFilters } from '@/lib/api/transactions';
import { useTransactionStore } from '@/store/transactionStore';
import type { TransactionRowData } from '@/components/transactions/TransactionRow';

const PAGE_SIZE = 20;

interface UseTransactionFeedResult {
  transactions: TransactionRowData[];
  loading: boolean;      // true only on the very first fetch for the current filters
  loadingMore: boolean;  // true while fetching the next page
  refreshing: boolean;   // true during pull-to-refresh
  error: string | null;
  hasMore: boolean;
  loadMore: () => void;
  refresh: () => void;
}

export function useTransactionFeed(): UseTransactionFeedResult {
  const { activeTab, statusFilter, categoryFilter } = useTransactionStore();

  const [transactions, setTransactions] = useState<TransactionRowData[]>([]);
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
    if (activeTab === 'history') {
      return {
        status: 'user_reviewed',
        category: categoryFilter ?? undefined,
        page: targetPage,
        pageSize: PAGE_SIZE,
      };
    }
    return statusFilter === 'all'
      ? {
          statuses: ['pending_review', 'approved'],
          category: categoryFilter ?? undefined,
          page: targetPage,
          pageSize: PAGE_SIZE,
        }
      : {
          status: statusFilter,
          category: categoryFilter ?? undefined,
          page: targetPage,
          pageSize: PAGE_SIZE,
        };
  }, [activeTab, statusFilter, categoryFilter]);

  const runFetch = useCallback(async (targetPage: number, mode: 'initial' | 'more' | 'refresh') => {
    const requestId = ++requestIdRef.current;
    if (mode === 'initial') setLoading(true);
    if (mode === 'more') setLoadingMore(true);
    if (mode === 'refresh') setRefreshing(true);
    setError(null);

    try {
      const { transactions: rows, totalCount: count } = await fetchTransactions(buildFilters(targetPage));
      if (requestId !== requestIdRef.current) return; // a newer request already superseded this one

      setTotalCount(count);
      setPage(targetPage);
      setTransactions(prev => (mode === 'more' ? [...prev, ...rows as TransactionRowData[]] : rows as TransactionRowData[]));
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
  }, [activeTab, statusFilter, categoryFilter]);

  const hasMore = transactions.length < totalCount;

  const loadMore = useCallback(() => {
    if (loading || loadingMore || refreshing || !hasMore) return;
    runFetch(page + 1, 'more');
  }, [loading, loadingMore, refreshing, hasMore, page, runFetch]);

  const refresh = useCallback(() => {
    runFetch(0, 'refresh');
  }, [runFetch]);

  return { transactions, loading, loadingMore, refreshing, error, hasMore, loadMore, refresh };
}