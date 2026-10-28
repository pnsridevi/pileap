select * from pg_extension where extname = 'pgcrypto';

-- ============================================================
-- Pileap — Prod schema reconstruction (manual export)
-- Captured: 2026-07-20, via SQL editor (pg_dump/CLI unavailable)
-- Run this file top to bottom, as-is, on the NEW project's SQL editor.
--
-- KNOWN GAP: `health_module_tag` on transactions is type ARRAY — element
-- type (text[]? uuid[]?) not resolvable from information_schema.columns
-- alone. Placeholder below uses text[]; confirm via:
--   select column_name, udt_name from information_schema.columns
--   where table_schema='public' and table_name='transactions' and data_type='ARRAY';
-- and fix Section 0 if it's not text[].
--
-- NOTE FOR PHASE 2: transactions_status_check currently only allows
-- 'pending_review' | 'approved' | 'user_reviewed'. The new pending_haiku
-- status will need this constraint altered before the new pipeline can
-- write that status — see TODO comment inline below.
-- ============================================================

-- ------------------------------------------------------------
-- SECTION 0: TABLES
-- Dependency order: users -> accounts -> transactions -> custom_categories
-- -> transaction_audit. transactions' self-referencing FKs (split_from_id,
-- possible_contra_of, possible_duplicate_of) are declared inline — Postgres
-- allows a table to reference itself within its own CREATE TABLE.
-- ------------------------------------------------------------

CREATE TABLE public.users (
  id uuid NOT NULL,
  phone text,
  primary_ingestion_source text CHECK (primary_ingestion_source = ANY (ARRAY['sms'::text, 'email'::text])),
  created_at timestamp with time zone DEFAULT now(),
  CONSTRAINT users_pkey PRIMARY KEY (id),
  -- users_id_fkey had no resolvable references_table/column in public schema —
  -- this is the standard Supabase pattern of linking to auth.users(id).
  CONSTRAINT users_id_fkey FOREIGN KEY (id) REFERENCES auth.users(id)
);

CREATE TABLE public.accounts (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL,
  account_type text NOT NULL CHECK (account_type = ANY (ARRAY['bank'::text, 'credit_card'::text, 'loan'::text, 'mf'::text, 'equity'::text, 'insurance'::text, 'epf'::text, 'nps'::text, 'ppf'::text, 'fd'::text, 'real_estate'::text])),
  institution_name text,
  account_number_masked text,
  balance_latest numeric,
  balance_updated_at timestamp with time zone,
  aa_linked boolean DEFAULT false,
  is_active boolean DEFAULT true,
  created_at timestamp with time zone DEFAULT now(),
  CONSTRAINT accounts_pkey PRIMARY KEY (id),
  CONSTRAINT accounts_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id)
);

CREATE TABLE public.transactions (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL,
  account_id uuid NOT NULL,
  txn_date date NOT NULL,
  amount numeric,
  type text CHECK (type = ANY (ARRAY['Expense'::text, 'Income'::text, 'Investment'::text, 'Liability'::text, 'Asset'::text])),
  category text,
  sub_category text,
  merchant text,
  source text CHECK (source = ANY (ARRAY['sms'::text, 'email'::text, 'manual'::text, 'pdf'::text, 'cash'::text, 'haiku'::text])),
  -- TODO (phase 2): add 'pending_haiku_review' (or chosen name) to this list
  -- before the new pipeline can write that status.
  status text NOT NULL DEFAULT 'pending_review'::text CHECK (status = ANY (ARRAY['pending_review'::text, 'approved'::text, 'user_reviewed'::text])),
  reviewed_at timestamp with time zone,
  raw_text text,
  is_deleted boolean DEFAULT false,
  split_from_id uuid,
  added_late boolean DEFAULT false,
  after_report_month text,
  is_contra boolean DEFAULT false,
  possible_contra_of uuid,
  duplicate_confidence numeric CHECK (duplicate_confidence >= 0::numeric AND duplicate_confidence <= 1::numeric),
  possible_duplicate_of uuid,
  health_module_tag text[], -- CONFIRM element type — see header note
  created_at timestamp with time zone DEFAULT now(),
  ref_number text,
  ref_type text CHECK (ref_type = ANY (ARRAY['upi_rrn'::text, 'neft_utr'::text, 'unknown'::text])),
  txn_group_id uuid,
  is_infrastructure boolean DEFAULT false,
  merchant_key text,
  parse_failure text,
  CONSTRAINT transactions_pkey PRIMARY KEY (id),
  CONSTRAINT transactions_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id),
  CONSTRAINT transactions_account_id_fkey FOREIGN KEY (account_id) REFERENCES public.accounts(id),
  CONSTRAINT transactions_split_from_id_fkey FOREIGN KEY (split_from_id) REFERENCES public.transactions(id),
  CONSTRAINT transactions_possible_contra_of_fkey FOREIGN KEY (possible_contra_of) REFERENCES public.transactions(id),
  CONSTRAINT transactions_possible_duplicate_of_fkey FOREIGN KEY (possible_duplicate_of) REFERENCES public.transactions(id)
);

