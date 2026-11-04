import { describe, expect, it } from 'vitest';

import enFeatMgmt from './locales/en-US/featMgmt.json';
import esFeatMgmt from './locales/es-MX/featMgmt.json';

type Catalog = { manageProducts: { productDialog: { photo: Record<string, string> } } };

describe('photo error copy (S2B: "Photo upload failed.. Try again.")', () => {
  for (const [name, catalog] of [
    ['en-US', enFeatMgmt],
    ['es-MX', esFeatMgmt],
  ] as const) {
    const photo = (catalog as unknown as Catalog).manageProducts.productDialog.photo;
    it(`${name}: upload and remove errors do not splice a sentence into another`, () => {
      // The AppError messages ('Photo upload failed.', "Couldn't remove the photo.") are whole
      // sentences ending in a full stop; interpolating them mid-sentence doubled the stop.
      expect(photo['errorUpload']).not.toContain('{{message}}');
      expect(photo['errorRemove']).not.toContain('{{message}}');
      expect(photo['errorUpload']).not.toMatch(/\.\./);
      expect(photo['errorRemove']).not.toMatch(/\.\./);
    });
  }
});
