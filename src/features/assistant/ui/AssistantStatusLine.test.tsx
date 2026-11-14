import { screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { AssistantStatus } from '@shared/lib/domain';
import { renderWithProviders } from '@shared/lib/test-utils';
import { AssistantStatusLine } from './AssistantStatusLine';

const status: { data: AssistantStatus | undefined } = { data: undefined };
vi.mock('../model/useAssistantStatus', () => ({ useAssistantStatus: () => ({ data: status.data }) }));

const base: AssistantStatus = { state: 'ready', reason: null, modelId: null, runtimeTag: null };
const show = (s: Partial<AssistantStatus>) => {
  status.data = { ...base, ...s };
  renderWithProviders(<AssistantStatusLine />);
};

describe('AssistantStatusLine', () => {
  it('says not installed', () => {
    show({ state: 'not_installed' });
    expect(screen.getByTestId('assistant-status-line')).toHaveTextContent('Assistant not installed');
  });

  it.each([
    ['HASH_MISMATCH', 'do not match their signed hashes'],
    ['SIGNATURE_INVALID', 'signature is invalid'],
    ['MEMORY_PRESSURE', 'low on memory'],
    ['NOT_WINDOWS', 'Windows only'],
    ['SOMETHING_NEW', 'unknown reason'],
  ])('names the reason %s', (reason, text) => {
    show({ state: 'unavailable', reason });
    expect(screen.getByTestId('assistant-status-line')).toHaveTextContent(new RegExp(`^Assistant unavailable: .*${text}`));
  });

  it('shows the model and runtime when ready', () => {
    show({ modelId: 'qwen-3b', runtimeTag: 'b4567' });
    expect(screen.getByTestId('assistant-status-line')).toHaveTextContent('Assistant ready (qwen-3b, b4567)');
  });

  it('renders nothing before the status is known', () => {
    status.data = undefined;
    expect(renderWithProviders(<AssistantStatusLine />).container).toBeEmptyDOMElement();
  });
});
