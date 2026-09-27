import { describe, expect, it } from 'vitest';
import {
  type ReceiptData,
  AdminResetPinRequestSchema,
  AdminResetPinSuccessSchema,
  ChangeOwnPinRequestSchema,
  ChangeOwnPinSuccessSchema,
  SetStaffActiveRequestSchema,
  SetStaffActiveSuccessSchema,
  catchToAppError,
  mapAdminResetPinEdgeError,
  mapAgentProxyErrorBody,
  mapChangeOwnPinEdgeError,
  mapSetStaffActiveEdgeError,
  mapProcessPaymentEdgeError,
  mapProcessSplitPaymentEdgeError,
  mapStaffSignInEdgeError,
  AgentProxyRequestSchema,
  ProcessDirectSaleRequestSchema,
  ProcessPaymentEnvelopeSchema,
  ProcessPaymentRequestSchema,
  ProcessSplitPaymentRequestSchema,
  ReceiptDataSchema,
  ReceiveShipmentRequestSchema,
  ReceiveShipmentSuccessSchema,
  SendReceiptEmailRequestSchema,
} from './edge-function-contracts';
import i18n from './i18n';

const tabId = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';

function baseValidRequest() {
  return {
    tabId,
    amount: 10,
    method: 'cash' as const,
    idempotencyKey: 'payment_cash_abc',
    tenderedAmount: 20,
  };
}

function validReceiptData(overrides: Partial<ReceiptData> = {}): ReceiptData {
  return {
    receiptNumber: 'RCPT1234',
    tabId,
    customerName: 'Guest',
    cashierName: 'Staff',
    storeName: 'Test Bar',
    barAddress: 'Calle 1',
    items: [{ name: 'Beer', quantity: 1, unitPrice: 10, lineTotal: 10 }],
    subtotal: 10,
    total: 10,
    paymentMethod: 'cash',
    processedAt: new Date('2026-04-17T12:00:00.000Z'),
    squareReceiptUrl: null,
    tenderedAmount: 20,
    changeAmount: 10,
    ...overrides,
  };
}

// Keep the reference so TypeScript doesn't complain about unused import
void validReceiptData;

describe('ReceiptDataSchema — Sprint 2 discount fields', () => {
  it('accepts receipt with discountAmount: null', () => {
    const r = ReceiptDataSchema.safeParse({
      ...validReceiptData(),
      discountAmount: null,
    });
    expect(r.success).toBe(true);
  });

  it('accepts receipt without discount fields', () => {
    const r = ReceiptDataSchema.safeParse(validReceiptData());
    expect(r.success).toBe(true);
  });

  it('accepts persisted promotion snapshots on receipt items', () => {
    const r = ReceiptDataSchema.safeParse({
      ...validReceiptData(),
      items: [
        {
          name: 'Beer',
          quantity: 1,
          unitPrice: 8,
          lineTotal: 8,
          promotionId: 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb',
          discountRate: 20,
          discountAmount: 2,
        },
      ],
    });
    expect(r.success).toBe(true);
  });

  it('rejects a negative receipt-item promotion amount', () => {
    const r = ReceiptDataSchema.safeParse({
      ...validReceiptData(),
      items: [{ name: 'Beer', quantity: 1, unitPrice: 10, lineTotal: 10, discountAmount: -1 }],
    });
    expect(r.success).toBe(false);
  });
});

