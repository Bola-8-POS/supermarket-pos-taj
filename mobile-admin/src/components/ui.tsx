/* eslint-disable react-refresh/only-export-components -- shared UI module intentionally exports components and style helpers */
import { Ionicons } from '@expo/vector-icons';
import { Image } from 'expo-image';
import type { ComponentProps, ReactNode } from 'react';
import {
  ActivityIndicator,
  Pressable,
  RefreshControl,
  ScrollView,
  StyleSheet,
  Text,
  View,
  type PressableProps,
  type StyleProp,
  type TextStyle,
  type ViewStyle,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { colors, radius, space, touch, type } from '@/theme';
import bola8Mark from '../../assets/images/bola8-mark.png';

export type IconName = ComponentProps<typeof Ionicons>['name'];

export function BrandLockup({ compact = false }: { compact?: boolean }) {
  const markSize = compact ? 48 : 72;
  return (
    <View accessible accessibilityLabel="Bola 8 POS by Tapatio Solutions" style={s.brandLockup}>
      <Image
        source={bola8Mark}
        style={{ width: markSize, height: markSize }}
        contentFit="contain"
      />
      <View style={{ alignItems: 'center', gap: 2 }}>
        <Text style={compact ? text.h1 : s.brandTitle}>Bola 8 POS</Text>
        <Text style={s.brandCompany}>Tapatio Solutions</Text>
      </View>
    </View>
  );
}

export function BrandFooter() {
  return (
    <View accessible accessibilityLabel="Hecho en México. Tapatio Solutions." style={s.brandFooter}>
      <Text style={s.brandMade}>Hecho en México 🇲🇽</Text>
      <Text style={s.brandCompany}>Tapatio Solutions</Text>
    </View>
  );
}

/** Scrollable screen body with pull-to-refresh and safe-area padding. */
export function Screen({
  children,
  refreshing = false,
  onRefresh,
  padTop = false,
}: {
  children: ReactNode;
  refreshing?: boolean;
  onRefresh?: () => void;
  padTop?: boolean;
}) {
  const insets = useSafeAreaInsets();
  return (
    <ScrollView
      style={s.screen}
      contentContainerStyle={{
        padding: space[4],
        paddingTop: padTop ? insets.top + space[3] : space[4],
        paddingBottom: space[8] + insets.bottom,
        gap: space[4],
      }}
      refreshControl={
        onRefresh ? (
          <RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={colors.brand} colors={[colors.brand]} />
        ) : undefined
      }>
      {children}
    </ScrollView>
  );
}

export function Card({ children, style }: { children: ReactNode; style?: StyleProp<ViewStyle> }) {
  return <View style={[s.card, style]}>{children}</View>;
}

export function SectionHeader({ title, action, onAction }: { title: string; action?: string; onAction?: () => void }) {
  return (
    <View style={s.sectionHeader}>
      <Text style={s.sectionTitle}>{title}</Text>
      {action && onAction ? (
        <Pressable onPress={onAction} hitSlop={8}>
          <Text style={s.sectionAction}>{action}</Text>
        </Pressable>
      ) : null}
    </View>
  );
}

export function Kpi({
  label,
  value,
  hint,
  tone = 'default',
  style,
}: {
  label: string;
  value: string;
  hint?: string;
  tone?: 'default' | 'success' | 'warning' | 'danger' | 'brand';
  style?: StyleProp<ViewStyle>;
}) {
  const color = toneColor(tone);
  return (
    <View style={[s.kpi, style]}>
      <Text style={s.kpiLabel}>{label}</Text>
      <Text style={[s.kpiValue, { color }]} numberOfLines={1} adjustsFontSizeToFit>
        {value}
      </Text>
      {hint ? <Text style={s.kpiHint}>{hint}</Text> : null}
    </View>
  );
}

export function Pill({ label, tone = 'default', icon }: { label: string; tone?: Tone; icon?: IconName }) {
  const color = toneColor(tone);
  const bg = toneSoft(tone);
  return (
    <View style={[s.pill, { backgroundColor: bg }]}>
      {icon ? <Ionicons name={icon} size={12} color={color} /> : null}
      <Text style={[s.pillText, { color }]}>{label}</Text>
    </View>
  );
}

export function Row({
  title,
  subtitle,
  right,
  rightSub,
  icon,
  iconTone = 'default',
  onPress,
  chevron = !!onPress,
  leading,
}: {
  title: string;
  subtitle?: string;
  right?: string;
  rightSub?: string;
  icon?: IconName;
  iconTone?: Tone;
  onPress?: () => void;
  chevron?: boolean;
  leading?: ReactNode;
}) {
  return (
    <Pressable
      onPress={onPress}
      disabled={!onPress}
      style={({ pressed }) => [s.row, pressed && onPress ? { backgroundColor: colors.accent } : null]}>
      {leading ?? (icon ? (
        <View style={[s.rowIcon, { backgroundColor: toneSoft(iconTone) }]}>
          <Ionicons name={icon} size={18} color={toneColor(iconTone)} />
        </View>
      ) : null)}
      <View style={{ flex: 1, gap: 2 }}>
        <Text style={s.rowTitle} numberOfLines={1}>
          {title}
        </Text>
        {subtitle ? (
          <Text style={s.rowSub} numberOfLines={1}>
            {subtitle}
          </Text>
        ) : null}
      </View>
      {right || rightSub ? (
        <View style={{ alignItems: 'flex-end', gap: 2 }}>
          {right ? <Text style={s.rowRight}>{right}</Text> : null}
          {rightSub ? <Text style={s.rowSub}>{rightSub}</Text> : null}
        </View>
      ) : null}
      {chevron ? <Ionicons name="chevron-forward" size={16} color={colors.mutedForeground} /> : null}
    </Pressable>
  );
}

export function Divider() {
  return <View style={s.divider} />;
}

export function Avatar({ name, size = 36 }: { name: string; size?: number }) {
  const ini = name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map(p => p.charAt(0).toUpperCase())
    .join('');
  return (
    <View style={[s.avatar, { width: size, height: size, borderRadius: size / 2 }]}>
      <Text style={[s.avatarText, { fontSize: size * 0.38 }]}>{ini}</Text>
    </View>
  );
}

export function Button({
  title,
  onPress,
  tone = 'brand',
  loading = false,
  disabled,
  icon,
  style,
  ...rest
}: PressableProps & {
  title: string;
  tone?: 'brand' | 'danger' | 'ghost';
  loading?: boolean;
  icon?: IconName;
  style?: StyleProp<ViewStyle>;
}) {
  const bg = tone === 'brand' ? colors.brand : tone === 'danger' ? colors.destructive : 'transparent';
  const fg = tone === 'brand' ? colors.brandForeground : tone === 'danger' ? colors.destructiveForeground : colors.foreground;
  return (
    <Pressable
      accessibilityRole="button"
      onPress={onPress}
      disabled={disabled || loading}
      style={({ pressed }) => [
        s.button,
        { backgroundColor: bg, opacity: disabled ? 0.5 : pressed ? 0.85 : 1 },
        tone === 'ghost' ? { borderWidth: 1, borderColor: colors.borderStrong } : null,
        style,
      ]}
      {...rest}>
      {loading ? (
        <ActivityIndicator color={fg} />
      ) : (
        <>
          {icon ? <Ionicons name={icon} size={18} color={fg} /> : null}
          <Text style={[s.buttonText, { color: fg }]}>{title}</Text>
        </>
      )}
    </Pressable>
  );
}

export function Chips<T extends string>({
  options,
  value,
  onChange,
}: {
  options: { key: T; label: string }[];
  value: T;
  onChange: (k: T) => void;
}) {
  return (
    <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ gap: space[2] }}>
      {options.map(o => {
        const active = o.key === value;
        return (
          <Pressable
            key={o.key}
            onPress={() => { onChange(o.key); }}
            accessibilityRole="button"
            accessibilityState={{ selected: active }}
            style={[s.chip, active ? s.chipActive : null]}>
            <Text style={[s.chipText, active ? s.chipTextActive : null]}>{o.label}</Text>
          </Pressable>
        );
      })}
    </ScrollView>
  );
}

