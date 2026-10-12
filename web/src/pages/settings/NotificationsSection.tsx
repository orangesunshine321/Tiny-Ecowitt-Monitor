/**
 * Settings → Notifications (DESIGN §5 Settings, docs/research/web-pwa-push.md §2).
 *
 * Push on Apple devices: iPhone/iPad only in the Home Screen app; permission and subscribe must come straight from a
 * tap (push.ts `subscribe()` asks first, inside the click). Each device keeps its own preferences on the server.
 */
import { BellOff, BellRing, CircleSlash, ExternalLink, Laptop, LockKeyhole, Monitor, Moon, Send, ShieldAlert, Smartphone, Tablet, Trash2, TriangleAlert } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';
import type { AlertKind, AlertSeverity, PushDevice, PushPrefs } from '../../../../shared/types';
import { errorText, getPushDevices, postPushTest, postPushUnsubscribe } from '../../api';
import { AddToHomeScreenHint, Button, IconButton, ListGroup, ListRow, RelativeTime, SegmentedControl, StatusBadge, Toggle } from '../../components';
import { useAsync } from '../../hooks/useAsync';
import {
  DEVICE_EVENT,
  currentPermission,
  defaultDeviceName,
  getStoredDevice,
  isPushSupported,
  needsHomeScreenInstall,
  sendTest,
  subscribe,
  unsubscribe,
  updatePrefs,
} from '../../push';
import { pushToast, useSnapshot } from '../../store';
import { ALERT_KINDS, SUBSCRIBABLE_KINDS } from '../alerts/alertKinds';
import { publicUrlTarget } from './diagnosticsModel';
import { DEFAULT_QUIET_HOURS, cleanDeviceName, inQuietHours, pushUiState, quietHoursPatch, toggleKind, type QuietHours } from './settingsModel';
import { Callout, ListItem, TextFieldRow } from './ui';

const SEVERITIES: { value: AlertSeverity; label: string }[] = [
  { value: 'info', label: 'Info' },
  { value: 'warning', label: 'Warning' },
  { value: 'critical', label: 'Critical' },
];

