import { Compass } from 'lucide-react';
import { Button } from '../components/Button';
import { EmptyState } from '../components/EmptyState';
import { PageHeader } from './PageHeader';

/** Shown for unknown in-app paths. */
export function NotFound() {
  return (
    <>
      <PageHeader title="Not Found" />
      <EmptyState
        icon={<Compass size={28} strokeWidth={1.8} />}
        title="This page doesn’t exist"
        message="The link may be out of date. Everything on pve1 is reachable from the sidebar or with ⌘K."
        action={
          <Button href="/" variant="prominent">
            Go to Overview
          </Button>
        }
      />
    </>
  );
}
