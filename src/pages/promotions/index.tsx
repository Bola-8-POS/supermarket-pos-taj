/* eslint-disable import/order, @typescript-eslint/no-confusing-void-expression */
import type { ColumnDef } from '@tanstack/react-table';
import { Pencil, Percent, Trash2 } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useSearchParams } from 'react-router-dom';
import { toast } from 'sonner';
import {
  usePromotions,
  useMutationUpdatePromotion,
  useMutationDeletePromotion,
  type Promotion,
} from '@entities/promotion';
import { PromotionDialog } from '@features/manage-promotions';
import { formatMoney } from '@shared/lib/format';
import { cn } from '@shared/lib/utils';
import {
  Badge,
  Button,
  ConfirmDialog,
  DataTable,
  EmptyState,
  LockedFeature,
  MoneyDisplay,
  PageContainer,
  POSButton,
  StatusBadge,
  Switch,
} from '@shared/ui';
import type { StatusBadgeProps } from '@shared/ui';

type PromotionStatus = 'promo_active' | 'promo_scheduled' | 'promo_expired' | 'promo_inactive';
type KindFilter = 'all' | 'discounts' | 'combos';

function derivePromotionStatus(p: Promotion): PromotionStatus {
  const now = new Date();
  if (!p.active) return 'promo_inactive';
  if (p.startsAt > now) return 'promo_scheduled';
  if (now > p.endsAt) return 'promo_expired';
  return 'promo_active';
}

