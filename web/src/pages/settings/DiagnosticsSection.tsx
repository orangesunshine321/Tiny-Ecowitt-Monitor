/**
 * Settings → Diagnostics (#diagnostics): the server's self-test (GET /api/diagnostics, the same checks as
 * `pve1-dash-doctor`) and this device's own checks, grouped, each with a status glyph, what was found and a copyable
 * fix. Groups that passed are folded. The server checks run when the section scrolls into view (or straight away when
 * the page was opened at #diagnostics, e.g. from the offline banner), and again on "Run Again".
 */
import { BookOpen, ChevronDown, ClipboardCopy, ExternalLink, RotateCw, Stethoscope } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { getDiagnostics } from '../../api';
import { Button, ListGroup, StatusBadge, StatusIcon } from '../../components';
import { formatTime } from '../../format';
import { useAsync } from '../../hooks/useAsync';
import { useNow } from '../../hooks/useNow';
import { currentPermission, getStoredDevice, isIos, isPushSupported, isStandalone } from '../../push';
import { pushToast, useAppStore, useSnapshot } from '../../store';
import { PROJECT_URL } from './AboutSection';
import {
  STATUS_LABEL,
  STATUS_TONE,
  countChecks,
  deviceChecks,
  docsHref,
  groupChecks,
  reportText,
  summaryText,
  worstStatus,
  type CheckGroup,
  type UiCheck,
} from './diagnosticsModel';
import { Callout, CodeBlock, ListItem, copyText } from './ui';

const ANCHOR = 'diagnostics';

function navigationProtocol(): string | undefined {
  try {
    const nav = performance.getEntriesByType('navigation')[0] as PerformanceNavigationTiming | undefined;
    return nav?.nextHopProtocol || undefined;
  } catch {
    return undefined;
  }
}

/** Service worker scope: undefined while checking, null when none is registered. */
function useServiceWorkerScope(): string | null | undefined {
  const [scope, setScope] = useState<string | null | undefined>(undefined);
  useEffect(() => {
    let alive = true;
    if (!('serviceWorker' in navigator)) {
      setScope(null);
      return;
    }
    navigator.serviceWorker
      .getRegistration()
      .then((r) => alive && setScope(r ? r.scope : null))
      .catch(() => alive && setScope(null));
    return () => {
      alive = false;
    };
  }, []);
  return scope;
}

export function DiagnosticsSection() {
  const publicUrl = useSnapshot((s) => s.meta.publicUrl);
  const serverPushEnabled = useSnapshot((s) => s.meta.pushEnabled && !!s.meta.vapidPublicKey);
  const connection = useAppStore((s) => s.connection);
  const lastEventAt = useAppStore((s) => s.lastEventAt);
  const clockOffsetMs = useAppStore((s) => s.serverTimeOffset);
  const now = useNow(5_000);
  const swScope = useServiceWorkerScope();

  // run the server checks once the section is (nearly) on screen; at once when deep-linked
  const rootRef = useRef<HTMLDivElement>(null);
  const deepLinked = typeof location !== 'undefined' && location.hash === `#${ANCHOR}`;
  const [wanted, setWanted] = useState(() => deepLinked || typeof IntersectionObserver === 'undefined');
  useEffect(() => {
    if (wanted || !rootRef.current) return;
    const io = new IntersectionObserver((entries) => entries.some((e) => e.isIntersecting) && setWanted(true), { rootMargin: '200px 0px' });
    io.observe(rootRef.current);
    return () => io.disconnect();
  }, [wanted]);
  const query = useAsync((signal) => getDiagnostics({ signal }), [], { enabled: wanted });
  const report = query.data;

  // content above (devices, data sources) can grow after the first scroll to #diagnostics: land on it again once
  const relanded = useRef(false);
  useEffect(() => {
    if (!report || relanded.current || !deepLinked) return;
    relanded.current = true;
    document.getElementById(ANCHOR)?.scrollIntoView({ block: 'start' });
  }, [report, deepLinked]);

  const stored = getStoredDevice();
  const device = useMemo(
    () =>
      deviceChecks({
        secure: typeof window !== 'undefined' && window.isSecureContext,
        origin: location.origin,
        path: location.pathname + location.search + location.hash,
        publicUrl,
        ios: isIos(),
        standalone: isStandalone(),
        pushSupported: isPushSupported(),
        permission: currentPermission(),
        stored: stored ? { id: stored.id, lost: stored.lost } : null,
        serverPushEnabled,
        swAvailable: 'serviceWorker' in navigator,
        swScope,
        protocol: navigationProtocol(),
        connection,
        lastEventAgoMs: lastEventAt !== null ? Math.max(0, now - lastEventAt) : null,
        clockOffsetMs,
      }),
    // `stored` is re-read every render (cheap, localStorage); its fields are what matter
    [publicUrl, serverPushEnabled, swScope, connection, lastEventAt, now, clockOffsetMs, stored?.id, stored?.lost],
  );

  const all = useMemo<UiCheck[]>(() => [...device, ...(report?.checks ?? [])], [device, report]);
  const groups = useMemo(() => groupChecks(all), [all]);
  const counts = countChecks(all);
  const running = query.loading;
  const firstRun = running && !report;
  const overall = firstRun ? 'skip' : worstStatus(all);

  const copyReport = () => {
    const text = reportText(report, device, { url: location.href, userAgent: navigator.userAgent, error: report ? undefined : query.error });
    copyText(text)
      .then(() => pushToast({ tone: 'ok', title: 'Report copied', body: 'Paste it into a message or an issue.', key: 'diag-copy' }))
      .catch(() => pushToast({ tone: 'warn', title: 'Couldn’t copy', body: 'Run pve1-dash-doctor in the dashboard container instead.', key: 'diag-copy' }));
  };

  return (
    <div ref={rootRef} className="set-stack set-diag">
      <ListGroup
        header="Diagnostics"
        footer={
          <>
            The same checks run in a shell with <code>pve1-dash-doctor</code> in the dashboard container, even when the dashboard is down.
          </>
        }
      >
        <ListItem className="set-diag-summary">
          <span className="set-diag-summary-icon" aria-hidden="true">
            {firstRun ? <StatusIcon tone="info" size={22} spinning /> : <StatusIcon tone={STATUS_TONE[overall]} size={22} />}
          </span>
          <div className="set-inline-text">
            <div className="set-inline-title">
              {firstRun ? 'Running checks…' : !wanted ? 'Server checks not run yet' : summaryText(counts)}
            </div>
            <div className="set-inline-sub">
              {report ? (
                <>
                  Checked at {formatTime(report.generatedAt, { seconds: true })}
                  {report.appVersion ? ` · pve1-dash ${report.appVersion}` : ''}
                </>
              ) : firstRun ? (
                'Talking to Proxmox, SSH and push can take a few seconds.'
              ) : (
                'This device’s checks are below.'
              )}
            </div>
          </div>
          <div className="set-diag-actions">
            <Button
              variant="gray"
              size="small"
              icon={<RotateCw size={14} strokeWidth={2.3} />}
              loading={running}
              onClick={() => (wanted ? query.reload() : setWanted(true))}
            >
              {report ? 'Run Again' : 'Run'}
            </Button>
            <Button variant="gray" size="small" icon={<ClipboardCopy size={14} strokeWidth={2.2} />} onClick={copyReport} disabled={firstRun}>
              Copy Report
            </Button>
          </div>
        </ListItem>
        {query.error && !report && (
          <ListItem>
            <Callout tone="warn" icon={<Stethoscope size={18} strokeWidth={2} />} title="The server checks couldn’t run">
              {query.error.replace(/\.$/, '')}. In the dashboard container run <code>pve1-dash-doctor</code>; it works even when the dashboard is down.
            </Callout>
          </ListItem>
        )}
      </ListGroup>

      {groups.map((g) => (
        <DiagGroupList key={g.group} group={g} />
      ))}
      {firstRun && (
        <ListGroup header="Server">
          <ListItem>
            <span className="t-label-2">Waiting for the server’s checks…</span>
          </ListItem>
        </ListGroup>
      )}
    </div>
  );
}