export function Loading() {
  return (
    <View style={{ padding: space[6], alignItems: 'center' }}>
      <ActivityIndicator color={colors.brand} />
    </View>
  );
}

export function Empty({ icon = 'checkmark-circle-outline', title, hint }: { icon?: IconName; title: string; hint?: string }) {
  return (
    <View style={s.empty}>
      <Ionicons name={icon} size={28} color={colors.mutedForeground} />
      <Text style={s.emptyTitle}>{title}</Text>
      {hint ? <Text style={s.emptyHint}>{hint}</Text> : null}
    </View>
  );
}

export function ErrorBox({ message, onRetry }: { message: string; onRetry?: () => void }) {
  return (
    <View accessibilityRole="alert" style={s.error}>
      <Ionicons name="alert-circle" size={18} color={colors.destructive} />
      <Text style={{ color: colors.foreground, flex: 1, ...type.small }}>{message}</Text>
      {onRetry ? (
        <Pressable onPress={onRetry} hitSlop={8}>
          <Text style={{ color: colors.brand, ...type.small, fontWeight: '600' }}>Retry</Text>
        </Pressable>
      ) : null}
    </View>
  );
}

/** Simple horizontal bar list — the app's only chart primitive. */
export function Bars({
  data,
  highlightIndex,
  formatValue,
}: {
  data: { label: string; value: number }[];
  highlightIndex?: number;
  formatValue?: (v: number) => string;
}) {
  const max = Math.max(1, ...data.map(d => d.value));
  return (
    <View style={{ gap: space[2] }}>
      {data.map((d, i) => (
        <View key={d.label} style={{ flexDirection: 'row', alignItems: 'center', gap: space[2] }}>
          <Text style={[s.barLabel, { width: 64 }]} numberOfLines={1}>
            {d.label}
          </Text>
          <View style={{ flex: 1, height: 10, backgroundColor: colors.muted, borderRadius: 5, overflow: 'hidden', flexDirection: 'row' }}>
            <View style={{ flex: d.value, backgroundColor: i === highlightIndex ? colors.brandStrong : colors.brand, borderRadius: 5 }} />
            <View style={{ flex: max - d.value }} />
          </View>
          <Text style={[s.barLabel, { width: 72, textAlign: 'right', color: colors.foreground }]} numberOfLines={1}>
            {formatValue ? formatValue(d.value) : String(d.value)}
          </Text>
        </View>
      ))}
    </View>
  );
}

