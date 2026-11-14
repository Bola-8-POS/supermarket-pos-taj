import { useLocalSearchParams, useRouter } from 'expo-router';
import { useState } from 'react';
import { Alert, Linking, StyleSheet, Text, TextInput, View } from 'react-native';

import { Button, Card, Divider, Empty, ErrorBox, Loading, Pill, Row, Screen, text, type Tone } from '@/components/ui';
import { useConfirmTransfer, useDisputeTransfer, useTransfer } from '@/features/more/queries';
import { useStaffNames } from '@/lib/common-queries';
import { dateTime, money } from '@/lib/format';
import { colors, radius, space, touch } from '@/theme';

export default function TransferDetailScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const router = useRouter();
  const transfer = useTransfer(id);
  const nameOf = useStaffNames();
  const confirmMutation = useConfirmTransfer();
  const disputeMutation = useDisputeTransfer();

  const [code, setCode] = useState('');
  const [showDispute, setShowDispute] = useState(false);
  const [reason, setReason] = useState('');
  const [formError, setFormError] = useState<string | null>(null);

  if (transfer.isLoading) return <Loading />;
  if (transfer.error) return <ErrorBox message={transfer.error.message} onRetry={() => void transfer.refetch()} />;

  const t = transfer.data;
  if (!t) return <Empty icon="alert-circle-outline" title="Transfer not found" />;

  const customer = t.payments?.tabs?.customer_name ?? `Ticket ${t.payment_id.slice(0, 6).toUpperCase()}`;
  const phone = t.customer_phone;
  const statusTone: Tone = t.status === 'pending' ? 'warning' : t.status === 'confirmed' ? 'success' : t.status === 'disputed' ? 'danger' : 'default';

  const doConfirm = () => {
    if (!code.trim()) {
      setFormError('Enter the code the customer gave you.');
      return;
    }
    setFormError(null);
    Alert.alert('Confirm transfer', `Mark this ${money(t.payments?.amount)} transfer as confirmed?`, [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Confirm',
        onPress: () => {
          confirmMutation.mutate(
            { paymentId: t.payment_id, code: code.trim() },
            {
              onSuccess: () => {
                router.back();
              },
              onError: e => {
                setFormError(e.message);
              },
            }
          );
        },
      },
    ]);
  };

  const doDispute = () => {
    if (!reason.trim()) {
      setFormError('A dispute reason is required.');
      return;
    }
    setFormError(null);
    Alert.alert('Mark as disputed', 'This marks the transfer as disputed and cannot be undone from here. Continue?', [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Mark disputed',
        style: 'destructive',
        onPress: () => {
          disputeMutation.mutate(
            { paymentId: t.payment_id, reason: reason.trim() },
            {
              onSuccess: () => {
                router.back();
              },
              onError: e => {
                setFormError(e.message);
              },
            }
          );
        },
      },
    ]);
  };

  return (
    <Screen>
      <View style={{ alignItems: 'center', gap: space[2] }}>
        <Text style={s.bigAmount}>{money(t.payments?.amount)}</Text>
        <Pill label={t.status} tone={statusTone} />
      </View>

      <Card>
        <Row title={customer} subtitle="Customer / ticket" />
        <Divider />
        {phone ? (
          <Row title={phone} subtitle="Phone — tap to call" icon="call-outline" iconTone="brand" onPress={() => void Linking.openURL(`tel:${phone}`)} />
        ) : (
          <Row title="No phone on file" subtitle="Phone" />
        )}
        <Divider />
        <Row title={nameOf(t.created_by)} subtitle={`Requested · ${dateTime(t.created_at)}`} />
        {/* The reference IS the confirmation code the customer must supply; never show it
            while the transfer is still pending or the manager could confirm without checking
            the bank. It is fine to show once the transfer is confirmed/disputed. */}
        {t.status !== 'pending' && t.payments?.reference_number ? (
          <>
            <Divider />
            <Row title={t.payments.reference_number} subtitle="Payment reference number" />
          </>
        ) : null}
      </Card>

      {t.status === 'pending' ? (
        <Card style={s.formCard}>
          <Text style={text.h2}>Confirm transfer</Text>
          <TextInput
            value={code}
            onChangeText={setCode}
            placeholder="Code from customer"
            placeholderTextColor={colors.mutedForeground}
            keyboardType="number-pad"
            style={s.input}
          />
          {formError && !showDispute ? <Text style={s.errorText}>{formError}</Text> : null}
          <Button title="Confirm transfer" tone="brand" onPress={doConfirm} loading={confirmMutation.isPending} disabled={disputeMutation.isPending} />

          <Divider />

          {!showDispute ? (
            <Button
              title="Dispute this transfer"
              tone="ghost"
              icon="alert-circle-outline"
              onPress={() => {
                setShowDispute(true);
                setFormError(null);
              }}
            />
          ) : (
            <View style={{ gap: space[3] }}>
              <Text style={text.h2}>Dispute reason</Text>
              <TextInput
                value={reason}
                onChangeText={setReason}
                placeholder="Why is this transfer being disputed?"
                placeholderTextColor={colors.mutedForeground}
                multiline
                style={[s.input, s.multiline]}
              />
              {formError ? <Text style={s.errorText}>{formError}</Text> : null}
              <Button title="Mark as disputed" tone="danger" onPress={doDispute} loading={disputeMutation.isPending} disabled={confirmMutation.isPending} />
            </View>
          )}
        </Card>
      ) : (
        <Card>
          {t.status === 'confirmed' ? (
            <Row title={nameOf(t.confirmed_by)} subtitle={`Confirmed · ${t.confirmed_at ? dateTime(t.confirmed_at) : '—'}`} icon="checkmark-circle" iconTone="success" />
          ) : (
            <>
              <Row title={nameOf(t.disputed_by)} subtitle={`Disputed · ${t.disputed_at ? dateTime(t.disputed_at) : '—'}`} icon="alert-circle" iconTone="danger" />
              {t.dispute_reason ? (
                <>
                  <Divider />
                  <Row title={t.dispute_reason} subtitle="Reason" />
                </>
              ) : null}
            </>
          )}
        </Card>
      )}
    </Screen>
  );
}

const s = StyleSheet.create({
  bigAmount: { fontSize: 36, lineHeight: 42, fontWeight: '700', letterSpacing: -0.5, color: colors.foreground, fontVariant: ['tabular-nums'] },
  formCard: { padding: space[4], gap: space[3] },
  input: {
    minHeight: touch.min,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.borderStrong,
    paddingHorizontal: space[3],
    color: colors.foreground,
    backgroundColor: colors.surfaceRaised,
    fontSize: 15,
  },
  multiline: { minHeight: 80, paddingTop: space[2], textAlignVertical: 'top' },
  errorText: { ...text.small, color: colors.destructive },
});
