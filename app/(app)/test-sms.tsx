import { useState } from 'react';
import {
  View, Text, StyleSheet, TouchableOpacity,
  ScrollView, ActivityIndicator, Platform, PermissionsAndroid,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { colors, spacing, fontSize, fontWeight, radius } from '@/constants/theme';
import { SmsReader, SmsMessage } from '../../modules/sms-reader/src/index';

type Status = 'idle' | 'loading' | 'done' | 'error';

export default function TestSmsScreen() {
  const [status, setStatus]     = useState<Status>('idle');
  const [messages, setMessages] = useState<SmsMessage[]>([]);
  const [error, setError]       = useState<string | null>(null);
  const [hasPerm, setHasPerm]   = useState<boolean | null>(null);

  async function requestPermission() {
    if (Platform.OS !== 'android') {
      setError('SMS reading is Android only.');
      return;
    }
    try {
      const result = await PermissionsAndroid.request(
        PermissionsAndroid.PERMISSIONS.READ_SMS,
        {
          title: 'Pileap needs SMS access',
          message:
            'Pileap reads bank SMS to automatically track your transactions. ' +
            'Only messages from known bank senders are read.',
          buttonPositive: 'Allow',
          buttonNegative: 'Deny',
        }
      );
      const granted = result === PermissionsAndroid.RESULTS.GRANTED;
      setHasPerm(granted);
      if (!granted) {
        setError('Permission denied. Please allow SMS access to continue.');
      }
    } catch (e: any) {
      setError(e.message ?? 'Permission request failed');
    }
  }

  async function fetchSms() {
    if (Platform.OS !== 'android') {
      setError('SMS reading is Android only.');
      return;
    }

    // Request permission first if not yet granted
    if (!hasPerm) {
      await requestPermission();
      return;
    }

    setStatus('loading');
    setError(null);
    setMessages([]);
    try {
      const result = await SmsReader.getMessages();
      setMessages(result);
      setStatus('done');
    } catch (e: any) {
      setError(e.message ?? 'Unknown error');
      setStatus('error');
    }
  }

  return (
    <SafeAreaView style={s.safe} edges={['top']}>
      <View style={s.header}>
        <Text style={s.title}>SMS Reader — Test</Text>
        <Text style={s.subtitle}>
          Platform: {Platform.OS} {Platform.OS === 'android' ? '✅' : '❌'}
        </Text>
      </View>

      <View style={s.btnRow}>
        <TouchableOpacity style={s.btnSecondary} onPress={requestPermission} activeOpacity={0.8}>
          <Text style={s.btnSecondaryText}>Request Permission</Text>
        </TouchableOpacity>
        <TouchableOpacity style={s.btnPrimary} onPress={fetchSms} activeOpacity={0.8}>
          <Text style={s.btnPrimaryText}>Fetch Bank SMS</Text>
        </TouchableOpacity>
      </View>

      {hasPerm !== null && (
        <View style={[s.permBadge, { backgroundColor: hasPerm ? '#dcfce7' : '#fee2e2' }]}>
          <Text style={{ color: hasPerm ? '#166534' : '#991b1b', fontSize: fontSize.sm, fontWeight: fontWeight.semibold }}>
            READ_SMS permission: {hasPerm ? 'GRANTED ✅' : 'DENIED ❌'}
          </Text>
        </View>
      )}

      {status === 'loading' && (
        <View style={s.center}>
          <ActivityIndicator size="large" color={colors.brand} />
          <Text style={s.loadingText}>Reading SMS inbox...</Text>
        </View>
      )}

      {status === 'error' && (
        <View style={s.errorBox}>
          <Text style={s.errorText}>Error: {error}</Text>
        </View>
      )}

      {status === 'done' && (
        <View style={s.resultHeader}>
          <Text style={s.resultCount}>
            {messages.length} bank SMS found in last 90 days
          </Text>
        </View>
      )}

      <ScrollView style={s.scroll} contentContainerStyle={s.scrollInner}>
        {messages.map((msg, i) => (
          <View key={msg.id} style={s.msgCard}>
            <View style={s.msgCardHead}>
              <Text style={s.msgSender}>{msg.address}</Text>
              <Text style={s.msgDate}>
                {new Date(msg.date).toLocaleDateString('en-IN', {
                  day: '2-digit', month: 'short', year: 'numeric',
                })}
              </Text>
            </View>
            <Text style={s.msgBody}>{msg.body}</Text>
            <Text style={s.msgIndex}>#{i + 1}</Text>
          </View>
        ))}
      </ScrollView>
    </SafeAreaView>
  );
}

const s = StyleSheet.create({
  safe: { flex: 1, backgroundColor: colors.white },

  header: {
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.md,
    borderBottomWidth: 1,
    borderBottomColor: colors.border,
  },
  title: {
    fontSize: fontSize.lg,
    fontWeight: fontWeight.bold,
    color: colors.dark,
  },
  subtitle: {
    fontSize: fontSize.sm,
    color: colors.muted,
    marginTop: 2,
  },

  btnRow: {
    flexDirection: 'row',
    gap: spacing.sm,
    padding: spacing.lg,
  },
  btnPrimary: {
    flex: 1,
    backgroundColor: colors.brand,
    paddingVertical: 10,
    borderRadius: radius.md,
    alignItems: 'center',
  },
  btnPrimaryText: {
    fontSize: fontSize.sm,
    fontWeight: fontWeight.semibold,
    color: colors.white,
  },
  btnSecondary: {
    flex: 1,
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.border,
    paddingVertical: 10,
    borderRadius: radius.md,
    alignItems: 'center',
  },
  btnSecondaryText: {
    fontSize: fontSize.sm,
    fontWeight: fontWeight.semibold,
    color: colors.dark,
  },

  permBadge: {
    marginHorizontal: spacing.lg,
    padding: spacing.sm,
    borderRadius: radius.md,
    marginBottom: spacing.sm,
  },

  center: { alignItems: 'center', paddingTop: spacing.xl },
  loadingText: {
    marginTop: spacing.md,
    fontSize: fontSize.sm,
    color: colors.muted,
  },

  errorBox: {
    margin: spacing.lg,
    padding: spacing.md,
    backgroundColor: '#fee2e2',
    borderRadius: radius.md,
  },
  errorText: {
    fontSize: fontSize.sm,
    color: '#991b1b',
  },

  resultHeader: {
    paddingHorizontal: spacing.lg,
    paddingBottom: spacing.sm,
  },
  resultCount: {
    fontSize: fontSize.sm,
    fontWeight: fontWeight.semibold,
    color: colors.brand,
  },

  scroll: { flex: 1 },
  scrollInner: { padding: spacing.lg, paddingBottom: 40, gap: spacing.md },

  msgCard: {
    backgroundColor: colors.surface,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.border,
    padding: spacing.md,
  },
  msgCardHead: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    marginBottom: spacing.xs,
  },
  msgSender: {
    fontSize: fontSize.xs,
    fontWeight: fontWeight.bold,
    color: colors.brand,
  },
  msgDate: {
    fontSize: fontSize.xs,
    color: colors.muted,
  },
  msgBody: {
    fontSize: fontSize.xs,
    color: colors.dark,
    lineHeight: 18,
  },
  msgIndex: {
    fontSize: 10,
    color: colors.muted,
    marginTop: 4,
    textAlign: 'right',
  },
});