/**
 * Alerts (DESIGN §5): active alerts grouped by severity, and a timeline of recent alerts including resolved ones.
 * Rows open the page that explains the alert (alert.path, in-app paths only). Alert text is rendered as plain text.
 */
import { BellRing, ChevronRight, CircleCheck, History } from 'lucide-react';
import { useMemo, useState } from 'react';
import type { AlertEvent } from '../../../shared/types';
import {
  Button,
  Card,
  EmptyState,
  IconButton,
  ListGroup,
  ListRow,
  PageHeader,
  RelativeTime,
  StatusBadge,
  StatusIcon,
  TONE_COLOR,
  ToolbarGroup,
} from '../components';
import { formatDuration, formatTime, plural } from '../format';
import { useServerNow } from '../hooks/useNow';
import { Link, navigate } from '../router';
import { useAlerts } from '../store';
import { SEVERITY_LABEL, SEVERITY_TONE, kindInfo } from './alerts/alertKinds';
import { activeSummary, groupByDay, groupBySeverity, resolvedAfterSec, safeAppPath } from './alerts/alertsModel';
import './alerts/alerts.css';

/** History items shown before "Show more". */
const HISTORY_PAGE = 25;

const dayFormat = new Intl.DateTimeFormat(undefined, {
  weekday: 'long',
  day: 'numeric',
  month: 'long',
});

export default function AlertsPage() {
  const { active, recent } = useAlerts();
  const groups = useMemo(() => groupBySeverity(active), [active]);
  const summary = activeSummary(active);

  return (
    <>
      <PageHeader
        title="Alerts"
        subtitle={summary || 'All clear'}
        toolbar={
          <ToolbarGroup label="Notifications">
            <IconButton
              icon={<BellRing size={18} strokeWidth={2} />}
              label="Notification settings"
              onClick={() => navigate('/settings#notifications')}
            />
          </ToolbarGroup>
        }
      />
      <div className="al-wrap">
        <div className="al-page">
          <div className="al-active">
            {groups.length === 0 ? (
              <Card className="al-allclear">
                <EmptyState
                  tone="ok"
                  icon={<CircleCheck size={28} strokeWidth={1.8} />}
                  title="All clear"
                  message="Nothing needs your attention right now. New alerts appear here and, if you enabled them, as notifications."
                />
              </Card>
            ) : (
              groups.map((g) => (
                <ListGroup
                  key={g.severity}
                  className="al-group"
                  header={
                    <span className="al-group-header" data-tone={SEVERITY_TONE[g.severity]}>
                      <StatusIcon tone={SEVERITY_TONE[g.severity]} size={13} />
                      {SEVERITY_LABEL[g.severity]}
                      <span className="al-group-count">{g.alerts.length}</span>
                    </span>
                  }
                >
                  {g.alerts.map((a) => (
                    <ActiveRow key={a.id} alert={a} />
                  ))}
                </ListGroup>
              ))
            )}
          </div>

          <Card
            className="al-history"
            title="History"
            subtitle={recent.length ? `${plural(recent.length, 'recent alert')}, newest first` : 'Recent alerts'}
            icon={<History size={16} strokeWidth={2.2} />}
            iconColor="var(--gray)"
            padding="none"
          >
            <Timeline events={recent} />
          </Card>
        </div>
      </div>
    </>
  );
}

function ActiveRow({ alert: a }: { alert: AlertEvent }) {
  const info = kindInfo(a.kind);
  const Icon = info.icon;
  const tone = SEVERITY_TONE[a.severity];
  return (
    <ListRow
      wrap
      icon={<Icon strokeWidth={2.1} />}
      iconColor={TONE_COLOR[tone]}
      title={<span className="al-row-title">{a.title}</span>}
      subtitle={
        <span className="al-row-sub">
          <span className="al-row-body">{a.body}</span>
          <span className="al-row-meta">
            {info.label} · <RelativeTime time={a.time} prefix="started " />
          </span>
        </span>
      }
      href={safeAppPath(a.path)}
    />
  );
}

function Timeline({ events }: { events: readonly AlertEvent[] }) {
  const now = useServerNow(60_000);
  const [limit, setLimit] = useState(HISTORY_PAGE);
  const days = useMemo(() => groupByDay(events, now, (t) => dayFormat.format(t)), [events, now]);

  if (!events.length) {
    return (
      <EmptyState
        compact
        className="al-history-empty"
        icon={<History size={24} strokeWidth={1.9} />}
        title="No history yet"
        message="Alerts that fire and resolve are listed here."
      />
    );
  }

  let shown = 0;
  const total = days.reduce((n, d) => n + d.events.length, 0);
  return (
    <div className="al-tl">
      {days.map((d) => {
        if (shown >= limit) return null;
        const items = d.events.slice(0, limit - shown);
        shown += items.length;
        return (
          <section key={d.key} className="al-tl-day" aria-label={d.label}>
            <h3 className="al-tl-dayhead">{d.label}</h3>
            <ol className="al-tl-list">
              {items.map((e) => (
                <TimelineItem key={e.id} event={e} now={now} />
              ))}
            </ol>
          </section>
        );
      })}
      {total > limit && (
        <div className="al-tl-more">
          <Button variant="plain" onClick={() => setLimit((l) => l + HISTORY_PAGE)}>
            Show {Math.min(HISTORY_PAGE, total - limit)} more
          </Button>
        </div>
      )}
    </div>
  );
}

function TimelineItem({ event: e, now }: { event: AlertEvent; now: number }) {
  const tone = SEVERITY_TONE[e.severity];
  const after = resolvedAfterSec(e);
  const path = safeAppPath(e.path);
  const status = e.resolved ? (
    <StatusBadge tone="ok" size="small" label={after !== undefined ? `Resolved after ${formatDuration(after, { units: 1 })}` : 'Resolved'} />
  ) : (
    <StatusBadge tone={tone} size="small" label={`Active · ${formatDuration(Math.max(0, (now - e.time) / 1000), { units: 1 })}`} />
  );
  const content = (
    <>
      <time className="al-tl-time" dateTime={new Date(e.time).toISOString()}>
        {formatTime(e.time)}
      </time>
      <span className="al-tl-node" aria-hidden="true">
        <i />
      </span>
      <span className="al-tl-body">
        <span className="al-tl-title">{e.title}</span>
        <span className="al-tl-text">{e.body}</span>
        <span className="al-tl-meta">
          {status}
          <span className="al-tl-kind">
            {SEVERITY_LABEL[e.severity]} · {kindInfo(e.kind).label}
          </span>
        </span>
      </span>
      {path && <ChevronRight className="al-tl-chevron" size={16} strokeWidth={2.4} aria-hidden="true" />}
    </>
  );
  return (
    <li className="al-tl-item" data-tone={tone} data-resolved={e.resolved || undefined}>
      {path ? (
        <Link to={path} className="al-tl-row">
          {content}
        </Link>
      ) : (
        <div className="al-tl-row">{content}</div>
      )}
    </li>
  );
}