describe('AgentProxyRequestSchema', () => {
  it('accepts a minimal valid body with tools/system omitted', () => {
    const r = AgentProxyRequestSchema.safeParse({
      model: 'claude-sonnet-4-6',
      max_tokens: 1024,
      messages: [{ role: 'user', content: 'hi' }],
    });
    expect(r.success).toBe(true);
  });

  it('accepts the same shape plus tools and system', () => {
    const r = AgentProxyRequestSchema.safeParse({
      model: 'claude-sonnet-4-6',
      max_tokens: 1024,
      system: 'You are a helpful assistant.',
      tools: [{ name: 'get_menu', description: 'Get menu', input_schema: {} }],
      messages: [{ role: 'user', content: 'hi' }],
    });
    expect(r.success).toBe(true);
  });

  it('rejects a body missing messages', () => {
    const r = AgentProxyRequestSchema.safeParse({
      model: 'claude-sonnet-4-6',
      max_tokens: 1024,
    });
    expect(r.success).toBe(false);
  });

  it('rejects max_tokens: 0', () => {
    const r = AgentProxyRequestSchema.safeParse({
      model: 'claude-sonnet-4-6',
      max_tokens: 0,
      messages: [{ role: 'user', content: 'hi' }],
    });
    expect(r.success).toBe(false);
  });

  it('rejects a negative max_tokens', () => {
    const r = AgentProxyRequestSchema.safeParse({
      model: 'claude-sonnet-4-6',
      max_tokens: -1,
      messages: [{ role: 'user', content: 'hi' }],
    });
    expect(r.success).toBe(false);
  });
});

