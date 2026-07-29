/**
 * app/(app)/transactions/custom-categories.tsx
 *
 * Custom Categories management screen — was a one-line stub. Lists every
 * merchant -> category mapping the user has saved (via EditModal/SplitFlow's
 * "save this category for this merchant" switch, or the RegisterFactPrompt
 * flow), with a delete action to remove one. Previously only viewable
 * directly in the Supabase dashboard — this is the in-app equivalent.
 *
 * Read-only otherwise by design: editing a mapping's category isn't
 * offered here — the natural way to change one is to edit a transaction
 * from that merchant again with the save switch on (upserts and
 * overwrites, see saveCustomCategory()'s docblock in customCategories.ts).
 * This screen's job is visibility + removal, not a second editing path.
 */
import { useCallback, useEffect, useState } from 'react';
import { View, Text, FlatList, TouchableOpacity, StyleSheet, ActivityIndicator, Alert } from 'react-native';
import { colors, radius, spacing, fontSize, fontWeight } from '@/constants/theme';
import {
  fetchCustomCategoriesForDisplay,
  deleteCustomCategoryById,
  type CustomCategoryRow,
} from '@/lib/api/customCategories';

export default function CustomCategoriesScreen() {
  const [rows, setRows] = useState<CustomCategoryRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const data = await fetchCustomCategoriesForDisplay();
      setRows(data);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  const handleDelete = (row: CustomCategoryRow) => {
    Alert.alert(
      'Remove saved category?',
      `Future transactions from "${row.merchant}" will go back through normal classification instead of auto-applying ${row.category}${row.sub_category ? ` · ${row.sub_category}` : ''}.`,
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Remove',
          style: 'destructive',
          onPress: async () => {
            setBusyId(row.id);
            try {
              await deleteCustomCategoryById(row.id);
              setRows((prev) => prev.filter((r) => r.id !== row.id));
            } catch (e) {
              setError(e instanceof Error ? e.message : String(e));
            } finally {
              setBusyId(null);
            }
          },
        },
      ],
    );
  };

  return (
    <View style={styles.container}>
      <View style={styles.headerRow}>
        <Text style={styles.title}>Custom Categories</Text>
        <Text style={styles.subtitle}>
          Merchants you've taught Pileap to auto-categorize. Remove one to have that merchant go through normal
          review again.
        </Text>
      </View>

      {error && <Text style={styles.errorText}>{error}</Text>}

      {loading ? (
        <ActivityIndicator color={colors.brand} style={{ marginTop: spacing.xl }} />
      ) : (
        <FlatList
          data={rows}
          keyExtractor={(r) => r.id}
          contentContainerStyle={{ paddingBottom: spacing.xl }}
          ListEmptyComponent={
            <Text style={styles.emptyText}>
              No custom categories saved yet. Use "Save this category for this merchant" while editing a
              transaction to add one.
            </Text>
          }
          renderItem={({ item }) => (
            <View style={styles.row}>
              <View style={styles.rowLeft}>
                <Text style={styles.merchant} numberOfLines={1}>{item.merchant}</Text>
                <Text style={styles.meta}>
                  {item.type} · {item.category}{item.sub_category ? ` · ${item.sub_category}` : ''}
                </Text>
              </View>
              <TouchableOpacity
                onPress={() => handleDelete(item)}
                disabled={busyId === item.id}
                hitSlop={8}
                style={styles.deleteBtn}
              >
                <Text style={styles.deleteText}>{busyId === item.id ? '…' : 'Remove'}</Text>
              </TouchableOpacity>
            </View>
          )}
        />
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.surface, padding: spacing.md },
  headerRow: { marginBottom: spacing.md },
  title: { fontSize: fontSize.xl, fontWeight: fontWeight.bold, color: colors.dark, marginBottom: spacing.xs },
  subtitle: { fontSize: fontSize.sm, color: colors.muted, lineHeight: 18 },
  errorText: { fontSize: fontSize.xs, color: colors.red, marginBottom: spacing.sm },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    backgroundColor: colors.white,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.border,
    padding: spacing.sm,
    marginBottom: spacing.sm,
  },
  rowLeft: { flex: 1, paddingRight: spacing.sm },
  merchant: { fontSize: fontSize.base, fontWeight: fontWeight.semibold, color: colors.dark },
  meta: { fontSize: fontSize.xs, color: colors.muted, marginTop: 2 },
  deleteBtn: { paddingHorizontal: spacing.sm, paddingVertical: spacing.xs },
  deleteText: { fontSize: fontSize.xs, color: colors.red, fontWeight: fontWeight.semibold },
  emptyText: { textAlign: 'center', color: colors.muted, fontSize: fontSize.sm, marginTop: spacing.xl, lineHeight: 20 },
});