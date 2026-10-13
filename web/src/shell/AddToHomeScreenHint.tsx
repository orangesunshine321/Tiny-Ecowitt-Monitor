import { Share, SquarePlus } from 'lucide-react';
import { useEffect, useState } from 'react';
import { needsHomeScreenInstall } from '../push';
import './AddToHomeScreenHint.css';

/** True on iOS/iPadOS in a Safari tab (push needs the Home Screen app). Re-checks when the display mode changes. */
export function useNeedsHomeScreenInstall(): boolean {
  const [needs, setNeeds] = useState(() => needsHomeScreenInstall());
  useEffect(() => {
    let mql: MediaQueryList | undefined;
    try {
      mql = window.matchMedia('(display-mode: standalone)');
    } catch {
      return;
    }
    const on = () => setNeeds(needsHomeScreenInstall());
    mql.addEventListener('change', on);
    return () => mql?.removeEventListener('change', on);
  }, []);
  return needs;
}

export interface AddToHomeScreenHintProps {
  /** show even when not on iOS (previews, the component gallery) */
  force?: boolean;
  /** what the install unlocks, shown under the title */
  reason?: string;
  className?: string;
}

/**
 * "Add to Home Screen first" instructions for iOS/iPadOS Safari, where Web Push only works in the installed web app.
 * Renders nothing elsewhere (unless `force`). Place it inside a Card.
 */
export function AddToHomeScreenHint({ force, reason = 'Notifications on iPhone and iPad work only in the Home Screen app.', className }: AddToHomeScreenHintProps) {
  const needs = useNeedsHomeScreenInstall();
  // Over plain HTTP a Home Screen app can't get push or a service worker: Settings explains "open the HTTPS address"
  // instead, so don't suggest installing from here.
  if (!force && (!needs || (typeof window !== 'undefined' && !window.isSecureContext))) return null;
  return (
    <div className={`shell-a2hs ${className ?? ''}`}>
      <img src="/icons/apple-touch-icon.png" alt="" />
      <div>
        <div className="shell-a2hs-title">Add pve1 to your Home Screen</div>
        <div className="shell-a2hs-text">{reason}</div>
        <ol>
          <li>
            <span>
              Tap{' '}
              <span className="shell-a2hs-glyph" role="img" aria-label="Share">
                <Share size={15} strokeWidth={2.2} aria-hidden="true" />
              </span>{' '}
              <strong>Share</strong> in Safari’s toolbar.
            </span>
          </li>
          <li>
            <span>
              Choose{' '}
              <span className="shell-a2hs-glyph" aria-hidden="true">
                <SquarePlus size={15} strokeWidth={2.2} />
              </span>{' '}
              <strong>Add to Home Screen</strong>, then <strong>Add</strong>.
            </span>
          </li>
          <li>
            <span>Open pve1 from the Home Screen and enable notifications in Settings.</span>
          </li>
        </ol>
      </div>
    </div>
  );
}