describe('ProcessPaymentRequestSchema', () => {
  it('accepts valid cash with tenderedAmount', () => {
    const r = ProcessPaymentRequestSchema.safeParse(baseValidRequest());
    expect(r.success).toBe(true);
  });

  it('accepts card without tenderedAmount', () => {
    const r = ProcessPaymentRequestSchema.safeParse({
      ...baseValidRequest(),
      method: 'card',
      tenderedAmount: undefined,
      referenceNumber: 'REF123',
    });
    expect(r.success).toBe(true);
  });

  it('accepts rappi with a reference number', () => {
    const r = ProcessPaymentRequestSchema.safeParse({
      ...baseValidRequest(),
      method: 'rappi',
      tenderedAmount: undefined,
      referenceNumber: 'R-99',
    });
    expect(r.success).toBe(true);
  });

  it('accepts uber_eats without a reference number', () => {
    const r = ProcessPaymentRequestSchema.safeParse({
      ...baseValidRequest(),
      method: 'uber_eats',
      tenderedAmount: undefined,
    });
    expect(r.success).toBe(true);
  });

  it('rejects bank_transfer (handled by its own flow, not process-payment)', () => {
    const r = ProcessPaymentRequestSchema.safeParse({
      ...baseValidRequest(),
      method: 'bank_transfer',
      tenderedAmount: undefined,
    });
    expect(r.success).toBe(false);
  });

  it('rejects cash without tenderedAmount', () => {
    const r = ProcessPaymentRequestSchema.safeParse({
      ...baseValidRequest(),
      tenderedAmount: undefined,
    });
    expect(r.success).toBe(false);
    if (!r.success) {
      expect(r.error.issues.some(i => i.path.includes('tenderedAmount'))).toBe(true);
    }
  });

  it('rejects non-cash with tenderedAmount', () => {
    const r = ProcessPaymentRequestSchema.safeParse({
      ...baseValidRequest(),
      method: 'card',
      tenderedAmount: 50,
    });
    expect(r.success).toBe(false);
  });

  it('rejects negative amount', () => {
    const r = ProcessPaymentRequestSchema.safeParse({
      ...baseValidRequest(),
      amount: -1,
    });
    expect(r.success).toBe(false);
  });

  it('rejects amount not multiple of 0.01', () => {
    const r = ProcessPaymentRequestSchema.safeParse({
      ...baseValidRequest(),
      amount: 10.001,
    });
    expect(r.success).toBe(false);
  });

  it('rejects empty idempotencyKey', () => {
    const r = ProcessPaymentRequestSchema.safeParse({
      ...baseValidRequest(),
      idempotencyKey: '',
    });
    expect(r.success).toBe(false);
  });

  it('rejects idempotencyKey over 255 chars', () => {
    const r = ProcessPaymentRequestSchema.safeParse({
      ...baseValidRequest(),
      idempotencyKey: 'x'.repeat(256),
    });
    expect(r.success).toBe(false);
  });

  it('rejects invalid tabId', () => {
    const r = ProcessPaymentRequestSchema.safeParse({
      ...baseValidRequest(),
      tabId: 'not-a-uuid',
    });
    expect(r.success).toBe(false);
  });

  it('rejects referenceNumber over 64 chars', () => {
    const r = ProcessPaymentRequestSchema.safeParse({
      ...baseValidRequest(),
      method: 'card',
      tenderedAmount: undefined,
      referenceNumber: 'r'.repeat(65),
    });
    expect(r.success).toBe(false);
  });

  // Sprint 2 — discount fields
  it('accepts valid request with discount fields', () => {
    const r = ProcessPaymentRequestSchema.safeParse({
      ...baseValidRequest(),
      discountScope: 'all',
      discountType: 'percent',
      discountValue: 10,
      discountAmount: 1.0,
    });
    expect(r.success).toBe(true);
  });

  it('accepts valid request without discount fields (all optional)', () => {
    const r = ProcessPaymentRequestSchema.safeParse(baseValidRequest());
    expect(r.success).toBe(true);
  });

  // Phase 15 gap-closure (D-02) — expectedVersion
  it('accepts request without expectedVersion (field is optional)', () => {
    const r = ProcessPaymentRequestSchema.safeParse(baseValidRequest());
    expect(r.success).toBe(true);
  });

  it('accepts expectedVersion: 0 and retains it in parsed output', () => {
    const r = ProcessPaymentRequestSchema.safeParse({
      ...baseValidRequest(),
      expectedVersion: 0,
    });
    expect(r.success).toBe(true);
    if (r.success) {
      expect(r.data.expectedVersion).toBe(0);
    }
  });

  it('accepts expectedVersion: 7 and retains it in parsed output', () => {
    const r = ProcessPaymentRequestSchema.safeParse({
      ...baseValidRequest(),
      expectedVersion: 7,
    });
    expect(r.success).toBe(true);
    if (r.success) {
      expect(r.data.expectedVersion).toBe(7);
    }
  });

  it('rejects negative expectedVersion', () => {
    const r = ProcessPaymentRequestSchema.safeParse({
      ...baseValidRequest(),
      expectedVersion: -1,
    });
    expect(r.success).toBe(false);
  });

  it('rejects non-integer expectedVersion', () => {
    const r = ProcessPaymentRequestSchema.safeParse({
      ...baseValidRequest(),
      expectedVersion: 1.5,
    });
    expect(r.success).toBe(false);
  });

  it('accepts an approverId uuid next to approvalId and rejects a non-uuid', () => {
    const ok = ProcessPaymentRequestSchema.safeParse({
      ...baseValidRequest(),
      managerOverride: true,
      approvalId: '5f1e2d3c-4b5a-4c6d-8e7f-9a0b1c2d3e4f',
      approverId: '3a7c9e21-5f2b-4d81-9c3a-6e408f17b2d5',
    });
    expect(ok.success).toBe(true);
    const bad = ProcessPaymentRequestSchema.safeParse({ ...baseValidRequest(), approverId: 'not-a-uuid' });
    expect(bad.success).toBe(false);
  });

  it('rejects a non-uuid approvalId', () => {
    const bad = ProcessPaymentRequestSchema.safeParse({ ...baseValidRequest(), approvalId: '000000' });
    expect(bad.success).toBe(false);
  });
});

describe('ProcessDirectSaleRequestSchema', () => {
  it('accepts an approverId uuid next to approvalId and rejects a non-uuid', () => {
    const baseDirectSaleRequest = {
      items: [{ productId: tabId, quantity: 1, unitPrice: 10 }],
      shiftId: tabId,
      cajaSessionId: tabId,
      idempotencyKey: 'direct_sale_abc',
      method: 'cash' as const,
      tenderedAmount: 20,
    };
    const ok = ProcessDirectSaleRequestSchema.safeParse({
      ...baseDirectSaleRequest,
      managerOverride: true,
      approvalId: '5f1e2d3c-4b5a-4c6d-8e7f-9a0b1c2d3e4f',
      approverId: '3a7c9e21-5f2b-4d81-9c3a-6e408f17b2d5',
    });
    expect(ok.success).toBe(true);
    const bad = ProcessDirectSaleRequestSchema.safeParse({
      ...baseDirectSaleRequest,
      approverId: 'not-a-uuid',
    });
    expect(bad.success).toBe(false);
  });
});

