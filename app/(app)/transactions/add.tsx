/**
 * app/(app)/transactions/add.tsx
 *
 * Manual transaction entry — new screen. Reuses the same category/
 * subcategory chip-picker pattern (including "+ Add new") built for
 * EditModal.tsx/SplitFlow.tsx, applied to a blank form instead of an
 * existing transaction. Reached via the "+" icon in the Feed header.
 *
 * On submit, calls transactions.ts's insertManualTransaction() — a direct
 * insert, NOT the SMS-ingestion path (insertTransaction()) or the draft-
 * workspace Submit flow (submitTransactionPage()). Per product decisions
 * this session: lands directly as status 'user_reviewed' (skips the
 * review queue), source 'manual', and deliberately runs no duplicate
 * detection (findDuplicateCandidate() is never called here).
 *
 * Account picker: fetches existing accounts + ensures Cash exists
 * (resolveCashAccountId(), same as accounts.tsx), filtered to
 * is_active !== false. This is the one place account-tracking (accounts.
 * is_active) actually has a real effect right now — see the discussion
 * this session on why enforcing it at SMS-ingestion time was deferred
 * (too risky to touch blind) while a brand-new form with no existing
 * behavior to break was safe to filter immediately.
 */
import { useCallback, useEffect, useState } from 'react';
import { View, Text, TextInput, TouchableOpacity, ScrollView, StyleSheet, ActivityIndicator, Switch } from 'react-native';
import { useRouter } from 'expo-router';
import { colors, radius, spacing, fontSize, fontWeight } from '@/constants/theme';
import { TAXONOMY, TxnType, signedAmount } from '@/constants/transactionTaxonomy';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';
import { insertManualTransaction } from '@/lib/api/transactions';
import { saveCustomCategory } from '@/lib/api/customCategories';
import { fetchAccounts, resolveCashAccountId, type Account } from '@/lib/api/accounts';

