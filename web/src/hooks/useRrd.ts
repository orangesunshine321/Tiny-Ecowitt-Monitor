import type { RrdPoint, Timeframe } from '../../../shared/types';
import { getGuestRrd, getNodeRrd } from '../api';
import { useAsync, type AsyncState } from './useAsync';

/** How often each timeframe is refreshed (RRD resolution: hour = 1 min, day = 30 min, …). */
const REFRESH_MS: Record<Timeframe, number> = {
  hour: 60_000,
  day: 5 * 60_000,
  week: 30 * 60_000,
  month: 60 * 60_000,
  year: 6 * 60 * 60_000,
};

/**
 * Node or guest RRD history for a timeframe, refreshed periodically. Pass `timeframe: null` to skip loading (e.g. when
 * the "Live" segment shows the SSE history instead).
 *
 * @example const { data, loading, error } = useRrd({ kind: 'node' }, 'day');
 */
export function useRrd(
  target: { kind: 'node' } | { kind: 'guest'; vmid: number },
  timeframe: Timeframe | null,
): AsyncState<RrdPoint[]> {
  const vmid = target.kind === 'guest' ? target.vmid : undefined;
  return useAsync<RrdPoint[]>(
    (signal) => (vmid === undefined ? getNodeRrd(timeframe!, { signal }) : getGuestRrd(vmid, timeframe!, { signal })),
    [vmid, timeframe],
    { enabled: timeframe !== null, refreshMs: timeframe ? REFRESH_MS[timeframe] : undefined },
  );
}
