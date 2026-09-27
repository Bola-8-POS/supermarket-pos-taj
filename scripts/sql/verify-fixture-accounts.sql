-- Not an assertion: prints counts only, for a human to read.
-- Run on a customer project during onboarding and rollout so the owner can
-- decide whether any fixture or demo account exists there (see the wave 4b
-- rollout notes, item C6). Names and PINs are never selected.
-- Run: psql -h 127.0.0.1 -p 54322 -U postgres -d postgres < scripts/sql/verify-fixture-accounts.sql

-- Active profiles whose id matches one of supabase/seed.sql's four
-- (now-removed) fixture rows or src/shared/lib/license/demo-accounts.ts's
-- three DEMO_STAFF rows, or whose email ends in @barpos.dev (integration
-- test fixtures) or @test.local (setup-dev-users.ts accounts). Never
-- @barpos.local: that domain is every real staff member's address (see
-- create-staff), so it is not a fixture marker.
SELECT role, count(*) AS active_count
FROM public.profiles
WHERE is_active
  AND (
    id IN (
      '11111111-1111-1111-1111-111111111111',
      '22222222-2222-2222-2222-222222222222',
      '33333333-3333-3333-3333-333333333333',
      '44444444-4444-4444-4444-444444444444',
      '0d3f2a9c-0001-4d3e-8a11-000000000001',
      '0d3f2a9c-0002-4d3e-8a11-000000000002',
      '0d3f2a9c-0003-4d3e-8a11-000000000003'
    )
    OR email LIKE '%@barpos.dev'
    OR email LIKE '%@test.local'
  )
GROUP BY role
ORDER BY role;

-- Active profiles that have not yet changed their default PIN.
SELECT count(*) AS active_must_change_pin_false
FROM public.profiles
WHERE is_active
  AND must_change_pin = false;