describe('ProcessSplitPaymentRequestSchema', () => {
  it('accepts an approverId uuid next to approvalId and rejects a non-uuid', () => {
    const baseSplitPaymentRequest = {
      tabId,
      legs: [{ method: 'cash' as const, amount: 10, tenderedAmount: 10 }],
      expectedTotal: 10,
      idempotencyKey: 'split_abc',
    };
    const ok = ProcessSplitPaymentRequestSchema.safeParse({
      ...baseSplitPaymentRequest,
      managerOverride: true,
      approvalId: '5f1e2d3c-4b5a-4c6d-8e7f-9a0b1c2d3e4f',
      approverId: '3a7c9e21-5f2b-4d81-9c3a-6e408f17b2d5',
    });
    expect(ok.success).toBe(true);
    const bad = ProcessSplitPaymentRequestSchema.safeParse({
      ...baseSplitPaymentRequest,
      approverId: 'not-a-uuid',
    });
    expect(bad.success).toBe(false);
  });
});

describe('ReceiveShipmentRequestSchema / ReceiveShipmentSuccessSchema', () => {
  const baseReceiveShipmentRequest = {
    supplierId: '5f1e2d3c-4b5a-4c6d-8e7f-9a0b1c2d3e4f',
    items: [{ productId: '3a7c9e21-5f2b-4d81-9c3a-6e408f17b2d5', quantity: 1, costPrice: 10 }],
  };

  it('accepts an idempotencyKey uuid and rejects a non-uuid', () => {
    const ok = ReceiveShipmentRequestSchema.safeParse({
      ...baseReceiveShipmentRequest,
      idempotencyKey: '11111111-1111-4111-8111-111111111111',
    });
    expect(ok.success).toBe(true);
    const bad = ReceiveShipmentRequestSchema.safeParse({
      ...baseReceiveShipmentRequest,
      idempotencyKey: 'not-a-uuid',
    });
    expect(bad.success).toBe(false);
  });

  it('accepts a request with no idempotencyKey (older callers stay valid)', () => {
    expect(ReceiveShipmentRequestSchema.safeParse(baseReceiveShipmentRequest).success).toBe(true);
  });

  it('accepts idempotent: true and omitted on the success schema, rejects a non-boolean', () => {
    const shipmentId = '5f1e2d3c-4b5a-4c6d-8e7f-9a0b1c2d3e4f';
    expect(
      ReceiveShipmentSuccessSchema.safeParse({ shipmentId, idempotent: true }).success
    ).toBe(true);
    expect(ReceiveShipmentSuccessSchema.safeParse({ shipmentId }).success).toBe(true);
    expect(
      ReceiveShipmentSuccessSchema.safeParse({ shipmentId, idempotent: 'yes' }).success
    ).toBe(false);
  });
});

// TODO: Move callProcessPayment invocation tests to e2e/05-payments.spec.ts
// These require the Deno Edge Runtime (npx supabase functions serve) to be running.
describe.skip('callProcessPayment — requires edge runtime', () => {
  it.todo('move to e2e/05-payments.spec.ts');
});

