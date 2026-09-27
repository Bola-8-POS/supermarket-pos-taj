/**
 * ensure-staff-account.ts
 *
 * Extracted from setup-dev-users.ts (unchanged behaviour) so scripts/seed-demo.ts can reuse the
 * same idempotent "create or repair a PIN-login staff account" logic without duplicating it.
 *
 * WARNING: Uses service role key — do NOT import this in the renderer.
 */

/* eslint-disable */

/** name -> deterministic @test.local email, matching the convention already used by other test fixtures in this DB. */
function emailForName(name: string): string {
  const slug = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return `${slug}@test.local`;
}

export async function ensureStaffAccount(
  db: any,
  role: 'admin' | 'manager' | 'cashier' | 'kitchen',
  name: string,
  pin: string,
  // Default 'en-US' keeps setup-dev-users.ts (E2E accounts assert on English UI text)
  // byte-identical in behaviour; scripts/seed-demo.ts passes 'es-MX' for DEMO_STAFF.
  locale: 'es-MX' | 'en-US' = 'en-US',
  // Optional fixed auth.users/profiles id (DEMO_STAFF) so a nightly db reset re-creates the
  // same ids instead of minting new ones (see src/shared/lib/license/demo-accounts.ts).
  fixedId?: string
): Promise<void> {
  const email = emailForName(name);

  const { data: existing, error: findErr } = await db
    .from('profiles')
    .select('id, is_active, deleted_at, must_change_pin, pin, role, email, locale')
    .eq('name', name)
    .maybeSingle();

  if (findErr) {
    console.error(`Failed to look up profile "${name}":`, findErr);
    process.exit(1);
  }

  if (existing) {
    const id = existing.id as string;

    // Re-sync the auth.users password to the current PIN and make sure the
    // account is confirmed/usable — cheap and idempotent, repairs drift from
    // a prior manual PIN change or a stale auth.users row.
    const { error: authUpdateErr } = await db.auth.admin.updateUserById(id, {
      password: pin,
      email_confirm: true,
    });
    if (authUpdateErr) {
      console.error(`Failed to sync auth password for "${name}":`, authUpdateErr);
      process.exit(1);
    }

    const needsRepair =
      existing.pin !== pin ||
      existing.role !== role ||
      existing.is_active !== true ||
      existing.deleted_at !== null ||
      existing.must_change_pin !== false ||
      existing.locale !== locale ||
      !existing.email;

    if (needsRepair) {
      const { error: updateErr } = await db
        .from('profiles')
        .update({
          pin,
          role,
          is_active: true,
          deleted_at: null,
          must_change_pin: false,
          // App default is es-MX (D-02), but E2E specs assert on English UI text
          // (e2e/helpers/auth.ts and most e2e/*.spec.ts selectors) — post-login,
          // i18n.changeLanguage(staff.locale) fires, so setup-dev-users.ts's test-only
          // accounts pin to en-US regardless of the app-wide default; seed-demo.ts's
          // DEMO_STAFF pass 'es-MX' to match the app's real default instead.
          locale,
          email: existing.email ?? email,
        })
        .eq('id', id);
      if (updateErr) {
        console.error(`Failed to repair profile "${name}":`, updateErr);
        process.exit(1);
      }
      console.log(`  repaired: ${name} (${role})`);
    } else {
      console.log(`  ok: ${name} (${role})`);
    }
    return;
  }

  // No profile yet — create the auth.users account first (profiles.id is a
  // foreign key to auth.users.id, not auto-generated), then the profile row.
  const { data: created, error: createErr } = await db.auth.admin.createUser({
    ...(fixedId ? { id: fixedId } : {}),
    email,
    password: pin,
    email_confirm: true,
  });
  if (createErr || !created?.user) {
    console.error(`Failed to create auth user for "${name}":`, createErr);
    process.exit(1);
  }

  const { error: insertErr } = await db.from('profiles').insert({
    id: created.user.id,
    name,
    pin,
    role,
    email,
    is_active: true,
    must_change_pin: false,
    // See the repair-path comment above.
    locale,
  });
  if (insertErr) {
    console.error(`Failed to insert profile "${name}":`, insertErr);
    process.exit(1);
  }
  console.log(`  created: ${name} (${role})`);
}