export function NotificationsSection() {
  const serverEnabled = useSnapshot((s) => s.meta.pushEnabled && !!s.meta.vapidPublicKey);
  const publicUrl = useSnapshot((s) => s.meta.publicUrl);
  const secure = typeof window === 'undefined' || window.isSecureContext;
  const [permission, setPermission] = useState(currentPermission);
  const [stored, setStored] = useState(getStoredDevice);
  const [needsInstall, setNeedsInstall] = useState(needsHomeScreenInstall);
  const supported = isPushSupported();

  // permission and the stored device can change outside this page (system settings, another tab)
  useEffect(() => {
    const refresh = () => {
      if (document.visibilityState !== 'visible') return;
      setPermission(currentPermission());
      setStored(getStoredDevice());
      setNeedsInstall(needsHomeScreenInstall());
    };
    document.addEventListener('visibilitychange', refresh);
    window.addEventListener('focus', refresh);
    return () => {
      document.removeEventListener('visibilitychange', refresh);
      window.removeEventListener('focus', refresh);
    };
  }, []);

  const query = useAsync((signal) => getPushDevices({ signal }), [], { enabled: serverEnabled });
  // the self-heal (shell/pushSelfHeal.ts) may re-register or mark this device lost while Settings is open
  const reloadDevices = query.reload;
  useEffect(() => {
    const onDeviceChange = () => {
      setStored(getStoredDevice());
      reloadDevices();
    };
    window.addEventListener(DEVICE_EVENT, onDeviceChange);
    return () => window.removeEventListener(DEVICE_EVENT, onDeviceChange);
  }, [reloadDevices]);
  const [devices, setDevices] = useState<PushDevice[] | undefined>(undefined);
  useEffect(() => {
    if (query.data) setDevices(query.data);
  }, [query.data]);

  const upsert = useCallback(
    (d: PushDevice) =>
      setDevices((list) => (list ? (list.some((x) => x.id === d.id) ? list.map((x) => (x.id === d.id ? d : x)) : [...list, d]) : [d])),
    [],
  );
  const remove = useCallback((id: string) => setDevices((list) => list?.filter((x) => x.id !== id)), []);

  const state = pushUiState({ serverEnabled, secure, supported, needsInstall, permission, storedId: stored?.id ?? null, storedLost: stored?.lost, devices });
  const me = stored ? devices?.find((d) => d.id === stored.id) : undefined;
  const [name, setName] = useState(() => stored?.name || defaultDeviceName());
  useEffect(() => {
    if (me?.name) setName(me.name);
  }, [me?.name]);

  const [busy, setBusy] = useState<null | 'enable' | 'test' | 'off'>(null);

  // Called directly from the button's click: subscribe() requests permission before its first await.
  const enable = () => {
    setBusy('enable');
    subscribe(cleanDeviceName(name) || defaultDeviceName())
      .then((device) => {
        setStored(getStoredDevice());
        upsert(device);
        pushToast({ tone: 'ok', title: 'Notifications are on', body: `${device.name} will get pve1 alerts.`, key: 'push' });
      })
      .catch((err) => pushToast({ tone: 'crit', title: 'Couldn’t enable notifications', body: errorText(err), key: 'push' }))
      .finally(() => {
        setPermission(currentPermission());
        setBusy(null);
      });
  };

  const disable = () => {
    setBusy('off');
    const id = stored?.id;
    unsubscribe()
      .then(() => {
        setStored(null);
        if (id) remove(id);
        pushToast({ tone: 'info', title: 'Notifications are off on this device', key: 'push' });
      })
      .catch((err) => pushToast({ tone: 'crit', title: 'Couldn’t turn notifications off', body: errorText(err), key: 'push' }))
      .finally(() => setBusy(null));
  };

  const test = () => {
    setBusy('test');
    sendTest(stored?.id ?? null)
      .then((r) =>
        r.ok
          ? pushToast({ tone: 'ok', title: 'Test notification sent', body: 'It should arrive within a few seconds.', key: 'push-test' })
          : pushToast({ tone: 'crit', title: 'The test wasn’t delivered', body: r.error ?? 'The push service refused it.', key: 'push-test' }),
      )
      .catch((err) => pushToast({ tone: 'crit', title: 'The test wasn’t delivered', body: errorText(err), key: 'push-test' }))
      .finally(() => {
        setBusy(null);
        query.reload();
      });
  };

  /** Optimistic preference change; reverts on failure. */
  const savePrefs = (patch: Partial<PushPrefs>, newName?: string) => {
    if (!me) return;
    const before = me;
    upsert({ ...me, name: newName ?? me.name, prefs: { ...me.prefs, ...patch } });
    updatePrefs(patch, newName, me.id)
      .then((d) => {
        upsert(d);
        if (newName !== undefined) setStored(getStoredDevice());
      })
      .catch((err) => {
        upsert(before);
        pushToast({ tone: 'crit', title: 'Couldn’t save the notification settings', body: errorText(err), key: 'push-prefs' });
      });
  };

  return (
    <div className="set-stack">
      <ListGroup header="Notifications" footer={footerFor(state)}>
        {state === 'server-off' && (
          <ListItem>
            <Callout tone="off" icon={<BellOff size={18} strokeWidth={2} />} title="Push notifications are off on the server">
              Set <code>alerts.enabled: true</code> and a real <code>alerts.vapidSubject</code> in config.yaml, then restart pve1-dash. The server log
              says why push couldn’t start.
            </Callout>
          </ListItem>
        )}
        {state === 'insecure' && (
          <ListItem>
            <InsecureCallout publicUrl={publicUrl} />
          </ListItem>
        )}
        {state === 'needs-install' && (
          <ListItem>
            <AddToHomeScreenHint force reason="iPhone and iPad deliver notifications only to the Home Screen app, not to a Safari tab." />
          </ListItem>
        )}
        {state === 'unsupported' && (
          <ListItem>
            <Callout tone="off" icon={<CircleSlash size={18} strokeWidth={2} />} title="This browser can’t receive push notifications">
              Use Safari on macOS 13 or later, or Chrome, Edge or Firefox. On iPhone and iPad (iOS 16.4 or later), add pve1 to the Home Screen and
              open it from there.
            </Callout>
          </ListItem>
        )}
        {state === 'denied' && (
          <ListItem>
            <Callout tone="crit" icon={<ShieldAlert size={18} strokeWidth={2} />} title="Notifications are blocked for pve1">
              Allow them again, then come back here: on iPhone and iPad in <strong>Settings → Notifications → pve1</strong>; in Safari on a Mac in{' '}
              <strong>Safari → Settings → Websites → Notifications</strong>; in Chrome via the site settings next to the address bar.
            </Callout>
          </ListItem>
        )}
        {state === 'lost' && (
          <ListItem>
            <Callout tone="warn" icon={<TriangleAlert size={18} strokeWidth={2} />} title="This device is no longer registered">
              The dashboard doesn’t know this device any more (it may have been removed, or the push service expired it). Turn notifications on again.
            </Callout>
          </ListItem>
        )}
        {(state === 'off' || state === 'lost') && (
          <>
            <TextFieldRow label="Device name" value={name} placeholder={defaultDeviceName()} onCommit={(v) => setName(cleanDeviceName(v))} />
            <ListItem className="set-actions">
              <Button
                variant="prominent"
                size="large"
                block
                icon={<BellRing size={17} strokeWidth={2.2} />}
                loading={busy === 'enable'}
                onClick={enable}
              >
                {state === 'lost' ? 'Turn On Again' : 'Enable on This Device'}
              </Button>
            </ListItem>
          </>
        )}
        {state === 'on' && (
          <>
            <ListRow
              icon={<BellRing strokeWidth={2.1} />}
              iconColor="var(--status-ok)"
              title="On for this device"
              subtitle={me ? `via ${me.endpointHost}` : 'Checking with the dashboard…'}
              value={me?.lastSuccessAt ? <RelativeTime time={me.lastSuccessAt} prefix="Delivered " /> : undefined}
            />
            <TextFieldRow
              label="Device name"
              value={me?.name ?? name}
              disabled={!me}
              onCommit={(v) => {
                const n = cleanDeviceName(v);
                if (n) savePrefs({}, n);
              }}
            />
          </>
        )}
      </ListGroup>

      {state === 'on' && me && (
        <>
          <ListGroup header="Alert types" footer="Only the alerts you pick here are sent to this device. Each device has its own choices.">
            {SUBSCRIBABLE_KINDS.map((k) => (
              <KindRow
                key={k}
                kind={k}
                checked={me.prefs.kinds.includes(k)}
                onChange={(on) => savePrefs({ kinds: toggleKind(me.prefs.kinds, k, on, SUBSCRIBABLE_KINDS) })}
              />
            ))}
          </ListGroup>

          <ListGroup header="Delivery">
            <ListItem className="set-inline">
              <div className="set-inline-text">
                <div className="set-inline-title">Minimum severity</div>
                <div className="set-inline-sub">Quieter alerts below this level stay in the app.</div>
              </div>
              <SegmentedControl
                ariaLabel="Minimum severity"
                size="small"
                options={SEVERITIES}
                value={me.prefs.minSeverity}
                onChange={(v) => savePrefs({ minSeverity: v })}
              />
            </ListItem>
            <ListRow
              title="Recoveries"
              subtitle="Also notify when an alert resolves"
              accessory={<Toggle ariaLabel="Notify about recoveries" checked={me.prefs.recoveries} onChange={(v) => savePrefs({ recoveries: v })} />}
            />
          </ListGroup>

          <QuietHoursGroup
            value={me.prefs.quietHours}
            onChange={(patch) => savePrefs(patch as unknown as Partial<PushPrefs>)}
          />

          <ListGroup>
            <ListItem className="set-actions set-actions-row">
              <Button variant="gray" icon={<Send size={15} strokeWidth={2.2} />} loading={busy === 'test'} onClick={test}>
                Send Test Notification
              </Button>
              <Button variant="tinted" tint="red" icon={<BellOff size={15} strokeWidth={2.2} />} loading={busy === 'off'} onClick={disable}>
                Turn Off on This Device
              </Button>
            </ListItem>
          </ListGroup>
        </>
      )}

      {serverEnabled && (
        <DevicesList
          devices={devices}
          loading={query.loading && !devices}
          error={query.error}
          myId={stored?.id ?? null}
          onRemoved={(id) => {
            remove(id);
            if (id === stored?.id) setStored(getStoredDevice());
          }}
          onRetry={query.reload}
        />
      )}
    </div>
  );
}

