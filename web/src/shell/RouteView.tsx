import { CloudOff } from 'lucide-react';
import { Suspense, useEffect, useLayoutEffect, useSyncExternalStore } from 'react';
import { Button } from '../components/Button';
import { EmptyState } from '../components/EmptyState';
import { PageSkeleton } from '../components/Skeleton';
import { applyScroll, useRoute, type LazyPage } from '../router';
import { reconnectNow, useConnection, useHasSnapshot } from '../store';
import { ErrorBoundary } from './ErrorBoundary';
import { NotFound } from './NotFound';

const noPage = { subscribe: () => () => undefined, isSettled: () => true, preload: () => Promise.resolve() };

/**
 * Renders the matched page. Pages only render once the first snapshot arrived AND their chunk is loaded; until then a
 * skeleton (outside Suspense, so React's 300 ms Suspense reveal throttle never applies) or a "can't reach the server"
 * state shows. The chunk is requested right away, in parallel with the snapshot (main.tsx starts it even earlier).
 * An error boundary keeps a failing page (or a page chunk deleted by a server update) from blanking the whole app;
 * it resets with the route key.
 */
export function RouteView() {
  const route = useRoute();
  const has = useHasSnapshot();
  const page: Pick<LazyPage, 'subscribe' | 'isSettled' | 'preload'> = route.route?.component ?? noPage;
  const ready = useSyncExternalStore(page.subscribe, page.isSettled, page.isSettled);
  useEffect(() => {
    void page.preload();
  }, [page]);

  // restore/reset scroll for the new history entry (inside flushSync during view transitions)
  const { key } = route;
  useLayoutEffect(() => {
    applyScroll();
  }, [key]);

  if (!route.route) return <NotFound />;
  if (!has || !ready) return <Waiting />;
  const Page = route.route.component;
  return (
    <div className="route-view" key={route.key} data-enter={route.animateEnter || undefined}>
      <ErrorBoundary scope="page">
        <Suspense fallback={<PageSkeleton />}>
          <Page />
        </Suspense>
      </ErrorBoundary>
    </div>
  );
}

function Waiting() {
  const { connection, lastError } = useConnection();
  if (connection === 'offline') {
    return (
      <EmptyState
        icon={<CloudOff size={28} strokeWidth={1.8} />}
        tone="crit"
        title="Can’t reach the dashboard"
        message={
          <>
            pve1-dash isn’t answering{lastError ? ` (${lastError})` : ''}. It retries automatically; check that the service is running and
            that your reverse proxy forwards /api/stream.
          </>
        }
        action={
          <Button variant="prominent" onClick={() => reconnectNow()}>
            Try Again
          </Button>
        }
      />
    );
  }
  return <PageSkeleton />;
}
