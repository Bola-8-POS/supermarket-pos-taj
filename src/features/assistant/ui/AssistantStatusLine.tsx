import { useTranslation } from 'react-i18next';
import { useAssistantStatus } from '../model/useAssistantStatus';

// eslint-disable-next-line i18next/no-literal-string -- bridge reason codes (Plan 29-02 contract), used only as translation keys
const REASONS = new Set(['SIGNATURE_INVALID', 'HASH_MISMATCH', 'OVER_BUDGET', 'MANIFEST_INVALID', 'UNTRUSTED_PATH', 'SPAWN_FAILED', 'HEALTH_FAILED', 'EXITED', 'MEMORY_PRESSURE', 'NOT_WINDOWS']);

/** One muted line telling an admin why the assistant is missing (D-05). Rendered only inside the manage_settings-gated Hardware tab. */
export function AssistantStatusLine() {
  const { t } = useTranslation('featMgmt');
  const { data } = useAssistantStatus();
  if (!data) return null;

  let line: string;
  if (data.state === 'ready') {
    line = t('assistant.status.ready', { modelId: data.modelId ?? '-', runtimeTag: data.runtimeTag ?? '-' });
  } else if (data.state === 'unavailable') {
    const code = data.reason !== null && REASONS.has(data.reason) ? data.reason : 'UNKNOWN';
    line = t('assistant.status.unavailable', { reason: t(`assistant.status.reason.${code}`) });
  } else {
    line = t(data.state === 'starting' ? 'assistant.status.starting' : 'assistant.status.notInstalled');
  }

  return (
    <p data-testid="assistant-status-line" className="text-sm text-muted-foreground">
      {line}
    </p>
  );
}
