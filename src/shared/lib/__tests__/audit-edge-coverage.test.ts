/**
 * audit-edge-coverage.test.ts
 *
 * SC4 enforcement: an explicit allowlist of sensitive-mutation Edge Functions
 * (functions that mutate the DB directly and are NOT already covered by an
 * audited RPC) must each import the shared audit helper and call recordAudit.
 *
 * D-09: confirmed sensitive, uncovered mutators are create-staff (14-08)
 * and settings-restore (14-08). process-payment delegates to the
 * already-audited process_payment_atomic RPC and is intentionally excluded
 * from this allowlist. void-order was removed from this allowlist in
 * Phase 5 (SALE-01) when the void-order edge function was deleted.
 */
import { existsSync, readFileSync } from 'fs';
import { join } from 'path';

import { describe, it, expect } from 'vitest';

const FUNCTIONS_DIR = join(process.cwd(), 'supabase', 'functions');

// Explicit allowlist of sensitive-mutation Edge Functions per D-09.
const SENSITIVE_EDGE_FUNCTIONS = ['create-staff', 'settings-restore'];

function readIndexSource(fnName: string): string {
  const indexPath = join(FUNCTIONS_DIR, fnName, 'index.ts');
  const raw = readFileSync(indexPath, 'utf-8');
  // Strip comment lines so header prose cannot self-satisfy the assertion.
  return raw.replace(/^\s*\/\/.*$/gm, '');
}

describe('audit edge-function coverage enforcement (SC4)', () => {
  it('SENSITIVE_EDGE_FUNCTIONS allowlist is non-empty and every named directory exists', () => {
    expect(SENSITIVE_EDGE_FUNCTIONS.length).toBeGreaterThan(0);

    for (const fnName of SENSITIVE_EDGE_FUNCTIONS) {
      const indexPath = join(FUNCTIONS_DIR, fnName, 'index.ts');
      expect(existsSync(indexPath), `${fnName}: supabase/functions/${fnName}/index.ts not found`).toBe(
        true
      );
    }
  });

  it.each(SENSITIVE_EDGE_FUNCTIONS)(
    'sensitive edge function imports and calls recordAudit: %s',
    fnName => {
      const source = readIndexSource(fnName);

      const importsAuditHelper = source.includes("from '../_shared/audit.ts'");
      const callsRecordAudit = source.includes('recordAudit(');

      expect(
        importsAuditHelper,
        `${fnName}: missing import from '../_shared/audit.ts'`
      ).toBe(true);
      expect(callsRecordAudit, `${fnName}: no recordAudit( call found`).toBe(true);
    }
  );
});
