import { Outlet, useLocation } from 'react-router-dom';
import { usePersistedBool } from '@shared/lib/usePersistedBool';
import { DemoBar } from './DemoBar';
import { Sidebar } from './Sidebar';

/**
 * Persistent application chrome for every authenticated route: a sidebar
 * rail on the left, the routed page filling the rest. The checkout screen
 * forces the compact rail so the product grid and cart get the full width.
 */
export function AppShell() {
  const location = useLocation();
  const [collapsedPref, setCollapsedPref] = usePersistedBool('sidebar-collapsed', false);
  // eslint-disable-next-line i18next/no-literal-string -- route path, not UI copy
  const forceRail = location.pathname.startsWith('/pos');
  const collapsed = forceRail || collapsedPref;

  return (
    <div className="flex h-dvh w-full overflow-hidden bg-background">
      <Sidebar
        collapsed={collapsed}
        toggleHidden={forceRail}
        onToggle={() => {
          setCollapsedPref(prev => !prev);
        }}
      />
      <main className="relative flex min-w-0 flex-1 flex-col overflow-hidden" id="main-content">
        <DemoBar />
        <Outlet />
      </main>
    </div>
  );
}