/**
 * Over plain HTTP (the installer's LAN address) nothing push-related can work, and an iPhone Home Screen app added
 * from there never can either: send people to the HTTPS address instead (D10/D19).
 */
function InsecureCallout({ publicUrl }: { publicUrl: string | undefined }) {
  const here = typeof location === 'undefined' ? '' : location.origin;
  const target = typeof location === 'undefined' ? undefined : publicUrlTarget(publicUrl, here, location.pathname + location.search + location.hash);
  const host = target ? new URL(target).host : undefined;
  return (
    <Callout tone="warn" icon={<LockKeyhole size={18} strokeWidth={2} />} title="Notifications and the Home Screen app need HTTPS">
      <p className="set-callout-p">
        You opened pve1 at <code>{here}</code>, a plain HTTP address. Browsers only allow notifications on HTTPS pages, and on iPhone and iPad a
        Home Screen app added from this address can never receive them.
      </p>
      {target ? (
        <>
          <p className="set-callout-p">Open the HTTPS address and turn notifications on there (on iPhone and iPad, add that page to the Home Screen first).</p>
          <Button variant="prominent" href={target} target="_self" rel="noopener" icon={<ExternalLink size={15} strokeWidth={2.2} />}>
            Open {host}
          </Button>
        </>
      ) : (
        <p className="set-callout-p">
          Open the dashboard through your HTTPS reverse proxy instead. Set <code>publicUrl: https://…</code> in <code>/etc/pve1-dash/config.yaml</code>{' '}
          (then <code>systemctl restart pve1-dash</code>) and a link to it appears here.
        </p>
      )}
    </Callout>
  );
}

