/** The Attention items of the live snapshot, shared by the Attention card and the iPhone status strip. */
import { useMemo } from 'react';
import type { Snapshot } from '../../../../shared/types';
import { useServerNow } from '../../hooks';
import { shallowEqual, useSnapshot } from '../../store';
import { deriveAttention, type AttentionInput, type AttentionItem } from './attention';

const select = (s: Snapshot): AttentionInput => ({
  node: s.node,
  alerts: s.alerts,
  zfs: s.zfs,
  disks: s.disks,
  services: s.services,
  guests: s.guests,
  inventory: s.inventory,
  backups: s.backups,
  tasks: s.tasks,
  storage: s.storage,
  meta: s.meta,
  hostInventory: s.hostInventory,
});

/** One derivation per snapshot + minute, however many components ask (the strip and the card render together). */
let cache: { input: AttentionInput; now: number; items: AttentionItem[] } | null = null;

function derive(input: AttentionInput, now: number): AttentionItem[] {
  if (cache && cache.now === now && shallowEqual(cache.input, input)) return cache.items;
  const items = deriveAttention(input, now);
  cache = { input, now, items };
  return items;
}

export function useAttention(): AttentionItem[] {
  const input = useSnapshot(select);
  const now = useServerNow(60_000);
  return useMemo(() => derive(input, now), [input, now]);
}
