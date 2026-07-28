/**
 * src/components/transactions/RegisterFactPrompt.tsx
 *
 * Contextual "what is this recurring debit?" card — the actual UI for
 * `registered_facts`. Triggered from the review queue (not a blocking
 * onboarding step, per the agreed design) at the moment a NACH debit or
 * ambiguous broker debit lands in pending_review with no classification:
 * "We spotted a ₹12,000 debit on the 5th — what's this for?" Amount and
 * day come from the real transaction; dropdowns only ask what the parser
 * genuinely cannot know on its own.
 *
 * Flow: pick what this is (EMI / SIP / Insurance Premium / Salary) ->
 * fill the type-specific fields (scoped dropdowns from
 * registeredFactOptions.ts, sourced from the same rosters already in
 * smsParser.ts's TAXONOMY) -> confirmRegisteredFact() writes the fact AND
 * resolves this transaction in one action.
 *
 * Never writes anything until the user explicitly confirms — same "don't
 * guess" spirit as the rest of this pipeline. Skip/cancel leaves the row
 * exactly as it was (still pending_review, generic NACH label), so nothing
 * is lost by dismissing this once; it'll show again next time the row is
 * visible, per the review queue's existing behavior for unresolved rows.
 *
 * [FLAG — same scope note as registeredFactOptions.ts] Which modules
 * actually need this was never fully closed out against the scoring
 * reality-check doc (that doc wasn't available when this was designed).
 * This ships against what's actually implemented in registeredFacts.ts/
 * smsParser.ts (4 fact types), not a fresh derivation from that doc.
 */
import { useEffect, useState } from 'react';
import { Modal, View, Text, TouchableOpacity, ScrollView, StyleSheet, TextInput, Alert } from 'react-native';
import { colors, radius, spacing, fontSize, fontWeight } from '@/constants/theme';
import type { Transaction } from '@/lib/api/transactions';
import { confirmRegisteredFact, type FactType } from '@/lib/api/registeredFacts';
import {
  LOAN_CATEGORIES,
  SIP_PLATFORMS,
  INSURANCE_TYPES,
  OTHER_OPTION,
} from '@/constants/registeredFactOptions';
import { Button } from '@/components/ui/Button';

interface Props {
  visible: boolean;
  transaction: Transaction | null;
  onCancel: () => void;
  /** Called after a successful write, so the parent can refetch the row
   * (it's no longer pending_review after this). */
  onConfirmed: () => void;
}

type Step = 'pick-type' | 'details';

