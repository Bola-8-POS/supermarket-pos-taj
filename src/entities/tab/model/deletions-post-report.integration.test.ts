// vi.unmock MUST be the very first statement — overrides the global Supabase mock in test-setup.ts
vi.unmock('@shared/lib/supabase');

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { renderHook, waitFor } from '@testing-library/react';
import { createElement, type ReactNode } from 'react';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { supabase } from '@shared/lib/supabase';
import { testDb } from '@shared/lib/supabase-test-client';
import { useDeletionsPostReport } from './queries-reports';

// Jamie Chen (manager) — consistent with other integration tests in this suite
const STAFF_ID = 'cb969ea6-7443-4c03-ac99-bbe8aba0bb8e';

// Deterministic test IDs — prefix IT-DELPOST to avoid collisions with other
// tests. get_deletions_post_report reads audit_logs directly (entity_id is
// returned as-is, no join to a real tabs row) so IT_TAB_ID only needs to
// exist inside this test's own audit_logs rows.
const IT_LOG_IN_RANGE = 'db010000-db01-4db0-8db0-db0100000001';
const IT_LOG_OUT_RANGE = 'db020000-db02-4db0-8db0-db0200000002';
const IT_TAB_ID = 'db030000-db03-4db0-8db0-db0300000003';

// Far-future date range so dev-environment data never contaminates these tests
// (same pattern as category-revenue-report.integration.test.ts).
const RANGE_FROM = new Date('2035-08-01T00:00:00.000Z');
const RANGE_TO = new Date('2035-08-31T23:59:59.000Z');

function makeWrapper(qc: QueryClient) {
  return function Wrapper({ children }: { children: ReactNode }) {
    return createElement(QueryClientProvider, { client: qc }, children);
  };
}

// ---------------------------------------------------------------------------
// Integration: useDeletionsPostReport — real Supabase
// Phase 24 Plan 06 Task 2 — SC-1
// ---------------------------------------------------------------------------

describe('useDeletionsPostReport — integration (real Supabase)', () => {
  beforeAll(async () => {
    await supabase.auth.signInWithPassword({ email: 'jamie@barpos.dev', password: '567890' });
  });

  afterAll(async () => {
    await supabase.auth.signOut();
  });

  beforeEach(async () => {
    // fieldsChanged is derived by diffing `before`'s top-level keys against
    // `after` (excluding updated_at/version/items, which always change and
    // are never a meaningful "field edit"). Only `notes` differs here, so
    // fieldsChanged must resolve to exactly ['notes'].
    const logsR = await testDb.from('audit_logs').upsert([
      {
        id: IT_LOG_IN_RANGE,
        action: 'tab.edit_paid',
        entity_type: 'tab',
        entity_id: IT_TAB_ID,
        actor_id: STAFF_ID,
        before: {
          notes: 'original notes',
          updated_at: '2025-01-01T00:00:00.000Z',
          version: 1,
          items: [{ id: 'x' }],
        },
        after: {
          notes: 'corrected notes',
          updated_at: '2035-08-15T00:00:00.000Z',
          version: 2,
          items: [{ id: 'y' }],
          reason: 'Integration test: post-close correction',
        },
        created_at: '2035-08-15T12:00:00.000Z',
      },
      {
        id: IT_LOG_OUT_RANGE,
        action: 'tab.edit_paid',
        entity_type: 'tab',
        entity_id: IT_TAB_ID,
        actor_id: STAFF_ID,
        before: { notes: 'old' },
        after: { notes: 'new', reason: 'Out of range edit' },
        created_at: '2036-01-01T00:00:00.000Z',
      },
    ]);
    if (logsR.error) throw new Error(`beforeEach audit_logs: ${JSON.stringify(logsR.error)}`);
  });

  afterEach(async () => {
    await testDb.from('audit_logs').delete().in('id', [IT_LOG_IN_RANGE, IT_LOG_OUT_RANGE]);
  });

  // ---------------------------------------------------------------------------
  // AC-1: rows contain all required fields, fieldsChanged excludes noise keys
  // ---------------------------------------------------------------------------

  it('AC-1: in-range correction includes tabId, staffName, reason, editedAt, and the correct fieldsChanged', async () => {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const { result } = renderHook(() => useDeletionsPostReport(RANGE_FROM, RANGE_TO), {
      wrapper: makeWrapper(qc),
    });

    await waitFor(
      () => {
        expect(result.current.isSuccess).toBe(true);
      },
      { timeout: 10_000 }
    );

    expect(result.current.data?.ok).toBe(true);
    if (!result.current.data?.ok) return;

    const rows = result.current.data.data;
    const target = rows.find(r => r.tabId === IT_TAB_ID && r.reason === 'Integration test: post-close correction');

    expect(target).toBeDefined();
    expect(target?.staffName).toBe('Jamie Chen');
    expect(target?.editedAt).toBeInstanceOf(Date);
    expect(isNaN((target?.editedAt as Date).getTime())).toBe(false);
    // updated_at/version/items always change but must NOT appear — only
    // the genuinely edited scalar field (notes) should be reported.
    expect(target?.fieldsChanged).toEqual(['notes']);

    qc.clear();
  });

  // ---------------------------------------------------------------------------
  // AC-2: date-range filter excludes out-of-range corrections
  // ---------------------------------------------------------------------------

  it('AC-2: correction outside the queried range is excluded', async () => {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const { result } = renderHook(() => useDeletionsPostReport(RANGE_FROM, RANGE_TO), {
      wrapper: makeWrapper(qc),
    });

    await waitFor(
      () => {
        expect(result.current.isSuccess).toBe(true);
      },
      { timeout: 10_000 }
    );

    expect(result.current.data?.ok).toBe(true);
    if (!result.current.data?.ok) return;

    const outOfRange = result.current.data.data.find(r => r.reason === 'Out of range edit');
    expect(outOfRange).toBeUndefined();

    qc.clear();
  });
});