CREATE TABLE public.custom_categories (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL,
  merchant text NOT NULL,
  type text NOT NULL CHECK (type = ANY (ARRAY['Expense'::text, 'Income'::text, 'Investment'::text, 'Liability'::text, 'Asset'::text])),
  category text NOT NULL,
  sub_category text,
  created_at timestamp with time zone DEFAULT now(),
  updated_at timestamp with time zone DEFAULT now(),
  CONSTRAINT custom_categories_pkey PRIMARY KEY (id),
  CONSTRAINT custom_categories_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id),
  CONSTRAINT custom_categories_user_id_merchant_key UNIQUE (user_id, merchant)
);

CREATE TABLE public.transaction_audit (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  transaction_id uuid NOT NULL,
  user_id uuid NOT NULL,
  action text NOT NULL CHECK (action = ANY (ARRAY['status_change'::text, 'field_edit'::text, 'split'::text, 'contra_confirmed'::text, 'duplicate_resolved'::text, 'group_assigned'::text])),
  old_value jsonb,
  new_value jsonb,
  created_at timestamp with time zone DEFAULT now(),
  CONSTRAINT transaction_audit_pkey PRIMARY KEY (id),
  CONSTRAINT transaction_audit_transaction_id_fkey FOREIGN KEY (transaction_id) REFERENCES public.transactions(id),
  CONSTRAINT transaction_audit_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id)
);

/*Functions */
-- ------------------------------------------------------------
-- SECTION 1: FUNCTIONS
-- ------------------------------------------------------------

-- Auto-enables RLS on every newly created table in `public`.
-- IMPORTANT: this is an EVENT TRIGGER function — the function alone does
-- nothing until the event trigger itself (created separately, see
-- Section 4 / pending confirmation) is also recreated on the new project.
CREATE OR REPLACE FUNCTION public.rls_auto_enable()
 RETURNS event_trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog'
AS $function$
DECLARE
  cmd record;
BEGIN
  FOR cmd IN
    SELECT *
    FROM pg_event_trigger_ddl_commands()
    WHERE command_tag IN ('CREATE TABLE', 'CREATE TABLE AS', 'SELECT INTO')
      AND object_type IN ('table','partitioned table')
  LOOP
     IF cmd.schema_name IS NOT NULL AND cmd.schema_name IN ('public') AND cmd.schema_name NOT IN ('pg_catalog','information_schema') AND cmd.schema_name NOT LIKE 'pg_toast%' AND cmd.schema_name NOT LIKE 'pg_temp%' THEN
      BEGIN
        EXECUTE format('alter table if exists %s enable row level security', cmd.object_identity);
        RAISE LOG 'rls_auto_enable: enabled RLS on %', cmd.object_identity;
      EXCEPTION
        WHEN OTHERS THEN
          RAISE LOG 'rls_auto_enable: failed to enable RLS on %', cmd.object_identity;
      END;
     ELSE
        RAISE LOG 'rls_auto_enable: skip % (either system schema or not in enforced list: %.)', cmd.object_identity, cmd.schema_name;
     END IF;
  END LOOP;
END;
$function$;

-- Core write path for the transaction review page: field edits (partial,
-- key-presence-checked), splits (soft-delete original + insert N lines,
-- audit-logged), and bulk status promotion to 'user_reviewed' for
-- everything visible on the page (status-change audit rows only written
-- when status actually changes, to avoid no-op log spam).
CREATE OR REPLACE FUNCTION public.submit_transaction_page(p_user_id uuid, p_page_ids uuid[], p_edits jsonb, p_splits jsonb)
 RETURNS TABLE(id uuid)
 LANGUAGE plpgsql
AS $function$
declare
  v_edit      jsonb;
  v_split     jsonb;
  v_line      jsonb;
  v_original  transactions%rowtype;
  v_new_id    uuid;
  v_child_ids jsonb;
