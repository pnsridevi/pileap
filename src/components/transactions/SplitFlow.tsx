/**
 * src/components/transactions/SplitFlow.tsx
 *
 * Draft-workspace split, arch doc 5.3.3 + 5.9. Like EditModal, this never
 * writes to Supabase — onSubmit(split) hands a TransactionSplit to the
 * parent, which holds it in local state (replacing the original row with
 * the drafted child rows in the page view) until page Submit.
 *
 * Uses ui/Button and ui/Input for text fields and footer actions. Type/
 * category/sub-category stay as custom chips — same reasoning as
 * EditModal.tsx.
 */
import { useMemo, useState } from 'react';
import { Modal, View, Text, TouchableOpacity, ScrollView, StyleSheet } from 'react-native';
import { colors, radius, spacing, fontSize, fontWeight } from '@/constants/theme';
import type { Transaction, TransactionSplit, SplitLineInput } from '@/lib/api/transactions';
import { TAXONOMY, TxnType, signedAmount } from '@/constants/transactionTaxonomy';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';

interface DraftLine {
  amountText: string;
  type: TxnType;
  category: string;
  subCategory?: string;
  merchant: string;
}

interface Props {
  visible: boolean;
  transaction: Transaction | null;
  onCancel: () => void;
  onSubmit: (split: TransactionSplit) => void;
}

function makeDefaultLine(t: Transaction): DraftLine {
  const def = TAXONOMY[t.type as TxnType]?.[0];
  return {
    amountText: '',
    type: t.type as TxnType,
    category: t.category,
    subCategory: t.sub_category ?? def?.subCategories?.[0],
    merchant: t.merchant ?? '',
  };
}

