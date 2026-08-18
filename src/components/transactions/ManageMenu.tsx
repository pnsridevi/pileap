/**
 * src/components/transactions/ManageMenu.tsx
 *
 * Small "⋯" icon + dropdown, placed next to the Feed/History SubTabs
 * control. Custom Categories exists as a route with no other way to
 * navigate to it from the UI — this menu is that entry point.
 *
 * Shared by both index.tsx (Feed) and history.tsx (History) rather than
 * duplicated in each — same menu, same destinations, regardless of which
 * sub-tab it's opened from.
 *
 * [REMOVED — this pass] "Accounts" — that screen moved from
 * app/(app)/transactions/accounts.tsx to app/(app)/profile/accounts.tsx
 * (account tracking is a settings-style concern, not a
 * transactions-tab one — see the design discussion this was decided
 * from). It's now reachable from the Profile tab directly, so it doesn't
 * need a second entry point buried in this menu too. If a quick shortcut
 * from here is ever wanted again, re-add with path
 * '/(app)/profile/accounts' — not '/(app)/transactions/accounts', which
 * no longer exists.
 */
import { useState } from 'react';
import { Modal, Pressable, View, Text, TouchableOpacity, StyleSheet } from 'react-native';
import { useRouter } from 'expo-router';
import { colors, radius, spacing, fontSize, fontWeight, shadows } from '@/constants/theme';

const MENU_ITEMS = [
  { label: 'Custom Categories', path: '/(app)/transactions/custom-categories' as const },
  // [REMOVED — per request] Budget vs Actual isn't built yet; removed
  // from the menu for now so it doesn't link to an unfinished stub.
  // Re-add once that screen has real content:
  // { label: 'Budget vs Actual', path: '/(app)/transactions/budget-vs-actual' as const },
];

export function ManageMenu() {
  const router = useRouter();
  const [open, setOpen] = useState(false);

  return (
    <>
      <TouchableOpacity onPress={() => setOpen(true)} hitSlop={10} style={styles.iconBtn}>
        <Text style={styles.iconText}>⋯</Text>
      </TouchableOpacity>

      <Modal visible={open} transparent animationType="fade" onRequestClose={() => setOpen(false)}>
        <Pressable style={styles.backdrop} onPress={() => setOpen(false)}>
          <View style={styles.menu}>
            {MENU_ITEMS.map((item) => (
              <TouchableOpacity
                key={item.path}
                style={styles.menuItem}
                onPress={() => {
                  setOpen(false);
                  router.push(item.path);
                }}
              >
                <Text style={styles.menuItemText}>{item.label}</Text>
              </TouchableOpacity>
            ))}
          </View>
        </Pressable>
      </Modal>
    </>
  );
}

const styles = StyleSheet.create({
  iconBtn: {
    width: 32,
    height: 32,
    alignItems: 'center',
    justifyContent: 'center',
  },
  iconText: {
    fontSize: 20,
    lineHeight: 20,
    color: colors.mid,
    fontWeight: fontWeight.bold,
  },
  backdrop: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.15)',
    alignItems: 'flex-end',
  },
  menu: {
    marginTop: 90,
    marginRight: spacing.md,
    backgroundColor: colors.white,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.border,
    paddingVertical: spacing.xs,
    minWidth: 180,
    ...shadows.md,
  },
  menuItem: {
    paddingVertical: spacing.sm,
    paddingHorizontal: spacing.md,
  },
  menuItemText: {
    fontSize: fontSize.sm,
    color: colors.dark,
    fontWeight: fontWeight.medium,
  },
});