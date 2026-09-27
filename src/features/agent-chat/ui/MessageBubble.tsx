import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import type { Message } from '@shared/lib/agent/brain';

interface MessageBubbleProps {
  message: Message;
}

export function MessageBubble({ message }: MessageBubbleProps) {
  const isUser = message.role === 'user';

  if (isUser) {
    return (
      <div className="flex justify-end px-3 py-1">
        <div className="max-w-[75%] rounded-2xl rounded-br-md bg-primary px-4 py-2.5 text-sm leading-relaxed text-primary-foreground shadow-xs">
          {message.content}
        </div>
      </div>
    );
  }

  return (
    <div className="flex justify-start px-3 py-1">
      <div className="max-w-[85%] rounded-2xl rounded-bl-md border border-border bg-card px-4 py-2.5 text-sm leading-relaxed text-card-foreground shadow-xs">
        <ReactMarkdown
          remarkPlugins={[remarkGfm]}
          components={{
            code({ children, className }) {
              const isInline = !className;
              if (isInline) {
                return (
                  <code className="rounded bg-muted px-1 py-0.5 font-mono text-xs">{children}</code>
                );
              }
              return (
                <pre className="overflow-x-auto rounded bg-muted p-2">
                  <code className="font-mono text-xs">{children}</code>
                </pre>
              );
            },
            ul({ children }) {
              return <ul className="ml-4 list-disc space-y-1">{children}</ul>;
            },
            ol({ children }) {
              return <ol className="ml-4 list-decimal space-y-1">{children}</ol>;
            },
            li({ children }) {
              return <li className="text-sm">{children}</li>;
            },
            p({ children }) {
              return <p className="mb-1 last:mb-0">{children}</p>;
            },
          }}
        >
          {message.content}
        </ReactMarkdown>
      </div>
    </div>
  );
}
