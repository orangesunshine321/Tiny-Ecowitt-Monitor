/**
 * Error boundaries, and recovery from a replaced build.
 *
 * Every page is a lazily loaded chunk with a hashed name. After update.sh replaces the app, the old chunks are gone
 * (the server answers 404 for unknown /assets/*), but a resumed Home Screen app still runs the old bundle. Opening a
 * page it has not loaded yet then fails to import. Without a boundary React unmounts the whole root and leaves a blank
 * screen with no reload control (standalone apps have none). Here:
 *  - a failed chunk/preload reloads the page once to pick up the new build (guarded against loops via sessionStorage);
 *  - any other render error shows "Something went wrong" with Reload, scoped to the page so the chrome keeps working.
 */
import { RefreshCw, TriangleAlert } from 'lucide-react';
import { Component, type ErrorInfo, type ReactNode } from 'react';
import { Button } from '../components/Button';
import { EmptyState } from '../components/EmptyState';
import { isChunkLoadError, reloadForNewBuild } from './buildRecovery';
import './ErrorBoundary.css';

interface Props {
  children: ReactNode;
  /** 'page' keeps the app chrome around the message; 'app' replaces everything */
  scope: 'page' | 'app';
}

interface State {
  error: unknown;
  reloading: boolean;
}

export class ErrorBoundary extends Component<Props, State> {
  override state: State = { error: null, reloading: false };

  static getDerivedStateFromError(error: unknown): Partial<State> {
    return { error };
  }

  override componentDidCatch(error: unknown, info: ErrorInfo): void {
    if (isChunkLoadError(error) && reloadForNewBuild()) {
      this.setState({ reloading: true });
      return;
    }
    console.error('pve1-dash: render error', error, info.componentStack);
  }

  override render(): ReactNode {
    const { error, reloading } = this.state;
    if (error === null) return this.props.children;
    const chunk = isChunkLoadError(error);
    const offline = typeof navigator !== 'undefined' && navigator.onLine === false;
    const title = reloading ? 'Loading the new version…' : chunk ? (offline ? 'This page isn’t available offline' : 'pve1-dash was updated') : 'Something went wrong';
    const message = reloading
      ? undefined
      : chunk
        ? offline
          ? 'It hasn’t been opened on this device yet. Try again when the network is back.'
          : 'This page belongs to a newer version of the dashboard. Reload to continue.'
        : 'This view hit an unexpected error. Reloading usually fixes it.';
    return (
      <div className={this.props.scope === 'app' ? 'ui-error-app' : 'ui-error-page'} role="alert">
        <EmptyState
          icon={reloading ? <RefreshCw size={28} strokeWidth={1.8} /> : <TriangleAlert size={28} strokeWidth={1.8} />}
          tone={reloading ? 'info' : chunk ? 'info' : 'warn'}
          title={title}
          message={message}
          action={
            reloading ? undefined : (
              <Button variant="prominent" icon={<RefreshCw size={16} strokeWidth={2.2} />} onClick={() => location.reload()}>
                Reload
              </Button>
            )
          }
        />
      </div>
    );
  }
}
