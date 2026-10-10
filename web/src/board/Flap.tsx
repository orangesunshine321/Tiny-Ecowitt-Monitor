/**
 * Split-flap cells. React renders each cell's skeleton once; flapEngine.ts turns the faces imperatively, so a
 * character change never re-renders React (≈ 200 cells on the fullscreen board).
 */
import { memo, useEffect, useLayoutEffect, useRef, type RefObject } from 'react';
import { useReducedMotion } from '../hooks/useMediaQuery';
import { CHAR_DRUM, fitText } from './drum';
import { FLAP_TIMING, createFlapCell, createFlapGroup, snapGroup, type FlapGroup, type FlapHandle } from './flapEngine';

export interface FlapProps {
  /** target face (a character, or a word on a word drum) */
  value: string;
  drum: readonly string[];
  group: FlapGroup;
  /** stagger before this cell starts turning (ms) */
  delay?: number;
  /** start on the drum's blank home face and turn to `value` (the opening ripple) */
  intro?: boolean;
  /** 'word' cells are wide and left-aligned (REMARKS) */
  variant?: 'char' | 'word';
  className?: string;
}

/**
 * One flap module: static top/bottom halves, a falling top flap and a rising bottom flap, plus a hinge line. Each
 * half is an `overflow:hidden` half-height box holding a full-height glyph (pixel-stable, no clip-path).
 */
export const Flap = memo(function Flap({ value, drum, group, delay = 0, intro = false, variant = 'char', className }: FlapProps) {
  const ref = useRef<HTMLSpanElement>(null);
  const handle = useRef<FlapHandle | null>(null);
  const valueRef = useRef(value);
  valueRef.current = value;

  // create before paint so the first frame already shows a face (blank for the intro, else the value)
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const h = createFlapCell(el, drum, group, intro ? (drum[0] ?? '') : valueRef.current);
    handle.current = h;
    return () => {
      h.dispose();
      handle.current = null;
    };
    // `intro` and the value only matter at creation; later values arrive through set() below
  }, [drum, group]);

  useEffect(() => {
    handle.current?.set(value, delay);
  }, [value, delay, drum, group]);

  return (
    <span ref={ref} className={`flap ${className ?? ''}`} data-variant={variant === 'word' ? 'word' : undefined} aria-hidden="true">
      <span className="flap-half flap-top">
        <span className="flap-g" />
      </span>
      <span className="flap-half flap-bottom">
        <span className="flap-g" />
      </span>
      <span className="flap-half flap-top flap-fall">
        <span className="flap-g" />
        <span className="flap-shade" />
      </span>
      <span className="flap-half flap-bottom flap-rise">
        <span className="flap-g" />
        <span className="flap-shade" />
      </span>
    </span>
  );
});

export interface FlapTextProps {
  text: string;
  /** number of flaps */
  width: number;
  align?: 'left' | 'right';
  drum?: readonly string[];
  group: FlapGroup;
  /** row index (vertical stagger) */
  row?: number;
  /** column offset of the first flap (horizontal stagger across columns) */
  col?: number;
  intro?: boolean;
  className?: string;
}

/** `width` character flaps showing `text` (normalised, cut and padded with blank flaps). */
export function FlapText({ text, width, align = 'left', drum = CHAR_DRUM, group, row = 0, col = 0, intro, className }: FlapTextProps) {
  const chars = fitText(text, width, align, drum);
  return (
    <span className={`flap-text ${className ?? ''}`}>
      {chars.map((ch, i) => (
        <Flap key={i} value={ch} drum={drum} group={group} intro={intro} delay={row * FLAP_TIMING.row + (col + i) * FLAP_TIMING.col} />
      ))}
    </span>
  );
}

/**
 * A stable FlapGroup for one board: keeps `sound`/`reduced` current, and tracks whether the board is on screen
 * (off-screen boards jump straight to their faces instead of animating).
 */
export function useFlapGroup(containerRef: RefObject<HTMLElement | null>, opts: { sound?: boolean } = {}): FlapGroup {
  const reduced = useReducedMotion();
  const groupRef = useRef<FlapGroup | null>(null);
  if (!groupRef.current) groupRef.current = createFlapGroup({ reduced, sound: !!opts.sound });
  const group = groupRef.current;
  group.reduced = reduced;
  group.sound = !!opts.sound;

  useEffect(() => {
    const el = containerRef.current;
    if (!el || typeof IntersectionObserver === 'undefined') return;
    const io = new IntersectionObserver(
      (entries) => {
        const visible = entries.some((e) => e.isIntersecting);
        group.visible = visible;
        if (!visible) snapGroup(group);
      },
      { threshold: 0 },
    );
    io.observe(el);
    return () => io.disconnect();
  }, [containerRef, group]);

  return group;
}

/** CSS custom properties that carry FLAP_TIMING into the keyframes. */
export const FLAP_TIMING_VARS = {
  '--flap-step': `${FLAP_TIMING.step}ms`,
  '--flap-final': `${FLAP_TIMING.final}ms`,
  '--flap-fade': `${FLAP_TIMING.fade}ms`,
} as const;