function todayIso(): string {
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

const ACCOUNT_TYPE_LABELS: Record<Account['account_type'], string> = {
  bank: 'Bank', credit_card: 'Credit Card', loan: 'Loan', mf: 'Mutual Fund',
  equity: 'Equity', insurance: 'Insurance', epf: 'EPF', nps: 'NPS',
  ppf: 'PPF', fd: 'FD', real_estate: 'Real Estate', cash: 'Cash',
};

export default function AddTransactionScreen() {
  const router = useRouter();

  const [accounts, setAccounts] = useState<Account[]>([]);
  const [loadingAccounts, setLoadingAccounts] = useState(true);
  const [accountId, setAccountId] = useState<string | null>(null);

  const [txnDate, setTxnDate] = useState(todayIso());
  const [amountText, setAmountText] = useState('');
  const [type, setType] = useState<TxnType>('Expense');
  const [category, setCategory] = useState('');
  const [subCategory, setSubCategory] = useState<string | undefined>(undefined);
  const [merchant, setMerchant] = useState('');
  const [saveCustom, setSaveCustom] = useState(false);

  const [addingCategory, setAddingCategory] = useState(false);
  const [newCategoryText, setNewCategoryText] = useState('');
  const [addingSubCategory, setAddingSubCategory] = useState(false);
  const [newSubCategoryText, setNewSubCategoryText] = useState('');

  const [formError, setFormError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const loadAccounts = useCallback(async () => {
    setLoadingAccounts(true);
    try {
      const cashId = await resolveCashAccountId();
      const rows = await fetchAccounts();
      // [Filtering by is_active happens here — see file docblock.]
      const active = rows.filter((a) => a.is_active !== false);
      setAccounts(active);
      setAccountId((prev) => prev ?? cashId);
    } catch (e) {
      setFormError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoadingAccounts(false);
    }
  }, []);

  useEffect(() => { loadAccounts(); }, [loadAccounts]);

  const categoryDefs = TAXONOMY[type] ?? [];
  const activeCategoryDef = categoryDefs.find((c) => c.category === category);
  const subCategoryOptions = activeCategoryDef?.subCategories ?? [];
  const isCustomCategory = category !== '' && !activeCategoryDef;
  const isCustomSubCategory = !!subCategory && !subCategoryOptions.includes(subCategory);

  const handleTypeChange = (next: TxnType) => {
    setType(next);
    const firstCat = TAXONOMY[next]?.[0];
    setCategory(firstCat?.category ?? '');
    setSubCategory(firstCat?.subCategories?.[0]);
    setAddingCategory(false);
    setNewCategoryText('');
    setAddingSubCategory(false);
    setNewSubCategoryText('');
  };

  const handleCategoryChange = (next: string) => {
    setCategory(next);
    const def = categoryDefs.find((c) => c.category === next);
    setSubCategory(def?.subCategories?.[0]);
    setAddingCategory(false);
    setNewCategoryText('');
    setAddingSubCategory(false);
    setNewSubCategoryText('');
  };

  const handleAddCategory = () => {
    const trimmed = newCategoryText.trim();
    if (!trimmed) return;
    setCategory(trimmed);
    setSubCategory(trimmed);
    setNewCategoryText('');
    setAddingCategory(false);
    setFormError(null);
  };

  const handleAddSubCategory = () => {
    const trimmed = newSubCategoryText.trim();
    if (!trimmed) return;
    setSubCategory(trimmed);
    setNewSubCategoryText('');
    setAddingSubCategory(false);
    setFormError(null);
  };

  const handleSubmit = async () => {
    const magnitude = parseFloat(amountText);
    if (Number.isNaN(magnitude) || magnitude <= 0) {
      setFormError('Enter a valid amount.');
      return;
    }
    if (!category.trim()) {
      setFormError('Select an existing category, or add a new one.');
      return;
    }
    if (!accountId) {
      setFormError('Select an account.');
      return;
    }
    setFormError(null);
    setSubmitting(true);
    try {
      const inserted = await insertManualTransaction({
        txn_date: txnDate,
        amount: signedAmount(magnitude, type, subCategory),
        type,
        category,
        sub_category: subCategory ?? null,
        merchant: merchant || null,
        account_id: accountId,
      });

      if (saveCustom && merchant && category) {
        try {
          await saveCustomCategory({ merchant, type, category, subCategory: subCategory ?? null, excludeTransactionId: inserted.id });
        } catch (e) {
          console.error('Failed to save custom category preference:', e);
        }
      }

      router.back();
    } catch (e) {
      setFormError(e instanceof Error ? e.message : String(e));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <View style={styles.container}>
      <ScrollView showsVerticalScrollIndicator={false} contentContainerStyle={{ paddingBottom: spacing.xl }}>
        <Text style={styles.title}>Add Transaction</Text>
        <Text style={styles.subtitle}>
          For anything not caught by SMS or email — e.g. a cash purchase. Saved immediately, no review needed.
        </Text>

        <View style={styles.row}>
          <View style={styles.fieldHalf}>
            <Input label="Date" value={txnDate} onChangeText={setTxnDate} placeholder="YYYY-MM-DD" />
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
              <Text style={[styles.chipText, category === c.category && styles.chipTextActive]}>{c.category}</Text>
            </TouchableOpacity>
          ))}
          {isCustomCategory && (
            <View style={[styles.chip, styles.chipActive]}>
              <Text style={[styles.chipText, styles.chipTextActive]}>{category}</Text>
            </View>
          )}
          <TouchableOpacity style={styles.addChip} onPress={() => setAddingCategory(true)}>
            <Text style={styles.addChipText}>+ Add new</Text>
          </TouchableOpacity>
        </View>

        {addingCategory && (
          <View style={styles.addInputRow}>
            <View style={styles.addInputField}>
              <Input value={newCategoryText} onChangeText={setNewCategoryText} placeholder="New category name" autoFocus />
            </View>
            <Button label="Add" variant="primary" size="sm" disabled={!newCategoryText.trim()} onPress={handleAddCategory} />
            <Button label="Cancel" variant="ghost" size="sm" onPress={() => { setAddingCategory(false); setNewCategoryText(''); }} />
          </View>
        )}

        {category !== '' && (
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
              {isCustomSubCategory && (
                <View style={[styles.chip, styles.chipActive]}>
                  <Text style={[styles.chipText, styles.chipTextActive]}>{subCategory}</Text>
                </View>
              )}
              <TouchableOpacity style={styles.addChip} onPress={() => setAddingSubCategory(true)}>
                <Text style={styles.addChipText}>+ Add new</Text>
              </TouchableOpacity>
            </View>

            {addingSubCategory && (
              <View style={styles.addInputRow}>
                <View style={styles.addInputField}>
                  <Input value={newSubCategoryText} onChangeText={setNewSubCategoryText} placeholder="New subcategory name" autoFocus />
                </View>
                <Button label="Add" variant="primary" size="sm" disabled={!newSubCategoryText.trim()} onPress={handleAddSubCategory} />
                <Button label="Cancel" variant="ghost" size="sm" onPress={() => { setAddingSubCategory(false); setNewSubCategoryText(''); }} />
              </View>
            )}
          </>
        )}

        <Input label="Merchant / Description" value={merchant} onChangeText={setMerchant} placeholder="e.g. Local grocery store" />

        <Text style={styles.label}>Account</Text>
        {loadingAccounts ? (
          <ActivityIndicator color={colors.brand} style={{ marginVertical: spacing.sm }} />
        ) : (
          <View style={styles.chipRow}>
            {accounts.map((a) => (
              <TouchableOpacity
                key={a.id}
                style={[styles.chip, accountId === a.id && styles.chipActive]}
                onPress={() => setAccountId(a.id)}
              >
                <Text style={[styles.chipText, accountId === a.id && styles.chipTextActive]}>
                  {a.institution_name ?? ACCOUNT_TYPE_LABELS[a.account_type]}
                  {a.account_number_masked ? ` ${a.account_number_masked}` : ''}
                </Text>
              </TouchableOpacity>
            ))}
          </View>
        )}

        <View style={styles.customCatBox}>
          <Switch value={saveCustom} onValueChange={setSaveCustom} trackColor={{ true: colors.brand }} />
          <Text style={styles.customCatText}>
            Save this category for this merchant — future transactions from it will auto-apply this category.
          </Text>
        </View>

        {formError && <Text style={styles.formError}>{formError}</Text>}

        <View style={styles.footer}>
          <Button label="Cancel" variant="ghost" onPress={() => router.back()} />
          <Button label="Save Transaction" variant="primary" loading={submitting} onPress={handleSubmit} />
        </View>
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.white, padding: spacing.lg },
  title: { fontSize: fontSize.xl, fontWeight: fontWeight.bold, color: colors.dark, marginBottom: spacing.xs },
  subtitle: { fontSize: fontSize.sm, color: colors.muted, marginBottom: spacing.md, lineHeight: 18 },
  row: { flexDirection: 'row', gap: spacing.sm },
  fieldHalf: { flex: 1 },
  label: {
    fontSize: fontSize.xs, fontWeight: fontWeight.semibold, color: colors.mid,
    marginTop: spacing.sm, marginBottom: spacing.xs, textTransform: 'uppercase', letterSpacing: 0.4,
  },
  chipRow: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.xs },
  chip: {
    paddingHorizontal: spacing.sm, paddingVertical: spacing.xs, borderRadius: radius.full,
    borderWidth: 1, borderColor: colors.border, backgroundColor: colors.surface,
  },
  chipActive: { backgroundColor: colors.brand, borderColor: colors.brand },
  chipText: { fontSize: fontSize.xs, color: colors.mid, fontWeight: fontWeight.medium },
  chipTextActive: { color: colors.white },
  addChip: {
    paddingHorizontal: spacing.sm, paddingVertical: spacing.xs, borderRadius: radius.full,
    borderWidth: 1, borderColor: colors.brand, borderStyle: 'dashed', backgroundColor: colors.white,
  },
  addChipText: { fontSize: fontSize.xs, color: colors.brand, fontWeight: fontWeight.semibold },
  addInputRow: { flexDirection: 'row', alignItems: 'flex-end', gap: spacing.xs, marginTop: spacing.xs },
  addInputField: { flex: 1 },
  customCatBox: {
    flexDirection: 'row', alignItems: 'flex-start', gap: spacing.sm, backgroundColor: colors.surface,
    borderWidth: 1, borderColor: colors.border, borderRadius: radius.md, padding: spacing.sm, marginTop: spacing.md,
  },
  customCatText: { flex: 1, fontSize: fontSize.xs, color: colors.mid, lineHeight: 16 },
  formError: { fontSize: fontSize.xs, color: colors.red, marginTop: spacing.sm },
  footer: { flexDirection: 'row', justifyContent: 'flex-end', gap: spacing.sm, marginTop: spacing.lg },
});