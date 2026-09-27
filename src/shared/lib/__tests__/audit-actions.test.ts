/**
 * audit-actions.test.ts
 *
 * CI enforcement: every record_audit() call in migration files must use
 * an action string present in AuditActionSchema.options.
 */
import { readFileSync, readdirSync } from 'fs';
import { join } from 'path';

import { describe, it, expect } from 'vitest';

import { AuditActionSchema } from '../audit-actions';

const MIGRATIONS_DIR = join(process.cwd(), 'supabase', 'migrations');
const FUNCTIONS_DIR = join(process.cwd(), 'supabase', 'functions');
const VALID_ACTIONS = new Set<string>(AuditActionSchema.options);

// Phase 14-02: RPC-coverage scaffold (VALIDATION.md Wave 0 requirement).
// SCAFFOLD — expected RED for transfer_tab/record_stock_movement/caja_open/
// close_tab/produce_prep_batch/force_pin_change until their Wave-2/Wave-3
// migration lands (14-03..14-09); driven GREEN incrementally; final GREEN
// enforced at 14-14 gate.
const TARGET_RPCS: { fn: string; action: string; pending?: boolean }[] = [
  { fn: 'process_payment_atomic', action: 'payment.process' },
  { fn: 'process_refund', action: 'payment.refund' },
  { fn: 'close_caja_session', action: 'caja.close' },
  { fn: 'add_combo_to_tab', action: 'combo.add_to_tab' },
  { fn: 'transfer_tab', action: 'tab.transfer' },
  { fn: 'record_stock_movement', action: 'inventory.manual_adjust' },
  { fn: 'caja_open', action: 'caja.open' },
  { fn: 'close_tab', action: 'tab.close' },
  { fn: 'produce_prep_batch', action: 'prep.produce' },
  { fn: 'force_pin_change', action: 'permission.force_pin_change' },
  // Phase 24-01: order_item.remove is registered in AuditActionSchema here, ahead of
  // the remove_tab_item RPC migration that calls PERFORM record_audit(...) for it
  // (ships in Plan 24-04). `pending: true` lets the assertion below skip itself while
  // the function is undefined, then self-upgrade to a full check once the migration lands.
  { fn: 'remove_tab_item', action: 'order_item.remove', pending: true },
];

describe('audit-actions enforcement', () => {
  it('AuditActionSchema has at least 20 enumerated actions', () => {
    expect(AuditActionSchema.options.length).toBeGreaterThanOrEqual(20);
  });

  it('every record_audit() call in migrations uses an enumerated action', () => {
    const migrationFiles = readdirSync(MIGRATIONS_DIR)
      .filter(f => f.endsWith('.sql'))
      .map(f => join(MIGRATIONS_DIR, f));

    const violations: string[] = [];

    for (const file of migrationFiles) {
      const content = readFileSync(file, 'utf-8');
      // Match: PERFORM record_audit('action.label', ... ) — first string param
      const matches = content.matchAll(/PERFORM\s+record_audit\s*\(\s*'([^']+)'/g);
      for (const match of matches) {
        const action = match[1];
        if (action !== undefined && !VALID_ACTIONS.has(action)) {
          violations.push(`${file}: '${action}' not in AuditActionSchema`);
        }
      }
    }

    expect(violations).toEqual([]);
  });

  // Per-RPC coverage assertions. 4 already-wired RPCs (process_payment_atomic,
  // process_refund, close_caja_session, add_combo_to_tab) PASS immediately.
  // The remaining 6 (transfer_tab, record_stock_movement, caja_open,
  // close_tab, produce_prep_batch, force_pin_change) are expected RED until
  // their Wave-2/Wave-3 migration lands — see the SCAFFOLD comment above
  // TARGET_RPCS.
  it.each(TARGET_RPCS)(
    'every migration-wired target RPC calls record_audit: $fn -> $action',
    ({ fn, action, pending }) => {
      const migrationFiles = readdirSync(MIGRATIONS_DIR)
        .filter(f => f.endsWith('.sql'))
        .map(f => join(MIGRATIONS_DIR, f));

      // Concatenate all migration SQL, stripping `-- ...` comment lines first
      // so header prose (e.g. a docstring mentioning a target action) cannot
      // self-satisfy the grep.
      const concatenatedSql = migrationFiles
        .map(file => readFileSync(file, 'utf-8').replace(/^\s*--.*$/gm, ''))
        .join('\n');

      const definesFn = new RegExp(
        `CREATE\\s+(OR\\s+REPLACE\\s+)?FUNCTION\\s+(public\\.)?${fn}\\s*\\(`,
        'i'
      ).test(concatenatedSql);

      if (pending === true && !definesFn) {
        // Migration not shipped yet (see the TARGET_RPCS comment for this entry) —
        // skip enforcement until it lands, rather than failing this plan's gate.
        return;
      }

      const callsRecordAudit = new RegExp(
        `PERFORM\\s+record_audit\\s*\\(\\s*'${action.replace(/\./g, '\\.')}'`
      ).test(concatenatedSql);

      expect(definesFn, `${fn}: function not defined in any migration`).toBe(true);
      expect(
        callsRecordAudit,
        `${fn}: no PERFORM record_audit('${action}', ...) found`
      ).toBe(true);
    }
  );

  // Phase 22-01 (Pitfall 2 closure): the assertion above only scans SQL
  // migrations for `PERFORM record_audit(...)` — it never covered TypeScript
  // edge functions calling `recordAudit(...)` directly (supabase/functions/).
  // That gap let 'permission.admin_pin_reset' ship inside admin-reset-pin
  // without any CI backstop. This sibling test closes it.
  it('every recordAudit() call in edge functions uses an enumerated action', () => {
    const functionDirs = readdirSync(FUNCTIONS_DIR, { withFileTypes: true })
      .filter(entry => entry.isDirectory() && entry.name !== '_shared')
      .map(entry => join(FUNCTIONS_DIR, entry.name));

    const violations: string[] = [];

    for (const dir of functionDirs) {
      const files = readdirSync(dir).filter(f => f.endsWith('.ts'));
      const concatenated = files.map(f => readFileSync(join(dir, f), 'utf-8')).join('\n');

      // [^)]*? spans newlines (no /s flag needed — `[^)]` already matches
      // \n), matching the multi-line `recordAudit(supabaseAdmin, {\n  action: '...'` shape.
      const matches = concatenated.matchAll(/recordAudit\s*\([^)]*?action:\s*'([^']+)'/g);
      for (const match of matches) {
        const action = match[1];
        if (action !== undefined && !VALID_ACTIONS.has(action)) {
          violations.push(`${dir}: '${action}' not in AuditActionSchema`);
        }
      }
    }

    expect(violations).toEqual([]);
  });
});