describe('SendReceiptEmailRequestSchema', () => {
  it('accepts valid email and plain text', () => {
    const r = SendReceiptEmailRequestSchema.safeParse({
      email: '  a@b.co  ',
      receiptPlainText: 'Receipt\nLine',
    });
    expect(r.success).toBe(true);
    if (r.success) {
      expect(r.data.email).toBe('a@b.co');
    }
  });

  it('rejects invalid email', () => {
    const r = SendReceiptEmailRequestSchema.safeParse({
      email: 'not-email',
      receiptPlainText: 'x',
    });
    expect(r.success).toBe(false);
  });

  it('rejects empty receiptPlainText', () => {
    const r = SendReceiptEmailRequestSchema.safeParse({
      email: 'a@b.co',
      receiptPlainText: '',
    });
    expect(r.success).toBe(false);
  });

  it('rejects receiptPlainText over 50_000 chars', () => {
    const r = SendReceiptEmailRequestSchema.safeParse({
      email: 'a@b.co',
      receiptPlainText: 'x'.repeat(50_001),
    });
    expect(r.success).toBe(false);
  });
});

// TODO: Move callSendReceiptEmail invocation tests to e2e/08-settings-receipt.spec.ts
// These require the Deno Edge Runtime (npx supabase functions serve) to be running.
describe.skip('callSendReceiptEmail — requires edge runtime', () => {
  it.todo('move to e2e/08-settings-receipt.spec.ts');
});

describe('AdminResetPinRequestSchema / AdminResetPinSuccessSchema / mapAdminResetPinEdgeError', () => {
  const validUuid = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';

  it('accepts a valid targetStaffId + 6-digit newPin', () => {
    const r = AdminResetPinRequestSchema.safeParse({ targetStaffId: validUuid, newPin: '123456' });
    expect(r.success).toBe(true);
  });

  it('rejects a non-uuid targetStaffId', () => {
    const r = AdminResetPinRequestSchema.safeParse({
      targetStaffId: 'not-a-uuid',
      newPin: '123456',
    });
    expect(r.success).toBe(false);
  });

  it('rejects a non-6-digit newPin', () => {
    const r = AdminResetPinRequestSchema.safeParse({ targetStaffId: validUuid, newPin: '12345' });
    expect(r.success).toBe(false);
  });

  it('accepts a valid id + name success payload', () => {
    const r = AdminResetPinSuccessSchema.safeParse({ id: validUuid, name: 'Alex' });
    expect(r.success).toBe(true);
  });

  it('maps 401 to AUTH_REQUIRED', () => {
    expect(mapAdminResetPinEdgeError(401, 'Missing bearer token').code).toBe('AUTH_REQUIRED');
  });

  it('maps 403 to AUTH_FORBIDDEN', () => {
    expect(mapAdminResetPinEdgeError(403, 'Insufficient role').code).toBe('AUTH_FORBIDDEN');
  });

  it('maps 404 to NOT_FOUND', () => {
    expect(mapAdminResetPinEdgeError(404, 'Staff member not found').code).toBe('NOT_FOUND');
  });

  it('maps a PARTIAL_FAILURE-prefixed message to PIN_RESET_PARTIAL_FAILURE regardless of status', () => {
    expect(
      mapAdminResetPinEdgeError(
        500,
        'PARTIAL_FAILURE: credential changed but staff record failed to sync'
      ).code
    ).toBe('PIN_RESET_PARTIAL_FAILURE');
  });

  it('maps a plain 500 (not PARTIAL_FAILURE-prefixed) to SUPABASE_ERROR — proves the prefix match is not a blanket 500 catch', () => {
    expect(mapAdminResetPinEdgeError(500, 'some other db error').code).toBe('SUPABASE_ERROR');
  });

  it('maps a 409 CREDENTIAL_WRITE_FAILED (compensated, nothing changed) to the generic SUPABASE_ERROR', () => {
    expect(
      mapAdminResetPinEdgeError(409, 'CREDENTIAL_WRITE_FAILED: nothing changed, try again').code
    ).toBe('SUPABASE_ERROR');
  });
});

