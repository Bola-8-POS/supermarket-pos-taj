export function TypingIndicator() {
  return (
    <div className="flex items-center gap-1 px-3 py-2">
      <span
        className="size-2 animate-pulse rounded-full bg-muted-foreground"
        style={{ animationDelay: '0ms', animationDuration: '900ms' }}
      />
      <span
        className="size-2 animate-pulse rounded-full bg-muted-foreground"
        style={{ animationDelay: '150ms', animationDuration: '900ms' }}
      />
      <span
        className="size-2 animate-pulse rounded-full bg-muted-foreground"
        style={{ animationDelay: '300ms', animationDuration: '900ms' }}
      />
    </div>
  );
}
