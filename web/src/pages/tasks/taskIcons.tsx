/** Glyph per task family (taskModel.TaskKind). Neutral glyphs: the status pill carries the colour. */
import {
  Archive,
  ArchiveRestore,
  ArrowRightLeft,
  Camera,
  Copy,
  Download,
  HardDrive,
  KeyRound,
  ListChecks,
  Network,
  Pause,
  Play,
  Plus,
  Power,
  RotateCw,
  Server,
  Settings2,
  ShieldCheck,
  Square,
  SquareTerminal,
  Terminal,
  Trash,
  Users,
  Database,
  type LucideIcon,
} from 'lucide-react';
import { GlyphTile } from '../storage/ui';
import { taskKind, type TaskKind } from './taskModel';

const ICONS: Record<TaskKind, LucideIcon> = {
  backup: Archive,
  restore: ArchiveRestore,
  start: Play,
  stop: Square,
  shutdown: Power,
  reboot: RotateCw,
  pause: Pause,
  console: SquareTerminal,
  shell: Terminal,
  create: Plus,
  clone: Copy,
  destroy: Trash,
  migrate: ArrowRightLeft,
  snapshot: Camera,
  config: Settings2,
  disk: HardDrive,
  storage: Database,
  update: Download,
  service: Server,
  network: Network,
  certificate: ShieldCheck,
  ha: KeyRound,
  user: Users,
  other: ListChecks,
};

export function taskIcon(kind: TaskKind): LucideIcon {
  return ICONS[kind] ?? ListChecks;
}

/** A neutral rounded tile with the task family glyph. */
export function TaskGlyph({ type, kind, size = 30 }: { type?: string; kind?: TaskKind; size?: number }) {
  const Icon = taskIcon(kind ?? taskKind(type ?? ''));
  return (
    <GlyphTile size={size}>
      <Icon strokeWidth={2} />
    </GlyphTile>
  );
}
