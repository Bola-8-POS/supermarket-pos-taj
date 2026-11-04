// Pure allow-list gate for send-receipt-email. verifyCaller only checks
// is_active, so the role itself must be checked here (fail closed).
const RECEIPT_EMAIL_ROLES = ['cashier', 'manager', 'admin']

export function canEmailReceipt(role: unknown): boolean {
  return typeof role === 'string' && RECEIPT_EMAIL_ROLES.includes(role)
}
