import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import {
  OfflineActionTypeSchema,
  type OfflineAction,
  type Tab,
} from '@shared/lib/domain';
import i18n from '@shared/lib/i18n';
import { logger } from '@shared/lib/logger-instance';
import { ok, err, type Result } from '@shared/lib/result';
/* eslint-disable i18next/no-literal-string -- the zustand persist store name
   below is a localStorage key, not UI copy. */

// ============================================================================
// OFFLINE ACTION QUEUE
//
// Phase 15 Plan 04: OfflineAction is now sourced from domain.ts (Zod single
// source of truth). Locked enum: open-tab | place-order | start-pool-timer |
// stop-pool-timer. Each entry carries an `expectedVersion` captured at enqueue
// time so the OfflineQueueProcessor can drop stale actions on replay.
// ============================================================================

export type { OfflineAction };

// ============================================================================
// STATE & ACTIONS
// ============================================================================

interface TabsState {
  /** All open tabs loaded from the server. */
  tabs: Tab[];
  /** Tab currently being edited in the cart panel. */
  activeTabId: string | null;
  /** Tab selected in the drawer UI (may differ from activeTabId). */
  selectedTabId: string | null;
  /** Controls the tab drawer visibility. */
  isTabDrawerOpen: boolean;
  /** Actions queued while offline; replayed in order when connectivity returns. */
  offlineQueue: OfflineAction[];
  /** True while the queue is being replayed after reconnection. Not persisted. */
  isSyncing: boolean;
}

interface TabsActions {
  /** Replaces the tabs list with the result from TanStack Query. */
  loadTabs: (tabs: Tab[]) => void;

  /** Adds a freshly-created tab; returns DUPLICATE_ENTRY if it already exists. */
  openTab: (tab: Tab) => Result<Tab>;

  /** Sets which tab the cart panel is currently editing. */
  setActiveTab: (id: string | null) => void;

  /** Updates a tab's status; returns NOT_FOUND if the tab is not in the store. */
  updateTabStatus: (id: string, status: Tab['status']) => Result<undefined>;

  /** Applies a Supabase Realtime INSERT / UPDATE / DELETE event to the tabs list. */
  handleRealtimeUpdate: (payload: {
    eventType: 'INSERT' | 'UPDATE' | 'DELETE';
    new: Partial<Tab>;
    old: Partial<Tab>;
  }) => void;

  /** Selects a tab in the drawer UI and sets it as the active cart tab. */
  selectTab: (id: string) => void;

  /** Clears the drawer UI selection. */
  clearSelection: () => void;

  /** Opens the tab drawer. */
  openDrawer: () => void;

  /** Closes the tab drawer. */
  closeDrawer: () => void;

  /** Appends an action to the offline queue. */
  enqueueOfflineAction: (action: Omit<OfflineAction, 'id' | 'timestamp' | 'retryCount'>) => void;

  /** Removes a single action from the offline queue by its id. */
  dequeueOfflineAction: (id: string) => void;

  /** Clears all queued offline actions. */
  clearOfflineQueue: () => void;

  /** Sets the syncing flag shown in the OfflineBanner. */
  setSyncing: (flag: boolean) => void;
}

type TabsStore = TabsState & TabsActions;