function DiagGroupList({ group: g }: { group: CheckGroup }) {
  const healthy = g.worst === 'ok' || g.worst === 'skip';
  const [open, setOpen] = useState(!healthy);
  // a group that turns bad on a re-run unfolds by itself
  useEffect(() => {
    if (!healthy) setOpen(true);
  }, [healthy]);
  const c = countChecks(g.checks);
  return (
    <ListGroup
      className="set-diag-group"
      header={
        <span className="set-diag-head" data-tone={STATUS_TONE[g.worst]}>
          <StatusIcon tone={STATUS_TONE[g.worst]} size={13} />
          {g.label}
        </span>
      }
    >
      {open ? (
        g.checks.map((check) => <CheckRow key={check.id} check={check} />)
      ) : (
        <button type="button" className="ui-row set-diag-fold" onClick={() => setOpen(true)} aria-expanded={false}>
          <span className="ui-row-text">
            <span className="ui-row-title">{c.ok ? `${c.ok} of ${g.checks.length} passed` : `${g.checks.length} skipped`}</span>
            <span className="ui-row-subtitle">{g.checks.map((x) => x.title).join(' · ')}</span>
          </span>
          <ChevronDown className="ui-row-chevron" size={17} strokeWidth={2.4} aria-hidden="true" />
        </button>
      )}
    </ListGroup>
  );
}

function CheckRow({ check: c }: { check: UiCheck }) {
  const tone = STATUS_TONE[c.status] ?? 'warn';
  const docs = docsHref(c.docs, PROJECT_URL);
  // a link is the fix itself; prose steps read as text, commands and config lines as copyable code
  const showFix = !!c.fix && c.status !== 'ok' && !c.link;
  return (
    <ListItem className="set-diag-check">
      <div className="set-diag-row" data-status={c.status}>
        <span className="set-diag-icon" aria-hidden="true">
          <StatusIcon tone={tone} size={17} />
        </span>
        <div className="set-diag-text">
          <div className="set-diag-title">
            <span>{c.title}</span>
            {c.status !== 'ok' && <StatusBadge tone={tone} size="small" icon={null} label={STATUS_LABEL[c.status] ?? c.status} />}
          </div>
          <div className="set-diag-detail">{c.detail}</div>
          {showFix && (c.fixText ? <p className="set-diag-fixtext">{c.fix}</p> : <CodeBlock text={c.fix!} label={`fix for ${c.title}`} wrap />)}
          {(c.link || (docs && c.status !== 'ok')) && (
            <div className="set-diag-links">
              {c.link && (
                <Button variant="prominent" size="small" href={c.link.href} target="_self" rel="noopener" icon={<ExternalLink size={14} strokeWidth={2.2} />}>
                  {c.link.label}
                </Button>
              )}
              {docs && c.status !== 'ok' && (
                <Button variant="plain" size="small" href={docs} icon={<BookOpen size={14} strokeWidth={2.2} />}>
                  Troubleshooting guide
                </Button>
              )}
            </div>
          )}
        </div>
      </div>
    </ListItem>
  );
}
