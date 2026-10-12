/**
 * Guest detail → Notes: the Proxmox description as TEXT. Markup that helper scripts write into notes is reduced to its
 * text (notes.ts), links become plain http(s) anchors and are also listed; nothing is ever rendered as HTML and no
 * image is loaded.
 */
import { Link2, StickyNote } from 'lucide-react';
import { useMemo } from 'react';
import type { Guest } from '../../../../../shared/types';
import { Card, EmptyState, ListGroup, ListRow } from '../../../components';
import { parseNotes, type NoteLine } from './notes';

function hostPath(href: string): string {
  try {
    const u = new URL(href);
    const path = u.pathname === '/' ? '' : u.pathname;
    return `${u.host}${path}`;
  } catch {
    return href;
  }
}

function Line({ line }: { line: NoteLine }) {
  if (!line.spans.length) return <span className="gd-notes-gap" aria-hidden="true" />;
  const Tag = line.heading ? 'strong' : 'span';
  return (
    <Tag className="gd-notes-line" data-heading={line.heading || undefined}>
      {line.spans.map((s, i) =>
        s.href ? (
          <a key={i} href={s.href} target="_blank" rel="noopener noreferrer" title={s.href}>
            {s.text}
          </a>
        ) : (
          <span key={i}>{s.text}</span>
        ),
      )}
    </Tag>
  );
}

export function NotesTab({ guest: g }: { guest: Guest }) {
  const notes = useMemo(() => parseNotes(g.description), [g.description]);
  if (!notes.lines.length) {
    return (
      <Card className="gd-unavailable">
        <EmptyState
          icon={<StickyNote size={26} strokeWidth={1.9} />}
          title="No notes"
          message="Notes you write for this guest in Proxmox (Summary → Notes) show up here."
        />
      </Card>
    );
  }
  return (
    <div className="gd-stack">
      <Card
        title="Notes"
        subtitle={notes.html ? 'From Proxmox · formatting removed' : 'From Proxmox'}
        icon={<StickyNote size={16} strokeWidth={2.2} />}
        iconColor="var(--yellow)"
      >
        {/* React renders text nodes only; the parser never produces markup */}
        <div className="gd-notes">
          {notes.lines.map((line, i) => (
            <Line key={i} line={line} />
          ))}
        </div>
      </Card>
      {notes.html && notes.links.length > 0 && (
        <Card title="Links" subtitle="From the notes" padding="none" className="gd-list" icon={<Link2 size={16} strokeWidth={2.2} />} iconColor="var(--blue)">
          <ListGroup plain ariaLabel="Links in the notes">
            {notes.links.map((l) => (
              <ListRow key={l.href} dense href={l.href} title={l.label} subtitle={<span className="t-mono gd-break">{hostPath(l.href)}</span>} />
            ))}
          </ListGroup>
        </Card>
      )}
    </div>
  );
}
