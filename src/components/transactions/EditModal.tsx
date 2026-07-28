/**
 * src/components/transactions/EditModal.tsx
 *
 * Draft-workspace edit form per arch doc 5.3.3 — "Nothing Written Until
 * Submit". This modal never talks to Supabase. It calls onSave(edit) with a
 * TransactionEdit; the parent (Transactions tab index.tsx) holds it in
 * local state and only sends it to the DB when the user taps Submit on the
 * page (via transactions.ts:submitTransactionPage).
 *
 * [CONFIRMED] The actual submit_transaction_page Postgres function has now
 * been reviewed against this flow — the field names this modal builds
 * (txn_date/amount/type/category/sub_category/merchant on TransactionEdit)
 * match exactly what the RPC reads via its `v_edit ? 'field'` key-presence
 * checks. This modal genuinely does lead to a real DB write; it just
 * doesn't perform that write itself, by design. One behavior worth knowing
 * about since it's not obvious from this file alone: the RPC also bulk-
 * promotes EVERY transaction on the current page to 'user_reviewed'
 * (moving it to History) when Submit is tapped on the page — not just the
 * rows that were actually edited. That's the RPC's own stated design
 * ("bulk status promotion... for everything visible on the page"), not
 * something introduced here.
 *
 * Uses ui/Button and ui/Input for the text fields and footer actions.
 * Type/category/sub-category stay as custom chips below — they're a
 * multi-select-style picker, not a text field or single action, so Input/
 * Button don't fit them.
 */
import { useEffect, useState } from 'react';
import { Modal, View, Text, TouchableOpacity, ScrollView, StyleSheet, Switch } from 'react-native';
import { colors, radius, spacing, fontSize, fontWeight } from '@/constants/theme';
import type { Transaction, TransactionEdit } from '@/lib/api/transactions';
import { TAXONOMY, TxnType, signedAmount } from '@/constants/transactionTaxonomy';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';

interface Props {
  visible: boolean;
  transaction: Transaction | null;
  onCancel: () => void;
  /** [FIX — comment was stale] Previously said "this modal doesn't write it
   * anywhere itself... no custom_categories API wired up yet" — that gap
   * has since been closed: index.tsx now actually calls
   * customCategories.ts's saveCustomCategory() when this flag is true,
   * instead of discarding it. Still surfaced here rather than written by
   * this modal directly, same reasoning as the transaction edit itself —
   * this component stays a pure form, the parent owns all persistence. */
  onSave: (edit: TransactionEdit, saveCustomCategory: boolean) => void;
}

