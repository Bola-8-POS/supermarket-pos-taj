import { useTranslation } from 'react-i18next';
import { useStaffStore } from '@entities/staff/model/store';
import { runAgent } from '@shared/lib/agent/brain';
import type { Message } from '@shared/lib/agent/brain';
import { parseProductsCsv } from '@shared/lib/agent/csv-parser';
import { executeTool } from '@shared/lib/agent/tools/index';
import { extractProductsFromImage, extractProductsFromText } from '@shared/lib/agent/vision';
import { formatMoney } from '@shared/lib/format';
import { logger } from '@shared/lib/logger';
import { useAgentStore } from './agentStore';

function readFileAsBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = reader.result as string;
      resolve(result.split(',')[1] ?? '');
    };
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

function readFileAsText(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => { resolve(reader.result as string); };
    reader.onerror = reject;
    reader.readAsText(file);
  });
}

export function useAgent() {
  const { t } = useTranslation('featMgmt');
  const state = useAgentStore();
  const userRole = useStaffStore((s) => s.currentStaff?.role ?? 'bartender');
  const userId = useStaffStore((s) => s.currentStaff?.id);

  const sendMessage = async (text: string): Promise<void> => {
    const conversationHistory: Message[] = useAgentStore.getState().messages;

    const userMessage: Message = { role: 'user', content: text };
    state.addMessage(userMessage);
    state.setTyping(true);

    try {
      const result = await runAgent(text, userRole, conversationHistory, userId);

      state.setAwaitingConfirmation(result.awaitingConfirmation);
      state.setPendingConfirmation(result.pendingConfirmation);

      const assistantMessage: Message = { role: 'assistant', content: result.text };
      state.addMessage(assistantMessage);

      if (!useAgentStore.getState().isOpen) {
        useAgentStore.setState({ hasUnread: true });
      }

      if (result.toolsExecuted.length > 0) {
        logger.info('agent.tools.executed', { tools: result.toolsExecuted.join(',') });
      }
    } catch (e) {
      logger.error('agent.sendMessage.failed', { role: userRole }, e);
      const errorMessage: Message = {
        role: 'assistant',
        content: t('agentChat.processErrorMessage'),
      };
      state.addMessage(errorMessage);
    } finally {
      state.setTyping(false);
    }
  };

  const handleFileImport = async (file: File): Promise<void> => {
    state.addMessage({ role: 'user', content: `📎 ${file.name}` });
    state.setTyping(true);

    try {
      let products: Array<{ name: string; price: number }> = [];

      if (file.type === 'image/jpeg') {
        const base64 = await readFileAsBase64(file);
        products = await extractProductsFromImage(base64, 'image/jpeg');
      } else if (file.type === 'image/png') {
        const base64 = await readFileAsBase64(file);
        products = await extractProductsFromImage(base64, 'image/png');
      } else if (file.type === 'image/gif') {
        const base64 = await readFileAsBase64(file);
        products = await extractProductsFromImage(base64, 'image/gif');
      } else if (file.type === 'image/webp') {
        const base64 = await readFileAsBase64(file);
        products = await extractProductsFromImage(base64, 'image/webp');
      } else if (file.type === 'text/csv') {
        const text = await readFileAsText(file);
        products = parseProductsCsv(text);
      } else if (file.type === 'application/pdf') {
        const base64 = await readFileAsBase64(file);
        products = await extractProductsFromText(base64);
      }

      if (products.length > 0) {
        state.setPendingImportProducts(products);
        const preview = products
          .slice(0, 5)
          .map((p) => `| ${p.name} | ${formatMoney(p.price)} |`)
          .join('\n');
        const header = `| ${t('agentChat.nameHeader')} | ${t('agentChat.priceHeader')} |\n|--------|--------|`;
        const remaining = products.length - 5;
        const more =
          products.length > 5 ? t('agentChat.andMoreInline', { count: remaining }) : '';
        const count = String(products.length);
        // eslint-disable-next-line i18next/no-literal-string -- English plural-suffix grammar token, not standalone UI copy
        const plural = products.length !== 1 ? 's' : '';
        state.addMessage({
          role: 'assistant',
          content: `${header}\n${preview}${more}\n\n${t('agentChat.confirmImportPrompt', { count, plural })}`,
        });
      } else {
        state.addMessage({
          role: 'assistant',
          content: t('agentChat.noProductsFoundMessage'),
        });
      }
    } catch (e) {
      logger.error('agent.handleFileImport.failed', { fileName: file.name }, e);
      state.addMessage({
        role: 'assistant',
        content: t('agentChat.noProductsFoundMessage'),
      });
    } finally {
      state.setTyping(false);
    }
  };

  const confirmAction = async (token: string): Promise<void> => {
    state.setTyping(true);
    state.setPendingConfirmation(null);
    try {
      const ctx = { userId, userRole, durationMs: undefined };
      const result = await executeTool('confirm_action', { token }, ctx);
      state.addMessage({
        role: 'assistant',
        content: result.ok
          ? t('agentChat.actionExecutedSuccess')
          : t('agentChat.actionErrorPrefix', { message: result.error.message }),
      });
    } catch (e) {
      logger.error('agent.confirmAction.failed', {}, e);
      state.addMessage({
        role: 'assistant',
        content: t('agentChat.confirmErrorPrefix', { error: String(e) }),
      });
    } finally {
      state.setTyping(false);
    }
  };

  const cancelAction = async (token: string): Promise<void> => {
    state.setPendingConfirmation(null);
    const ctx = { userId, userRole, durationMs: undefined };
    await executeTool('cancel_action', { token }, ctx);
    state.addMessage({ role: 'assistant', content: t('agentChat.actionCancelled') });
  };

  const confirmImport = async (): Promise<void> => {
    const products = useAgentStore.getState().pendingImportProducts;
    if (!products) return;

    state.setTyping(true);
    state.setPendingImportProducts(null);

    try {
      const ctx = { userId: undefined, userRole, durationMs: undefined };
      const staged = await executeTool('bulk_import_products', { products }, ctx);

      // bulk_import_products is a write tool guarded by the pending-confirmation
      // pattern (see menuTools.ts): the call above only stages the import and
      // returns a confirm_token — it never inserts rows. The actual DB write
      // happens on confirm_action, which this file-drop "Confirm Import" button
      // must trigger itself (unlike chat-driven tool calls, which run through
      // runAgent/ConfirmActionCard for that second step).
      const confirmToken =
        staged.ok && staged.data !== null && typeof staged.data === 'object' && 'confirm_token' in staged.data
          ? (staged.data as { confirm_token?: string }).confirm_token
          : undefined;
      const result = confirmToken
        ? await executeTool('confirm_action', { token: confirmToken }, ctx)
        : staged;

      const count = String(products.length);
      // eslint-disable-next-line i18next/no-literal-string -- English plural-suffix grammar token, not standalone UI copy
      const plural = products.length !== 1 ? 's' : '';

      if (result.ok) {
        state.addMessage({
          role: 'assistant',
          content: t('agentChat.importSuccessMessage', { count, plural }),
        });
      } else {
        state.addMessage({
          role: 'assistant',
          content: t('agentChat.importErrorPrefix', { message: result.error.message }),
        });
      }
    } catch (e) {
      logger.error('agent.confirmImport.failed', {}, e);
      state.addMessage({
        role: 'assistant',
        content: t('agentChat.importErrorPrefix', { message: String(e) }),
      });
    } finally {
      state.setTyping(false);
    }
  };

  return {
    isOpen: state.isOpen,
    messages: state.messages,
    isTyping: state.isTyping,
    awaitingConfirmation: state.awaitingConfirmation,
    hasUnread: state.hasUnread,
    pendingImportProducts: state.pendingImportProducts,
    pendingConfirmation: state.pendingConfirmation,
    open: state.open,
    close: state.close,
    toggle: state.toggle,
    markRead: state.markRead,
    clearMessages: state.clearMessages,
    setPendingImportProducts: state.setPendingImportProducts,
    sendMessage,
    handleFileImport,
    confirmImport,
    confirmAction,
    cancelAction,
  };
}
