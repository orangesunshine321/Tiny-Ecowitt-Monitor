import { useRoute } from './router';
import { AppShell } from './shell/AppShell';
import { RouteView } from './shell/RouteView';
import { Toasts } from './shell/Toasts';

/** Chooses the chrome for the current route: the full shell, or none for the fullscreen departure board. */
export default function App() {
  const route = useRoute();
  if (route.route?.fullscreen) {
    return (
      <>
        <RouteView />
        <Toasts />
      </>
    );
  }
  return (
    <AppShell>
      <RouteView />
    </AppShell>
  );
}
