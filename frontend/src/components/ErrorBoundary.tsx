import { Component, type ReactNode } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';

/**
 * Safety net: a single page's render error used to blank the whole app
 * (white screen, no message). The boundary catches the error and shows a
 * friendly screen with a retry / go-back / dashboard escape instead.
 * It resets whenever the route changes, so navigating away always clears it.
 */
class ErrorBoundaryInner extends Component<
  { children: ReactNode; onResetKeyChange: string },
  { error: Error | null }
> {
  state: { error: Error | null } = { error: null };

  static getDerivedStateFromError(error: Error): { error: Error } {
    return { error };
  }

  componentDidCatch(error: Error): void {
    // Keep the failure visible in the console for debugging; never send
    // anything anywhere.
    console.error('Page crashed:', error);
  }

  componentDidUpdate(prevProps: { onResetKeyChange: string }): void {
    if (prevProps.onResetKeyChange !== this.props.onResetKeyChange && this.state.error) {
      this.setState({ error: null });
    }
  }

  private retry = (): void => this.setState({ error: null });

  render(): ReactNode {
    if (!this.state.error) return this.props.children;
    return <CrashScreen onRetry={this.retry} />;
  }
}

function CrashScreen({ onRetry }: { onRetry: () => void }) {
  const navigate = useNavigate();
  return (
    <div className="mx-auto max-w-lg px-4 py-16 text-center">
      <div className="rounded-xl border border-slate-200 bg-white px-6 py-10 shadow-sm">
        <p className="text-lg font-semibold text-slate-800">Something went wrong</p>
        <p className="mt-2 text-sm text-slate-500">
          This page ran into a problem and couldn&apos;t be shown. Your data is safe — try again, or go back to
          where you were.
        </p>
        <div className="mt-6 flex flex-wrap items-center justify-center gap-2">
          <button
            onClick={onRetry}
            className="rounded-lg bg-brand-700 px-4 py-2 text-sm font-medium text-white hover:bg-brand-900"
          >
            Try again
          </button>
          <button
            onClick={() => navigate(-1)}
            className="rounded-lg border border-slate-300 bg-white px-4 py-2 text-sm font-medium text-slate-700 hover:bg-slate-50"
          >
            Go back
          </button>
          <button
            onClick={() => navigate('/')}
            className="rounded-lg border border-slate-300 bg-white px-4 py-2 text-sm font-medium text-slate-700 hover:bg-slate-50"
          >
            Go to dashboard
          </button>
        </div>
      </div>
    </div>
  );
}

export default function ErrorBoundary({ children }: { children: ReactNode }) {
  const location = useLocation();
  // R2-C fix (F3): ErrorBoundaryInner used to ALSO get key={location.pathname}
  // here. That remounted the entire app — every page, Layout, and the
  // GuidedTour's open/step state — on EVERY navigation, so the tour could
  // never survive its own Next click (step 2 never rendered) and any
  // in-progress page state was lost on each route change. The reset on
  // route change is already handled without a remount by
  // componentDidUpdate above (onResetKeyChange), so the key is dropped
  // and the tree now stays mounted across navigations.
  return (
    <ErrorBoundaryInner onResetKeyChange={location.pathname}>{children}</ErrorBoundaryInner>
  );
}
