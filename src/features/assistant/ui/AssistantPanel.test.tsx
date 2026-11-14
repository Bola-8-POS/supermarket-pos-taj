import { act, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useStaffStore } from '@entities/staff/model/store';
import type { AssistantStatus, Staff } from '@shared/lib/domain';
import { formatMoney } from '@shared/lib/format';
import { renderWithProviders } from '@shared/lib/test-utils';
import { useAssistantHistory } from '../model/historyStore';
import { useAssistantPanelStore } from '../model/panelStore';
import { AssistantPanel } from './AssistantPanel';

const status: { data: AssistantStatus | undefined } = { data: undefined };
const feature = { enabled: true };
const runTurn = vi.fn();
const runChoice = vi.fn();
const gate = vi.fn();
const UNLOCKED = { ok: true, data: { ok: true, locked: false, until: null } };

vi.mock('../model/useAssistantStatus', () => ({
  useAssistantStatus: () => status,
  modelTag: () => "e2e",
  localModel: { propose: vi.fn(), status: vi.fn() },
}));
vi.mock('../model/gateway', () => ({
  runTurn: (...a: unknown[]) => runTurn(...a) as unknown,
  runChoice: (...a: unknown[]) => runChoice(...a) as unknown,
}));
vi.mock('@entities/assistant', () => ({
  productLookup: vi.fn(),
  expiryList: vi.fn(),
  lowStock: vi.fn(),
  salesSummary: vi.fn(),
  assistantGate: () => gate() as unknown,
  stageProposal: vi.fn(),
  approveProposal: vi.fn(),
  cancelProposal: vi.fn(),
  recordRejection: vi.fn(),
}));
vi.mock('@entities/staff', () => ({ usePermissions: () => ({ can: () => true, ready: true }) }));
vi.mock('@shared/lib/license/features', async importOriginal => ({
  ...(await importOriginal<object>()),
  useFeature: () => ({ enabled: feature.enabled, locked: !feature.enabled, requestUpgrade: vi.fn() }),
}));

const staffWith = (role: Staff['role']): Staff => ({
  id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  name: 'Test Staff',
  role,
  isActive: true,
  mustChangePin: false,
  locale: 'en-US',
});
const ready: AssistantStatus = { state: 'ready', reason: null, modelId: null, runtimeTag: null };