/** Column chart for 24-hour breakdown. */
export function Columns({ data, highlightIndex }: { data: { label: string; value: number }[]; highlightIndex?: number }) {
  const max = Math.max(1, ...data.map(d => d.value));
  return (
    <View style={{ flexDirection: 'row', alignItems: 'flex-end', gap: 3, height: 96 }}>
      {data.map((d, i) => (
        <View key={d.label} style={{ flex: 1, alignItems: 'center', gap: 4, height: '100%', justifyContent: 'flex-end' }}>
          <View style={{ flex: max - d.value }} />
          <View
            style={{
              width: '100%',
              flex: d.value,
              minHeight: 3,
              backgroundColor: i === highlightIndex ? colors.brandStrong : d.value > 0 ? colors.brand : colors.muted,
              borderRadius: 2,
            }}
          />
          {i % 6 === 0 ? <Text style={[s.barLabel, { fontSize: 9 }]}>{d.label}</Text> : <Text style={[s.barLabel, { fontSize: 9 }]}> </Text>}
        </View>
      ))}
    </View>
  );
}

export type Tone = 'default' | 'success' | 'warning' | 'danger' | 'brand';

export function toneColor(t: Tone): string {
  switch (t) {
    case 'success':
      return colors.success;
    case 'warning':
      return colors.warning;
    case 'danger':
      return colors.destructive;
    case 'brand':
      return colors.brand;
    default:
      return colors.foreground;
  }
}
export function toneSoft(t: Tone): string {
  switch (t) {
    case 'success':
      return colors.successSoft;
    case 'warning':
      return colors.warningSoft;
    case 'danger':
      return colors.destructiveSoft;
    case 'brand':
      return colors.brandSoft;
    default:
      return colors.muted;
  }
}

