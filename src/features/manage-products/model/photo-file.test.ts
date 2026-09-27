import { describe, expect, it } from 'vitest';
import {
  ACCEPTED_PHOTO_MIME_TYPES,
  MAX_UPLOAD_BYTES,
  firstImageFromClipboard,
  firstImageFromDataTransfer,
  photoObjectPath,
  resizePhoto,
  targetDimensions,
  validatePhotoFile,
  type DataTransferItemLike,
} from './photo-file';

function makeFile(type: string, size: number): File {
  const blob = new Blob([new Uint8Array(size)], { type });
  return new File([blob], 'photo', { type });
}

function makeItem(kind: string, type: string, file: File | null): DataTransferItemLike {
  return { kind, type, getAsFile: () => file };
}

describe('validatePhotoFile', () => {
  it('accepts an image/jpeg file of size 1024', () => {
    const result = validatePhotoFile(makeFile('image/jpeg', 1024));
    expect(result.ok).toBe(true);
  });

  it('rejects image/heic with VALIDATION_ERROR carrying the offending type', () => {
    const result = validatePhotoFile(makeFile('image/heic', 1024));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('VALIDATION_ERROR');
      expect(result.error.detail).toBe('image/heic');
    }
  });

  it('rejects an unsupported type with an empty File.type using the unknownType sentinel, not an empty string', () => {
    const result = validatePhotoFile(makeFile('', 1024));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.detail).toBe('unknownType');
      expect(result.error.detail).not.toBe('');
    }
  });

  it('accepts image/png at exactly 10 MB', () => {
    const result = validatePhotoFile(makeFile('image/png', MAX_UPLOAD_BYTES));
    expect(result.ok).toBe(true);
  });

  it('rejects image/png at 10 MB + 1 byte with a size string formatted to one decimal place', () => {
    const result = validatePhotoFile(makeFile('image/png', MAX_UPLOAD_BYTES + 1));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('PHOTO_TOO_LARGE');
      expect(result.error.detail).toMatch(/^\d+\.\d$/);
    }
  });

  it('is stateless — calling it twice on the same File returns the same verdict', () => {
    const file = makeFile('image/heic', 1024);
    const first = validatePhotoFile(file);
    const second = validatePhotoFile(file);
    expect(first).toEqual(second);
  });

  it('renders the megabyte figure for a 12,582,912-byte file as 12.0, not 12 or 12.00', () => {
    const result = validatePhotoFile(makeFile('image/png', 12_582_912));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.detail).toBe('12.0');
    }
  });
});

describe('targetDimensions', () => {
  it('does not scale at the 1200px threshold', () => {
    expect(targetDimensions({ width: 1200, height: 600 })).toEqual({ width: 1200, height: 600 });
  });

  it('scales a 1201px-wide landscape image to a longest edge of 1200 with an integer short edge', () => {
    const result = targetDimensions({ width: 1201, height: 600 });
    expect(result.width).toBe(1200);
    expect(Number.isInteger(result.height)).toBe(true);
  });

  it('scales a portrait image on its height', () => {
    expect(targetDimensions({ width: 600, height: 2400 })).toEqual({ width: 300, height: 1200 });
  });
});

describe('photoObjectPath', () => {
  it('matches products/<productId>/<uuid>.<ext>', () => {
    const path = photoObjectPath('11111111-1111-1111-1111-111111111111', 'webp');
    expect(path).toMatch(
      /^products\/11111111-1111-1111-1111-111111111111\/[0-9a-f-]{36}\.webp$/
    );
  });

  it('returns different paths on two consecutive calls', () => {
    const a = photoObjectPath('11111111-1111-1111-1111-111111111111', 'webp');
    const b = photoObjectPath('11111111-1111-1111-1111-111111111111', 'webp');
    expect(a).not.toBe(b);
  });
});

describe('ACCEPTED_PHOTO_MIME_TYPES', () => {
  it('contains exactly jpeg, png, webp', () => {
    expect([...ACCEPTED_PHOTO_MIME_TYPES].sort()).toEqual(
      ['image/jpeg', 'image/png', 'image/webp'].sort()
    );
  });
});

describe('resizePhoto', () => {
  it('a file whose declared type is accepted but whose bytes cannot be decoded resolves to an err carrying the declared type, and never rejects as an unhandled promise (Pitfall 5)', async () => {
    const file = makeFile('image/png', 1024); // garbage bytes — not a real PNG
    const result = await resizePhoto(file);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('PHOTO_DECODE_FAILED');
      expect(result.error.detail).toBe('image/png');
    }
  });
});

describe('firstImageFromDataTransfer', () => {
  it('returns the accepted image entry, skipping a leading plain-text item', () => {
    const imageFile = makeFile('image/png', 10);
    const items = [makeItem('string', 'text/plain', null), makeItem('file', 'image/png', imageFile)];
    expect(firstImageFromDataTransfer(items)).toBe(imageFile);
  });

  it('returns null when the list has no image entry at all', () => {
    const items = [makeItem('string', 'text/plain', null)];
    expect(firstImageFromDataTransfer(items)).toBeNull();
  });

  it('returns an unsupported image type entry rather than dropping it, so the caller can name the offending type', () => {
    const heicFile = makeFile('image/heic', 10);
    const items = [makeItem('file', 'image/heic', heicFile)];
    expect(firstImageFromDataTransfer(items)).toBe(heicFile);
  });
});

describe('firstImageFromClipboard', () => {
  it('returns the image file when the clipboard carries both text and an image', () => {
    const imageFile = makeFile('image/jpeg', 10);
    const clipboardData = {
      items: [makeItem('string', 'text/plain', null), makeItem('file', 'image/jpeg', imageFile)],
    };
    expect(firstImageFromClipboard(clipboardData)).toBe(imageFile);
  });

  it('returns null for a text-only clipboard payload', () => {
    const clipboardData = { items: [makeItem('string', 'text/plain', null)] };
    expect(firstImageFromClipboard(clipboardData)).toBeNull();
  });
});