describe('AssistantPanel', () => {
  beforeEach(() => {
    status.data = ready;
    feature.enabled = true;
    runTurn.mockReset();
    runChoice.mockReset();
    gate.mockReset();
    gate.mockResolvedValue(UNLOCKED);
    localStorage.clear();
    useAssistantHistory.getState().bind(null);
    useAssistantPanelStore.setState({ isOpen: true, isBusy: false, messages: [], lockedUntil: null });
    useStaffStore.setState({ currentStaff: staffWith('cashier'), isAuthenticated: true });
  });

  it('renders for a cashier when the assistant is ready', () => {
    renderWithProviders(<AssistantPanel renderPinDialog={() => null} />);
    expect(screen.getByRole('dialog', { name: 'Assistant' })).toBeInTheDocument();
  });

  it('renders nothing when the status is not ready', () => {
    status.data = { ...ready, state: 'not_installed' };
    expect(renderWithProviders(<AssistantPanel renderPinDialog={() => null} />).container.firstChild).toBeNull();
  });

  it('renders nothing when the license lacks ai_assistant (hidden, not locked)', () => {
    feature.enabled = false;
    expect(renderWithProviders(<AssistantPanel renderPinDialog={() => null} />).container.firstChild).toBeNull();
  });

  it('sends the typed text and renders the lookup reply from i18n keys', async () => {
    runTurn.mockResolvedValue({
      type: 'result',
      kind: 'product.lookup',
      rows: [
        {
          productId: '11111111-1111-4111-8111-111111111111',
          name: 'Ghee 500g',
          price: 12.5,
          quantityOnHand: 7,
          barcode: null,
        },
      ],
      more: false,
    });
    renderWithProviders(<AssistantPanel renderPinDialog={() => null} />);
    await userEvent.type(screen.getByRole('textbox', { name: 'Message to the assistant' }), 'price of ghee');
    await userEvent.click(screen.getByRole('button', { name: 'Send message' }));
    expect(runTurn).toHaveBeenCalledWith(
      'price of ghee',
      expect.objectContaining({ signal: expect.any(AbortSignal) })
    );
    expect(await screen.findByText('Found 1 product.')).toBeInTheDocument();
    expect(screen.getByText(`Ghee 500g: ${formatMoney(12.5)}, 7 in stock, location not recorded`)).toBeInTheDocument();
    await waitFor(() => expect(screen.queryByTestId('assistant-typing')).not.toBeInTheDocument());
  });

  it('renders a refusal by its localized code and never echoes a card number', async () => {
    runTurn.mockResolvedValue({ type: 'refusal', code: 'PAYMENT_DATA' });
    renderWithProviders(<AssistantPanel renderPinDialog={() => null} />);
    await userEvent.type(screen.getByRole('textbox', { name: 'Message to the assistant' }), 'pay 4111111111111111');
    await userEvent.click(screen.getByRole('button', { name: 'Send message' }));
    expect(await screen.findByText(/Please do not type card numbers here/)).toBeInTheDocument();
    expect(screen.queryByText(/4111111111111111/)).not.toBeInTheDocument();
    expect(screen.getByText('pay [redacted]')).toBeInTheDocument();
  });

  it('shows one button per matching supplier and a tap re-runs only the read, never a second model turn', async () => {
    const options = [
      { id: 'a1111111-1111-4111-8111-111111111111', name: 'Sysco' },
      { id: 'b2222222-2222-4222-8222-222222222222', name: 'Susan Foods' },
    ];
    runTurn.mockResolvedValue({ type: 'choose', kind: 'stock.low', options });
    runChoice.mockResolvedValue({
      type: 'result',
      kind: 'stock.low',
      rows: [{ productId: '11111111-1111-4111-8111-111111111111', name: 'Ghee', quantityOnHand: 2, lowStockThreshold: 10 }],
      more: false,
      supplierName: 'Susan Foods',
    });
    renderWithProviders(<AssistantPanel renderPinDialog={() => null} />);
    await userEvent.type(screen.getByRole('textbox', { name: 'Message to the assistant' }), 'low stock from su');
    await userEvent.click(screen.getByRole('button', { name: 'Send message' }));
    expect(await screen.findByText('Several suppliers match. Which one do you mean?')).toBeInTheDocument();
    expect(screen.getAllByTestId('assistant-choice').map(b => b.textContent)).toEqual(['Sysco', 'Susan Foods']);

    await userEvent.click(screen.getByRole('button', { name: 'Susan Foods' }));
    expect(runChoice).toHaveBeenCalledWith(options[1]!.id, expect.objectContaining({ signal: expect.any(AbortSignal) }));
    expect(runTurn).toHaveBeenCalledTimes(1);
    expect(await screen.findByText('Ghee: 2 left (low at 10)')).toBeInTheDocument();
  });

  it('marks a sales summary reply persist:false and leaves other replies unmarked', async () => {
    const summary = {
      cajaId: '22222222-2222-4222-8222-222222222222',
      openedAt: '2026-11-08T14:00:00Z',
      closedAt: null,
      summary: {
        totalRevenue: 250, cashSales: 100, cardSales: 150, rappiSales: 0, uberEatsSales: 0,
        bankTransferSales: 0, bankTransferPending: 0, orderCount: 9, tabCount: 0,
        totalExpenses: 0, totalIncome: 0, netBalance: 250,
      },
    };
    runTurn.mockResolvedValueOnce({ type: 'result', kind: 'sales.summary', summary });
    runTurn.mockResolvedValueOnce({ type: 'refusal', code: 'NOT_FOUND' });
    renderWithProviders(<AssistantPanel renderPinDialog={() => null} />);
    const input = screen.getByRole('textbox', { name: 'Message to the assistant' });
    await userEvent.type(input, 'sales today');
    await userEvent.click(screen.getByRole('button', { name: 'Send message' }));
    expect(await screen.findByText(`Cash: ${formatMoney(100)}`)).toBeInTheDocument();
    await userEvent.type(input, 'anything');
    await userEvent.click(screen.getByRole('button', { name: 'Send message' }));
    await screen.findByText('Nothing was found.');
    const assistantMessages = useAssistantPanelStore.getState().messages.filter(m => m.role === 'assistant');
    expect(assistantMessages.map(m => ('persist' in m ? m.persist : undefined))).toEqual([false, undefined]);
  });

  it('clears the chat when a different staff member signs in', async () => {
    renderWithProviders(<AssistantPanel renderPinDialog={() => null} />);
    act(() => {
      useAssistantPanelStore.getState().addMessage({ role: 'user', text: 'secret question' });
    });
    expect(screen.getByText('secret question')).toBeInTheDocument();
    useStaffStore.setState({
      currentStaff: { ...staffWith('manager'), id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb' },
    });
    await waitFor(() => expect(screen.queryByText('secret question')).not.toBeInTheDocument());
    // Signing out empties the chat too; the first staff member gets their own question back on signing in again (D-19).
    act(() => {
      useStaffStore.setState({ currentStaff: null, isAuthenticated: false });
    });
    expect(useAssistantPanelStore.getState().messages).toEqual([]);
    act(() => {
      useStaffStore.setState({ currentStaff: staffWith('cashier'), isAuthenticated: true });
    });
    expect(await screen.findByText('secret question')).toBeInTheDocument();
  });

  describe('cool-down lockout (D-15)', () => {
    const UNTIL = '2026-11-08T18:30:00Z';
    const LOCKED = { ok: true, data: { ok: true, locked: true, until: UNTIL } };
    const time = new Date(UNTIL).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });

    it('opening the panel reads the gate; a lock shows the localized banner and disables the input', async () => {
      gate.mockResolvedValue(LOCKED);
      renderWithProviders(<AssistantPanel renderPinDialog={() => null} />);
      const banner = await screen.findByTestId('assistant-lockout');
      expect(banner).toHaveTextContent(`The assistant is paused for you until ${time}`);
      expect(banner).toHaveTextContent('Selling is not affected');
      expect(screen.getByRole('textbox', { name: 'Message to the assistant' })).toBeDisabled();
      expect(screen.getByRole('button', { name: 'Send message' })).toBeDisabled();
      expect(runTurn).not.toHaveBeenCalled();
    });

    it('an unlocked gate shows no banner', async () => {
      renderWithProviders(<AssistantPanel renderPinDialog={() => null} />);
      await waitFor(() => { expect(gate).toHaveBeenCalled(); });
      expect(screen.queryByTestId('assistant-lockout')).toBeNull();
    });

    it('a turn answered with ASSISTANT_LOCKED flips the panel to the lockout', async () => {
      runTurn.mockResolvedValue({ type: 'refusal', code: 'ASSISTANT_LOCKED', until: UNTIL });
      renderWithProviders(<AssistantPanel renderPinDialog={() => null} />);
      await userEvent.type(screen.getByRole('textbox', { name: 'Message to the assistant' }), 'price of ghee');
      await userEvent.click(screen.getByRole('button', { name: 'Send message' }));
      expect(await screen.findByTestId('assistant-lockout')).toBeInTheDocument();
      expect(screen.getByRole('textbox', { name: 'Message to the assistant' })).toBeDisabled();
    });

    it('the lock that the 5th refusal reports (onLocked) flips the panel at once', async () => {
      runTurn.mockImplementation(async (_text: string, deps: { onLocked?: (u: string | null) => void }) => {
        deps.onLocked?.(UNTIL);
        return { type: 'refusal', code: 'MODEL_REFUSED_UNSAFE' };
      });
      renderWithProviders(<AssistantPanel renderPinDialog={() => null} />);
      await userEvent.type(screen.getByRole('textbox', { name: 'Message to the assistant' }), 'bad request');
      await userEvent.click(screen.getByRole('button', { name: 'Send message' }));
      expect(await screen.findByTestId('assistant-lockout')).toBeInTheDocument();
    });
  });
});
