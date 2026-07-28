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