begin
  for v_edit in select * from jsonb_array_elements(coalesce(p_edits, '[]'::jsonb))
  loop
    select * into v_original
    from transactions
    where transactions.id = (v_edit->>'id')::uuid
      and transactions.user_id = p_user_id;

    if found then
      update transactions set
        txn_date     = case when v_edit ? 'txn_date'     then (v_edit->>'txn_date')::date  else txn_date end,
        amount       = case when v_edit ? 'amount'       then (v_edit->>'amount')::numeric else amount end,
        type         = case when v_edit ? 'type'         then v_edit->>'type'              else type end,
        category     = case when v_edit ? 'category'     then v_edit->>'category'          else category end,
        sub_category = case when v_edit ? 'sub_category' then v_edit->>'sub_category'       else sub_category end,
        merchant     = case when v_edit ? 'merchant'     then v_edit->>'merchant'           else merchant end
      where transactions.id = (v_edit->>'id')::uuid
        and transactions.user_id = p_user_id;

      insert into transaction_audit (transaction_id, user_id, action, old_value, new_value)
      values (v_original.id, p_user_id, 'field_edit', to_jsonb(v_original), v_edit);
    end if;
  end loop;

  for v_split in select * from jsonb_array_elements(coalesce(p_splits, '[]'::jsonb))
  loop
    select * into v_original
    from transactions
    where transactions.id = (v_split->>'originalId')::uuid
      and transactions.user_id = p_user_id;

    if found then
      update transactions set is_deleted = true where transactions.id = v_original.id;

      v_child_ids := '[]'::jsonb;

      for v_line in select * from jsonb_array_elements(v_split->'lines')
      loop
        insert into transactions (
          user_id, account_id, txn_date, amount, type, category, sub_category,
          merchant, source, status, reviewed_at, raw_text, is_deleted,
          split_from_id, added_late, after_report_month, is_contra,
          possible_contra_of, duplicate_confidence, possible_duplicate_of,
          ref_number, ref_type, txn_group_id, is_infrastructure
        ) values (
          p_user_id, v_original.account_id, v_original.txn_date,
          (v_line->>'amount')::numeric, v_line->>'type', v_line->>'category',
          v_line->>'sub_category',
          coalesce(v_line->>'merchant', v_original.merchant),
          v_original.source, 'user_reviewed', now(), v_original.raw_text, false,
          v_original.id, v_original.added_late, v_original.after_report_month,
          false, null, null, null, null, null, null, false
        )
        returning transactions.id into v_new_id;

        v_child_ids := v_child_ids || to_jsonb(v_new_id);

        id := v_new_id;
        return next;
      end loop;

      insert into transaction_audit (transaction_id, user_id, action, old_value, new_value)
      values (
        v_original.id, p_user_id, 'split',
        to_jsonb(v_original),
        jsonb_build_object('child_ids', v_child_ids)
      );
    end if;
  end loop;

  insert into transaction_audit (transaction_id, user_id, action, old_value, new_value)
  select transactions.id, p_user_id, 'status_change',
         jsonb_build_object('status', status),
         jsonb_build_object('status', 'user_reviewed')
  from transactions
  where transactions.id = any(p_page_ids)
    and transactions.user_id = p_user_id
    and transactions.is_deleted = false
    and transactions.status is distinct from 'user_reviewed';

  update transactions
    set status = 'user_reviewed', reviewed_at = now()
    where transactions.id = any(p_page_ids)
      and transactions.user_id = p_user_id
      and transactions.is_deleted = false;

  return;
end;
$function$;

-- Auto-provisions a public.users row when a new auth user signs up.
-- IMPORTANT: this is almost certainly wired to a trigger ON auth.users,
-- not on any public schema table — that trigger was NOT captured by the
-- original "trigger_schema = 'public'" query and needs separate
-- confirmation (see the auth-schema trigger check).
CREATE OR REPLACE FUNCTION public.handle_new_auth_user()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
AS $function$
   begin
     insert into public.users (id, phone, primary_ingestion_source)
     values (new.id, new.phone, 'sms')
     on conflict (id) do nothing;
     return new;
   end;
   $function$;

   /*indexes*/ 

   -- ------------------------------------------------------------
-- SECTION 2: INDEXES
-- (primary key indexes are recreated automatically by their table's
-- PRIMARY KEY constraint — included here for reference only, don't
-- run the *_pkey lines manually if you're recreating tables from
-- scratch with proper PK constraints)
-- ------------------------------------------------------------

-- users_pkey — automatic via PRIMARY KEY on users.id
-- accounts_pkey — automatic via PRIMARY KEY on accounts.id
-- transactions_pkey — automatic via PRIMARY KEY on transactions.id
-- custom_categories_pkey — automatic via PRIMARY KEY on custom_categories.id
-- transaction_audit_pkey — automatic via PRIMARY KEY on transaction_audit.id

CREATE INDEX transactions_user_id_txn_date_idx ON public.transactions USING btree (user_id, txn_date);
CREATE INDEX transactions_user_id_status_idx ON public.transactions USING btree (user_id, status);
CREATE INDEX transactions_user_id_is_deleted_idx ON public.transactions USING btree (user_id, is_deleted);
CREATE INDEX transactions_user_id_ref_number_idx ON public.transactions USING btree (user_id, ref_number) WHERE (ref_number IS NOT NULL);
CREATE INDEX transactions_merchant_key_idx ON public.transactions USING btree (merchant_key);
-- custom_categories_user_id_merchant_key: NOT recreated here — already
-- declared as a UNIQUE constraint on the table in Section 0, which
-- auto-creates its own backing index. Adding it again here would collide.

/*RLS policies */

-- ------------------------------------------------------------
-- SECTION 3: RLS POLICIES
--
-- NOTE: custom_categories RLS was captured as enabled with zero policies
-- (the write feature isn't built yet on prod, so nothing currently
-- depends on that gap). Policies for it are included below as the
-- intended correct set for when that feature ships.
--
-- Run first, on every table:
--   alter table public.users enable row level security;
--   alter table public.accounts enable row level security;
--   alter table public.transactions enable row level security;
--   alter table public.transaction_audit enable row level security;
--   alter table public.custom_categories enable row level security;
-- ------------------------------------------------------------

CREATE POLICY "Users can update own row" ON public.users
  AS PERMISSIVE FOR UPDATE TO public
  USING (auth.uid() = id)
  WITH CHECK (auth.uid() = id);

CREATE POLICY "Users can view own row" ON public.users
  AS PERMISSIVE FOR SELECT TO public
  USING (auth.uid() = id);

CREATE POLICY "Users can delete own accounts" ON public.accounts
  AS PERMISSIVE FOR DELETE TO public
  USING (auth.uid() = user_id);

