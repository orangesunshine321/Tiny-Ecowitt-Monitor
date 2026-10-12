import { CircleCheck, CircleMinus, Info, LoaderCircle, OctagonX, TriangleAlert, type LucideIcon } from 'lucide-react';
import { TONE_COLOR, type Tone } from './status';

const ICONS: Record<Tone, LucideIcon> = {
  ok: CircleCheck,
  warn: TriangleAlert,
  crit: OctagonX,
  off: CircleMinus,
  info: Info,
};

export interface StatusIconProps {
  tone: Tone;
  /** px, default 14 */
  size?: number;
  /** show a spinner instead of the info glyph (running tasks) */
  spinning?: boolean;
  /** colour the glyph with the tone (default) or inherit currentColor */
  colored?: boolean;
  className?: string;
}

/** The glyph that accompanies a status colour (never colour alone). Decorative: pair it with text. */
export function StatusIcon({ tone, size = 14, spinning, colored = true, className }: StatusIconProps) {
  const Icon = spinning ? LoaderCircle : ICONS[tone];
  return (
    <Icon
      aria-hidden="true"
      size={size}
      strokeWidth={2.2}
      className={[spinning ? 'ui-spin' : '', className ?? ''].join(' ').trim() || undefined}
      style={colored ? { color: TONE_COLOR[tone] } : undefined}
    />
  );
}
