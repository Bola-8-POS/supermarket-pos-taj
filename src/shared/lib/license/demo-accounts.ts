/**
 * Shared demo staff — the ONLY place their names/PINs are defined. `scripts/seed-demo.ts`
 * creates them and `pages/login/DemoLoginHint` displays them. Plain-Node-importable: no
 * React, no Vite env, no path aliases.
 */
// Pins are 6 digits (repeated-digit, easy to read aloud) to satisfy the DB's
// `pin_length` CHECK constraint (LENGTH(pin) = 6, supabase/migrations/20260414000002)
// and domain.ts's PinSchema (`/^\d{6}$/`) — every other profile in this app has a
// 6-digit PIN, and a 4-digit demo PIN fails `ensureStaffAccount`'s profile insert.
//
// Fixed UUIDs: the online demo's DB is wiped and reseeded nightly (reset-demo.yml). Without
// a stable id every reset would mint new profile ids, and a browser tab opened across the
// reset keeps offering the old ids from its in-memory staff list — its next clock-in then
// fails the shifts.staff_id foreign key ("Invalid reference to related record"). GoTrue's
// admin create-user endpoint honours a caller-supplied id, so the seed pins these.
export const DEMO_STAFF = [
  { id: '0d3f2a9c-0001-4d3e-8a11-000000000001', name: 'Ana Admin', role: 'admin', pin: '000000' },
  { id: '0d3f2a9c-0002-4d3e-8a11-000000000002', name: 'Luis Gerente', role: 'manager', pin: '111111' },
  { id: '0d3f2a9c-0003-4d3e-8a11-000000000003', name: 'Sofía Cajera', role: 'cashier', pin: '222222' },
] as const satisfies readonly {
  id: string;
  name: string;
  role: 'admin' | 'manager' | 'cashier';
  pin: string;
}[];