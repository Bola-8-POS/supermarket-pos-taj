/**
 * ECDSA P-256 public key (SPKI, base64) matching the license server's signing key.
 * Generated 2026-09-06 for the LOCAL license-server stack (license-server/LICENSE_PUBLIC_KEY_SPKI.txt).
 * Rotate before shipping against the production license server: regenerate the pair,
 * set LICENSE_SIGNING_KEY_PKCS8 as the edge-function secret, paste the new SPKI here
 * (or override at build time with VITE_LICENSE_PUBLIC_KEY).
 */
const EMBEDDED_PUBLIC_KEY_SPKI =
  'MFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAE+y6m+FI1kszoCCxAL9AMLhA60CKeuyHOZ/288vT1UnOPuR63wUY123y92RNZ4oQ+Yc4oIMuFrfq5Yd6FSG2Cfg==';

export const LICENSE_PUBLIC_KEY_SPKI: string =
  import.meta.env.VITE_LICENSE_PUBLIC_KEY?.trim() || EMBEDDED_PUBLIC_KEY_SPKI;
