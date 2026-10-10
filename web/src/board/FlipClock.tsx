import { useRef } from 'react';
import { useServerNow } from '../hooks/useNow';
import { DIGIT_DRUM } from './drum';
import { Flap, useFlapGroup } from './Flap';

const pad = (n: number) => String(n).padStart(2, '0');

/**
 * Station flip clock: 24-hour HH:MM on digit drums (9 → 0 is one flap, like a real clock), a blinking colon, and the
 * server-corrected time so a wall iPad with a drifting clock still shows the server's time.
 */
export function FlipClock({ sound }: { sound: boolean }) {
  const ref = useRef<HTMLDivElement>(null);
  const group = useFlapGroup(ref, { sound });
  const now = useServerNow(1000);
  const d = new Date(now);
  const hh = pad(d.getHours());
  const mm = pad(d.getMinutes());
  return (
    <div ref={ref} className="fb bd-clock" role="timer" aria-label={`Time ${hh}:${mm}`}>
      <span className="flap-text" aria-hidden="true">
        <Flap value={hh[0]!} drum={DIGIT_DRUM} group={group} />
        <Flap value={hh[1]!} drum={DIGIT_DRUM} group={group} delay={30} />
      </span>
      <span className="bd-clock-colon" aria-hidden="true">
        <i />
        <i />
      </span>
      <span className="flap-text" aria-hidden="true">
        <Flap value={mm[0]!} drum={DIGIT_DRUM} group={group} delay={60} />
        <Flap value={mm[1]!} drum={DIGIT_DRUM} group={group} delay={90} />
      </span>
    </div>
  );
}