CREATE POLICY "Users can insert own accounts" ON public.accounts
  AS PERMISSIVE FOR INSERT TO public
  WITH CHECK (auth.uid() = user_id);

CREATE POLICY "Users can update own accounts" ON public.accounts
  AS PERMISSIVE FOR UPDATE TO public
  USING (auth.uid() = user_id)
  WITH CHECK (auth.uid() = user_id);

CREATE POLICY "Users can view own accounts" ON public.accounts
  AS PERMISSIVE FOR SELECT TO public
  USING (auth.uid() = user_id);

CREATE POLICY "Users can delete own transactions" ON public.transactions
  AS PERMISSIVE FOR DELETE TO public
  USING (auth.uid() = user_id);

CREATE POLICY "Users can insert own transactions" ON public.transactions
  AS PERMISSIVE FOR INSERT TO public
  WITH CHECK (auth.uid() = user_id);

CREATE POLICY "Users can update own transactions" ON public.transactions
  AS PERMISSIVE FOR UPDATE TO public
  USING (auth.uid() = user_id)
  WITH CHECK (auth.uid() = user_id);

CREATE POLICY "Users can view own transactions" ON public.transactions
  AS PERMISSIVE FOR SELECT TO public
  USING (auth.uid() = user_id);

CREATE POLICY "transaction_audit_insert_only" ON public.transaction_audit
  AS PERMISSIVE FOR INSERT TO public
  WITH CHECK (user_id = auth.uid());

-- custom_categories: not part of the original captured pg_policies output
-- (RLS was enabled with zero policies attached — see flag above). Added
-- here because the custom_categories write feature isn't built yet on
-- prod, so there's no "current behavior" to faithfully mirror — this is
-- the intended correct policy set for when that feature ships.
CREATE POLICY "Users can view own custom categories" ON public.custom_categories
  AS PERMISSIVE FOR SELECT TO public
  USING (auth.uid() = user_id);

CREATE POLICY "Users can insert own custom categories" ON public.custom_categories
  AS PERMISSIVE FOR INSERT TO public
  WITH CHECK (auth.uid() = user_id);

CREATE POLICY "Users can update own custom categories" ON public.custom_categories
  AS PERMISSIVE FOR UPDATE TO public
  USING (auth.uid() = user_id)
  WITH CHECK (auth.uid() = user_id);

CREATE POLICY "Users can delete own custom categories" ON public.custom_categories
  AS PERMISSIVE FOR DELETE TO public
  USING (auth.uid() = user_id);

  /*Triggers */

  -- ------------------------------------------------------------
-- SECTION 4: TRIGGERS — CONFIRMED
-- ------------------------------------------------------------

-- Event trigger wiring rls_auto_enable(): NOT created here. The new
-- Supabase project already ships an event trigger of this exact name
-- ("ensure_rls" on ddl_command_end) as a platform default, calling a
-- function also named rls_auto_enable. Since CREATE OR REPLACE FUNCTION
-- in Section 1 overwrites that function's body by name, the existing
-- trigger automatically starts calling YOUR version — no separate
-- CREATE EVENT TRIGGER needed, and attempting one collides on the name.
-- (Confirmed via: select evtname, evtfoid::regproc from pg_event_trigger
-- where evtname = 'ensure_rls' — returned function_name = rls_auto_enable,
-- evtenabled = 'O' i.e. active.)

-- Trigger on auth.users wiring handle_new_auth_user() — confirmed via
-- information_schema.triggers with event_object_schema = 'auth'.
CREATE TRIGGER on_auth_user_created
  AFTER INSERT ON auth.users
  FOR EACH ROW EXECUTE FUNCTION handle_new_auth_user();

  /*Add Haiku suggested transaction status*/

  ALTER TABLE transactions 
  DROP CONSTRAINT transactions_status_check,
  ADD CONSTRAINT transactions_status_check 
  CHECK (status IN ('pending_review', 'approved', 'user_reviewed', 'haiku_suggested'));

  /*Registered facts table creation */

  CREATE TABLE registered_facts (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id           uuid NOT NULL REFERENCES auth.users(id),
  fact_type         text NOT NULL CHECK (fact_type IN ('emi','sip','insurance_premium','salary')),
  entity_name       text NOT NULL,
  reference_value   text,              -- whatever label it came from (UMRN/Mandate ID/Policy No...) — generic, unlabeled on purpose
  expected_amount   numeric,
  amount_tolerance  numeric DEFAULT 0,
  expected_day      int,
  day_tolerance     int DEFAULT 5,
  resolved_type          text NOT NULL,
  resolved_category      text NOT NULL,
  resolved_sub_category  text,
  merchant_key      text,
  is_active         boolean DEFAULT true,
  created_at        timestamptz DEFAULT now(),
  updated_at        timestamptz DEFAULT now(),
  is_secured_debt boolean
);

/*Custom categories table modification */

ALTER TABLE custom_categories

  ADD COLUMN merchant_key text;

-- backfill existing rows using the same normalisation smsParser.ts already uses

UPDATE custom_categories

  SET merchant_key = left(lower(regexp_replace(merchant, '[^a-zA-Z0-9@]', '', 'g')), 40);

ALTER TABLE custom_categories

  ALTER COLUMN merchant_key SET NOT NULL;

