/**
 * iPhone Overview: one line under the large title that answers "is anything wrong?" before anything else — the worst
 * severity with its counts (or "All systems nominal"), and whether the node is up. Opens Alerts.
 */
import { ChevronRight } from 'lucide-react';
import type { Snapshot } from '../../../../shared/types';
import { StatusIcon, type Tone } from '../../components';
import { formatDuration } from '../../format';
import { Link } from '../../router';
import { useSnapshot } from '../../store';
import { attentionCounts, countsTitle, nodeProblemTitle, type AttentionCounts } from './attention';
import { useAttention } from './useAttention';

const TONE: Record<NonNullable<AttentionCounts['worst']>, Tone> = { critical: 'crit', warning: 'warn', info: 'info' };

const selectNode = (s: Snapshot) => ({
  name: s.node.node,
  online: s.node.online,
  errorKind: s.node.errorKind,
  // whole hours: the strip doesn't need to re-render on every 5 s poll
  uptimeHours: Math.floor(s.node.uptime / 3600),
  running: s.guests.filter((g) => g.status === 'running' && !g.template).length,
  total: s.guests.filter((g) => !g.template).length,
});

export function StatusStrip() {
  const items = useAttention();
  const node = useSnapshot(selectNode);
  const c = attentionCounts(items);
  const offline = !node.online;
  const tone: Tone = offline ? 'crit' : c.worst ? TONE[c.worst] : 'ok';
  const title = offline ? `${node.name} is offline` : countsTitle(c);
  const subtitle = offline
    ? nodeProblemTitle({ node: node.name, errorKind: node.errorKind })
    : [
        node.uptimeHours > 0 ? `${node.name} up ${formatDuration(node.uptimeHours * 3600)}` : `${node.name} online`,
        node.total ? `${node.running}/${node.total} guests running` : undefined,
        c.snoozed ? `${c.snoozed} snoozed` : undefined,
      ]
        .filter(Boolean)
        .join(' · ');
  return (
    <Link to={offline ? '/settings#diagnostics' : '/alerts'} className="ov-strip material-card" data-tone={tone} aria-label={`${title}. ${subtitle}`}>
      <span className="ov-strip-icon" aria-hidden="true">
        <StatusIcon tone={tone} size={19} colored={false} />
      </span>
      <span className="ov-strip-text">
        <span className="ov-strip-title">{title}</span>
        <span className="ov-strip-sub">{subtitle}</span>
      </span>
      <ChevronRight className="ov-strip-chevron" size={17} strokeWidth={2.4} aria-hidden="true" />
    </Link>
  );
}
