# Pending Migrations

Checklist of SQL in `supabase/migrations/` that has NOT yet been applied to
a given environment. Check a box only after running the file in that
environment's Supabase SQL Editor (or via `supabase db push` once the CLI
workflow is set up).

## submit_transaction_page.sql

Installs the `submit_transaction_page` RPC — required for the Transactions
tab's Submit button (draft edits + splits + status transition). Without it,
`submitTransactionPage()` in `src/lib/api/transactions.ts` will throw
`function submit_transaction_page(...) does not exist`.

- [x] Dev
- [ ] Staging
- [ ] Production

---

## dev_disable_rls.sql — ⚠️ DEV ONLY, NEVER RUN ON STAGING/PRODUCTION

Temporary bypass — disables RLS on `accounts`/`transactions` because auth
isn't built yet, so there's no `auth.uid()` for real policies to check
against. Ingestion and every write in the Transactions tab will fail with
"new row violates row-level security policy" without this, on any dev
database with RLS enabled.

**Must be reversed** once real auth exists: re-enable RLS and write
policies scoped to `auth.uid() = user_id` on both tables, then remove this
file. Do not let this reach a shared/staging/production database in its
disabled state.

- [ ] Dev (bypass applied — re-enable before auth work ships)

---

## allow_null_pending_review_fields.sql — applies to ALL environments (not a dev-only bypass)

Makes `type`, `category`, `amount` nullable on `transactions` — the live
schema had them as NOT NULL, which blocked the documented pending_review-
with-null-fields behavior (arch doc 4.8) for escalated/unparseable SMS.
This corrects a schema bug against the documented design — ship it to
staging/production too, not just dev.

- [ ] Dev
- [ ] Staging
- [ ] Production

**Open question, originally noted here:** `account_id` IS explicitly
required not-null per arch doc Table 23. Confirmed resolved in practice —
`resolveUnknownAccountId()` in `transactions.ts` now routes any SMS with no
extractable account number to a placeholder "Unknown" account, so
`account_id` is never actually null at insert time. Leaving this note as a
record of the original open question, not because it's still open.

---

## drop_duplicate_unique_constraint.sql — applies to ALL environments (not a dev-only bypass)

Drops the `(user_id, account_id, txn_date, amount)` unique constraint on
`transactions`. Product decision: a transaction must never be silently
rejected for looking like a duplicate — every parsed message must produce
exactly one row. Duplicate detection is now entirely application-level
(`findDuplicateCandidate()` in `transactions.ts`), which flags likely
duplicates via `possible_duplicate_of`/`duplicate_confidence` and forces
`pending_review` instead of silently dropping the insert.

**Without this migration applied, the fix does not work as designed** — the
DB will still reject exact-value true-duplicate inserts at the database
level regardless of what the application code does, silently defeating this
for that subset of cases (near-duplicates with a different `ref_number`
would still insert fine either way — it's specifically the exact
account+date+amount case that needs this constraint gone).

**CONFIRM THE ACTUAL CONSTRAINT NAME** before running in any environment —
see the migration file's own header comment for the query to check it.

- [ ] Dev
- [ ] Staging
- [ ] Production

---

## (RESOLVED — no migration needed) possible_contra_of ON DELETE behavior

Previously flagged: `transactions.possible_contra_of` is a self-referencing
FK with no `ON DELETE` behavior, causing a foreign-key-constraint error when
manually clearing tables for dev testing.

Resolved as a side effect of the duplicate-detection work above:
`confirmDuplicate()` is now the first real, wired-up caller of soft-delete
(`is_deleted = true`) in this codebase, and soft-delete never triggers this
FK at all (the row still exists, just hidden — `possible_contra_of` pointers
stay valid). The FK error itself only ever came up during manual/dev SQL
cleanup (raw `DELETE`s), not through any real user-facing flow — still true.
If manual dev cleanup needs to keep clearing tables via raw SQL, the
workaround from before still applies:
```sql
UPDATE transactions SET possible_contra_of = NULL;
DELETE FROM transactions;
DELETE FROM accounts;
```

---

## (PARTIALLY BUILT) Soft-delete write path for spurious/erroneous transactions

Real scenario (PNB → HDFC internal transfer producing a spurious SBI-format
message): still valid, still relevant.

**Update — this pass:** `confirmDuplicate()` in `transactions.ts` now
soft-deletes (`is_deleted = true`, never a hard `DELETE`) — this is the same
mechanism a general "delete this spurious transaction" feature would use,
but it's currently only reachable through the duplicate-confirmation flow,
not from a general Delete control on any row.

Still outstanding:
1. A general-purpose `deleteTransaction()` — reachable from any row, not
   just ones flagged as possible duplicates.
2. `TransactionRow.tsx` needs a general Delete control, separate from the
   duplicate-confirm/contra-confirm UI.
3. If the row being deleted has `possible_contra_of` set (either direction),
   that link must be cleared on the partner row too.
4. **Still unverified:** whether health-score, goals, or any other
   aggregate/summary query filters on `is_deleted = false`. Now more
   pressing than before, since `is_deleted = true` rows are starting to
   exist in practice (from confirmed duplicates), not just a hypothetical.

- [ ] Not started (general case) — soft-delete mechanism itself now proven
      via the duplicate-confirmation flow, general UI/API still to come

---

Add new entries above this line as new migration files are created.