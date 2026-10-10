import { CloudOff } from 'lucide-react';
import { Suspense, useLayoutEffect } from 'react';
import { Button } from '../components/Button';
import { EmptyState } from '../components/EmptyState';
import { PageSkeleton } from '../components/Skeleton';
import { applyScroll, useRoute } from '../router';
import { reconnectNow, useConnection, useHasSnapshot } from '../store';
import { NotFound } from './NotFound';

/**
 * Renders the matched page (lazy, inside Suspense with a page skeleton). Pages only render once the first snapshot
 * arrived; until then a skeleton or a "can't reach the server" state shows.
 */
export function RouteView() {
  const route = useRoute();
  const has = useHasSnapshot();

  // restore/reset scroll for the new history entry (inside flushSync during view transitions)
  const { key } = route;
  useLayoutEffect(() => {
    applyScroll();
  }, [key]);

  if (!route.route) return <NotFound />;
  if (!has) return <Waiting />;
  const Page = route.route.component;
  return (
    <div className="route-view" key={route.key} data-enter={route.animateEnter || undefined}>
      <Suspense fallback={<PageSkeleton />}>
        <Page />
      </Suspense>
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
