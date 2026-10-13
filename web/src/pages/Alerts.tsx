/**
 * Alerts (DESIGN §5): active alerts grouped by severity, and a timeline of recent alerts including resolved ones.
 * Rows open the page that explains the alert (alert.path, in-app paths only). Alert text is rendered as plain text.
 *
 * Snooze (decision 6, D51): each active alert has a snooze menu (1 hour … until it resolves). A snoozed alert sends
 * no notifications and doesn't count in badges; it moves to a muted "Snoozed" group with an Unsnooze action. The
 * server ends a snooze early when the severity rises. The history marks what is new since the last visit (D68).
 */
import { Bell, BellOff, BellRing, ChevronRight, CircleCheck, History } from 'lucide-react';
import { Fragment, useMemo, useRef, useState, type CSSProperties } from 'react';
import type { AlertEvent } from '../../../shared/types';
import {
  Button,
  Card,
  EmptyState,
  IconButton,
  ListGroup,
  ListRow,
  PageHeader,
  Popover,
  RelativeTime,
  StatusBadge,
  StatusIcon,
  TONE_COLOR,
  ToolbarGroup,
} from '../components';
import { errorText, postAlertAck, postAlertUnack } from '../api';
import { formatDuration, formatTime, plural } from '../format';
import { useLastVisit } from '../hooks/useLastVisit';
import { useServerNow } from '../hooks/useNow';
import { Link, navigate } from '../router';
import { applyPatch, pushToast, serverNow, useAlerts, useAppStore } from '../store';
import { SEVERITY_LABEL, SEVERITY_TONE, kindInfo } from './alerts/alertKinds';
import {
  SNOOZE_OPTIONS,
  groupByDay,
  groupBySeverity,
  isSnoozed,
  lastVisitDividerId,
  pageSummary,
  resolvedAfterSec,
  safeAppPath,
  snoozeLabel,
  splitSnoozed,
} from './alerts/alertsModel';
import './alerts/alerts.css';

/** History items shown before "Show more". */
const HISTORY_PAGE = 25;

const dayFormat = new Intl.DateTimeFormat(undefined, {
  weekday: 'long',
  day: 'numeric',
  month: 'long',
});
const shortDay = new Intl.DateTimeFormat(undefined, { weekday: 'short' });
const SNOOZE_FMT = { time: (t: number) => formatTime(t), day: (t: number) => shortDay.format(t) };

/** Put an updated alert into the store right away (the alerts patch over SSE follows). */
function applyAlert(ev: AlertEvent): void {
  const cur = useAppStore.getState().snapshot?.alerts;
  if (!cur) return;
  const swap = (list: AlertEvent[]) => list.map((a) => (a.id === ev.id ? ev : a));
  applyPatch('alerts', { active: swap(cur.active), recent: swap(cur.recent) });
}

