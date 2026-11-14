// src/entities/audit-log/model/queries.ts
/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-assignment,
   @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access, i18next/no-literal-string */
// Pre-regen cast: audit_logs table added in Phase 14; supabase.types.ts extended manually.
// i18next/no-literal-string: query-key namespace strings + multi-line Supabase
// chain args (table names, column filters) below are wire-protocol identifiers,
// not UI copy — same category as the config's excluded 'from'/'select'/'eq'
// callees, but the plugin doesn't resolve callee names across a multi-line
// method chain (recurring quirk since 21-08).
import { useInfiniteQuery } from '@tanstack/react-query';

import { AuditLogSchema } from '@shared/lib/domain';
import type { AuditLog, AuditLogFilters } from '@shared/lib/domain';
import { supabase } from '@shared/lib/supabase';

const db = supabase as any;

const PAGE_SIZE = 50;

export const auditKeys = {
  all: ['audit-logs'] as const,
  list: (filters: AuditLogFilters) => [...auditKeys.all, 'list', filters] as const,
};

/**
 * Strips PostgREST `.or()` filter-string metacharacters (`,` `.` `(` `)`) from a
 * raw search term before it is interpolated into a `.or('col.ilike.%term%,...')`
 * expression. Without this, a user-entered comma/period/parenthesis can
 * restructure the filter's grouping (Phase 14 RESEARCH.md Security Domain V5).
 */
export function sanitizeSearch(raw: string): string {
  return raw.replace(/[,.()]/g, '');
}

function mapAuditRow(row: Record<string, unknown>): AuditLog {
  return AuditLogSchema.parse({
    id: row['id'],
    actorId: row['actor_id'] ?? null,
    action: row['action'],
    entityType: row['entity_type'],
    entityId: row['entity_id'] ?? null,
    before: row['before'] ?? null,
    after: row['after'] ?? null,
    terminalId: row['terminal_id'] ?? null,
    source: row['source'],
    createdAt: new Date(row['created_at'] as string),
  });
}

/**
 * Infinite query for audit logs with filters.
 * Page size: 50. Ordered by created_at DESC.
 */
export function useAuditLogs(filters: AuditLogFilters) {
  return useInfiniteQuery({
    queryKey: auditKeys.list(filters),
    initialPageParam: 0,
    queryFn: async ({ pageParam }): Promise<AuditLog[]> => {
      let query = db
        .from('audit_logs')
        .select('*')
        .order('created_at', { ascending: false })
        .range(pageParam, pageParam + PAGE_SIZE - 1);

      if (filters.action) {
        query = query.eq('action', filters.action);
      }
      if (filters.entityType) {
        query = query.eq('entity_type', filters.entityType);
      }
      if (filters.actorId) {
        query = query.eq('actor_id', filters.actorId);
      }
      if (filters.dateFrom) {
        query = query.gte('created_at', filters.dateFrom.toISOString());
      }
      if (filters.dateTo) {
        query = query.lte('created_at', filters.dateTo.toISOString());
      }
      const term = filters.search ? sanitizeSearch(filters.search) : '';
      if (term) {
        query = query.or(`entity_id::text.ilike.%${term}%,action.ilike.%${term}%`);
      }

      const { data, error } = await query;
      if (error) throw error as Error;
      return ((data ?? []) as Record<string, unknown>[]).map(mapAuditRow);
    },
    getNextPageParam: (lastPage: AuditLog[], allPages: AuditLog[][]) =>
      lastPage.length < PAGE_SIZE ? undefined : allPages.length * PAGE_SIZE,
  });
}
