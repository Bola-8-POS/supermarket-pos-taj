import type { ColumnDef } from '@tanstack/react-table';
import { useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useSearchParams } from 'react-router-dom';
import { AdminResetPinDialog } from '@features/admin-reset-pin';
import { ClockInModal } from '@features/clock-in-staff';
import { ClockOutDialog } from '@features/clock-out-staff';
import { CreateStaffDialog } from '@features/create-staff';
import { DeactivateStaffDialog } from '@features/deactivate-staff';
import { EditLocaleDialog } from '@features/edit-staff-locale';
import { ForcePinChangeDialog } from '@features/force-pin-change';
import { useOpenShifts, useStaffList } from '@entities/staff';
import { useStaffStore } from '@entities/staff/model/store';
import type { Shift, Staff } from '@shared/lib/domain';
import { DataTable } from '@shared/ui/DataTable';
import { POSButton } from '@shared/ui/POSButton';
import { ProtectedAction } from '@shared/ui/ProtectedAction';
import { SectionHeader } from '@shared/ui/SectionHeader';
import { Badge } from '@shared/ui/badge';

export type StaffShiftRow = {
  staff: Staff;
  shift: Shift | null;
};

function formatShiftDuration(clockIn: Date, tick: number): string {
  void tick;
  const ms = Date.now() - clockIn.getTime();
  const totalM = Math.floor(ms / 60000);
  const h = Math.floor(totalM / 60);
  const m = totalM % 60;
  if (h <= 0) return `${String(m)}m`;
  return `${String(h)}h ${String(m)}m`;
}

