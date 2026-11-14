import { screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { useStaffStore } from '@entities/staff/model/store';
import { AuditActionSchema } from '@shared/lib/audit-actions';
import type { AuditLog, Staff } from '@shared/lib/domain';
import enCommon from '@shared/lib/i18n/locales/en-US/common.json';
import esCommon from '@shared/lib/i18n/locales/es-MX/common.json';
import { renderWithProviders } from '@shared/lib/test-utils';

import { AuditLogDetailSheet } from './AuditLogDetailSheet';

const textQuery = vi.fn();
vi.mock('@entities/assistant', () => ({
  useAssistantProposalText: (id: string | null) => textQuery(id) as unknown,
}));

const PROPOSAL = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const staff = (role: Staff['role']): Staff => ({
  id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
  name: 'Test',
  role,
  isActive: true,
  mustChangePin: false,
  locale: 'en-US',
});
const row = (action: string, entityId: string | null = PROPOSAL): AuditLog => ({
  id: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
  actorId: null,
  action,
  entityType: action.startsWith('assistant.') ? 'assistant_proposal' : 'payment',
  entityId,
  before: null,
  after: { kind: 'product.price' },
  terminalId: null,
  source: 'rpc',
  createdAt: new Date('2026-11-08T12:00:00Z'),
});

function show(r: AuditLog, role: Staff['role']) {
  useStaffStore.setState({ currentStaff: staff(role), isAuthenticated: true });
  return renderWithProviders(<AuditLogDetailSheet row={r} actorName={null} open onOpenChange={() => undefined} />);
}

describe('AuditLogDetailSheet: assistant raw message (D-17)', () => {
  beforeEach(() => {
    textQuery.mockReset();
    textQuery.mockReturnValue({ data: null, isError: false });
  });

  it('an admin sees the stored message as plain text, and the query is asked for that proposal', () => {
    textQuery.mockReturnValue({ data: 'cambia el precio del ghee a <b>89.50</b>', isError: false });
    show(row('assistant.staged'), 'admin');
    expect(textQuery).toHaveBeenLastCalledWith(PROPOSAL);
    const message = screen.getByTestId('assistant-raw-message');
    expect(message).toHaveTextContent('cambia el precio del ghee a <b>89.50</b>');
    expect(message.querySelector('b')).toBeNull();
  });

  it('a manager gets no query and no message section', () => {
    show(row('assistant.staged'), 'manager');
    expect(textQuery).toHaveBeenLastCalledWith(null);
    expect(screen.queryByTestId('assistant-raw-message')).toBeNull();
  });

  it('a cashier gets no query either', () => {
    show(row('assistant.executed'), 'cashier');
    expect(textQuery).toHaveBeenLastCalledWith(null);
  });

  it('other actions never ask for the text, even for an admin', () => {
    show(row('payment.process'), 'admin');
    expect(textQuery).toHaveBeenLastCalledWith(null);
    expect(screen.queryByTestId('assistant-raw-message')).toBeNull();
  });

  it('an assistant row without an entity id (a refusal) asks for nothing', () => {
    show(row('assistant.rejected', null), 'admin');
    expect(textQuery).toHaveBeenLastCalledWith(null);
  });

  it('a failed read shows a muted unavailable line, not the message', () => {
    textQuery.mockReturnValue({ data: undefined, isError: true });
    show(row('assistant.staged'), 'admin');
    expect(screen.getByTestId('assistant-message-unavailable')).toBeInTheDocument();
    expect(screen.queryByTestId('assistant-raw-message')).toBeNull();
  });

  it('shows the localized label as the title of an assistant row, and the raw action for the others', () => {
    show(row('assistant.executed'), 'manager');
    expect(screen.getByText(enCommon.auditActions.assistant.executed)).toBeInTheDocument();
  });
});

describe('assistant audit action labels', () => {
  const assistantActions = AuditActionSchema.options.filter(a => a.startsWith('assistant.'));

  it('has all 11 assistant actions', () => {
    expect(assistantActions).toHaveLength(11);
  });

  it.each([
    ['en-US', enCommon],
    ['es-MX', esCommon],
  ] as const)('every assistant.* action has a non-empty %s label', (_locale, bundle) => {
    const labels = bundle.auditActions.assistant as Record<string, string>;
    for (const action of assistantActions) {
      const label = labels[action.slice('assistant.'.length)];
      expect(label, action).toBeTruthy();
    }
  });
});