export function RegisterFactPrompt({ visible, transaction, onCancel, onConfirmed }: Props) {
  const [step, setStep] = useState<Step>('pick-type');
  const [factType, setFactType] = useState<FactType | null>(null);
  const [saving, setSaving] = useState(false);

  // EMI fields
  const [loanCategoryIdx, setLoanCategoryIdx] = useState<number | null>(null);
  const [lender, setLender] = useState<string | null>(null);
  const [lenderOther, setLenderOther] = useState('');

  // SIP fields
  const [sipPlatform, setSipPlatform] = useState<string | null>(null);
  const [sipPlatformOther, setSipPlatformOther] = useState('');

  // Insurance Premium fields
  const [insuranceTypeIdx, setInsuranceTypeIdx] = useState<number | null>(null);
  const [insurer, setInsurer] = useState<string | null>(null);
  const [insurerOther, setInsurerOther] = useState('');

  // Salary field (only used when merchant text is fully null)
  const [salaryLabel, setSalaryLabel] = useState('');

  // Reset all draft state whenever a new transaction is opened.
  useEffect(() => {
    setStep('pick-type');
    setFactType(null);
    setLoanCategoryIdx(null);
    setLender(null);
    setLenderOther('');
    setSipPlatform(null);
    setSipPlatformOther('');
    setInsuranceTypeIdx(null);
    setInsurer(null);
    setInsurerOther('');
    setSalaryLabel('');
  }, [transaction?.id]);

  if (!transaction) return null;

  const amount = Math.abs(transaction.amount ?? 0);
  const isCredit = (transaction.amount ?? 0) >= 0;

  const handlePickType = (t: FactType) => {
    setFactType(t);
    setStep('details');
  };

  const buildEntityName = (): string | null => {
    if (factType === 'emi') return lender === OTHER_OPTION ? lenderOther.trim() || null : lender;
    if (factType === 'sip') return sipPlatform === OTHER_OPTION ? sipPlatformOther.trim() || null : sipPlatform;
    if (factType === 'insurance_premium') return insurer === OTHER_OPTION ? insurerOther.trim() || null : insurer;
    if (factType === 'salary') return (transaction.merchant?.trim() || salaryLabel.trim()) || null;
    return null;
  };

  const canConfirm = (): boolean => {
    if (!factType) return false;
    if (factType === 'emi') return loanCategoryIdx !== null && !!buildEntityName();
    if (factType === 'sip') return !!buildEntityName();
    if (factType === 'insurance_premium') return insuranceTypeIdx !== null && !!buildEntityName();
    if (factType === 'salary') return !!buildEntityName();
    return false;
  };

  const handleConfirm = async () => {
    if (!factType || !canConfirm()) return;
    const entityName = buildEntityName();
    if (!entityName) return;

    setSaving(true);
    // [DEBUG] Temporary — proves this exact file/function is the one
    // actually running on-device. If this line never shows up in your
    // Metro/adb logs when you tap Confirm, the app is executing a
    // different copy of this file (stale bundle / duplicate file), not
    // the one you're editing. Remove once confirmed.
    console.log('[RegisterFactPrompt] handleConfirm firing', { factType, txnId: transaction.id });
    try {
      if (factType === 'emi') {
        const loanCat = loanCategoryIdx !== null ? LOAN_CATEGORIES[loanCategoryIdx] : null;
        // [FIX] BNPL is its own top-level category everywhere else in the
        // taxonomy (smsParser.ts: { category: 'BNPL', sub_category: null },
        // transactionCategories.ts: a separate { category: 'BNPL' } entry
        // with no subcategories) — it isn't a Loans subcategory. Writing
        // resolvedCategory: 'Loans' unconditionally here meant a BNPL debt
        // resolved through this prompt got a different category string
        // than the same BNPL debt would get if the parser had recognized
        // it directly, which would split one real-world category into two
        // for any downstream aggregation (Debt Ratio, spend breakdowns).
        const isBnpl = loanCat?.subCategory === 'BNPL';
        await confirmRegisteredFact({
          txnId: transaction.id,
          factType: 'emi',
          entityName,
          amount,
          txnDate: transaction.txn_date,
          merchant: transaction.merchant,
          referenceValue: transaction.ref_number ?? null,
          resolvedType: 'Liability',
          resolvedCategory: isBnpl ? 'BNPL' : 'Loans',
          resolvedSubCategory: isBnpl ? null : (loanCat?.subCategory ?? null),
          isSecuredDebt: loanCat?.isSecuredDebt ?? null,
        });
      } else if (factType === 'sip') {
        await confirmRegisteredFact({
          txnId: transaction.id,
          factType: 'sip',
          entityName,
          amount,
          txnDate: transaction.txn_date,
          merchant: transaction.merchant,
          referenceValue: transaction.ref_number ?? null,
          resolvedType: 'Investment',
          resolvedCategory: 'Mutual Funds',
          resolvedSubCategory: 'SIP',
        });
      } else if (factType === 'insurance_premium') {
        const insType = insuranceTypeIdx !== null ? INSURANCE_TYPES[insuranceTypeIdx] : null;
        await confirmRegisteredFact({
          txnId: transaction.id,
          factType: 'insurance_premium',
          entityName,
          amount,
          txnDate: transaction.txn_date,
          merchant: transaction.merchant,
          referenceValue: transaction.ref_number ?? null,
          resolvedType: 'Investment',
          resolvedCategory: 'Insurance',
          resolvedSubCategory: insType?.subCategory ?? null,
        });
      } else if (factType === 'salary') {
        await confirmRegisteredFact({
          txnId: transaction.id,
          factType: 'salary',
          entityName,
          amount,
          txnDate: transaction.txn_date,
          merchant: transaction.merchant,
          referenceValue: transaction.ref_number ?? null,
          resolvedType: 'Income',
          resolvedCategory: 'Salary',
          resolvedSubCategory: null,
        });
      }
      console.log('[RegisterFactPrompt] confirmRegisteredFact succeeded');
      onConfirmed();
    } catch (e) {
      // [FIX] Was a bare try/finally — any Supabase error (RLS, FK,
      // check-constraint violation, auth failure) was silently discarded:
      // onConfirmed() simply never ran, saving reset, modal stayed open
      // with no signal to the user or developer that anything went wrong.
      console.error('[RegisterFactPrompt] confirmRegisteredFact FAILED', e);
      Alert.alert(
        "Couldn't save",
        e instanceof Error ? e.message : 'Something went wrong saving this. Please try again.',
      );
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal visible={visible} animationType="slide" transparent onRequestClose={onCancel}>
      <View style={styles.overlay}>
        <View style={styles.sheet}>
          <ScrollView showsVerticalScrollIndicator={false}>
            {step === 'pick-type' ? (
              <>
                <Text style={styles.title}>What's this transaction?</Text>
                <Text style={styles.subtitle}>
                  We spotted a ₹{amount.toLocaleString('en-IN')} {isCredit ? 'credit' : 'debit'} on{' '}
                  {new Date(transaction.txn_date + 'T00:00:00').toLocaleDateString('en-IN', { day: 'numeric', month: 'short' })}
                  {' '}we couldn't automatically identify. Telling us once means we'll recognize it automatically
                  every time going forward.
                </Text>

                {transaction.raw_text ? (
                  <View style={styles.rawTextBox}>
                    <Text style={styles.rawTextLabel}>Original SMS</Text>
                    <Text style={styles.rawTextContent}>{transaction.raw_text}</Text>
                  </View>
                ) : null}

                <View style={styles.typeList}>
                  {isCredit ? (
                    <TypeOption label="This is my salary" onPress={() => handlePickType('salary')} />
                  ) : (
                    <>
                      <TypeOption label="Loan EMI" onPress={() => handlePickType('emi')} />
                      <TypeOption label="SIP / Mutual Fund investment" onPress={() => handlePickType('sip')} />
                      <TypeOption label="Insurance premium" onPress={() => handlePickType('insurance_premium')} />
                    </>
                  )}
                </View>

                <View style={styles.footer}>
                  <Button label="Not now" variant="ghost" onPress={onCancel} />
                </View>
              </>
            ) : (
              <>
                <Text style={styles.title}>
                  {factType === 'emi' && 'Loan EMI details'}
                  {factType === 'sip' && 'SIP details'}
                  {factType === 'insurance_premium' && 'Insurance premium details'}
                  {factType === 'salary' && 'Confirm salary'}
                </Text>
                <Text style={styles.subtitle}>
                  ₹{amount.toLocaleString('en-IN')} on the {new Date(transaction.txn_date + 'T00:00:00').getDate()}
                  {'  '}— we'll auto-apply this to every future transaction that matches.
                </Text>

                {factType === 'emi' && (
                  <>
                    <Text style={styles.label}>Loan category</Text>
                    <View style={styles.chipRow}>
                      {LOAN_CATEGORIES.map((c, idx) => (
                        <Chip
                          key={c.label}
                          label={c.label}
                          active={loanCategoryIdx === idx}
                          onPress={() => { setLoanCategoryIdx(idx); setLender(null); setLenderOther(''); }}
                        />
                      ))}
                    </View>

                    {loanCategoryIdx !== null && (
                      <>
                        <Text style={styles.label}>Lender</Text>
                        <View style={styles.chipRow}>
                          {[...LOAN_CATEGORIES[loanCategoryIdx].lenders, OTHER_OPTION].map((l) => (
                            <Chip key={l} label={l} active={lender === l} onPress={() => setLender(l)} />
                          ))}
                        </View>
                        {lender === OTHER_OPTION && (
                          <TextInput
                            style={styles.input}
                            value={lenderOther}
                            onChangeText={setLenderOther}
                            placeholder="Lender name"
                            placeholderTextColor={colors.muted}
                          />
                        )}
                      </>
                    )}
                  </>
                )}

                {factType === 'sip' && (
                  <>
                    <Text style={styles.label}>AMC / platform</Text>
                    <View style={styles.chipRow}>
                      {[...SIP_PLATFORMS, OTHER_OPTION].map((p) => (
                        <Chip key={p} label={p} active={sipPlatform === p} onPress={() => setSipPlatform(p)} />
                      ))}
                    </View>
                    {sipPlatform === OTHER_OPTION && (
                      <TextInput
                        style={styles.input}
                        value={sipPlatformOther}
                        onChangeText={setSipPlatformOther}
                        placeholder="AMC / platform name"
                        placeholderTextColor={colors.muted}
                      />
                    )}
                  </>
                )}

                {factType === 'insurance_premium' && (
                  <>
                    <Text style={styles.label}>Policy type</Text>
                    <View style={styles.chipRow}>
                      {INSURANCE_TYPES.map((t, idx) => (
                        <Chip
                          key={t.label}
                          label={t.label}
                          active={insuranceTypeIdx === idx}
                          onPress={() => { setInsuranceTypeIdx(idx); setInsurer(null); setInsurerOther(''); }}
                        />
                      ))}
                    </View>

                    {insuranceTypeIdx !== null && (
                      <>
                        <Text style={styles.label}>Insurer</Text>
                        <View style={styles.chipRow}>
                          {[...INSURANCE_TYPES[insuranceTypeIdx].insurers, OTHER_OPTION].map((i) => (
                            <Chip key={i} label={i} active={insurer === i} onPress={() => setInsurer(i)} />
                          ))}
                        </View>
                        {insurer === OTHER_OPTION && (
                          <TextInput
                            style={styles.input}
                            value={insurerOther}
                            onChangeText={setInsurerOther}
                            placeholder="Insurer name"
                            placeholderTextColor={colors.muted}
                          />
                        )}
                      </>
                    )}
                  </>
                )}

                {factType === 'salary' && (
                  <>
                    {transaction.merchant ? (
                      <Text style={styles.salaryConfirmText}>
                        Is this your salary — <Text style={{ fontWeight: fontWeight.semibold }}>{transaction.merchant}</Text>?
                      </Text>
                    ) : (
                      <>
                        <Text style={styles.label}>What should we call this?</Text>
                        <TextInput
                          style={styles.input}
                          value={salaryLabel}
                          onChangeText={setSalaryLabel}
                          placeholder="e.g. Acme Corp"
                          placeholderTextColor={colors.muted}
                        />
                      </>
                    )}
                  </>
                )}

                <View style={styles.footer}>
                  <Button label="Back" variant="ghost" onPress={() => setStep('pick-type')} />
                  <Button
                    label="Confirm"
                    variant="primary"
                    loading={saving}
                    disabled={!canConfirm()}
                    onPress={handleConfirm}
                  />
                </View>
              </>
            )}
          </ScrollView>
        </View>
      </View>
    </Modal>
  );
}

function TypeOption({ label, onPress }: { label: string; onPress: () => void }) {
  return (
    <TouchableOpacity style={typeOptionStyles.option} onPress={onPress}>
      <Text style={typeOptionStyles.text}>{label}</Text>
      <Text style={typeOptionStyles.chevron}>›</Text>
    </TouchableOpacity>
  );
}

function Chip({ label, active, onPress }: { label: string; active: boolean; onPress: () => void }) {
  return (
    <TouchableOpacity onPress={onPress} style={[styles.chip, active && styles.chipActive]}>
      <Text style={[styles.chipText, active && styles.chipTextActive]}>{label}</Text>
    </TouchableOpacity>
  );
}

const typeOptionStyles = StyleSheet.create({
  option: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius.md,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    marginBottom: spacing.xs,
    backgroundColor: colors.surface,
  },
  text: { fontSize: fontSize.base, color: colors.dark, fontWeight: fontWeight.medium },
  chevron: { fontSize: fontSize.lg, color: colors.muted },
});

