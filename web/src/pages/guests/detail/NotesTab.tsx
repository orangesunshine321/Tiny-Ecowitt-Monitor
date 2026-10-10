/** Guest detail → Notes: the Proxmox description as PLAIN text (never HTML or markdown). */
import { StickyNote } from 'lucide-react';
import type { Guest } from '../../../../../shared/types';
import { Card, EmptyState } from '../../../components';

export function NotesTab({ guest: g }: { guest: Guest }) {
  const text = g.description?.replace(/\s+$/, '') ?? '';
  if (!text.trim()) {
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
    <Card title="Notes" subtitle="From Proxmox · shown as plain text" icon={<StickyNote size={16} strokeWidth={2.2} />} iconColor="var(--yellow)">
      {/* React escapes text content; white-space: pre-wrap keeps the author's line breaks */}
      <p className="gd-notes">{text}</p>
    </Card>
  );
}