export const text: Record<'h1' | 'h2' | 'body' | 'small' | 'muted' | 'caption', TextStyle> = {
  h1: { ...type.h1, color: colors.foreground },
  h2: { ...type.h2, color: colors.foreground },
  body: { ...type.body, color: colors.foreground },
  small: { ...type.small, color: colors.foreground },
  muted: { ...type.small, color: colors.mutedForeground },
  caption: { ...type.caption, color: colors.mutedForeground, textTransform: 'uppercase' },
};

const s = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.background },
  brandLockup: { alignItems: 'center', gap: space[2] },
  brandTitle: { ...type.display, color: colors.foreground, textAlign: 'center' },
  brandCompany: { ...type.caption, color: colors.mutedForeground, letterSpacing: 0.9 },
  brandFooter: { alignItems: 'center', gap: 3, paddingVertical: space[2] },
  brandMade: { ...type.small, color: colors.foreground, fontWeight: '600' },
  card: {
    backgroundColor: colors.card,
    borderRadius: radius.lg,
    borderWidth: 1,
    borderColor: colors.border,
    overflow: 'hidden',
  },
  sectionHeader: { flexDirection: 'row', alignItems: 'baseline', justifyContent: 'space-between' },
  sectionTitle: { ...type.caption, color: colors.mutedForeground, textTransform: 'uppercase' },
  sectionAction: { ...type.small, color: colors.brand, fontWeight: '600' },
  kpi: {
    flex: 1,
    minWidth: 140,
    backgroundColor: colors.card,
    borderRadius: radius.lg,
    borderWidth: 1,
    borderColor: colors.border,
    padding: space[4],
    gap: 4,
  },
  kpiLabel: { ...type.caption, color: colors.mutedForeground, textTransform: 'uppercase' },
  kpiValue: { fontSize: 24, lineHeight: 30, fontWeight: '700', letterSpacing: -0.4, fontVariant: ['tabular-nums'] },
  kpiHint: { ...type.small, color: colors.mutedForeground },
  pill: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    paddingHorizontal: 8,
    paddingVertical: 3,
    borderRadius: 999,
    alignSelf: 'flex-start',
  },
  pillText: { ...type.caption, letterSpacing: 0.3 },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space[3],
    paddingHorizontal: space[4],
    minHeight: touch.comfy,
    paddingVertical: space[2],
  },
  rowIcon: { width: 36, height: 36, borderRadius: radius.sm, alignItems: 'center', justifyContent: 'center' },
  rowTitle: { ...type.body, color: colors.foreground, fontWeight: '500' },
  rowSub: { ...type.small, color: colors.mutedForeground },
  rowRight: { ...type.body, color: colors.foreground, fontWeight: '600', fontVariant: ['tabular-nums'] },
  divider: { height: 1, backgroundColor: colors.border, marginLeft: space[4] },
  avatar: { backgroundColor: colors.secondary, alignItems: 'center', justifyContent: 'center' },
  avatarText: { color: colors.foreground, fontWeight: '600' },
  button: {
    minHeight: touch.min + 4,
    borderRadius: radius.md,
    alignItems: 'center',
    justifyContent: 'center',
    flexDirection: 'row',
    gap: space[2],
    paddingHorizontal: space[4],
  },
  buttonText: { ...type.body, fontWeight: '600' },
  chip: {
    paddingHorizontal: 14,
    height: 36,
    borderRadius: 999,
    backgroundColor: colors.muted,
    alignItems: 'center',
    justifyContent: 'center',
  },
  chipActive: { backgroundColor: colors.foreground },
  chipText: { ...type.small, color: colors.foreground, fontWeight: '500' },
  chipTextActive: { color: colors.background },
  empty: { padding: space[6], alignItems: 'center', gap: space[2] },
  emptyTitle: { ...type.body, color: colors.foreground, fontWeight: '500' },
  emptyHint: { ...type.small, color: colors.mutedForeground, textAlign: 'center' },
  error: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space[2],
    padding: space[3],
    borderRadius: radius.md,
    backgroundColor: colors.destructiveSoft,
    borderWidth: 1,
    borderColor: colors.destructive,
  },
  barLabel: { ...type.small, color: colors.mutedForeground, fontVariant: ['tabular-nums'] },
});
