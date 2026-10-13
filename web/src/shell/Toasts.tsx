import { Portal } from '../components/Portal';
import { Toast } from '../components/Toast';
import { navigate } from '../router';
import { dismissToast, useToasts } from '../store';
import './Toasts.css';

/**
 * Top-centre stack of live toasts (alerts, update prompts). Newest at the bottom of the stack.
 *
 * Rendered in a portal outside #root, above sheets and Spotlight: while a modal is open #root is inert, and a toast
 * inside it (e.g. "New version available — Reload") could not be tapped or dismissed.
 */
export function Toasts() {
  const toasts = useToasts();
  return (
    <Portal>
      <section className="shell-toasts" aria-label="Notifications" aria-live="polite">
        {toasts.map((t) => (
          <Toast key={t.id} toast={t} onDismiss={dismissToast} onOpen={(p) => navigate(p)} />
        ))}
      </section>
    </Portal>
  );
}