ALTER TABLE custom_categories

  DROP CONSTRAINT custom_categories_user_id_merchant_key;

ALTER TABLE custom_categories

  ADD CONSTRAINT custom_categories_user_id_merchant_key_key UNIQUE (user_id, merchant_key);

CREATE INDEX idx_custom_categories_merchant_key ON custom_categories(merchant_key);

/*Transaction table new columns addition */

-- add_resolved_from.sql
--
-- Adds the missing persistence for smsParser.ts's Classification.resolvedFrom
-- ('custom_category' | 'registered_fact' | undefined). This value is
-- correctly computed at parse time and correctly propagated onto
-- ParsedTransaction (see smsParser.ts's own earlier fix for that hop), but
-- insertTransaction() in transactions.ts never wrote it into the `transactions`
-- table — there was no column for it to go into. Net effect: by the time a
-- row is fetched back out of the DB for the review queue UI, the information
-- about *why* a row auto-resolved (a saved custom-category preference vs. a
-- registered recurring-mandate fact) was already gone, even though the
-- carry-forward notes' UI requirement ("some indication when a row resolved
-- via custom_category or registered_fact") assumed it would still be there.
--
-- Nullable by design: the vast majority of rows resolve via ordinary regex
-- match and have no resolvedFrom value at all — that's the common case, not
-- an error state.
ALTER TABLE transactions
  ADD COLUMN IF NOT EXISTS resolved_from text
  CHECK (resolved_from IS NULL OR resolved_from IN ('custom_category', 'registered_fact'));

COMMENT ON COLUMN transactions.resolved_from IS
  'Which mechanism auto-resolved this transaction''s category, if any: '
  '''custom_category'' = matched a saved user preference for this merchant; '
  '''registered_fact'' = matched a registered recurring EMI/SIP/premium fact. '
  'Null for ordinary regex-taxonomy matches (the common case) and for '
  'unclassified/declined rows.';

  /*RLS for registered facts */

  alter table registered_facts enable row level security; -- confirm it's on (it already is)

create policy "Users can view their own registered_facts"
on registered_facts for select
using (auth.uid() = user_id);

create policy "Users can insert their own registered_facts"
on registered_facts for insert
with check (auth.uid() = user_id);

create policy "Users can update their own registered_facts"
on registered_facts for update
using (auth.uid() = user_id)
with check (auth.uid() = user_id);

/*Accounts table modification */

alter table public.accounts
  drop constraint accounts_account_type_check;

alter table public.accounts
  add constraint accounts_account_type_check check (
    account_type = any (
      array[
        'bank'::text,
        'credit_card'::text,
        'loan'::text,
        'mf'::text,
        'equity'::text,
        'insurance'::text,
        'epf'::text,
        'nps'::text,
        'ppf'::text,
        'fd'::text,
        'real_estate'::text,
        'cash'::text
      ]
    )
  );

  /*New table - user categories */

  -- create_user_categories.sql
--
-- New table for the taxonomy-expansion fix: previously, a category typed
-- via "+ Add new" was only ever saved as a merchant -> category mapping
-- (custom_categories), so it never became a selectable option for a
-- DIFFERENT merchant later. This table is deliberately NOT part of the
-- auto-categorization matching pipeline (custom_categories ->
-- registered_facts -> smsParser TAXONOMY -> uncategorized) — it has no
-- merchant column, so it structurally can't participate in merchant-based
-- matching. It exists purely as a second data source for the UI's
-- category/subcategory chip picker (EditModal, SplitFlow, add.tsx),
-- merged with the built-in TAXONOMY constant when rendering options.

-- [NOTE] sub_category is `not null default ''` rather than nullable.
-- Reasoning: a plain `unique(user_id, category, sub_category)` table
-- constraint doesn't stop duplicate rows when the column is nullable —
-- Postgres unique constraints treat NULL <> NULL, so (user_id, 'Food',
-- null) could be inserted repeatedly. The alternative (a COALESCE
-- expression index) can't be targeted by Supabase's upsert(onConflict:)
-- parameter, which requires literal column names matching a real
-- constraint. Storing '' instead of null for "no subcategory" (enforced
-- in userCategories.ts's saveUserCategory()) sidesteps both problems with
-- a plain constraint. fetchUserCategories() maps '' back to null for API
-- consumers, so nothing outside this table/its API file needs to know
-- about this storage detail.
-- [ADD] `type` was not in the originally discussed shape (user_id,
-- category, sub_category) but is required for correctness: every chip
-- picker in this codebase renders categories scoped by TxnType
-- (TAXONOMY['Expense'] vs TAXONOMY['Income'] etc. are separate lists).
-- Without a type column, a category typed while adding an Expense would
-- have no way to avoid also appearing under the Income tab's chip list
-- when merged with TAXONOMY — there'd be nothing to bucket it by.
create table if not exists user_categories (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null references auth.users(id) on delete cascade,
  type        text not null check (type in ('Expense','Income','Investment','Liability','Asset')),
  category    text not null,
  sub_category text not null default '',
  created_at  timestamptz not null default now(),

  constraint user_categories_unique_pair unique (user_id, type, category, sub_category)
);

-- RLS: same pattern as custom_categories / accounts — a user can only
-- read/write their own rows.
alter table user_categories enable row level security;

create policy "user_categories_select_own"
  on user_categories for select
  using (auth.uid() = user_id);

create policy "user_categories_insert_own"
  on user_categories for insert
  with check (auth.uid() = user_id);

create policy "user_categories_delete_own"
  on user_categories for delete
  using (auth.uid() = user_id);

create index if not exists user_categories_user_id_idx on user_categories(user_id); 

/*Drop not null constraint for account id" */

-- drop_account_id_not_null.sql
--
-- Removes the "account_id must never be null" constraint (arch doc
-- Table 23) — deliberately overturned this session. Previously, every
-- transaction with no extractable account number was routed to a shared
-- fake "Unknown" account per user, which corrupted findDuplicateCandidate()
-- (real unrelated transactions on the same date/amount, both unresolved,
-- got flagged as duplicates of each other purely from sharing that one
-- fake account_id). Null is the honest representation of "we don't know
-- which account" and is handled correctly by both contra detection
-- (differentAccount() already null-safe, unchanged) and duplicate
-- detection (findDuplicateCandidate() updated to skip its account-based
-- heuristic entirely when account_id is null).

-- 1. Drop the NOT NULL constraint on transactions.account_id.
alter table transactions
  alter column account_id drop not null;

/*-- 2. Re-point every existing transaction currently on a fake "Unknown"
--    account (account_number_masked = 'UNKNOWN') to account_id: null.
update transactions
set account_id = null
where account_id in (
  select id from accounts where account_number_masked = 'UNKNOWN'
);

-- 3. Delete the fake "Unknown" placeholder account rows themselves — one
--    per user, created by the now-removed resolveUnknownAccountId(). Safe
--    to delete now that step 2 has already re-pointed every referencing
--    transaction away from them.
delete from accounts where account_number_masked = 'UNKNOWN';*/

/* Haiku_candidate_log and low_confidence_log tables creation */

-- Migration: parse_logs (Log A + Log B)
--
-- Two logging-only tables. Neither is read by any existing code path, and
-- nothing writes to `transactions` differently because these exist. Safe
-- to run without affecting current testers.
--
-- IDENTITY KEY — mirrors transactions.ts's findGenuineResyncMatch(), not
-- a fresh design of our own. raw_sms_id ALONE is not used as a unique key
-- anywhere here: Android's SMS content provider _id is not guaranteed
-- permanently non-reusable, so a deleted message's ID can later be
-- assigned to a completely unrelated new message. Keying on raw_sms_id
-- alone would then silently treat that new, real message as "already
-- logged" and drop it. (raw_text, txn_date) was also considered and
-- rejected, for the same reason transactions.ts's own comments document:
-- two genuinely different real messages can share identical text and the
-- same date (confirmed there against real data — two same-day SIP debits
-- with no time component in the SMS body to tell them apart).
--
-- The safe combination, matching findGenuineResyncMatch() exactly: BOTH
-- raw_sms_id AND the exact raw_text must match an existing row for it to
-- count as "the same physical message, don't re-log it." txn_date is
-- stored as a plain column for readability only (e.g. "show me flags from
-- March") — it is NOT part of either table's identity key.
--
-- OPEN ITEM, not addressed here: transactions.raw_text is documented in
-- smsParser.ts as "AES-256 encrypt before INSERT (arch 11.2)". That
-- encryption happens somewhere inside ingestParsedMessages() /
-- lib/api/transactions.ts, which hasn't been shared, so this migration
-- does NOT replicate it — raw_text below is stored in plain text for now.
-- Before this ships to real testers (not just your own test device),
-- either apply the same encryption step to these inserts, or confirm with
-- yourself that plaintext-at-rest for these two tables specifically is
-- acceptable for the testing phase. Flagging rather than guessing.

create table if not exists haiku_candidate_log (
  id                    uuid primary key default gen_random_uuid(),
  user_id               uuid not null references auth.users(id) on delete cascade,
  raw_sms_id            text not null,
  raw_text              text not null,
  txn_date              date not null,  -- readability only, NOT part of the unique key (see note above)
  reason                text not null check (reason in ('missing_amount', 'unknown_direction', 'escalated_to_haiku')),
  extracted_amount      numeric,
  extracted_is_credit   boolean,
  extracted_merchant    text,
  extracted_bank        text,
  extracted_channel     text,
  logged_at             timestamptz not null,
  created_at            timestamptz not null default now(),
  -- Genuine-resync identity (same physical message + same reason logged
  -- again) is a true skip. A different reason for the same physical
  -- message is a genuinely new row, not a duplicate.
  unique (user_id, raw_sms_id, raw_text, reason)
);

create table if not exists low_confidence_log (
  id                        uuid primary key default gen_random_uuid(),
  user_id                   uuid not null references auth.users(id) on delete cascade,
  raw_sms_id                text not null,
  raw_text                  text not null,
  txn_date                  date not null,  -- readability only, NOT part of the unique key (see note above)
  matched_rule              text,
  l2_bank                   text,
  l2_merchant               text,
  l2_amount                 numeric,
  l2_direction              text,
  confidence_gate_reasons   text[] not null,
  logged_at                 timestamptz not null,
  created_at                timestamptz not null default now(),
  -- [CHANGED] This table gets UPDATED on conflict, not skipped (see
  -- parseLogs.ts) — if a rule fix changes what the gate flags for the same
  -- physical message, this row should reflect the current, not the stale,
  -- classification.
  unique (user_id, raw_sms_id, raw_text)
);

alter table haiku_candidate_log enable row level security;
alter table low_confidence_log  enable row level security;

-- Same shape as the rest of the app's per-user RLS: a user can only see
-- and write their own rows. Adjust policy names if your project has a
-- different naming convention already in use elsewhere.
create policy "haiku_candidate_log_own_rows" on haiku_candidate_log
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);

create policy "low_confidence_log_own_rows" on low_confidence_log
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);

-- Useful for the eventual "read last week's list" query these logs exist
-- for in the first place.
create index if not exists haiku_candidate_log_logged_at_idx on haiku_candidate_log (logged_at desc);
create index if not exists low_confidence_log_logged_at_idx  on low_confidence_log  (logged_at desc);

/*add new column - raw_sms_id in transactions */

-- add_raw_sms_id.sql
--
-- Adds raw_sms_id to transactions. Deliberately NO unique constraint on
-- (user_id, raw_sms_id) alone — Android's SMS content provider _id is not
-- documented as permanently non-reusable, so a bare unique constraint on
-- this column risks silently rejecting a genuinely new message if the OS
-- ever recycles a deleted message's _id. Enforced instead in application
-- code (insertTransaction() in transactions.ts), which requires BOTH
-- raw_sms_id AND raw_text to match an existing row before treating it as
-- a genuine resync — see that function's comment for the full reasoning.
--
-- Nullable: manually-entered transactions and any other non-SMS source
-- have no raw_sms_id at all.

alter table transactions
  add column if not exists raw_sms_id text null;

-- Non-unique index — this column IS queried on every insert (see
-- findGenuineResyncMatch in transactions.ts), so it still needs an index
-- for that lookup to stay fast as the table grows. Just not a unique one.
create index if not exists idx_transactions_user_raw_sms_id
  on transactions (user_id, raw_sms_id)
  where raw_sms_id is not null;

  /* Add raw_sms_id constraint */

  -- add_raw_sms_id_raw_text_unique_constraint.sql
--
-- Prevents two concurrent syncs (e.g. a genuine double-tap on "Sync Now",
-- or the hourly background task overlapping a foreground sync) from both
-- passing the application-level findGenuineResyncMatch() pre-check before
-- either has committed its INSERT, and both inserting a real duplicate row
-- for the same SMS. The app-level check alone can lose this race; only a
-- DB-level constraint makes it actually impossible.
--
-- Does NOT repeat what add_raw_sms_id.sql deliberately avoided: that
-- migration correctly refused a unique constraint on (user_id,
-- raw_sms_id) ALONE, since Android's SMS content provider _id can be
-- recycled and a bare-ID constraint could wrongly reject a genuinely new
-- message sharing a reused id. This constraint includes raw_text too —
-- two unrelated messages sharing both a recycled id AND identical text is
-- the same order of unlikely findGenuineResyncMatch() (transactions.ts)
-- already treats as safe. Consistent with that migration's reasoning, not
-- a reversal of it.
--
-- Also NOT the old (user_id, account_id, txn_date, amount) constraint
-- that was dropped separately (see drop_duplicate_unique_constraint.sql)
-- for being too strict and silently rejecting genuinely different
-- same-day/same-amount transactions.
--
-- Partial index conditions:
--   - raw_sms_id is not null: manual/CSV-sourced transactions have no
--     raw_sms_id and must never be constrained by this.
--   - is_deleted is not true: per the actual schema, is_deleted is
--     `boolean null default false` — NULLABLE, not NOT NULL. A plain
--     `is_deleted = false` check would silently exclude any row where
--     is_deleted is NULL (NULL = false evaluates to NULL, not true, in
--     Postgres) from this index's protection — same class of NULL-
--     comparison trap fetchTransactions() already guards against for
--     parse_failure elsewhere in this codebase (see its .or() comment).
--     `is_deleted is not true` is true for both false AND null, matching
--     the actually-intended "not currently marked deleted" semantics.
--     Mirrors findGenuineResyncMatch()'s own is_deleted scoping.
--
-- Known, accepted edge case: raw_text is also nullable at the column
-- level. Postgres unique indexes treat NULL as never equal to another
-- NULL, so two rows sharing raw_sms_id but both with raw_text IS NULL
-- would NOT violate this constraint. The app's own ParsedTransaction type
-- (smsParser.ts) guarantees raw_text is always set whenever raw_sms_id
-- is, so this is only reachable via a row inserted outside the normal app
-- path (e.g. a manual DB edit) — not addressed here, same scope
-- discipline as the rest of this fix (closes the concurrency race, isn't
-- a full data-integrity audit of every column).
--
-- Overlaps with add_raw_sms_id.sql's idx_transactions_user_raw_sms_id
-- (same (user_id, raw_sms_id) leftmost columns, but that one has no
-- is_deleted filter). Left in place deliberately — not verified here
-- whether any other query relies on it unscoped by is_deleted. Worth
-- checking separately; safe to drop later if nothing does.
--
-- Run on staging first: if any true duplicate rows already exist from a
-- past race (pre-dating this fix), index creation will fail until those
-- are cleaned up.
create unique index if not exists transactions_user_smsid_rawtext_unique
  on public.transactions using btree (user_id, raw_sms_id, raw_text) tablespace pg_default
where
  (raw_sms_id is not null and is_deleted is not true);

  /*Add background sync log table */

  -- add_background_sync_log_table.sql
-- Durable record of background-task activity, so "is the OS actually
-- invoking the hourly sync?" is answerable by a query. See
-- backgroundSync.ts / backgroundSyncLog.ts for what writes to this.

create table if not exists background_sync_log (
  id uuid primary key default gen_random_uuid(),
  user_id uuid references auth.users(id),
  event text not null,
  details jsonb,
  created_at timestamptz not null default now()
);

create index if not exists background_sync_log_user_id_created_at_idx
  on background_sync_log (user_id, created_at desc);

alter table background_sync_log enable row level security;

create policy "Users can insert their own background sync logs"
  on background_sync_log for insert
  with check (auth.uid() = user_id or user_id is null);

create policy "Users can read their own background sync logs"
  on background_sync_log for select
  using (auth.uid() = user_id);

-- Example check, once this has been live a few days:
--
-- select event, count(*), max(created_at) as most_recent
-- from background_sync_log
-- where user_id = auth.uid()
-- group by event
-- order by most_recent desc;
--
-- Zero 'task_invoked' rows over several days of normal phone use = the
-- OS is not running the task (or it's Denied/Restricted — also check
-- BackgroundFetch.getStatusAsync() on-device, which this table can't see).

/*chaneg time zone */

alter database postgres set timezone to 'Asia/Kolkata';

/*Add haiku pipeline tracking */

-- add_haiku_pipeline_tracking.sql
--
-- Adds the columns needed to run the real Haiku queue described in the
-- Pileap carry-forward chat. Nothing here touches `transactions` or
-- `low_confidence_log` — low_confidence_log is confirmed (by reading
-- smsParser.ts's own comment at the confidenceGate.js call site) to be a
-- shadow-only diagnostic table, never a Haiku queue, so it's untouched.
--
-- Every haiku_candidate_log row will now carry an explicit, terminal
-- haiku_status. The whole point of this column set is: when someone is
-- testing this, `select haiku_status, count(*) from haiku_candidate_log
-- group by 1` immediately tells you what's happening, with no guessing.

alter table public.haiku_candidate_log
  add column haiku_status text not null default 'pending',
  add column haiku_batch_id text,
  add column haiku_group_id text,
  add column haiku_response jsonb,
  add column haiku_error text,
  add column haiku_processed_at timestamp with time zone;

alter table public.haiku_candidate_log
  add constraint haiku_candidate_log_haiku_status_check
  check (
    haiku_status = any (array[
      'pending',                    -- not yet submitted to Haiku
      'sent',                       -- submitted, batch in flight
      'done_updated',               -- matched an existing pending_review row, updated it
      'done_inserted',              -- no sibling row existed (Layer 1 origin), inserted a new one
      'skipped_already_reviewed',   -- sibling row existed but a human (or reconcilePendingTransactions)
                                     -- already moved it off pending_review before Haiku responded —
                                     -- Haiku's answer was correctly discarded, not applied
      'dropped_unresolvable',       -- no sibling row, and Haiku also couldn't extract amount+direction —
                                     -- nothing worth inserting
      'failed'                      -- an error occurred applying this row; see haiku_error
    ])
  );

-- Used by haiku-submit to cheaply find work.
create index if not exists haiku_candidate_log_pending_idx
  on public.haiku_candidate_log (logged_at)
  where haiku_status = 'pending';

-- Used by haiku-collect to find in-flight batches without scanning the
-- whole table.
create index if not exists haiku_candidate_log_batch_idx
  on public.haiku_candidate_log (haiku_batch_id)
  where haiku_status = 'sent';  

  /*Add expected onfirmation date column in transactions */

  -- add_expected_confirmation_date.sql
--
-- One new column on `transactions`, per the provisional-notice
-- generalization design (Pileap chat). Nullable, no schema-level default
-- — every write path that sets parse_failure = 'awaiting_bank_confirmation'
-- (transactions.ts's insertTransaction(), and haiku-collect/index.ts's
-- applyResult()) now also sets this explicitly, either from the message's
-- own stated timeframe (Haiku-extracted) or a flat 14-day fallback.
--
-- Used by:
--   - transactions.ts's sweepOpenProvisionalNotices() (client-side, INR
--     rows only, runs at the end of every sync)
--   - haiku-collect/index.ts's sweepOpenProvisionalNotices() (server-side,
--     all rows including foreign-currency, runs on every scheduled
--     invocation, independent of the app's own sync/background-task
--     reliability)
--
-- Both flip parse_failure from 'awaiting_bank_confirmation' to the new
-- terminal value 'unconfirmed_expired' once this date has passed with
-- nothing matched — no new CHECK constraint needed since parse_failure is
-- already a free-text column with no such constraint (confirmed against
-- the live schema before writing this).

alter table public.transactions
  add column expected_confirmation_date date null;