export default function PromotionsPage() {
  const { t } = useTranslation('pages');
  const { t: tAdmin } = useTranslation('wAdmin');
  const { data: fetchedPromotions, isLoading, resultError } = usePromotions();
  const updateMutation = useMutationUpdatePromotion();
  const deleteMutation = useMutationDeletePromotion();

  const [lastGoodPromotions, setLastGoodPromotions] = useState<Promotion[]>([]);
  const [deleteId, setDeleteId] = useState<string | null>(null);
  const [dialog, setDialog] = useState<{ open: boolean; promotion: Promotion | null }>({
    open: false,
    promotion: null,
  });
  const [statusFilter, setStatusFilter] = useState<StatusBadgeProps['status'] | null>(null);
  const [kindFilter, setKindFilter] = useState<KindFilter>('all');
  const [searchParams, setSearchParams] = useSearchParams();

  useEffect(() => {
    /* eslint-disable react-hooks/set-state-in-effect -- fetch-failure backstop:
       remember the last-known-good rows so a background refetch failure keeps
       the table populated instead of clearing to blank (must_haves backstop) */
    if (fetchedPromotions) setLastGoodPromotions(fetchedPromotions);
    /* eslint-enable react-hooks/set-state-in-effect */
  }, [fetchedPromotions]);

  useEffect(() => {
    if (resultError) toast.error(tAdmin('promotionsListPanel.loadError'));
  }, [resultError, tAdmin]);

  // Fetch-failure backstop: keep the last-known rows rendered rather than
  // clearing the table to blank (must_haves backstop truth).
  const promotions = fetchedPromotions ?? lastGoodPromotions;

  const wantsNew = searchParams.get('new') === '1';
  const editId = searchParams.get('edit');

  useEffect(() => {
    /* eslint-disable react-hooks/set-state-in-effect -- deep-link → dialog sync */
    if (wantsNew) setDialog({ open: true, promotion: null });
    /* eslint-enable react-hooks/set-state-in-effect */
  }, [wantsNew]);

  useEffect(() => {
    /* eslint-disable react-hooks/set-state-in-effect -- deep-link → dialog sync */
    if (!editId) return;
    const target = promotions.find(p => p.id === editId);
    if (target && target.id !== dialog.promotion?.id) setDialog({ open: true, promotion: target });
    /* eslint-enable react-hooks/set-state-in-effect */
  }, [editId, promotions, dialog.promotion?.id]);

  function closeDialog() {
    setDialog({ open: false, promotion: null });
    if (wantsNew || editId) setSearchParams({}, { replace: true });
  }

  function openCreateDialog() {
    setDialog({ open: true, promotion: null });
  }

  const counts = useMemo(() => {
    const c = {
      promo_active: 0,
      promo_scheduled: 0,
      promo_expired: 0,
      promo_inactive: 0,
      needsReview: 0,
    };
    for (const p of promotions) {
      c[derivePromotionStatus(p)] += 1;
      if (p.needsReview) c.needsReview += 1;
    }
    return c;
  }, [promotions]);

  const visiblePromotions = promotions
    .filter(p => !statusFilter || derivePromotionStatus(p) === statusFilter)
    .filter(p => {
      if (kindFilter === 'discounts') return p.kind === 'discount';
      if (kindFilter === 'combos') return p.kind === 'combo';
      return true;
    });

  const columns: ColumnDef<Promotion>[] = [
    {
      id: 'name',
      accessorFn: p => p.name,
      header: tAdmin('promotionsListPanel.columnName'),
      cell: info => <span className="font-medium">{info.getValue<string>()}</span>,
    },
    {
      id: 'scope',
      header: tAdmin('promotionsListPanel.columnScope'),
      cell: ({ row }) => {
        const p = row.original;
        if (p.kind === 'combo') {
          return (
            <span className="text-sm">
              {tAdmin('promotionsListPanel.scopeCombo', { count: p.slots.length })}
            </span>
          );
        }
        if (p.targets.length === 0) {
          return (
            <Badge variant="secondary" className="text-xs">
              {tAdmin('promotionsListPanel.scopeStoreWide')}
            </Badge>
          );
        }
        const productCount = p.targets.filter(t => t.productId !== null).length;
        const categoryCount = p.targets.filter(t => t.categoryId !== null).length;
        return (
          <span className="text-sm">
            {tAdmin('promotionsListPanel.scopeTargetCounts', { productCount, categoryCount })}
          </span>
        );
      },
    },
    {
      id: 'discount',
      header: tAdmin('promotionsListPanel.columnDiscount'),
      cell: ({ row }) => {
        const p = row.original;
        switch (p.discountType) {
          case 'percent':
            return <span className="font-mono tabular-nums">{p.discountValue}%</span>;
          case 'bundle_price':
            return (
              <span className="text-sm">
                {tAdmin('promotionsListPanel.comboPricing.bundle_price', {
                  amount: formatMoney(p.discountValue),
                })}
              </span>
            );
          case 'cheapest_free':
            return (
              <span className="text-sm">
                {tAdmin('promotionsListPanel.comboPricing.cheapest_free', {
                  count: p.discountValue,
                })}
              </span>
            );
          case 'fixed':
          default:
            return <MoneyDisplay amount={p.discountValue} size="sm" />;
        }
      },
    },
    {
      id: 'dateRange',
      header: tAdmin('promotionsListPanel.columnDateRange'),
      cell: ({ row }) => (
        <span className="text-sm text-muted-foreground">
          {row.original.startsAt.toLocaleDateString()} – {row.original.endsAt.toLocaleDateString()}
        </span>
      ),
    },
    {
      id: 'status',
      header: tAdmin('promotionsListPanel.columnStatus'),
      cell: ({ row }) => <StatusBadge status={derivePromotionStatus(row.original)} />,
    },
    {
      id: 'review',
      header: tAdmin('promotionsListPanel.columnReview'),
      cell: ({ row }) =>
        row.original.needsReview ? <StatusBadge status="promo_needs_review" /> : null,
    },
    {
      id: 'actions',
      header: '',
      cell: ({ row }) => {
        const p = row.original;
        return (
          <div className="flex items-center justify-end gap-2">
            <Switch
              checked={p.active}
              disabled={updateMutation.isPending}
              aria-label={tAdmin('promotionsListPanel.toggleActiveAriaLabel')}
              onCheckedChange={checked => {
                void updateMutation.mutateAsync({ id: p.id, active: checked });
              }}
            />
            <LockedFeature feature="promotions">
              <POSButton
                type="button"
                variant="ghost"
                size="icon"
                aria-label={tAdmin('promotionsListPanel.edit')}
                onClick={e => {
                  e.stopPropagation();
                  setDialog({ open: true, promotion: p });
                }}
              >
                <Pencil className="size-4" />
              </POSButton>
            </LockedFeature>
            <POSButton
              type="button"
              variant="ghost"
              size="icon"
              aria-label={tAdmin('promotionsListPanel.delete')}
              onClick={e => {
                e.stopPropagation();
                setDeleteId(p.id);
              }}
            >
              <Trash2 className="size-4" />
            </POSButton>
          </div>
        );
      },
    },
  ];

  return (
    <PageContainer
      title={t('promotions.title')}
      actions={
        <LockedFeature feature="promotions">
          <POSButton type="button" onClick={openCreateDialog}>
            {t('promotions.newPromotion')}
          </POSButton>
        </LockedFeature>
      }
    >
      <p className="text-sm text-muted-foreground">{tAdmin('promotionsListPanel.hint')}</p>

      <div
        className="flex w-fit gap-1 rounded-xl bg-muted p-1"
        role="group"
        aria-label={tAdmin('promotionsListPanel.kindFilterLabel')}
      >
        {/* eslint-disable-next-line i18next/no-literal-string -- kind-filter keys, not UI copy (labels are t()-wrapped below) */}
        {(['all', 'discounts', 'combos'] as const).map(kf => (
          <POSButton
            key={kf}
            type="button"
            touchSize="default"
            variant={kindFilter === kf ? 'default' : 'ghost'}
            aria-pressed={kindFilter === kf}
            data-testid={`promotions-kind-filter-${kf}`}
            onClick={() => {
              setKindFilter(kf);
            }}
            className={cn('min-w-24', kindFilter !== kf && 'hover:bg-card')}
          >
            {tAdmin(`promotionsListPanel.kindFilter.${kf}`)}
          </POSButton>
        ))}
      </div>

      <div
        className="flex flex-wrap gap-3"
        role="group"
        aria-label={tAdmin('promotionsListPanel.statusFilterLabel')}
      >
        {(
          /* eslint-disable i18next/no-literal-string -- status keys + Tailwind
             class lookup table, not UI copy (labels are t()-wrapped above) */
          [
            ['promo_active', tAdmin('promotionsListPanel.statActive'), 'text-success-strong'],
            ['promo_scheduled', tAdmin('promotionsListPanel.statScheduled'), 'text-brand-strong'],
            ['promo_expired', tAdmin('promotionsListPanel.statExpired'), 'text-destructive'],
            ['promo_inactive', tAdmin('promotionsListPanel.statInactive'), 'text-muted-foreground'],
          ] as const
          /* eslint-enable i18next/no-literal-string */
        ).map(([status, label, tone]) => (
          <Button
            key={status}
            type="button"
            variant="ghost"
            aria-pressed={statusFilter === status}
            onClick={() => {
              setStatusFilter(prev => (prev === status ? null : status));
            }}
            className={cn(
              'h-auto min-w-[9rem] flex-col items-start gap-1 rounded-xl border border-border bg-card px-4 py-3 text-left shadow-xs hover:border-border-strong hover:bg-card',
              statusFilter === status && 'border-brand ring-2 ring-brand/30'
            )}
          >
            <span className="text-[0.6875rem] font-semibold tracking-[0.12em] text-muted-foreground uppercase">
              {label}
            </span>
            <span className={cn('text-numeric text-2xl font-semibold', tone)}>
              {counts[status]}
            </span>
          </Button>
        ))}
        {counts.needsReview > 0 && (
          <div className="flex min-w-[9rem] flex-col gap-1 rounded-xl border border-warning/40 bg-warning-soft px-4 py-3">
            <span className="text-[0.6875rem] font-semibold tracking-[0.12em] text-warning-strong uppercase">
              {tAdmin('promotionsListPanel.statNeedsReview')}
            </span>
            <span className="text-numeric text-2xl font-semibold text-warning-strong">
              {counts.needsReview}
            </span>
          </div>
        )}
      </div>

      <DataTable
        columns={columns}
        data={visiblePromotions}
        isLoading={isLoading}
        searchable
        emptyState={
          <EmptyState
            icon={Percent}
            title={tAdmin('promotionsListPanel.emptyTitle')}
            description={tAdmin('promotionsListPanel.emptyBody')}
            action={{ label: t('promotions.newPromotion'), onClick: openCreateDialog }}
          />
        }
      />

      <ConfirmDialog
        open={!!deleteId}
        title={tAdmin('promotionsListPanel.deleteTitle')}
        description={tAdmin('promotionsListPanel.deleteBody')}
        confirmLabel={tAdmin('promotionsListPanel.delete')}
        variant="destructive"
        onCancel={() => {
          setDeleteId(null);
        }}
        onConfirm={() => {
          if (deleteId) void deleteMutation.mutateAsync(deleteId);
          setDeleteId(null);
        }}
      />

      <PromotionDialog
        open={dialog.open}
        promotion={dialog.promotion}
        onOpenChange={open => {
          if (!open) closeDialog();
        }}
      />
    </PageContainer>
  );
}