/** Quiet hours for this device: warnings wait until morning, critical alerts still come through (unless turned off). */
function QuietHoursGroup({ value, onChange }: { value: QuietHours | undefined; onChange: (patch: { quietHours: QuietHours | null }) => void }) {
  const on = !!value;
  const q = value ?? DEFAULT_QUIET_HOURS;
  const quietNow = on && inQuietHours(value, Date.now());
  const change = (c: Parameters<typeof quietHoursPatch>[1]) => {
    const patch = quietHoursPatch(value, c);
    if (patch) onChange(patch);
    else pushToast({ tone: 'warn', title: 'Pick different start and end times', key: 'quiet-hours' });
  };
  return (
    <ListGroup
      header="Quiet hours"
      footer={
        on
          ? `${quietNow ? 'Quiet now. ' : ''}Between ${q.start} and ${q.end} (this device’s time) ${q.allowCritical ? 'only critical alerts are delivered' : 'nothing is delivered'}; everything still shows in the app.`
          : 'Hold back notifications at night. Alerts still show in the app.'
      }
    >
      <ListRow
        icon={<Moon strokeWidth={2.1} />}
        iconColor="var(--indigo)"
        title="Quiet hours"
        accessory={<Toggle ariaLabel="Quiet hours" checked={on} onChange={(v) => change({ enabled: v })} />}
      />
      {on && (
        <>
          <TimeRow label="From" value={q.start} onCommit={(v) => change({ start: v })} />
          <TimeRow label="To" value={q.end} onCommit={(v) => change({ end: v })} />
          <ListRow
            title="Critical alerts"
            subtitle="Still notify for critical alerts (node down, a failed disk)"
            accessory={<Toggle ariaLabel="Critical alerts during quiet hours" checked={q.allowCritical} onChange={(v) => change({ allowCritical: v })} />}
          />
        </>
      )}
    </ListGroup>
  );
}

function TimeRow({ label, value, onCommit }: { label: string; value: string; onCommit: (v: string) => void }) {
  const [draft, setDraft] = useState(value);
  useEffect(() => setDraft(value), [value]);
  return (
    <label role="listitem" className="set-field">
      <span className="set-field-label">{label}</span>
      <input
        className="set-field-input set-time-input"
        type="time"
        step={60}
        required
        value={draft}
        aria-label={`Quiet hours ${label.toLowerCase()}`}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={() => draft !== value && onCommit(draft)}
        onKeyDown={(e) => e.key === 'Enter' && (e.target as HTMLInputElement).blur()}
      />
    </label>
  );
}

function footerFor(state: ReturnType<typeof pushUiState>): string | undefined {
  if (state === 'off') return 'Your browser asks for permission first. Alerts arrive even when pve1 is closed.';
  if (state === 'on') return 'Notifications open the page that explains the alert.';
  return undefined;
}

function KindRow({ kind, checked, onChange }: { kind: AlertKind; checked: boolean; onChange: (on: boolean) => void }) {
  const info = ALERT_KINDS[kind];
  const Icon = info.icon;
  return (
    <ListRow
      dense
      icon={<Icon strokeWidth={2} />}
      title={info.label}
      subtitle={info.description}
      accessory={<Toggle ariaLabel={info.label} checked={checked} onChange={onChange} />}
    />
  );
}