export function StaffDashboard() {
  const { t } = useTranslation('staff');
  const { data: staffList, isIdleOrLoading: staffLoading } = useStaffList();
  const { data: openShifts, isIdleOrLoading: shiftsLoading } = useOpenShifts();
  const currentRole = useStaffStore(s => s.currentStaff?.role);
  const currentStaffId = useStaffStore(s => s.currentStaff?.id);
  const [searchParams] = useSearchParams();
  const targetStaffId = searchParams.get('id');
  const tableContainerRef = useRef<HTMLDivElement>(null);

  const [tick, setTick] = useState(0);
  useEffect(() => {
    const id = window.setInterval(() => {
      setTick(t => t + 1);
    }, 30_000);
    return () => {
      window.clearInterval(id);
    };
  }, []);

  const [clockInStaff, setClockInStaff] = useState<Staff | null>(null);
  const [clockOutTarget, setClockOutTarget] = useState<{ staff: Staff; shift: Shift } | null>(null);
  const [forcePinTarget, setForcePinTarget] = useState<Staff | null>(null);
  const [resetPinTarget, setResetPinTarget] = useState<Staff | null>(null);
  const [localeTarget, setLocaleTarget] = useState<Staff | null>(null);
  const [deactivateTarget, setDeactivateTarget] = useState<Staff | null>(null);
  const [addStaffOpen, setAddStaffOpen] = useState(false);

  const rows: StaffShiftRow[] = useMemo(() => {
    const staff = staffList ?? [];
    const shifts = openShifts ?? [];
    const scopedStaff =
      currentRole === 'cashier' ? staff.filter(s => s.id === currentStaffId) : staff;
    return scopedStaff.map(s => ({
      staff: s,
      shift: shifts.find(sh => sh.staffId === s.id) ?? null,
    }));
  }, [staffList, openShifts, currentRole, currentStaffId]);

  const columns = useMemo<ColumnDef<StaffShiftRow>[]>(
    () => [
      {
        accessorKey: 'staff.name',
        header: t('table.name'),
        cell: ({ row }) => <span className="font-medium">{row.original.staff.name}</span>,
      },
      {
        id: 'role',
        header: t('table.role'),
        cell: ({ row }) => (
          <Badge variant="outline" className="capitalize">
            {row.original.staff.role}
          </Badge>
        ),
      },
      {
        id: 'locale',
        header: t('table.locale'),
        cell: ({ row }) => (
          <Badge variant="outline" className="uppercase">
            {row.original.staff.locale}
          </Badge>
        ),
      },
      {
        id: 'clockIn',
        header: t('table.clockIn'),
        cell: ({ row }) =>
          row.original.shift ? (
            <span className="tabular-nums text-sm">
              {row.original.shift.clockIn.toLocaleTimeString(undefined, {
                hour: 'numeric',
                minute: '2-digit',
              })}
            </span>
          ) : (
            <span className="text-muted-foreground">—</span>
          ),
      },
      {
        id: 'duration',
        header: t('table.duration'),
        cell: ({ row }) =>
          row.original.shift ? (
            <span className="tabular-nums text-sm">
              {formatShiftDuration(row.original.shift.clockIn, tick)}
            </span>
          ) : (
            <span className="text-muted-foreground">—</span>
          ),
      },
      {
        id: 'actions',
        header: '',
        cell: ({ row }) => {
          const { staff, shift } = row.original;
          return (
            <div className="flex flex-wrap justify-end gap-2">
              {!shift && (
                <ProtectedAction action="clock_in" currentRole={currentRole}>
                  <POSButton
                    type="button"
                    size="sm"
                    variant="outline"
                    onClick={() => {
                      setClockInStaff(staff);
                    }}
                  >
                    {t('actions.clockIn')}
                  </POSButton>
                </ProtectedAction>
              )}
              {shift && (
                <ProtectedAction action="clock_out" currentRole={currentRole}>
                  <POSButton
                    type="button"
                    size="sm"
                    variant="destructive"
                    onClick={() => {
                      setClockOutTarget({ staff, shift });
                    }}
                  >
                    {t('actions.clockOut')}
                  </POSButton>
                </ProtectedAction>
              )}
              <ProtectedAction action="manage_staff" currentRole={currentRole}>
                <POSButton
                  type="button"
                  size="sm"
                  variant="outline"
                  onClick={() => {
                    setForcePinTarget(staff);
                  }}
                >
                  {t('actions.forcePinChange')}
                </POSButton>
              </ProtectedAction>
              <ProtectedAction action="manage_staff" currentRole={currentRole}>
                <POSButton
                  type="button"
                  size="sm"
                  variant="outline"
                  onClick={() => {
                    setResetPinTarget(staff);
                  }}
                >
                  {t('actions.resetPin')}
                </POSButton>
              </ProtectedAction>
              <ProtectedAction action="manage_staff" currentRole={currentRole}>
                <POSButton
                  type="button"
                  size="sm"
                  variant="outline"
                  onClick={() => {
                    setLocaleTarget(staff);
                  }}
                >
                  {t('locale.editTrigger')}
                </POSButton>
              </ProtectedAction>
              {staff.id !== currentStaffId && (
                <ProtectedAction action="manage_staff" currentRole={currentRole}>
                  <POSButton
                    type="button"
                    size="sm"
                    variant="destructive"
                    onClick={() => {
                      setDeactivateTarget(staff);
                    }}
                  >
                    {t('actions.deactivate')}
                  </POSButton>
                </ProtectedAction>
              )}
            </div>
          );
        },
      },
    ],
    [currentRole, currentStaffId, t, tick]
  );

  const isLoading = staffLoading || shiftsLoading;

  // Scroll the highlighted row (from ?id=) into view once it's rendered.
  useEffect(() => {
    if (!targetStaffId) return;
    if (!rows.some(row => row.staff.id === targetStaffId)) return;
    // eslint-disable-next-line i18next/no-literal-string -- CSS selector for the highlight class, not UI copy
    const highlighted = tableContainerRef.current?.querySelector('tr.bg-accent\\/40');
    // jsdom (unit tests) doesn't implement scrollIntoView — guard defensively.
    if (typeof highlighted?.scrollIntoView === 'function') {
      highlighted.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }
  }, [targetStaffId, rows]);

  return (
    <div className="mx-auto max-w-6xl space-y-8">
      <SectionHeader
        title={t('section.title')}
        description={t('section.description')}
        action={
          <ProtectedAction action="manage_staff" currentRole={currentRole}>
            <POSButton
              type="button"
              onClick={() => {
                setAddStaffOpen(true);
              }}
            >
              {t('addStaff.trigger')}
            </POSButton>
          </ProtectedAction>
        }
      />

      <div ref={tableContainerRef}>
        <DataTable
          columns={columns}
          data={rows}
          isLoading={isLoading}
          searchable
          searchPlaceholder={t('search.placeholder')}
          getRowClassName={row =>
            // eslint-disable-next-line i18next/no-literal-string -- Tailwind class string, not UI copy
            targetStaffId && row.staff.id === targetStaffId ? 'bg-accent/40' : undefined
          }
        />
      </div>

      <ClockInModal
        open={clockInStaff !== null}
        onOpenChange={next => {
          if (!next) setClockInStaff(null);
        }}
        staff={clockInStaff}
      />

      <ClockOutDialog
        key={
          clockOutTarget
            ? `${clockOutTarget.shift.id}-${clockOutTarget.staff.id}`
            : 'clock-out-idle'
        }
        open={clockOutTarget !== null}
        onOpenChange={next => {
          if (!next) setClockOutTarget(null);
        }}
        staff={clockOutTarget?.staff ?? null}
        shift={clockOutTarget?.shift ?? null}
      />

      <ForcePinChangeDialog
        staff={forcePinTarget}
        open={forcePinTarget !== null}
        onOpenChange={next => {
          if (!next) setForcePinTarget(null);
        }}
      />

      <AdminResetPinDialog
        staff={resetPinTarget}
        open={resetPinTarget !== null}
        onOpenChange={next => {
          if (!next) setResetPinTarget(null);
        }}
      />

      <EditLocaleDialog
        key={localeTarget?.id ?? 'locale-idle'}
        staff={localeTarget}
        open={localeTarget !== null}
        onOpenChange={next => {
          if (!next) setLocaleTarget(null);
        }}
      />

      <DeactivateStaffDialog
        staff={deactivateTarget}
        open={deactivateTarget !== null}
        onOpenChange={next => {
          if (!next) setDeactivateTarget(null);
        }}
      />

      <CreateStaffDialog open={addStaffOpen} onOpenChange={setAddStaffOpen} />
    </div>
  );
}