export const useTabStore = create<TabsStore>()(
  persist(
    (set, get) => ({
      tabs: [],
      activeTabId: null,
      selectedTabId: null,
      isTabDrawerOpen: false,
      offlineQueue: [],
      isSyncing: false,

      loadTabs: tabs => {
        logger.info('tabs.loaded', { count: tabs.length });
        set({ tabs });
      },

      openTab: tab => {
        if (get().tabs.some(t => t.id === tab.id)) {
          logger.warn('tabs.open.duplicate', { tabId: tab.id });
          // eslint-disable-next-line i18next/no-literal-string -- real
          // UI-facing error message, must stay translated despite the
          // file's technical-noise disable above.
          return err({ code: 'DUPLICATE_ENTRY', message: i18n.t('entities:tab.alreadyExistsInStore') });
        }
        logger.info('tabs.opened', { tabId: tab.id, customerName: tab.customerName });
        set(state => ({ tabs: [tab, ...state.tabs] }));
        return ok(tab);
      },

      setActiveTab: id => {
        logger.debug('tabs.activeTab.set', { tabId: id });
        set({ activeTabId: id });
      },

      updateTabStatus: (id, status) => {
        if (!get().tabs.some(t => t.id === id)) {
          logger.warn('tabs.updateStatus.notFound', { tabId: id });
          // eslint-disable-next-line i18next/no-literal-string -- real
          // UI-facing error message, must stay translated despite the
          // file's technical-noise disable above.
          return err({ code: 'NOT_FOUND', message: i18n.t('entities:tab.notFoundInStore') });
        }
        logger.info('tabs.status.updated', { tabId: id, status });
        set(state => ({
          tabs: state.tabs.map(t => (t.id === id ? { ...t, status } : t)),
        }));
        return ok(undefined);
      },

      handleRealtimeUpdate: ({ eventType, new: newRecord, old: oldRecord }) => {
        logger.debug('tabs.realtime', { eventType, tabId: newRecord.id ?? oldRecord.id });
        set(state => {
          switch (eventType) {
            case 'INSERT':
              if (newRecord.id && !state.tabs.some(t => t.id === newRecord.id)) {
                return { tabs: [newRecord as Tab, ...state.tabs] };
              }
              return state;
            case 'UPDATE':
              return {
                tabs: state.tabs.map(t => (t.id === newRecord.id ? { ...t, ...newRecord } : t)),
              };
            case 'DELETE':
              return { tabs: state.tabs.filter(t => t.id !== oldRecord.id) };
            default:
              return state;
          }
        });
      },

      selectTab: id => {
        logger.debug('tabs.selected', { tabId: id });
        set({ selectedTabId: id, activeTabId: id });
      },

      clearSelection: () => {
        logger.debug('tabs.selectionCleared');
        set({ selectedTabId: null, activeTabId: null });
      },

      openDrawer: () => {
        set({ isTabDrawerOpen: true });
      },

      closeDrawer: () => {
        set({ isTabDrawerOpen: false });
      },

      enqueueOfflineAction: action => {
        const entry: OfflineAction = {
          id: crypto.randomUUID(),
          timestamp: Date.now(),
          retryCount: 0,
          ...action,
        };
        logger.warn('offline.action.queued', { type: entry.type, id: entry.id });
        set(state => ({ offlineQueue: [...state.offlineQueue, entry] }));
      },

      dequeueOfflineAction: id => {
        logger.debug('offline.action.dequeued', { id });
        set(state => ({ offlineQueue: state.offlineQueue.filter(a => a.id !== id) }));
      },

      clearOfflineQueue: () => {
        logger.info('offline.queue.cleared');
        set({ offlineQueue: [] });
      },

      setSyncing: flag => {
        set({ isSyncing: flag });
      },
    }),
    {
      name: 'tabs',
      // Only persist UI selection and the offline queue.
      // The tabs array is server state owned by TanStack Query — persisting it
      // causes Date deserialisation bugs and stale data.
      // isSyncing is volatile and must never be persisted.
      partialize: state => ({
        activeTabId: state.activeTabId,
        selectedTabId: state.selectedTabId,
        offlineQueue: state.offlineQueue,
      }),
      version: 2,
      // Phase 15 Plan 04: legacy offlineQueue entries (pre-Phase-15) lack
      // expectedVersion and may carry action types outside the locked enum
      // (e.g. 'close-tab'). Default version to 0 and drop unknown types.
      migrate: (persisted, _persistedVersion) => {
        if (persisted == null || typeof persisted !== 'object') return persisted;
        const p = persisted as { offlineQueue?: unknown };
        if (!Array.isArray(p.offlineQueue)) return persisted;
        const validTypes = new Set<string>(OfflineActionTypeSchema.options);
        const upgraded: OfflineAction[] = [];
        for (const raw of p.offlineQueue) {
          if (raw == null || typeof raw !== 'object') continue;
          const entry = raw as Partial<OfflineAction> & { type?: unknown };
          if (typeof entry.type !== 'string' || !validTypes.has(entry.type)) {
            logger.warn('offline_queue.legacy_entry_dropped_unknown_type', { type: entry.type });
            continue;
          }
          if (typeof entry.expectedVersion !== 'number') {
            logger.warn('offline_queue.legacy_entry', {
              type: entry.type,
              id: entry.id,
            });
            upgraded.push({
              id: typeof entry.id === 'string' ? entry.id : crypto.randomUUID(),
              type: entry.type,
              payload: entry.payload,
              expectedVersion: 0,
              timestamp: typeof entry.timestamp === 'number' ? entry.timestamp : Date.now(),
              retryCount: typeof entry.retryCount === 'number' ? entry.retryCount : 0,
            });
            continue;
          }
          upgraded.push(entry as OfflineAction);
        }
        return { ...p, offlineQueue: upgraded };
      },
    }
  )
);

/** Returns a tab by ID, or undefined if not in store. */
export const selectTabById = (id: string): Tab | undefined =>
  useTabStore.getState().tabs.find(t => t.id === id);