function deviceIcon(name: string) {
  if (/iphone|android|phone/i.test(name)) return Smartphone;
  if (/ipad|tablet/i.test(name)) return Tablet;
  if (/mac|book|laptop/i.test(name)) return Laptop;
  return Monitor;
}

function DevicesList({
  devices,
  loading,
  error,
  myId,
  onRemoved,
  onRetry,
}: {
  devices: PushDevice[] | undefined;
  loading: boolean;
  error: string | undefined;
  myId: string | null;
  onRemoved: (id: string) => void;
  onRetry: () => void;
}) {
  const [confirm, setConfirm] = useState<string | null>(null);
  const [testing, setTesting] = useState<string | null>(null);

  const removeDevice = (d: PushDevice) => {
    if (confirm !== d.id) {
      setConfirm(d.id);
      return;
    }
    setConfirm(null);
    postPushUnsubscribe({ id: d.id })
      .then(() => {
        onRemoved(d.id);
        pushToast({ tone: 'info', title: `Removed ${d.name}`, key: 'push-device' });
      })
      .catch((err) => pushToast({ tone: 'crit', title: `Couldn’t remove ${d.name}`, body: errorText(err), key: 'push-device' }));
  };
  const testDevice = (d: PushDevice) => {
    setTesting(d.id);
    postPushTest(d.id)
      .then((r) =>
        pushToast(
          r.ok
            ? { tone: 'ok', title: `Test sent to ${d.name}`, key: 'push-test' }
            : { tone: 'crit', title: `The test to ${d.name} wasn’t delivered`, body: r.error, key: 'push-test' },
        ),
      )
      .catch((err) => pushToast({ tone: 'crit', title: `The test to ${d.name} wasn’t delivered`, body: errorText(err), key: 'push-test' }))
      .finally(() => setTesting(null));
  };

  const sorted = [...(devices ?? [])].sort((a, b) => (a.id === myId ? -1 : b.id === myId ? 1 : b.createdAt - a.createdAt));

  return (
    <ListGroup
      header="Devices"
      footer={sorted.length ? 'Every device that receives pve1 notifications. Removing one stops its notifications.' : undefined}
    >
      {loading && <ListRow title={<span className="t-label-2">Loading devices…</span>} />}
      {!loading && error && !devices && (
        <ListItem className="set-inline">
          <span className="set-inline-text t-label-2">Couldn’t load the device list: {error}</span>
          <Button variant="gray" size="small" onClick={onRetry}>
            Retry
          </Button>
        </ListItem>
      )}
      {!loading && devices && sorted.length === 0 && (
        <ListRow title={<span className="t-label-2">No devices yet</span>} subtitle="Enable notifications on a device to see it here." />
      )}
      {sorted.map((d) => {
        const Icon = deviceIcon(d.name);
        const mine = d.id === myId;
        return (
          <ListRow
            key={d.id}
            icon={<Icon strokeWidth={2} />}
            title={
              <span className="set-device-title">
                {d.name}
                {mine && <StatusBadge tone="info" size="small" icon={null} label="This device" />}
              </span>
            }
            subtitle={
              d.lastError ? (
                <span className="set-device-error">{d.lastError}</span>
              ) : (
                <>
                  {d.endpointHost} ·{' '}
                  {d.lastSuccessAt ? (
                    <RelativeTime time={d.lastSuccessAt} prefix="delivered " />
                  ) : (
                    <RelativeTime time={d.createdAt} prefix="added " />
                  )}
                </>
              )
            }
            accessory={
              <span className="set-device-actions">
                <IconButton
                  size="small"
                  variant="gray"
                  icon={<Send size={14} strokeWidth={2.2} />}
                  label={`Send a test to ${d.name}`}
                  disabled={testing === d.id}
                  onClick={() => testDevice(d)}
                />
                {!mine &&
                  (confirm === d.id ? (
                    <Button size="small" variant="tinted" tint="red" onClick={() => removeDevice(d)} onBlur={() => setConfirm(null)} autoFocus>
                      Remove
                    </Button>
                  ) : (
                    <IconButton
                      size="small"
                      variant="gray"
                      icon={<Trash2 size={14} strokeWidth={2.2} />}
                      label={`Remove ${d.name}`}
                      onClick={() => removeDevice(d)}
                    />
                  ))}
              </span>
            }
          />
        );
      })}
    </ListGroup>
  );
}
