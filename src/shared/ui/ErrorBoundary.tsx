import { Component, type ErrorInfo, type ReactNode } from 'react';
import i18n from '@shared/lib/i18n';
import { logError } from '@shared/lib/telemetry';
import { POSButton } from '@shared/ui/POSButton';

interface Props {
  children: ReactNode;
  fallback?: ReactNode;
}

interface State {
  hasError: boolean;
  error: Error | null;
}

export class ErrorBoundary extends Component<Props, State> {
  public state: State = {
    hasError: false,
    error: null,
  };

  public static getDerivedStateFromError(error: Error): State {
    return { hasError: true, error };
  }

  public componentDidCatch(error: Error, errorInfo: ErrorInfo) {
    void logError(error, { component: errorInfo.componentStack?.split('\n')[1]?.trim() });
  }

  public render() {
    if (this.state.hasError) {
      if (this.props.fallback) {
        return this.props.fallback;
      }
      // Class component — cannot use the useTranslation() hook. Uses the
      // imported i18n singleton's .t() directly (same pattern as non-component
      // consumers documented in @shared/lib/i18n/index.ts).
      return (
        <div className="mx-auto max-w-md rounded-2xl border border-destructive/20 bg-destructive-soft p-8 text-center">
          <h2 className="mb-2 text-lg font-semibold text-destructive">
            {i18n.t('common:errorBoundary.title')}
          </h2>
          <p className="mb-5 text-sm text-destructive/80">{this.state.error?.message}</p>
          <POSButton
            touchSize="large"
            variant="default"
            onClick={() => {
              this.setState({ hasError: false });
            }}
          >
            {i18n.t('common:actions.tryAgain')}
          </POSButton>
        </div>
      );
    }

    return this.props.children;
  }
}
