import { ImageOff } from 'lucide-react';
import type { ReactNode } from 'react';
import { useEffect, useState } from 'react';
import { cn } from '@shared/lib/utils';
import { Skeleton } from '@shared/ui/skeleton';
import { useSettings } from '../model/queries';
import { useStoreLogoUrl } from '../model/store-logo-file';

type Props = {
  className?: string;
  alt?: string;
  fallback?: ReactNode;
};

/**
 * Renders the admin-uploaded store logo on the (pre-auth) login hero and
 * anywhere else it's needed — a sibling concept to `widgets/LogoImage`, not
 * an edit of it. `LogoImage` stays hardcoded to the receipt-only base64 data
 * URL field; this component owns the separate `general.storeLogoPath`
 * Storage-backed source (Phase 33, D-01/D-09).
 *
 * Widget-owns-its-data, like `LogoImage`: calls `useSettings()` itself
 * rather than making callers prop-drill. Returns `fallback` when no path is
 * stored; on the resolved image failing to load, renders a centered
 * `ImageOff` instead of `fallback` so a broken object is visibly distinct
 * from "no logo configured" (T-33-11).
 */
export function StoreLogoImage({ className, alt = 'Logo', fallback = null }: Props) {
  const { data } = useSettings();
  const storeLogoPath = data?.general.storeLogoPath ?? null;
  const { url, isLoading } = useStoreLogoUrl(storeLogoPath);
  const [imgFailed, setImgFailed] = useState(false);

  // CR-02: a single failed <img> load must not permanently gate every future
  // render for the rest of this mount -- reset the flag whenever a new
  // signed URL (TTL refresh, retry, or a brand-new logo) resolves.
  useEffect(() => {
    // Resetting a failure flag when the resolved source changes, not
    // deriving state from props; same accepted pattern as
    // GeneralSettingsTab.tsx's own imgFailed resets.
    /* eslint-disable react-hooks/set-state-in-effect */
    setImgFailed(false);
    /* eslint-enable react-hooks/set-state-in-effect */
  }, [url]);

  if (!storeLogoPath) return <>{fallback}</>;

  if (imgFailed) {
    return <ImageOff className={cn('size-8 text-muted-foreground', className)} aria-hidden="true" />;
  }

  // Option B (33-02-SUMMARY.md): storeLogoPath is set but the signed URL is
  // still resolving — never fall back to the caller's `fallback` once a real
  // logo is known to exist (33-UI-SPEC.md §1 loading state). Fills whatever
  // fixed-size tile the caller already rendered around this component
  // (mirrors ProductPhotoTab's `Skeleton className="size-full rounded-xl"`).
  if (isLoading || !url) {
    return <Skeleton className={cn('size-full', className)} />;
  }

  return (
    <img
      data-testid="login-store-logo"
      src={url}
      alt={alt}
      className={cn('max-h-full max-w-full object-contain', className)}
      onError={() => {
        setImgFailed(true);
      }}
    />
  );
}
