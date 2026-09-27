/**
 * ReopenTabDialog - right-side Sheet for reopening a closed/paid tab.
 *
 * Mirrors EditPaidTabDialog's shell (Sheet -> Save -> ManagerPinDialog ->
 * submit) but drops all item-override/QuantityControl/add-item machinery —
 * reopening takes only a reason. Per D-06 the result is a fully normal open
 * tab with no special "reopened mode" UI.
 */
import { useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";

import { ManagerPinDialog } from "@features/manager-pin-gate";
import { tabKeys, useTab } from "@entities/tab";
import { supabase } from "@shared/lib/supabase";
import { getTerminalId } from "@shared/lib/terminal";
import { handleVersionError } from "@shared/lib/version-error";
import {
  Input,
  Label,
  POSButton,
  Sheet,
  SheetContent,
  SheetDescription,
  SheetFooter,
  SheetHeader,
  SheetTitle,
} from "@shared/ui";

import { useReopenTab } from "../model/useReopenTab";

export interface ReopenTabDialogProps {
  open: boolean;
  tabId: string | null;
  onOpenChange: (open: boolean) => void;
}

export function ReopenTabDialog({ open, tabId, onOpenChange }: ReopenTabDialogProps) {
  const { t } = useTranslation("featOrders");
  const queryClient = useQueryClient();
  const { data: tab } = useTab(tabId ?? "");
  const mutation = useReopenTab();

  const [reason, setReason] = useState("");
  const [pinOpen, setPinOpen] = useState(false);

  const isValid = reason.trim() !== "" && !mutation.isPending;

  async function handleSubmitReopen(approvalId: string, approverId: string) {
    if (!tab) return;

    const result = await mutation.mutateAsync({
      tabId: tab.id,
      expectedVersion: tab.version ?? 0,
      reason,
      approvalId,
      approverId,
    });

    if (!result.ok) {
      const isVersionConflict =
        result.error.code === "STALE_VERSION" || result.error.code === "NOT_FOUND_VERSIONED";
      if (
        isVersionConflict &&
        handleVersionError(result.error, {
          queryClient,
          queryKey: tabKeys.detail(tab.id),
          entity: "tabs",
          entityId: tab.id,
          expectedVersion: tab.version ?? 0,
          supabase,
          terminalId: getTerminalId(),
        })
      ) {
        handleOpenChange(false);
        return;
      }
      toast.error(result.error.message !== "" ? result.error.message : t("reopenTab.genericError"));
      return;
    }
    toast.success(t("reopenTab.reopenSuccess"));
    handleOpenChange(false);
  }

  function handleOpenChange(nextOpen: boolean) {
    if (!nextOpen) {
      setReason("");
      setPinOpen(false);
    }
    onOpenChange(nextOpen);
  }

  return (
    <>
      <Sheet open={open} onOpenChange={handleOpenChange}>
        <SheetContent side="right" className="w-full sm:max-w-xl overflow-y-auto flex flex-col">
          <SheetHeader>
            <SheetTitle>{t("reopenTab.title")}</SheetTitle>
            <SheetDescription>{t("reopenTab.description")}</SheetDescription>
          </SheetHeader>

          <div className="mt-4 flex-1 space-y-4 px-1">
            {tab && (
              <p className="text-sm text-muted-foreground">
                {t("reopenTab.summary", { name: tab.customerName })}
              </p>
            )}
            <div className="space-y-1.5">
              <Label htmlFor="reopen-tab-reason" className="text-sm font-medium">
                {t("reopenTab.reasonLabel")} <span className="text-destructive">*</span>
              </Label>
              <Input
                id="reopen-tab-reason"
                placeholder={t("reopenTab.reasonPlaceholder")}
                value={reason}
                onChange={e => { setReason(e.target.value); }}
              />
            </div>
          </div>

          <SheetFooter className="px-6 pb-6 flex gap-3">
            <POSButton
              variant="outline"
              touchSize="large"
              className="flex-1"
              onClick={() => { handleOpenChange(false); }}
            >
              {t("reopenTab.cancel")}
            </POSButton>
            <POSButton
              touchSize="xl"
              focusEmphasis="high"
              className="flex-1"
              disabled={!isValid}
              onClick={() => { setPinOpen(true); }}
            >
              {t("reopenTab.requestApproval")}
            </POSButton>
          </SheetFooter>
        </SheetContent>
      </Sheet>

      <ManagerPinDialog
        open={pinOpen}
        onOpenChange={setPinOpen}
        requiredAction="reopen_tab"
        onSuccess={(staff, approvalId) => {
          setPinOpen(false);
          void handleSubmitReopen(approvalId, staff.id);
        }}
      />
    </>
  );
}
