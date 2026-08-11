/**
 * src/components/transactions/SplitFlow.tsx
 *
 * Draft-workspace split, arch doc 5.3.3 + 5.9. Like EditModal, this never
 * writes to Supabase — onSubmit(split) hands a TransactionSplit to the
 * parent, which holds it in local state (replacing the original row with
 * the drafted child rows in the page view) until page Submit.
 *
 * [CONFIRMED] The actual submit_transaction_page Postgres function has now
 * been reviewed against this flow — the shape this component builds
 * ({ originalId, lines: [{ amount, type, category, sub_category,
 * merchant }] }) matches exactly what the RPC reads off p_splits. It soft-
 * deletes the original row and inserts one new row per line, each landing
 * directly as status 'user_reviewed' (a split is treated as an immediate,
 * final resolution, not something left pending). One thing this component
 * has no visibility into and can't control: the RPC does not carry
 * resolved_from or merchant_key forward onto the new split-child rows —
 * both come back null, which is correct for resolved_from (a manually
 * split line isn't an auto-resolved one) but means these rows won't be
 * matchable by merchant_key if that's ever needed later. Flagging, not
 * fixing — that's a call for whoever owns the RPC, not this file.
 *
 * [ADD] Custom category/subcategory entry per line — same feature and same
 * reasoning as EditModal.tsx's own "+ Add new" chips (see that file's
 * top-of-file comment for the full explanation). Since a split has
 * multiple independent lines, the add-new input state (whether the box is
 * open, and what's typed into it) lives ON each DraftLine rather than as
 * one shared piece of component state — otherwise typing a new category
 * for Line 2 would also affect Line 1's input. Confirming a brand-new
 * category on a line defaults that line's subCategory to the same string,
 * same as EditModal, so sub_category is never left null.
 *
 * Uses ui/Button and ui/Input for text fields and footer actions. Type/
 * category/sub-category stay as custom chips — same reasoning as
 * EditModal.tsx.
 */
import { useEffect, useMemo, useState } from 'react';
import { Modal, View, Text, TouchableOpacity, ScrollView, StyleSheet } from 'react-native';
import { colors, radius, spacing, fontSize, fontWeight } from '@/constants/theme';
import type { Transaction, TransactionSplit, SplitLineInput } from '@/lib/api/transactions';
import { TAXONOMY, TxnType, signedAmount } from '@/constants/transactionTaxonomy';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';
import { fetchUserCategories, saveUserCategory, mergeUserCategoriesIntoTaxonomy, type UserCategoryRow } from '@/lib/api/userCategories';

interface DraftLine {
  amountText: string;
  type: TxnType;
  category: string;
  subCategory?: string;
  merchant: string;
  // [ADD] Per-line "+ Add new" input state — see top-of-file comment.
  addingCategory: boolean;
  newCategoryText: string;
  addingSubCategory: boolean;
  newSubCategoryText: string;
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
    // [FIX] t.category is string | null (a genuinely uncategorized
    // transaction is a real case, not just a declined one), but
    // DraftLine.category is declared string. Falls back to the first
    // category for this type if there's no category yet, then '' if even
    // that's unavailable — same "nothing selected yet, not broken" intent
    // as the equivalent fix in EditModal.tsx.
    category: t.category ?? def?.category ?? '',
    subCategory: t.sub_category ?? def?.subCategories?.[0],
    merchant: t.merchant ?? '',
    addingCategory: false,
    newCategoryText: '',
    addingSubCategory: false,
    newSubCategoryText: '',
  };
}