describe('SetStaffActiveRequestSchema / SetStaffActiveSuccessSchema / mapSetStaffActiveEdgeError', () => {
  const validUuid = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';

  it('accepts staffId + active, with and without terminalId', () => {
    expect(
      SetStaffActiveRequestSchema.safeParse({ staffId: validUuid, active: false }).success
    ).toBe(true);
    expect(
      SetStaffActiveRequestSchema.safeParse({
        staffId: validUuid,
        active: true,
        terminalId: 'POS-1',
      }).success
    ).toBe(true);
  });

  it('rejects a non-uuid staffId and a non-boolean active', () => {
    expect(SetStaffActiveRequestSchema.safeParse({ staffId: 'nope', active: false }).success).toBe(
      false
    );
    expect(
      SetStaffActiveRequestSchema.safeParse({ staffId: validUuid, active: 'no' }).success
    ).toBe(false);
  });

  it('accepts the { ok: true, changed } success body and rejects ok: false', () => {
    expect(SetStaffActiveSuccessSchema.safeParse({ ok: true, changed: true }).success).toBe(true);
    expect(SetStaffActiveSuccessSchema.safeParse({ ok: false, changed: false }).success).toBe(
      false
    );
  });

  it('maps LAST_ADMIN, SELF and NOT_FOUND refusals', () => {
    expect(mapSetStaffActiveEdgeError(409, 'LAST_ADMIN').code).toBe('STAFF_LAST_ADMIN');
    expect(mapSetStaffActiveEdgeError(400, 'SELF').code).toBe('STAFF_SELF');
    expect(mapSetStaffActiveEdgeError(404, 'NOT_FOUND').code).toBe('NOT_FOUND');
  });

  it('maps a PARTIAL_FAILURE-prefixed message to STAFF_DEACTIVATE_PARTIAL_FAILURE', () => {
    expect(
      mapSetStaffActiveEdgeError(
        500,
        'PARTIAL_FAILURE: staff record updated but sign-in state failed to sync, retry'
      ).code
    ).toBe('STAFF_DEACTIVATE_PARTIAL_FAILURE');
  });

  it('maps 401/403 to the auth codes and anything else to SUPABASE_ERROR', () => {
    expect(mapSetStaffActiveEdgeError(401, 'Missing bearer token').code).toBe('AUTH_REQUIRED');
    expect(mapSetStaffActiveEdgeError(403, 'Insufficient role').code).toBe('AUTH_FORBIDDEN');
    expect(mapSetStaffActiveEdgeError(400, 'Invalid request').code).toBe('SUPABASE_ERROR');
  });
});

describe('ChangeOwnPinRequestSchema / ChangeOwnPinSuccessSchema / mapChangeOwnPinEdgeError', () => {
  it('accepts a 6-digit newPin, with and without terminalId', () => {
    expect(ChangeOwnPinRequestSchema.safeParse({ newPin: '123456' }).success).toBe(true);
    expect(
      ChangeOwnPinRequestSchema.safeParse({ newPin: '123456', terminalId: 'POS-1' }).success
    ).toBe(true);
  });

  it('rejects a newPin that is not exactly 6 digits', () => {
    expect(ChangeOwnPinRequestSchema.safeParse({ newPin: '12345' }).success).toBe(false);
    expect(ChangeOwnPinRequestSchema.safeParse({ newPin: '12345a' }).success).toBe(false);
  });

  it('accepts { ok: true } and rejects ok: false', () => {
    expect(ChangeOwnPinSuccessSchema.safeParse({ ok: true }).success).toBe(true);
    expect(ChangeOwnPinSuccessSchema.safeParse({ ok: false }).success).toBe(false);
  });

  it('maps SAME_PIN to PIN_SAME and a PARTIAL_FAILURE prefix to PIN_CHANGE_PARTIAL_FAILURE', () => {
    expect(mapChangeOwnPinEdgeError(400, 'SAME_PIN').code).toBe('PIN_SAME');
    expect(
      mapChangeOwnPinEdgeError(
        500,
        'PARTIAL_FAILURE: credential changed but staff record failed to sync'
      ).code
    ).toBe('PIN_CHANGE_PARTIAL_FAILURE');
  });

  it('maps 401/403 to the auth codes and a compensated 409 to SUPABASE_ERROR', () => {
    expect(mapChangeOwnPinEdgeError(401, 'Invalid session').code).toBe('AUTH_REQUIRED');
    expect(mapChangeOwnPinEdgeError(403, 'Insufficient role').code).toBe('AUTH_FORBIDDEN');
    expect(
      mapChangeOwnPinEdgeError(409, 'CREDENTIAL_WRITE_FAILED: nothing changed, try again').code
    ).toBe('SUPABASE_ERROR');
  });
});

