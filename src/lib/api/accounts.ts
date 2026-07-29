/**
 * src/lib/api/accounts.ts
 *
 * Supabase read/write layer for `accounts`. Two concerns live here:
 *
 *   1. Account tracking — `is_active` already existed on this table (every
 *      account transactions.ts's resolveAccountId() creates is inserted
 *      with is_active: true) but nothing ever read or toggled it. This
 *      file is what turns that dormant column into the actual "which
 *      accounts do I want tracked" feature discussed for the Accounts
 *      screen (app/(app)/transactions/accounts.tsx) — per the product
 *      decision: untracking an account only hides its FUTURE transactions
 *      (existing rows/queries are untouched by this file; the filtering
 *      itself is a separate, later change to the read paths that list/
 *      score transactions — not implemented here yet).
 *
 *   2. The Cash account — manual transaction entry needs an account_id to
 *      point at when the user picks "Cash" rather than a real bank/card
 *      account. accounts_account_type_check (see migration run this
 *      session) now allows 'cash' as a value. Modeled as one single,
 *      lazily-created row per user — same get-or-create shape as
 *      transactions.ts's resolveUnknownAccountId(), and deliberately NOT
 *      reusing that Unknown-placeholder account: Unknown means "SMS
 *      parsing couldn't tell which real bank account this came from",
 *      Cash means "there genuinely is no account, this was paid in cash"
 *      — two different facts that would be lost if merged into one row.
 */
import { supabase } from '../supabase';

async function getCurrentUserId(): Promise<string> {
  const { data: { user }, error } = await supabase.auth.getUser();
  if (error || !user) {
    throw new Error('Not authenticated — no user_id available for this request.');
  }
  return user.id;
}

export interface Account {
  id: string;
  user_id: string;
  account_type:
    | 'bank' | 'credit_card' | 'loan' | 'mf' | 'equity' | 'insurance'
    | 'epf' | 'nps' | 'ppf' | 'fd' | 'real_estate' | 'cash';
  institution_name: string | null;
  account_number_masked: string | null;
  balance_latest: number | null;
  balance_updated_at: string | null;
  aa_linked: boolean | null;
  is_active: boolean | null;
  created_at: string | null;
}

/** Every account for the current user, most-recently-created first — the
 * shape the Manage Accounts screen lists and toggles. */
export async function fetchAccounts(): Promise<Account[]> {
  const userId = await getCurrentUserId();
  const { data, error } = await supabase
    .from('accounts')
    .select('*')
    .eq('user_id', userId)
    .order('created_at', { ascending: false });

  if (error) throw error;
  return (data ?? []) as Account[];
}

/** Get-or-create the one Cash account for this user. Same reasoning as
 * transactions.ts's resolveUnknownAccountId() — a lookup-then-insert, not
 * an atomic upsert, since there's no unique constraint on
 * (user_id, account_type) to upsert against. Fine here: this only ever
 * runs from user-initiated UI actions (opening the manual-entry form or
 * the Manage Accounts screen), never from concurrent background
 * ingestion the way resolveAccountId() can be — the race window
 * resolveAccountId()'s own comment flags doesn't apply the same way here. */
export async function resolveCashAccountId(): Promise<string> {
  const userId = await getCurrentUserId();

  const { data: existing, error: lookupError } = await supabase
    .from('accounts')
    .select('id')
    .eq('user_id', userId)
    .eq('account_type', 'cash')
    .maybeSingle();

  if (lookupError) throw lookupError;
  if (existing) return existing.id;

  const { data: created, error: insertError } = await supabase
    .from('accounts')
    .insert({
      user_id: userId,
      account_type: 'cash',
      institution_name: 'Cash',
      account_number_masked: null,
      balance_latest: null,
      balance_updated_at: null,
      aa_linked: false,
      is_active: true,
    })
    .select('id')
    .single();

  if (insertError) throw insertError;
  return created.id;
}

/** Toggles an account's tracked state. Per the product decision this
 * session: turning tracking off only affects FUTURE transactions — this
 * function itself doesn't touch any existing transaction rows, and none
 * of the read paths that would need to respect this flag (Feed/History
 * queries, score calculations) are wired up to check it yet. This is
 * intentionally scoped to just the toggle + persistence for now. */
export async function setAccountActive(accountId: string, isActive: boolean): Promise<void> {
  const { error } = await supabase
    .from('accounts')
    .update({ is_active: isActive })
    .eq('id', accountId);
  if (error) throw error;
}