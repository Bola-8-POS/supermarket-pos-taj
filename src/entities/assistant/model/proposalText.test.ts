import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fetchAssistantProposalText } from './proposalText';

const result = vi.fn();
const eq = vi.fn();
vi.mock('@shared/lib/supabase', () => ({
  supabase: {
    from: (table: string) => ({
      select: (cols: string) => ({
        eq: (col: string, id: string) => {
          eq(table, cols, col, id);
          return { maybeSingle: () => result() as unknown };
        },
      }),
    }),
  },
}));

describe('fetchAssistantProposalText', () => {
  beforeEach(() => { result.mockReset(); eq.mockReset(); });

  it('reads raw_text of one proposal from the admin-only table', async () => {
    result.mockResolvedValue({ data: { raw_text: 'set ghee to 89.50' }, error: null });
    expect(await fetchAssistantProposalText('p-1')).toBe('set ghee to 89.50');
    expect(eq).toHaveBeenCalledWith('assistant_proposal_texts', 'raw_text', 'proposal_id', 'p-1');
  });

  it('a session that RLS shows no row (manager) gets null, not an error', async () => {
    result.mockResolvedValue({ data: null, error: null });
    expect(await fetchAssistantProposalText('p-1')).toBeNull();
  });

  it('a Supabase error is thrown, never swallowed', async () => {
    result.mockResolvedValue({ data: null, error: { message: 'boom' } });
    await expect(fetchAssistantProposalText('p-1')).rejects.toThrow('boom');
  });

  it('a row of the wrong shape is an error, not text', async () => {
    result.mockResolvedValue({ data: { raw_text: 5 }, error: null });
    await expect(fetchAssistantProposalText('p-1')).rejects.toThrow();
  });
});
