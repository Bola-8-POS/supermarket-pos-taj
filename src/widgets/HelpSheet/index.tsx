import { useEffect, useState, type ReactElement } from 'react';
import { useTranslation } from 'react-i18next';
import { useLocation } from 'react-router-dom';
import { getHelpForRoute } from '@shared/lib/help/content';
import { Sheet, SheetContent, SheetHeader, SheetTitle } from '@shared/ui/sheet';

// Minimal markdown → React. Supports `# heading`, `- bullet`, **bold**, and blank-line paragraphs.
function renderMarkdown(markdown: string): ReactElement[] {
  const lines = markdown.split(/\r?\n/);
  const nodes: ReactElement[] = [];
  let listBuffer: string[] = [];
  let paragraphBuffer: string[] = [];

  function flushList() {
    if (listBuffer.length === 0) return;
    nodes.push(
      <ul key={`ul-${String(nodes.length)}`} className="ml-5 list-disc space-y-1 text-sm">
        {listBuffer.map((item, idx) => (
          <li key={idx} dangerouslySetInnerHTML={{ __html: inlineFormat(item) }} />
        ))}
      </ul>
    );
    listBuffer = [];
  }

  function flushParagraph() {
    if (paragraphBuffer.length === 0) return;
    const text = paragraphBuffer.join(' ');
    nodes.push(
      <p
        key={`p-${String(nodes.length)}`}
        className="text-sm leading-relaxed"
        dangerouslySetInnerHTML={{ __html: inlineFormat(text) }}
      />
    );
    paragraphBuffer = [];
  }

  for (const raw of lines) {
    const line = raw.trim();
    if (line.startsWith('# ')) {
      flushList();
      flushParagraph();
      nodes.push(
        <h2 key={`h-${String(nodes.length)}`} className="text-lg font-semibold">
          {line.slice(2)}
        </h2>
      );
    } else if (line.startsWith('- ')) {
      flushParagraph();
      listBuffer.push(line.slice(2));
    } else if (line === '') {
      flushList();
      flushParagraph();
    } else {
      flushList();
      paragraphBuffer.push(line);
    }
  }
  flushList();
  flushParagraph();
  return nodes;
}

function escapeHtml(value: string): string {
  /* eslint-disable i18next/no-literal-string -- HTML entity escape sequences, not UI copy */
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
  /* eslint-enable i18next/no-literal-string */
}

function inlineFormat(text: string): string {
  const escaped = escapeHtml(text);
  // eslint-disable-next-line i18next/no-literal-string -- markdown-to-HTML tag substitution, not UI copy
  return escaped.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
}

export function HelpSheet() {
  const { t } = useTranslation('wPanels');
  const [open, setOpen] = useState(false);
  const location = useLocation();
  const entry = getHelpForRoute(location.pathname);

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === 'F1') {
        e.preventDefault();
        setOpen(prev => !prev);
      }
    }
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('keydown', onKey);
    };
  }, []);

  return (
    <Sheet open={open} onOpenChange={setOpen}>
      <SheetContent side="right" data-testid="help-sheet" className="w-full sm:max-w-md">
        <SheetHeader>
          <SheetTitle data-testid="help-sheet-title">{entry.title}</SheetTitle>
        </SheetHeader>
        <div data-testid="help-sheet-body" className="mt-4 space-y-3 overflow-y-auto pr-2">
          {renderMarkdown(entry.body)}
        </div>
        <p className="mt-6 text-xs text-muted-foreground">{t('helpSheet.pressF1OrEsc')}</p>
      </SheetContent>
    </Sheet>
  );
}
