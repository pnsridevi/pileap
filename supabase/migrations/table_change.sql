-- drop_duplicate_unique_constraint.sql
--
-- Removes the (user_id, account_id, txn_date, amount) unique constraint on
-- `transactions`. This constraint was arch doc 4.5's original "safety net"
-- against duplicate SMS — but per product decision, it must never silently
-- reject a row. Every parsed message should always produce exactly one row
-- in `transactions`, whether or not it looks like a duplicate. Duplicate
-- detection is now handled entirely at the application layer
-- (insertTransaction() in transactions.ts), which flags likely duplicates
-- via possible_duplicate_of + duplicate_confidence and routes them to
-- pending_review for the user to confirm or dismiss — never a silent drop.
--
-- Without dropping this constraint, a genuine duplicate SMS (identical
-- account/date/amount) would still fail the INSERT at the database level
-- even though the application now wants to insert it (flagged, not
-- rejected) — so the constraint has to go for that design to work at all.
--
-- CONFIRM THE CONSTRAINT NAME before running this in any environment.
-- Check with:
--   SELECT conname FROM pg_constraint
--   WHERE conrelid = 'transactions'::regclass AND contype = 'u';
-- The name below is inferred from the error message pattern this codebase
-- already checks for ('transactions_user_id_account_id_txn_date_amount'),
-- with Postgres's default '_key' suffix for auto-named unique constraints —
-- verify this matches before applying, and adjust if the real name differs.

ALTER TABLE transactions
  DROP CONSTRAINT IF EXISTS transactions_user_id_account_id_txn_date_amount_key;