describe('mapStaffSignInEdgeError', () => {
  it('maps 429 to AUTH_FORBIDDEN/LOCKED, carrying retryAfter as details', () => {
    expect(mapStaffSignInEdgeError(429, 'LOCKED', 42)).toEqual({
      code: 'AUTH_FORBIDDEN',
      message: 'LOCKED',
      details: '42',
    });
  });

  it('maps 401 to AUTH_REQUIRED/INVALID_CREDENTIALS, carrying retryAfter as details', () => {
    expect(mapStaffSignInEdgeError(401, 'INVALID_CREDENTIALS', 0)).toEqual({
      code: 'AUTH_REQUIRED',
      message: 'INVALID_CREDENTIALS',
      details: '0',
    });
  });

  it('maps anything else to SUPABASE_ERROR using the edge code as the message', () => {
    expect(mapStaffSignInEdgeError(503, 'UNAVAILABLE', 0)).toEqual({
      code: 'SUPABASE_ERROR',
      message: 'UNAVAILABLE',
    });
  });
});

describe('mapProcessPaymentEdgeError — PIN_LOCKED', () => {
  it('maps a PIN_LOCKED refusal to an AUTH_FORBIDDEN message carrying the wait time', () => {
    const error = mapProcessPaymentEdgeError('PIN_LOCKED', 'Too many attempts', 30);
    expect(error.code).toBe('AUTH_FORBIDDEN');
    expect(error.message).toContain('30');
  });
});

describe('mapProcessSplitPaymentEdgeError — PIN_LOCKED', () => {
  it('maps a PIN_LOCKED refusal to an AUTH_FORBIDDEN message carrying the wait time', () => {
    const error = mapProcessSplitPaymentEdgeError('PIN_LOCKED', 'Too many attempts', 30);
    expect(error.code).toBe('AUTH_FORBIDDEN');
    expect(error.message).toContain('30');
  });
});

describe('ProcessPaymentEnvelopeSchema — retryAfter', () => {
  it('parses an error envelope that carries retryAfter', () => {
    const r = ProcessPaymentEnvelopeSchema.safeParse({
      success: false,
      error: { code: 'PIN_LOCKED', message: 'Too many attempts', retryAfter: 30 },
    });
    expect(r.success).toBe(true);
    if (r.success) expect(r.data.error?.retryAfter).toBe(30);
  });
});

