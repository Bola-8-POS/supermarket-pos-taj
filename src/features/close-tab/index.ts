import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useRef } from 'react';
import { toast } from 'sonner';
import { tabKeys } from '@entities/tab/model/queries';
import { useTabStore } from '@entities/tab/model/store';
import i18n from '@shared/lib/i18n';
import { ok, supabaseQuery, versionedMutation, type Result } from '@shared/lib/result';
import { supabase } from '@shared/lib/supabase';
import { getTerminalId } from '@shared/lib/terminal';
import { handleVersionError } from '@shared/lib/version-error';

export function useCloseTab() {
  const queryClient = useQueryClient();
  const clearSelection = useTabStore(s => s.clearSelection);
  const expectedVersionRef = useRef(0);

  const mutation = useMutation({
    mutationFn: async (tabId: string): Promise<Result<void>> => {
      // tabs has a bump_version_on_update trigger (Phase 15) that rejects any
      // UPDATE not explicitly advancing `version` by 1 — fetch it first.
      const versionRes = await supabaseQuery<{ version: number }>(() =>
        supabase.from('tabs').select('version').eq('id', tabId).single()
      );
      if (!versionRes.ok) {
        return versionRes;
      }
      expectedVersionRef.current = versionRes.data.version;

      const upd = await versionedMutation(() =>
        supabase
          .from('tabs')
          .update({
            status: 'closed',
            closed_at: new Date().toISOString(),
            version: versionRes.data.version + 1,
          })
          .eq('id', tabId)
          .eq('version', versionRes.data.version)
          .select('id')
      );

      if (!upd.ok) {
        return upd;
      }

      return ok(undefined);
    },
  });

  const closeTab = async (tabId: string): Promise<Result<void>> => {
    const result = await mutation.mutateAsync(tabId);
    if (!result.ok) {
      const handled = handleVersionError(result.error, {
        queryClient,
        queryKey: tabKeys.all,
        entity: 'tabs',
        entityId: tabId,
        expectedVersion: expectedVersionRef.current,
        supabase,
        terminalId: getTerminalId(),
      });
      if (!handled) {
        toast.error(result.error.message);
      }
      return result;
    }
    toast.success(i18n.t('featOrders:closeTab.success'));
    await queryClient.invalidateQueries({ queryKey: tabKeys.lists() });
    clearSelection();
    return result;
  };

  return { closeTab, isClosing: mutation.isPending };
}
