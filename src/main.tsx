import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import '@shared/lib/zod-config';
import '@shared/lib/i18n';
import { logger } from '@shared/lib/logger-instance';
import { App } from './app/App';
import { PeekApp } from './app/PeekApp';
import './app/globals.css';

// Uncaught errors/rejections outside the React tree (async code, event
// handlers, etc.) skip ErrorBoundary entirely — without these, they vanish
// with no record in the app log or the Windows Event Log. Routes them
// through the same logger as everything else instead.
window.addEventListener('error', (event) => {
  logger.error('window.uncaught_error', { source: event.filename, line: event.lineno }, event.error);
});
window.addEventListener('unhandledrejection', (event) => {
  logger.error('window.unhandled_rejection', {}, event.reason);
});

const rootEl = document.getElementById('root');
if (!rootEl) {
  throw new Error('Root element #root not found');
}

const isPeek = new URLSearchParams(window.location.search).get('window') === 'peek';

createRoot(rootEl).render(
  <StrictMode>{isPeek ? <PeekApp /> : <App />}</StrictMode>
);
