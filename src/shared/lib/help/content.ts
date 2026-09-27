export type HelpEntry = {
  title: string;
  body: string;
};

const HELP_FALLBACK: HelpEntry = {
  title: 'Help',
  body: `# Help

Press **F1** at any time to see help for the current screen.

- Use the **Home** button to return to the dashboard.
- Press **Escape** to close this panel.`,
};

const HELP_BY_ROUTE: Record<string, HelpEntry> = {
  '/home': {
    title: 'Home — Help',
    body: `# Home dashboard

- Big-box navigation: tap any card to open that area.
- Top-right shows the current staff member and live clock.
- Use **Log out** to switch users; PIN login protects each role.`,
  },
  '/inventory': {
    title: 'Inventory — Help',
    body: `# Inventory

- Filter products by category.
- Scan a barcode to pre-select a product in the Batch Adjust dialog.
- Low-stock items are flagged; use **Adjust** to correct counts.`,
  },
  '/settings': {
    title: 'Settings — Help',
    body: `# Settings (admin only)

- **Hardware**: test the receipt printer, open the cash drawer, upload a logo.
- **Receipt**: set paper width and toggle which lines print.
- **Billing**: tax rate, first-hour billing mode.
- **Backup**: create and restore settings snapshots.`,
  },
  '/reports': {
    title: 'Reports — Help',
    body: `# Reports

- Pick a date range to view sales, payments, and caja summaries.
- Export to CSV from the top-right menu.`,
  },
  '/payments': {
    title: 'Payments — Help',
    body: `# Payments

- Lists every payment in the selected caja session.
- Click a row for payment detail, refund, or receipt reprint.`,
  },
  '/staff': {
    title: 'Staff — Help',
    body: `# Staff

- Clock-in and clock-out records are shown per shift.
- Admin can reset PINs and change roles.`,
  },
  '/login': {
    title: 'Login — Help',
    body: `# Login

- Choose your name, then enter your 6-digit PIN.
- Press **Enter** after the last digit to sign in.`,
  },
};

export function getHelpForRoute(pathname: string): HelpEntry {
  // Exact match first
  if (HELP_BY_ROUTE[pathname]) return HELP_BY_ROUTE[pathname];
  // Try top-level prefix (e.g. /pool-tables/:tableId → /pool-tables)
  const top = '/' + (pathname.split('/')[1] ?? '');
  if (HELP_BY_ROUTE[top]) return HELP_BY_ROUTE[top];
  return HELP_FALLBACK;
}
