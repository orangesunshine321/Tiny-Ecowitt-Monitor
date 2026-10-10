import { Toast } from '../components/Toast';
import { navigate } from '../router';
import { dismissToast, useToasts } from '../store';
import './Toasts.css';

/** Top-centre stack of live toasts (alerts, update prompts). Newest at the bottom of the stack. */
export function Toasts() {
  const toasts = useToasts();
  return (
    <section className="shell-toasts" aria-label="Notifications" aria-live="polite">
      {toasts.map((t) => (
        <Toast key={t.id} toast={t} onDismiss={dismissToast} onOpen={(p) => navigate(p)} />
      ))}
    </section>
  );
}