export function SplitFlow({ visible, transaction, onCancel, onSubmit }: Props) {
  const [lines, setLines] = useState<DraftLine[]>(transaction ? [makeDefaultLine(transaction), makeDefaultLine(transaction)] : []);

  // Reset draft lines whenever a new transaction is opened for splitting.
  useMemo(() => {
    if (transaction) setLines([makeDefaultLine(transaction), makeDefaultLine(transaction)]);
  }, [transaction?.id]);

  if (!transaction) return null;

  const targetAmount = Math.abs(transaction.amount);
  const runningTotal = lines.reduce((sum, l) => sum + (parseFloat(l.amountText) || 0), 0);
  const matches = Math.abs(runningTotal - targetAmount) < 0.005;

  const updateLine = (idx: number, patch: Partial<DraftLine>) => {
    setLines((prev) => prev.map((l, i) => (i === idx ? { ...l, ...patch } : l)));
  };

  const addLine = () => setLines((prev) => [...prev, makeDefaultLine(transaction)]);
  const removeLine = (idx: number) => setLines((prev) => prev.filter((_, i) => i !== idx));

  const handleSubmit = () => {
    if (!matches || lines.length < 2) return; // TODO: inline validation message instead of silent no-op

    const splitLines: SplitLineInput[] = lines.map((l) => ({
      amount: signedAmount(parseFloat(l.amountText) || 0, l.type, l.subCategory),
      type: l.type,
      category: l.category,
      sub_category: l.subCategory ?? null,
      merchant: l.merchant || null,
    }));

    onSubmit({ originalId: transaction.id, lines: splitLines });
  };

  return (
    <Modal visible={visible} animationType="slide" transparent onRequestClose={onCancel}>
      <View style={styles.overlay}>
        <View style={styles.sheet}>
          <ScrollView showsVerticalScrollIndicator={false}>
            <Text style={styles.title}>Split Transaction</Text>
            <Text style={styles.subtitle}>
              Break this into 2 or more transactions — e.g. a shared bill, or items that belong in different
              categories. Each line is checked against the ₹5,000 review rule on its own.
            </Text>

            <View style={styles.summaryBox}>
              <Text style={styles.summaryText}>
                {transaction.merchant || 'Transaction'} · ₹{targetAmount.toLocaleString('en-IN')}
              </Text>
            </View>

            {lines.map((line, idx) => {
              const categoryDefs = TAXONOMY[line.type] ?? [];
              const subOptions = categoryDefs.find((c) => c.category === line.category)?.subCategories ?? [];
              return (
                <View key={idx} style={styles.lineBox}>
                  <View style={styles.lineHeader}>
                    <Text style={styles.lineLabel}>Line {idx + 1}</Text>
                    {lines.length > 2 && (
                      <TouchableOpacity onPress={() => removeLine(idx)}>
                        <Text style={styles.removeText}>Remove</Text>
                      </TouchableOpacity>
                    )}
                  </View>
                  <Input
                    value={line.amountText}
                    onChangeText={(v) => updateLine(idx, { amountText: v })}
                    keyboardType="decimal-pad"
                    placeholder="Amount (₹)"
                  />
                  <View style={styles.chipRow}>
                    {(Object.keys(TAXONOMY) as TxnType[]).map((t) => (
                      <TouchableOpacity
                        key={t}
                        style={[styles.chip, line.type === t && styles.chipActive]}
                        onPress={() => {
                          const firstCat = TAXONOMY[t]?.[0];
                          updateLine(idx, { type: t, category: firstCat?.category ?? '', subCategory: firstCat?.subCategories?.[0] });
                        }}
                      >
                        <Text style={[styles.chipText, line.type === t && styles.chipTextActive]}>{t}</Text>
                      </TouchableOpacity>
                    ))}
                  </View>
                  <View style={styles.chipRow}>
                    {categoryDefs.map((c) => (
                      <TouchableOpacity
                        key={c.category}
                        style={[styles.chip, line.category === c.category && styles.chipActive]}
                        onPress={() => updateLine(idx, { category: c.category, subCategory: c.subCategories?.[0] })}
                      >
                        <Text style={[styles.chipText, line.category === c.category && styles.chipTextActive]}>
                          {c.category}
                        </Text>
                      </TouchableOpacity>
                    ))}
                  </View>
                  {subOptions.length > 0 && (
                    <View style={styles.chipRow}>
                      {subOptions.map((s) => (
                        <TouchableOpacity
                          key={s}
                          style={[styles.chip, line.subCategory === s && styles.chipActive]}
                          onPress={() => updateLine(idx, { subCategory: s })}
                        >
                          <Text style={[styles.chipText, line.subCategory === s && styles.chipTextActive]}>{s}</Text>
                        </TouchableOpacity>
                      ))}
                    </View>
                  )}
                  <Input
                    value={line.merchant}
                    onChangeText={(v) => updateLine(idx, { merchant: v })}
                    placeholder="Merchant / description"
                  />
                </View>
              );
            })}

            <TouchableOpacity onPress={addLine} style={styles.addLineBtn}>
              <Text style={styles.addLineText}>+ Add another line</Text>
            </TouchableOpacity>

            <View style={styles.totalsBox}>
              <Text style={styles.totalsText}>
                Original: ₹{targetAmount.toLocaleString('en-IN')} · Split total: ₹{runningTotal.toLocaleString('en-IN')}
              </Text>
              <Text style={[styles.matchStatus, { color: matches ? '#059669' : colors.red }]}>
                {matches ? 'Matches ✓' : 'Does not match'}
              </Text>
            </View>

            <View style={styles.footer}>
              <Button label="Cancel" variant="ghost" onPress={onCancel} />
              <Button label="Submit Split" variant="primary" onPress={handleSubmit} disabled={!matches} />
            </View>
          </ScrollView>
        </View>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  overlay: { flex: 1, backgroundColor: 'rgba(0,0,0,0.4)', justifyContent: 'flex-end' },
  sheet: {
    backgroundColor: colors.white,
    borderTopLeftRadius: radius.xl,
    borderTopRightRadius: radius.xl,
    padding: spacing.lg,
    maxHeight: '90%',
  },
  title: { fontSize: fontSize.xl, fontWeight: fontWeight.bold, color: colors.dark, marginBottom: spacing.xs },
  subtitle: { fontSize: fontSize.sm, color: colors.muted, marginBottom: spacing.md, lineHeight: 18 },
  summaryBox: {
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius.md,
    padding: spacing.sm,
    marginBottom: spacing.md,
  },
  summaryText: { fontSize: fontSize.base, fontWeight: fontWeight.semibold, color: colors.dark },
  lineBox: {
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius.md,
    padding: spacing.sm,
    marginBottom: spacing.sm,
    gap: spacing.xs,
  },
  lineHeader: { flexDirection: 'row', justifyContent: 'space-between', marginBottom: spacing.xs },
  lineLabel: { fontSize: fontSize.xs, fontWeight: fontWeight.semibold, color: colors.mid },
  removeText: { fontSize: fontSize.xs, color: colors.red, fontWeight: fontWeight.medium },
  chipRow: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.xs },
  chip: {
    paddingHorizontal: spacing.sm,
    paddingVertical: spacing.xs,
    borderRadius: radius.full,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.surface,
  },
  chipActive: { backgroundColor: colors.brand, borderColor: colors.brand },
  chipText: { fontSize: fontSize.xs, color: colors.mid, fontWeight: fontWeight.medium },
  chipTextActive: { color: colors.white },
  addLineBtn: { paddingVertical: spacing.sm, marginBottom: spacing.md },
  addLineText: { fontSize: fontSize.sm, color: colors.brand, fontWeight: fontWeight.semibold },
  totalsBox: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    backgroundColor: colors.brandLight,
    borderRadius: radius.md,
    padding: spacing.sm,
    marginBottom: spacing.md,
  },
  totalsText: { fontSize: fontSize.sm, color: colors.mid },
  matchStatus: { fontSize: fontSize.sm, fontWeight: fontWeight.semibold },
  footer: { flexDirection: 'row', justifyContent: 'flex-end', gap: spacing.sm, marginBottom: spacing.md },
});