export function SplitFlow({ visible, transaction, onCancel, onSubmit }: Props) {
  const [lines, setLines] = useState<DraftLine[]>(transaction ? [makeDefaultLine(transaction), makeDefaultLine(transaction)] : []);
  // [ADD] Inline validation error shown above the footer buttons — same
  // pattern as EditModal.tsx.
  const [formError, setFormError] = useState<string | null>(null);

  // [ADD] user_categories — see userCategories.ts's docblock. Shared
  // across all lines (it's per-user, not per-line), unlike the per-line
  // addingCategory/newCategoryText state on DraftLine.
  const [userCategories, setUserCategories] = useState<UserCategoryRow[]>([]);
  useEffect(() => {
    fetchUserCategories().then(setUserCategories).catch((e) => {
      console.error('Failed to load user categories:', e);
    });
  }, []);

  // Reset draft lines whenever a new transaction is opened for splitting.
  useMemo(() => {
    if (transaction) {
      setLines([makeDefaultLine(transaction), makeDefaultLine(transaction)]);
      setFormError(null);
    }
  }, [transaction?.id]);

  if (!transaction) return null;

  // [FIX] transaction.amount is number | null (declined-transaction
  // placeholders — see transactions.ts's Transaction type). A declined row
  // has nothing to split in practice, but falling back to 0 keeps this a
  // type-safe no-crash state (an empty target, "does not match" until
  // lines are added) rather than a compile error or a runtime NaN.
  const targetAmount = Math.abs(transaction.amount ?? 0);
  const runningTotal = lines.reduce((sum, l) => sum + (parseFloat(l.amountText) || 0), 0);
  const matches = Math.abs(runningTotal - targetAmount) < 0.005;

  const updateLine = (idx: number, patch: Partial<DraftLine>) => {
    setLines((prev) => prev.map((l, i) => (i === idx ? { ...l, ...patch } : l)));
  };

  const addLine = () => setLines((prev) => [...prev, makeDefaultLine(transaction)]);
  const removeLine = (idx: number) => setLines((prev) => prev.filter((_, i) => i !== idx));

  // [ADD] Confirms the typed category name for one line. Defaults that
  // line's subCategory to the same string — see this file's top-of-file
  // comment for why.
  const handleAddCategory = (idx: number) => {
    const trimmed = lines[idx].newCategoryText.trim();
    if (!trimmed) return;
    updateLine(idx, {
      category: trimmed,
      subCategory: trimmed,
      newCategoryText: '',
      addingCategory: false,
    });
    setFormError(null);
    // [CHANGE] No longer persists to user_categories here — deferred to
    // handleSubmit() below, once per line, with each line's FINAL
    // category/subCategory. Same reasoning as EditModal/add.tsx: saving
    // immediately here created a stray (category, null) row whenever a
    // subcategory was typed right after.
  };

  // [ADD] Confirms a typed subcategory name for one line — works whether
  // the line's category is a real TAXONOMY entry or a custom one just
  // typed in above.
  const handleAddSubCategory = (idx: number) => {
    const trimmed = lines[idx].newSubCategoryText.trim();
    const lineCategory = lines[idx].category;
    if (!trimmed || !lineCategory) return;
    updateLine(idx, {
      subCategory: trimmed,
      newSubCategoryText: '',
      addingSubCategory: false,
    });
    setFormError(null);
    // [CHANGE] Same reasoning as handleAddCategory above — no DB write here.
  };

  // [FIX] Previously only checked matches/line-count, silently no-opping
  // otherwise with a bare TODO comment. Now also checks every line has a
  // non-empty category (a line's category can legitimately start out as
  // '' — see makeDefaultLine's fallback chain — so this null/empty check
  // has to live here, not just rely on TAXONOMY always providing one) and
  // surfaces a real inline message for every failure case instead of
  // failing silently.
  const handleSubmit = () => {
    if (lines.length < 2) {
      setFormError('Add at least two lines to split this transaction.');
      return;
    }
    const emptyCategoryIdx = lines.findIndex((l) => !l.category.trim());
    if (emptyCategoryIdx !== -1) {
      setFormError(`Line ${emptyCategoryIdx + 1} needs a category before you can submit.`);
      return;
    }
    if (!matches) {
      setFormError('Split total must match the original amount.');
      return;
    }
    setFormError(null);

    // [ADD] Persist any newly typed category/subcategory to user_categories
    // now — at the moment the split is actually confirmed, not earlier
    // when "+ Add new" was tapped on a given line (see handleAddCategory/
    // handleAddSubCategory's comments for why). One save per line that
    // actually has something new, using each line's FINAL category/
    // subCategory — recomputes the same isCustomCategory/isCustomSubCategory
    // check the render loop uses, since that's line-scoped state not
    // otherwise available here. Fire-and-forget per line: a failed save
    // shouldn't block the split itself, only future reuse of that category.
    for (const l of lines) {
      const lineCategoryDefs = mergeUserCategoriesIntoTaxonomy(TAXONOMY[l.type] ?? [], userCategories, l.type);
      const lineActiveDef = lineCategoryDefs.find((c) => c.category === l.category);
      const lineSubOptions = lineActiveDef?.subCategories ?? [];
      const lineIsCustomCategory = l.category !== '' && !lineActiveDef;
      const lineIsCustomSubCategory = !!l.subCategory && !lineSubOptions.includes(l.subCategory);
      if (lineIsCustomCategory || lineIsCustomSubCategory) {
        saveUserCategory(l.type, l.category, l.subCategory ?? null)
          .catch((e) => console.error('Failed to save user category:', e));
      }
    }

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

            {/* [ADD] Same reasoning as EditModal.tsx — deciding how to split
                a transaction needs the original message as context just as
                much as a plain edit does, arguably more (you're deciding
                how to divide an amount across categories, not just
                confirming one). */}
            {transaction.raw_text ? (
              <View style={styles.rawTextBox}>
                <Text style={styles.rawTextLabel}>
                  {transaction.status === 'pending_review' || transaction.status === 'haiku_suggested'
                    ? 'Original SMS — check this before splitting'
                    : 'Original SMS'}
                </Text>
                <Text style={styles.rawTextContent}>{transaction.raw_text}</Text>
              </View>
            ) : null}

            <View style={styles.summaryBox}>
              <Text style={styles.summaryText}>
                {transaction.merchant || 'Transaction'} · ₹{targetAmount.toLocaleString('en-IN')}
              </Text>
            </View>

            {lines.map((line, idx) => {
              // [CHANGE] Was `TAXONOMY[line.type] ?? []` directly. Merges
              // in this user's saved user_categories for this line's type
              // — see mergeUserCategoriesIntoTaxonomy()'s docblock.
              const categoryDefs = mergeUserCategoriesIntoTaxonomy(TAXONOMY[line.type] ?? [], userCategories, line.type);
              const activeCategoryDef = categoryDefs.find((c) => c.category === line.category);
              const subOptions = activeCategoryDef?.subCategories ?? [];
              // [ADD] Same custom-category/subcategory detection as
              // EditModal.tsx, computed per line.
              const isCustomCategory = line.category !== '' && !activeCategoryDef;
              const isCustomSubCategory = !!line.subCategory && !subOptions.includes(line.subCategory);

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
                          updateLine(idx, {
                            type: t,
                            category: firstCat?.category ?? '',
                            subCategory: firstCat?.subCategories?.[0],
                            // [ADD] Switching type invalidates any
                            // in-progress custom entry for this line.
                            addingCategory: false,
                            newCategoryText: '',
                            addingSubCategory: false,
                            newSubCategoryText: '',
                          });
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
                        onPress={() => updateLine(idx, {
                          category: c.category,
                          subCategory: c.subCategories?.[0],
                          // [ADD] Picking a real chip cancels any pending
                          // "+ Add new" entry for this line.
                          addingCategory: false,
                          newCategoryText: '',
                          addingSubCategory: false,
                          newSubCategoryText: '',
                        })}
                      >
                        <Text style={[styles.chipText, line.category === c.category && styles.chipTextActive]}>
                          {c.category}
                        </Text>
                      </TouchableOpacity>
                    ))}
                    {/* [ADD] Keeps a custom (non-TAXONOMY) category visible
                        as its own active chip — same pattern as
                        EditModal.tsx. */}
                    {isCustomCategory && (
                      <View style={[styles.chip, styles.chipActive]}>
                        <Text style={[styles.chipText, styles.chipTextActive]}>{line.category}</Text>
                      </View>
                    )}
                    <TouchableOpacity
                      style={styles.addChip}
                      onPress={() => updateLine(idx, { addingCategory: true })}
                    >
                      <Text style={styles.addChipText}>+ Add new</Text>
                    </TouchableOpacity>
                  </View>

                  {line.addingCategory && (
                    <View style={styles.addInputRow}>
                      <View style={styles.addInputField}>
                        <Input
                          value={line.newCategoryText}
                          onChangeText={(v) => updateLine(idx, { newCategoryText: v })}
                          placeholder="New category name"
                          autoFocus
                        />
                      </View>
                      <Button
                        label="Add"
                        variant="primary"
                        size="sm"
                        disabled={!line.newCategoryText.trim()}
                        onPress={() => handleAddCategory(idx)}
                      />
                      <Button
                        label="Cancel"
                        variant="ghost"
                        size="sm"
                        onPress={() => updateLine(idx, { addingCategory: false, newCategoryText: '' })}
                      />
                    </View>
                  )}

                  {/* [CHANGE] Was gated on subOptions.length > 0 — now shown
                      whenever this line has a category selected, so
                      "+ Add new" is always reachable (matches EditModal.tsx's
                      same change and the same reasoning). */}
                  {line.category !== '' && (
                    <>
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
                        {isCustomSubCategory && (
                          <View style={[styles.chip, styles.chipActive]}>
                            <Text style={[styles.chipText, styles.chipTextActive]}>{line.subCategory}</Text>
                          </View>
                        )}
                        <TouchableOpacity
                          style={styles.addChip}
                          onPress={() => updateLine(idx, { addingSubCategory: true })}
                        >
                          <Text style={styles.addChipText}>+ Add new</Text>
                        </TouchableOpacity>
                      </View>

                      {line.addingSubCategory && (
                        <View style={styles.addInputRow}>
                          <View style={styles.addInputField}>
                            <Input
                              value={line.newSubCategoryText}
                              onChangeText={(v) => updateLine(idx, { newSubCategoryText: v })}
                              placeholder="New subcategory name"
                              autoFocus
                            />
                          </View>
                          <Button
                            label="Add"
                            variant="primary"
                            size="sm"
                            disabled={!line.newSubCategoryText.trim()}
                            onPress={() => handleAddSubCategory(idx)}
                          />
                          <Button
                            label="Cancel"
                            variant="ghost"
                            size="sm"
                            onPress={() => updateLine(idx, { addingSubCategory: false, newSubCategoryText: '' })}
                          />
                        </View>
                      )}
                    </>
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

            {/* [ADD] Hint shown whenever any line is missing a category —
                explains why Submit is disabled before the user even taps it. */}
            {lines.some((l) => !l.category.trim()) && (
              <Text style={styles.formError}>Every line needs a category before you can submit.</Text>
            )}
            {/* [ADD] Fallback inline error from handleSubmit's own guards
                (e.g. fewer than 2 lines) — the disabled prop below already
                covers most cases, this covers the rest. */}
            {formError && <Text style={styles.formError}>{formError}</Text>}

            <View style={styles.footer}>
              <Button label="Cancel" variant="ghost" onPress={onCancel} />
              <Button
                label="Submit Split"
                variant="primary"
                onPress={handleSubmit}
                disabled={!matches || lines.length < 2 || lines.some((l) => !l.category.trim())}
              />
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
  // [ADD] "+ Add new" chip — same dashed-border treatment as EditModal.tsx,
  // so it reads as an action rather than a selectable option.
  addChip: {
    paddingHorizontal: spacing.sm,
    paddingVertical: spacing.xs,
    borderRadius: radius.full,
    borderWidth: 1,
    borderColor: colors.brand,
    borderStyle: 'dashed',
    backgroundColor: colors.white,
  },
  addChipText: {
    fontSize: fontSize.xs,
    color: colors.brand,
    fontWeight: fontWeight.semibold,
  },
  // [ADD] Inline row shown under a line's chips while typing a new
  // category/subcategory name for that line.
  addInputRow: {
    flexDirection: 'row',
    alignItems: 'flex-end',
    gap: spacing.xs,
  },
  addInputField: {
    flex: 1,
  },
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
  // [ADD] Inline validation error/hint, shown above the footer buttons.
  formError: {
    fontSize: fontSize.xs,
    color: colors.red,
    marginBottom: spacing.sm,
  },
  footer: { flexDirection: 'row', justifyContent: 'flex-end', gap: spacing.sm, marginBottom: spacing.md },
});