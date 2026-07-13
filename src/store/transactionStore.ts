/**
 * src/store/transactionStore.ts
 *
 * Holds ONLY the user's current filter selection for the Transactions tab —
 * not the fetched transactions themselves. Fetched data + pagination state
 * lives in useTransactionFeed.ts instead, since that's tied to a fetch
 * lifecycle (loading/refreshing/error), not something that needs to persist
 * or be shared across screens the way a filter choice does.
 */
import { create } from 'zustand';

export type TransactionTab = 'active' | 'history';
export type StatusFilter = 'all' | 'pending_review' | 'approved';

interface TransactionStoreState {
  activeTab: TransactionTab;
  statusFilter: StatusFilter;
  categoryFilter: string | null;

  setActiveTab: (tab: TransactionTab) => void;
  setStatusFilter: (filter: StatusFilter) => void;
  setCategoryFilter: (category: string | null) => void;
  resetFilters: () => void;
}

export const useTransactionStore = create<TransactionStoreState>((set) => ({
  activeTab: 'active',
  statusFilter: 'all',
  categoryFilter: null,

  setActiveTab: (tab) => set({ activeTab: tab }),
  setStatusFilter: (filter) => set({ statusFilter: filter }),
  setCategoryFilter: (category) => set({ categoryFilter: category }),
  resetFilters: () => set({ statusFilter: 'all', categoryFilter: null }),
}));