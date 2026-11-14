/**
 * The raw request text of an assistant write proposal (D-17). It lives in `assistant_proposal_texts`, which only an
 * admin session can read (RLS is the authority): any other role gets no row, which is "nothing to show", not an error.
 * The caller decides whether to ask at all (UI hiding is a convenience, not the control).
 */
/* eslint-disable i18next/no-literal-string -- query key and error codes for logs, not UI copy */
import { useQuery } from '@tanstack/react-query';
import { z } from 'zod';
import { logger } from '@shared/lib/logger-instance';
import { supabase } from '@shared/lib/supabase';

const RowSchema = z.object({ raw_text: z.string() }).nullable();

export const assistantTextKeys = {
  one: (proposalId: string) => ['assistant-proposal-text', proposalId] as const,
};

/** The stored text, or null when the session may not see it (or none exists). A failed read throws, so the query errors. */
export async function fetchAssistantProposalText(proposalId: string): Promise<string | null> {
  const { data, error } = await supabase
    .from('assistant_proposal_texts')
    .select('raw_text')
    .eq('proposal_id', proposalId)
    .maybeSingle();
  if (error) {
    logger.warn('assistant.text.read_failed', { message: error.message });
    throw new Error(error.message);
  }
  const parsed = RowSchema.safeParse(data);
  if (!parsed.success) {
    logger.warn('assistant.text.unparseable', {});
    throw new Error('unparseable');
  }
  return parsed.data?.raw_text ?? null;
}

/** Disabled (no request is sent) while `proposalId` is null. */
export function useAssistantProposalText(proposalId: string | null) {
  return useQuery({
    queryKey: assistantTextKeys.one(proposalId ?? ''),
    queryFn: () => fetchAssistantProposalText(proposalId ?? ''),
    enabled: proposalId !== null,
    retry: false,
    staleTime: 60_000,
  });
}