export default function AlertsPage() {
  const { active, recent } = useAlerts();
  // a timed snooze ends on the server clock: re-split every half minute
  const now = useServerNow(30_000);
  const { live, snoozed } = useMemo(() => splitSnoozed(active, now), [active, now]);
  const groups = useMemo(() => groupBySeverity(live), [live]);
  const summary = pageSummary(active, now);

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
                  message={
                    snoozed.length
                      ? `Nothing else needs your attention. ${plural(snoozed.length, 'snoozed alert')} stay${snoozed.length === 1 ? 's' : ''} below until ${snoozed.length === 1 ? 'it resolves or its' : 'they resolve or their'} snooze ends.`
                      : 'Nothing needs your attention right now. New alerts appear here and, if you enabled them, as notifications.'
                  }
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
                    <ActiveRow key={a.id} alert={a} now={now} />
                  ))}
                </ListGroup>
              ))
            )}
            {snoozed.length > 0 && (
              <ListGroup
                className="al-group al-group-snoozed"
                header={
                  <span className="al-group-header" data-tone="off">
                    <BellOff size={13} strokeWidth={2.3} aria-hidden="true" />
                    Snoozed
                    <span className="al-group-count">{snoozed.length}</span>
                  </span>
                }
                footer="No notifications and no badge while snoozed. A snooze ends early if the alert gets worse."
              >
                {snoozed.map((a) => (
                  <ActiveRow key={a.id} alert={a} now={now} snoozed />
                ))}
              </ListGroup>
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

/**
 * One active alert: the row opens the explaining page; the trailing bell opens the snooze menu. The link and the
 * button are siblings (a button inside a link is invalid), so this is not a ListRow.
 */
function ActiveRow({ alert: a, now, snoozed }: { alert: AlertEvent; now: number; snoozed?: boolean }) {
  const info = kindInfo(a.kind);
  const Icon = info.icon;
  const tone = SEVERITY_TONE[a.severity];
  const path = safeAppPath(a.path);
  const content = (
    <>
      <span className="ui-row-icon" data-tinted style={{ '--_icon-bg': snoozed ? 'var(--gray)' : TONE_COLOR[tone] } as CSSProperties} aria-hidden="true">
        <Icon strokeWidth={2.1} />
      </span>
      <span className="ui-row-text">
        <span className="ui-row-title al-row-title">{a.title}</span>
        <span className="ui-row-subtitle al-row-sub">
          <span className="al-row-body">{a.body}</span>
          <span className="al-row-meta">
            {snoozed && <span className="al-row-snoozed">{snoozeLabel(a.acknowledged, now, SNOOZE_FMT)} · </span>}
            {snoozed ? `${SEVERITY_LABEL[a.severity]} · ` : ''}
            {info.label} · <RelativeTime time={a.time} prefix="started " />
          </span>
        </span>
      </span>
      {path && <ChevronRight className="ui-row-chevron" size={17} strokeWidth={2.4} aria-hidden="true" />}
    </>
  );
  return (
    <div role="listitem" className="al-arow" data-snoozed={snoozed || undefined}>
      {path ? (
        <Link to={path} className="ui-row al-arow-main" data-has-icon data-wrap>
          {content}
        </Link>
      ) : (
        <div className="ui-row al-arow-main" data-has-icon data-wrap>
          {content}
        </div>
      )}
      <SnoozeMenu alert={a} snoozed={!!snoozed} />
    </div>
  );
}

function SnoozeMenu({ alert: a, snoozed }: { alert: AlertEvent; snoozed: boolean }) {
  const anchor = useRef<HTMLSpanElement>(null);
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);

  const run = (req: Promise<AlertEvent>, done: (ev: AlertEvent) => string) => {
    setOpen(false);
    setBusy(true);
    req
      .then((ev) => {
        applyAlert(ev);
        pushToast({ tone: 'info', title: done(ev), body: a.title, key: `snooze-${a.id}` });
      })
      .catch((err) =>
        pushToast({
          tone: 'crit',
          title: snoozed ? 'Couldn’t unsnooze the alert' : 'Couldn’t snooze the alert',
          // 404: it resolved (or was replaced) in the meantime
          body: /404|not active|not found/i.test(errorText(err)) ? 'It is no longer active.' : errorText(err),
          key: `snooze-${a.id}`,
        }),
      )
      .finally(() => setBusy(false));
  };

  return (
    <span ref={anchor} className="al-snooze">
      <IconButton
        className="al-snooze-btn"
        size="small"
        variant="gray"
        icon={snoozed ? <Bell size={15} strokeWidth={2.2} /> : <BellOff size={15} strokeWidth={2.2} />}
        label={snoozed ? `Unsnooze or change the snooze of ${a.title}` : `Snooze ${a.title}`}
        aria-haspopup="menu"
        aria-expanded={open}
        disabled={busy}
        onClick={() => setOpen((o) => !o)}
      />
      <Popover open={open} onClose={() => setOpen(false)} anchorRef={anchor} placement="bottom-end" width={230} ariaLabel="Snooze">
        <div className="al-menu" role="menu" aria-label={snoozed ? 'Snooze options' : 'Snooze for'}>
          {snoozed && (
            <button
              type="button"
              role="menuitem"
              className="al-menu-item al-menu-strong"
              onClick={() => run(postAlertUnack(a.id), () => 'Alert unsnoozed')}
            >
              <Bell size={15} strokeWidth={2.2} aria-hidden="true" />
              Unsnooze
            </button>
          )}
          <div className="al-menu-label" aria-hidden="true">
            {snoozed ? 'Snooze again for' : 'Snooze for'}
          </div>
          {SNOOZE_OPTIONS.map((o) => (
            <button
              key={o.label}
              type="button"
              role="menuitem"
              className="al-menu-item"
              onClick={() =>
                run(postAlertAck(a.id, o.hours), (ev) =>
                  o.hours === undefined ? 'Snoozed until it resolves' : snoozeLabel(ev.acknowledged ?? { at: serverNow(), until: serverNow() + o.hours * 3_600_000 }, serverNow(), SNOOZE_FMT),
                )
              }
            >
              {o.label}
            </button>
          ))}
          <div className="al-menu-foot">No notifications and no badge while snoozed.</div>
        </div>
      </Popover>
    </span>
  );
}

function Timeline({ events }: { events: readonly AlertEvent[] }) {
  const now = useServerNow(60_000);
  const [limit, setLimit] = useState(HISTORY_PAGE);
  const days = useMemo(() => groupByDay(events, now, (t) => dayFormat.format(t)), [events, now]);
  // "since you last looked" (server clock), captured when the page opened
  const since = useLastVisit('alerts', serverNow);
  const dividerId = useMemo(() => lastVisitDividerId(days, since), [days, since]);

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
                <Fragment key={e.id}>
                  {e.id === dividerId && since !== null && (
                    <li className="al-tl-divider" role="separator" aria-label={`Older than your last visit at ${formatTime(since)}`}>
                      <span>Last viewed {formatTime(since)}</span>
                    </li>
                  )}
                  <TimelineItem event={e} now={now} isNew={since !== null && e.time > since} />
                </Fragment>
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

function TimelineItem({ event: e, now, isNew }: { event: AlertEvent; now: number; isNew?: boolean }) {
  const tone = SEVERITY_TONE[e.severity];
  const after = resolvedAfterSec(e);
  const path = safeAppPath(e.path);
  const status = e.resolved ? (
    <StatusBadge tone="ok" size="small" label={after !== undefined ? `Resolved after ${formatDuration(after, { units: 1 })}` : 'Resolved'} />
  ) : (
    <StatusBadge
      tone={isSnoozed(e, now) ? 'off' : tone}
      size="small"
      label={`${isSnoozed(e, now) ? 'Snoozed' : 'Active'} · ${formatDuration(Math.max(0, (now - e.time) / 1000), { units: 1 })}`}
    />
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
    <li className="al-tl-item" data-tone={tone} data-resolved={e.resolved || undefined} data-new={isNew || undefined}>
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