const styles = StyleSheet.create({
  overlay: { flex: 1, backgroundColor: 'rgba(0,0,0,0.4)', justifyContent: 'flex-end' },
  sheet: {
    backgroundColor: colors.white,
    borderTopLeftRadius: radius.xl,
    borderTopRightRadius: radius.xl,
    padding: spacing.lg,
    maxHeight: '88%',
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
  rawTextContent: { fontSize: fontSize.xs, color: colors.dark, lineHeight: 17 },
  typeList: { marginBottom: spacing.md },
  label: {
    fontSize: fontSize.xs,
    fontWeight: fontWeight.semibold,
    color: colors.mid,
    marginTop: spacing.sm,
    marginBottom: spacing.xs,
    textTransform: 'uppercase',
    letterSpacing: 0.4,
  },
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
  input: {
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius.md,
    paddingHorizontal: spacing.sm,
    paddingVertical: spacing.sm,
    fontSize: fontSize.base,
    color: colors.dark,
    marginTop: spacing.xs,
  },
  salaryConfirmText: { fontSize: fontSize.base, color: colors.dark, marginBottom: spacing.md, lineHeight: 20 },
  footer: {
    flexDirection: 'row',
    justifyContent: 'flex-end',
    gap: spacing.sm,
    marginTop: spacing.lg,
    marginBottom: spacing.md,
  },
});