// Every mapper's fallback branch now returns a generic translated message,
// keeping the raw server text only in `details` (for logs), not in
// `AppError.message` (what the UI shows). The prefix/equality checks above
// each fallback are untouched (asserted separately above by `.code`).
describe('hardened mapper fallbacks never surface raw server text as message', () => {
  const generic = i18n.t('common:edgeErrors.generic');

  it('mapAdminResetPinEdgeError generic fallback', () => {
    const error = mapAdminResetPinEdgeError(500, 'duplicate key value violates unique constraint');
    expect(error.code).toBe('SUPABASE_ERROR');
    expect(error.message).toBe(generic);
    expect(error.details).toBe('duplicate key value violates unique constraint');
  });

  it('mapSetStaffActiveEdgeError generic fallback', () => {
    const error = mapSetStaffActiveEdgeError(400, 'some raw db detail');
    expect(error.code).toBe('SUPABASE_ERROR');
    expect(error.message).toBe(generic);
    expect(error.details).toBe('some raw db detail');
  });

  it('mapChangeOwnPinEdgeError generic fallback', () => {
    const error = mapChangeOwnPinEdgeError(500, 'some raw db detail');
    expect(error.code).toBe('SUPABASE_ERROR');
    expect(error.message).toBe(generic);
    expect(error.details).toBe('some raw db detail');
  });

  it('mapProcessPaymentEdgeError default branch keeps the edge code in details, for logs', () => {
    const error = mapProcessPaymentEdgeError('SOME_UNKNOWN_CODE', 'raw rpc detail');
    expect(error.code).toBe('SUPABASE_ERROR');
    expect(error.message).toBe(generic);
    expect(error.details).toBe('SOME_UNKNOWN_CODE: raw rpc detail');
  });

  it('mapProcessSplitPaymentEdgeError default branch keeps the edge code in details, for logs', () => {
    const error = mapProcessSplitPaymentEdgeError('SOME_UNKNOWN_CODE', 'raw rpc detail');
    expect(error.code).toBe('SUPABASE_ERROR');
    expect(error.message).toBe(generic);
    expect(error.details).toBe('SOME_UNKNOWN_CODE: raw rpc detail');
  });

  it('mapStaffSignInEdgeError is untouched — a short server code, not free text', () => {
    // Regression guard: mapStaffSignInEdgeError must NOT gain the
    // generic-fallback treatment — it takes a short server-issued code, not
    // raw free text, and the design explicitly leaves it unchanged.
    expect(mapStaffSignInEdgeError(503, 'UNAVAILABLE', 0)).toEqual({
      code: 'SUPABASE_ERROR',
      message: 'UNAVAILABLE',
    });
  });
});

describe('mapAgentProxyErrorBody', () => {
  it('maps RATE_LIMITED to a translated message carrying retryAfter', () => {
    const error = mapAgentProxyErrorBody(
      { code: 'RATE_LIMITED', message: 'Too many requests', retryAfter: 42 },
      429
    );
    expect(error.code).toBe('RATE_LIMITED');
    expect(error.message).toContain('42');
  });

  it('maps FORBIDDEN to AUTH_FORBIDDEN with a translated message', () => {
    const error = mapAgentProxyErrorBody({ code: 'FORBIDDEN', message: 'nope' }, 403);
    expect(error.code).toBe('AUTH_FORBIDDEN');
    expect(error.message).toBe(i18n.t('common:edgeErrors.forbidden'));
  });

  it('maps MODEL_NOT_ALLOWED to a translated message', () => {
    const error = mapAgentProxyErrorBody({ code: 'MODEL_NOT_ALLOWED', message: 'nope' }, 400);
    expect(error.code).toBe('MODEL_NOT_ALLOWED');
    expect(error.message).toBe(i18n.t('common:edgeErrors.modelNotAllowed'));
  });

  it('falls back to a generic AGENT_ERROR, keeping the server text only in details', () => {
    const error = mapAgentProxyErrorBody(
      { code: 'ANTHROPIC_ERROR', message: 'Upstream error' },
      500
    );
    expect(error.code).toBe('AGENT_ERROR');
    expect(error.message).toBe(i18n.t('common:edgeErrors.generic'));
    expect(error.details).toBe('Upstream error');
  });

  it('falls back to a generic AGENT_ERROR with a status-derived detail when there is no parsed body', () => {
    const error = mapAgentProxyErrorBody(null, 500);
    expect(error.code).toBe('AGENT_ERROR');
    expect(error.message).toBe(i18n.t('common:edgeErrors.generic'));
    expect(error.details).toContain('500');
  });
});

describe('catchToAppError', () => {
  it('maps a LICENSE_LOCKED-prefixed Error to a LICENSE_LOCKED AppError', () => {
    const error = catchToAppError(
      new Error('LICENSE_LOCKED: this terminal is not licensed — database writes are disabled')
    );
    expect(error).toEqual({
      code: 'LICENSE_LOCKED',
      message: 'this terminal is not licensed — database writes are disabled',
    });
  });

  it('returns null for any other error', () => {
    expect(catchToAppError(new Error('network error'))).toBeNull();
    expect(catchToAppError('not an error')).toBeNull();
    expect(catchToAppError(undefined)).toBeNull();
  });
});
