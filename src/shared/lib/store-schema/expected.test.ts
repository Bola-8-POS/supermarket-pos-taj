import { copyFileSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { computeExpectedSchema } from '../../../../scripts/store-expected-schema';
import { getExpectedSchema } from './expected';

describe('computeExpectedSchema', () => {
  it('computes_max_and_count_from_a_temp_dir', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'schema-'));
    try {
      for (const n of ['20260101000001_a.sql', '20260301000002_b.sql', '20260201000003_c.sql']) {
        writeFileSync(path.join(dir, n), '-- x');
      }
      expect(computeExpectedSchema(dir)).toEqual({ maxVersion: '20260301000002', applied: 3 });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('ignores_files_without_a_14_digit_prefix', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'schema-'));
    try {
      for (const n of ['20260101000001_a.sql', 'README.md', '2026_short.sql', 'notes.sql', '20260101000002_b.txt']) {
        writeFileSync(path.join(dir, n), '-- x');
      }
      expect(computeExpectedSchema(dir)).toEqual({ maxVersion: '20260101000001', applied: 1 });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('bundled_level_matches_the_migrations_folder', () => {
    const dir = path.resolve(__dirname, '../../../../supabase/migrations');
    const sqlCount = readdirSync(dir).filter((f) => f.endsWith('.sql')).length;
    const level = computeExpectedSchema(dir);
    expect(level.applied).toBe(sqlCount);
    expect(level.maxVersion).toMatch(/^\d{14}$/);
  });
});

describe('pack manifest agreement', () => {
  it('client_level_equals_the_pack_manifest_rule', async () => {
    // @ts-expect-error -- plain .mjs build script without type declarations
    const { buildManifest } = (await import('../../../../store-server/pack/build/lib/manifest.mjs')) as {
      buildManifest: (o: Record<string, unknown>) => Promise<{ migrations: { count: number; max: string } }>;
    };
    const root = mkdtempSync(path.join(tmpdir(), 'pack-'));
    try {
      mkdirSync(path.join(root, 'migrations'));
      for (const n of [
        '20260101000001_a.sql',
        '20260301000002_b.sql',
        '20260201000003_c.sql',
        '20260401000004.sql', // no underscore: neither side counts it
        '2026_short.sql',
        '20260501000005_x.txt',
        'README.md',
      ]) {
        writeFileSync(path.join(root, 'migrations', n), '-- x');
      }
      const manifest = await buildManifest({
        root,
        packVersion: '1.0.0-r1',
        appVersion: '1.0.0',
        builtAt: 'x',
        repoCommit: 'x',
        components: {},
        denoLockSha256: 'x',
      });
      const client = computeExpectedSchema(path.join(root, 'migrations'));
      expect({ count: client.applied, max: client.maxVersion }).toEqual(manifest.migrations);
      expect(client.applied).toBe(3);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('R1_tip_built_manifest_equals_client_expected_level', async () => {
    // @ts-expect-error -- plain .mjs build script without type declarations
    const { buildManifest } = (await import('../../../../store-server/pack/build/lib/manifest.mjs')) as {
      buildManifest: (o: Record<string, unknown>) => Promise<{ migrations: { count: number; max: string } }>;
    };
    const real = path.resolve(__dirname, '../../../../supabase/migrations');
    const sqlFiles = readdirSync(real).filter((f) => f.endsWith('.sql'));
    const root = mkdtempSync(path.join(tmpdir(), 'pack-real-'));
    try {
      mkdirSync(path.join(root, 'migrations'));
      for (const f of sqlFiles) copyFileSync(path.join(real, f), path.join(root, 'migrations', f));
      const manifest = await buildManifest({
        root,
        packVersion: '1.0.0-r1',
        appVersion: '1.0.0',
        builtAt: 'x',
        repoCommit: 'x',
        components: {},
        denoLockSha256: 'x',
      });
      const client = computeExpectedSchema(real);
      // The pack built from this commit's real migrations folder, by the pack's own code path.
      expect(manifest.migrations).toEqual({ count: client.applied, max: client.maxVersion });
      expect(manifest.migrations.count).toBe(sqlFiles.length);
      expect(sqlFiles.length).toBeGreaterThan(0);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

});

describe('getExpectedSchema', () => {
  it('has_the_bundled_level_in_the_unit_environment', () => {
    const level = getExpectedSchema();
    expect(level.maxVersion).toMatch(/^\d{14}$/);
    expect(level.applied).toBeGreaterThan(0);
  });
});