export function EditModal({ visible, transaction, onCancel, onSave }: Props) {
  const [txnDate, setTxnDate] = useState('');
  const [amountText, setAmountText] = useState('');
  const [type, setType] = useState<TxnType>('Expense');
  const [category, setCategory] = useState('');
  const [subCategory, setSubCategory] = useState<string | undefined>(undefined);
  const [merchant, setMerchant] = useState('');
  const [saveCustom, setSaveCustom] = useState(false);

  useEffect(() => {
    if (!transaction) return;
    setTxnDate(transaction.txn_date);
    // [FIX] transaction.amount is genuinely number | null (declined-
    // transaction placeholders — see the Transaction type in
    // transactions.ts). Math.abs(null) used to silently coerce to 0 in
    // loose TS configs, but under strictNullChecks (which this project's
    // real tsconfig has on) this is a real type error, not just a runtime
    // footgun. Falls back to 0 — if a declined placeholder is ever opened
    // for editing, the user types in the real amount themselves.
    setAmountText(String(Math.abs(transaction.amount ?? 0)));
    // [FIX] transaction.type is also string | null (genuinely unclassified
    // rows, same as category) — the `as TxnType` cast here suppressed the
    // type error rather than fixing it, and would've silently left `type`
    // holding a null value the state's own declared type (TxnType) claims
    // is impossible. Falls back to 'Expense' — same default the state
    // starts with before any transaction is loaded — so the Type chips
    // always show a real, valid selection instead of none highlighted.
    setType((transaction.type as TxnType | null) ?? 'Expense');
    // [FIX] Same issue — transaction.category is string | null (genuinely
    // unclassified rows are real, not just declined ones), but setCategory
    // is typed Dispatch<SetStateAction<string>> since category starts as
    // useState(''). Empty string is the correct fallback here: it's what
    // makes categoryDefs/activeCategoryDef below correctly show "nothing
    // selected yet" rather than crashing or silently rendering "null".
    setCategory(transaction.category ?? '');
    setSubCategory(transaction.sub_category ?? undefined);
    setMerchant(transaction.merchant ?? '');
    setSaveCustom(false);
  }, [transaction]);

  if (!transaction) return null;

  const categoryDefs = TAXONOMY[type] ?? [];
  const activeCategoryDef = categoryDefs.find((c) => c.category === category);
  const subCategoryOptions = activeCategoryDef?.subCategories ?? [];

  const handleTypeChange = (next: TxnType) => {
    setType(next);
    const firstCat = TAXONOMY[next]?.[0];
    setCategory(firstCat?.category ?? '');
    setSubCategory(firstCat?.subCategories?.[0]);
  };

  const handleCategoryChange = (next: string) => {
    setCategory(next);
    const def = categoryDefs.find((c) => c.category === next);
    setSubCategory(def?.subCategories?.[0]);
  };

  const handleSave = () => {
    const magnitude = parseFloat(amountText);
    if (Number.isNaN(magnitude) || magnitude <= 0) return; // TODO: surface inline validation error rather than silently no-op

    const edit: TransactionEdit = {
      id: transaction.id,
      txn_date: txnDate,
      amount: signedAmount(magnitude, type, subCategory),
      type,
      category,
      sub_category: subCategory ?? null,
      merchant: merchant || null,
    };
    onSave(edit, saveCustom);
  };

  return (
    <Modal visible={visible} animationType="slide" transparent onRequestClose={onCancel}>
      <View style={styles.overlay}>
        <View style={styles.sheet}>
          <ScrollView showsVerticalScrollIndicator={false}>
            <Text style={styles.title}>Edit Transaction</Text>
            <Text style={styles.subtitle}>
              Update the type, category, or details for this transaction. Financial data can't be deleted or
              rejected — only corrected.
            </Text>

            {/* [ADD] Requested explicitly: showing the source SMS right here,
                where the user is actively deciding how to correct a row, is
                more useful than only showing it in the list view. Always
                shown when available (harmless for any status), with a label
                that calls it out more directly for pending_review/
                haiku_suggested — that's the case where the user genuinely
                doesn't know yet whether the current category is right, and
                the original message is the actual source of truth for that
                decision, not just a nice-to-have. */}
            {transaction.raw_text ? (
              <View style={styles.rawTextBox}>
                <Text style={styles.rawTextLabel}>
                  {transaction.status === 'pending_review' || transaction.status === 'haiku_suggested'
                    ? 'Original SMS — check this before correcting the fields below'
                    : 'Original SMS'}
                </Text>
                <Text style={styles.rawTextContent}>{transaction.raw_text}</Text>
              </View>
            ) : null}

            <View style={styles.row}>
              <View style={styles.fieldHalf}>
                <Input
                  label="Date"
                  value={txnDate}
                  onChangeText={setTxnDate}
                  placeholder="YYYY-MM-DD"
                />
              </View>
              <View style={styles.fieldHalf}>
                <Input
                  label="Amount (₹)"
                  value={amountText}
                  onChangeText={setAmountText}
                  keyboardType="decimal-pad"
                  placeholder="0.00"
                />
              </View>
            </View>

            <Text style={styles.label}>Type</Text>
            <View style={styles.chipRow}>
              {(Object.keys(TAXONOMY) as TxnType[]).map((t) => (
                <TouchableOpacity
                  key={t}
                  style={[styles.chip, type === t && styles.chipActive]}
                  onPress={() => handleTypeChange(t)}
                >
                  <Text style={[styles.chipText, type === t && styles.chipTextActive]}>{t}</Text>
                </TouchableOpacity>
              ))}
            </View>

            <Text style={styles.label}>Category</Text>
            <View style={styles.chipRow}>
              {categoryDefs.map((c) => (
                <TouchableOpacity
                  key={c.category}
                  style={[styles.chip, category === c.category && styles.chipActive]}
                  onPress={() => handleCategoryChange(c.category)}
                >
                  <Text style={[styles.chipText, category === c.category && styles.chipTextActive]}>
                    {c.category}
                  </Text>
                </TouchableOpacity>
              ))}
            </View>

            {subCategoryOptions.length > 0 && (
              <>
                <Text style={styles.label}>Subcategory</Text>
                <View style={styles.chipRow}>
                  {subCategoryOptions.map((s) => (
                    <TouchableOpacity
                      key={s}
                      style={[styles.chip, subCategory === s && styles.chipActive]}
                      onPress={() => setSubCategory(s)}
                    >
                      <Text style={[styles.chipText, subCategory === s && styles.chipTextActive]}>{s}</Text>
                    </TouchableOpacity>
                  ))}
                </View>
              </>
            )}

            <Input
              label="Merchant / Description"
              value={merchant}
              onChangeText={setMerchant}
              placeholder="e.g. Zomato, Salary"
            />

            <View style={styles.customCatBox}>
              <Switch value={saveCustom} onValueChange={setSaveCustom} trackColor={{ true: colors.brand }} />
              <Text style={styles.customCatText}>
                Save this category for this merchant — next time a transaction from the same merchant appears,
                Pileap will auto-apply it.
              </Text>
            </View>

            <View style={styles.footer}>
              <Button label="Cancel" variant="ghost" onPress={onCancel} />
              <Button label="Save Changes" variant="primary" onPress={handleSave} />
            </View>
          </ScrollView>
        </View>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  overlay: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.4)',
    justifyContent: 'flex-end',
  },
  sheet: {
    backgroundColor: colors.white,
    borderTopLeftRadius: radius.xl,
    borderTopRightRadius: radius.xl,
    padding: spacing.lg,
    maxHeight: '88%',
  },
  title: {
    fontSize: fontSize.xl,
    fontWeight: fontWeight.bold,
    color: colors.dark,
    marginBottom: spacing.xs,
  },
  subtitle: {
    fontSize: fontSize.sm,
    color: colors.muted,
    marginBottom: spacing.md,
    lineHeight: 18,
  },
  rawTextBox: {
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius.md,
    padding: spacing.sm,
    marginBottom: spacing.md,
  },
  rawTextLabel: {
    fontSize: fontSize.xs,
    fontWeight: fontWeight.semibold,
    color: colors.mid,
    marginBottom: spacing.xs,
    textTransform: 'uppercase',
    letterSpacing: 0.4,
  },
  rawTextContent: {
    fontSize: fontSize.xs,
    color: colors.dark,
    lineHeight: 17,
  },
  row: {
    flexDirection: 'row',
    gap: spacing.sm,
  },
  fieldHalf: {
    flex: 1,
  },
  label: {
    fontSize: fontSize.xs,
    fontWeight: fontWeight.semibold,
    color: colors.mid,
    marginTop: spacing.sm,
    marginBottom: spacing.xs,
    textTransform: 'uppercase',
    letterSpacing: 0.4,
  },
  chipRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: spacing.xs,
  },
  chip: {
    paddingHorizontal: spacing.sm,
    paddingVertical: spacing.xs,
    borderRadius: radius.full,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.surface,
  },
  chipActive: {
    backgroundColor: colors.brand,
    borderColor: colors.brand,
  },
  chipText: {
    fontSize: fontSize.xs,
    color: colors.mid,
    fontWeight: fontWeight.medium,
  },
  chipTextActive: {
    color: colors.white,
  },
  customCatBox: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: spacing.sm,
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius.md,
    padding: spacing.sm,
    marginTop: spacing.md,
  },
  customCatText: {
    flex: 1,
    fontSize: fontSize.xs,
    color: colors.mid,
    lineHeight: 16,
  },
  footer: {
    flexDirection: 'row',
    justifyContent: 'flex-end',
    gap: spacing.sm,
    marginTop: spacing.lg,
    marginBottom: spacing.md,
  },
});