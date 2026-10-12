/**
 * Checks that need no network: config warnings and publicUrl, services config, push settings and devices, and the
 * machine itself (Node version, dataDir, free disk, memory, clock skew).
 */
import { accessSync, constants, readFileSync, statfsSync, statSync } from 'node:fs';
import { freemem, hostname, totalmem } from 'node:os';
import { join } from 'node:path';
import { type Config, configCheck, hostCheckDisabled } from '../config.js';
import type { DiagnosticCheck } from '../../shared/types.js';
import { bytes, check, DOC, errText, shq, skipped } from './util.js';

const RESTART = 'systemctl restart pve1-dash';
export const MIN_NODE = [20, 19] as const;

// ─────────────────────────────────────────────────────────────── config

export function configChecks(config: Config, configPath: string): DiagnosticCheck[] {
  // index.ts replaces config.file with the exact load result (last-good fallback included) in the running server
  const file = configCheck({ config, path: configPath, warnings: [], ...(config.demo ? {} : { text: '' }) });
  return [file, publicUrlCheck(config, configPath)];
}

function publicUrlCheck(config: Config, configPath: string): DiagnosticCheck {
  const title = 'Public URL and host names';
  const set = `# In ${configPath} (top level), with the name you open the dashboard with:\npublicUrl: "https://dash.example.com"\n# then:\n${RESTART}`;
  if (!config.publicUrl) {
    if (config.demo) return check('config.publicUrl', 'config', title, 'ok', 'Demo mode.');
    return check(
      'config.publicUrl',
      'config',
      title,
      'warn',
      hostCheckDisabled(config)
        ? 'publicUrl is not set: the dashboard answers every host name (no DNS-rebinding protection), notification links fall back to the address each device subscribed from, and the guest setup command has no stable address.'
        : `publicUrl is not set; the dashboard answers ${config.allowedHosts.join(', ')} plus IP addresses and local names.`,
      { fix: set, docs: 'docs/SETUP.md' },
    );
  }
  const u = new URL(config.publicUrl);
  const problems: string[] = [];
  if (u.protocol !== 'https:') problems.push('it is http://: Web Push and the iPhone/iPad Home Screen app need HTTPS');
  if (u.pathname !== '/' && u.pathname !== '') problems.push(`it has a path (${u.pathname}): the dashboard must be served at the root of its own host name`);
  if (u.username || u.password) problems.push('it contains a user name or password');
  if (problems.length) {
    return check('config.publicUrl', 'config', title, 'warn', `publicUrl "${config.publicUrl}": ${problems.join('; ')}.`, { fix: set, docs: 'docs/SETUP.md' });
  }
  const extra = config.allowedHosts.length ? ` and ${config.allowedHosts.join(', ')}` : '';
  return check('config.publicUrl', 'config', title, 'ok', `${config.publicUrl}; requests for ${u.hostname}${extra}, IP addresses and local names are answered, other host names are refused.`);
}

// ─────────────────────────────────────────────────────────────── services

const CHECK_RE = /^(?:http|https|none|tcp:\/\/[^\s/:]+:\d{1,5}|https?:\/\/\S+)$/i;

export function servicesCheck(config: Config, configPath: string, knownVmids?: ReadonlySet<number>): DiagnosticCheck {
  const s = config.services;
  const title = 'Services configuration';
  const problems: string[] = [];
  const seen = new Map<string, number>();
  for (const [i, item] of s.items.entries()) {
    const where = `services.items[${i}] "${item.name}"`;
    seen.set(item.name.trim().toLowerCase(), (seen.get(item.name.trim().toLowerCase()) ?? 0) + 1);
    if (item.url) {
      try {
        const u = new URL(item.url);
        if (u.protocol !== 'http:' && u.protocol !== 'https:') problems.push(`${where}: url must be http(s)://, not ${u.protocol}`);
      } catch {
        problems.push(`${where}: url "${item.url}" is not a full URL (write e.g. "http://10.10.10.20:8096")`);
      }
    }
    if (item.check !== undefined && !CHECK_RE.test(item.check.trim())) {
      problems.push(`${where}: check "${item.check}" is not one of http, none, tcp://host:port or an http(s) URL`);
    } else if (!item.url && (item.check === undefined || /^https?$/i.test(item.check.trim()))) {
      problems.push(`${where}: has no url, so there is nothing to check or open (add url, or check: "tcp://host:port")`);
    }
    if (item.vmid !== undefined && knownVmids && knownVmids.size && !knownVmids.has(item.vmid)) {
      problems.push(`${where}: vmid ${item.vmid} does not exist on this node`);
    }
  }
  for (const [name, n] of seen) if (n > 1) problems.push(`the name "${name}" is used ${n} times; names must be unique`);
  if (problems.length) {
    return check('services.config', 'services', title, 'warn', problems.map((p) => `• ${p}`).join('\n'), { fix: `Edit services: in ${configPath}, then: ${RESTART}`, docs: 'deploy/config.example.yaml' });
  }
  const discovery = [s.autoDiscoverDocker && 'Docker', s.autoDiscoverPorts && 'well-known apps'].filter(Boolean).join(' and ');
  if (!s.items.length && !discovery) {
    return check('services.config', 'services', title, 'warn', 'No services are configured and auto-discovery is off, so the Services page stays empty.', {
      fix: `Set services.autoDiscoverDocker: true / services.autoDiscoverPorts: true, or add services.items in ${configPath}, then: ${RESTART}`,
    });
  }
  const inv = !config.inventory.enabled && discovery ? ' (discovery needs the SSH inventory, which is off)' : '';
  return check('services.config', 'services', title, inv ? 'warn' : 'ok', `${s.items.length} configured service(s)${discovery ? `; discovering ${discovery}` : ''}${inv}.`, inv ? { fix: 'Turn on inventory.enabled (the installer sets it up).' } : {});
}

// ─────────────────────────────────────────────────────────────── push

export function vapidSubjectProblem(subject: string): { status: 'warn' | 'fail'; why: string } | undefined {
  const s = subject.trim();
  if (/localhost/i.test(s)) return { status: 'fail', why: 'contains "localhost": Apple\'s push service rejects it (403 BadJwtToken), so iPhone, iPad and Mac Safari get no notifications' };
  if (!/^(mailto:[^\s@]+@[^\s@]+\.[^\s@]+|https:\/\/[^\s/]+\.[^\s/]+\S*)$/i.test(s) && !/^[^\s@:/]+@[^\s@/]+\.[^\s@/]+$/.test(s)) {
    return { status: 'fail', why: 'is not a mailto: address or https: URL with a real domain; push services reject it' };
  }
  if (/\.(local|lan|internal|invalid|test|home\.arpa|localdomain)(\/|$|>)/i.test(s)) return { status: 'fail', why: "uses a private/reserved domain; Apple's push service is reported to reject those (403 BadJwtToken)" };
  if (/@example\.(com|org|net)$|\/\/(www\.)?example\.(com|org|net)/i.test(s)) return { status: 'warn', why: 'is the placeholder from the example config; set your own address' };
  return undefined;
}

interface StoredPush {
  vapid?: { publicKey?: string };
  devices?: { name?: string; endpointHost?: string; lastError?: string; lastSuccessAt?: number; createdAt?: number }[];
}

export function readPushFile(dataDir: string): { file?: StoredPush; error?: string } {
  try {
    return { file: JSON.parse(readFileSync(join(dataDir, 'push.json'), 'utf8')) as StoredPush };
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') return {};
    return { error: code === 'EACCES' ? 'permission denied (run the doctor as root or pve1dash)' : errText(err) };
  }
}

export function pushChecks(config: Config, configPath: string): DiagnosticCheck[] {
  if (!config.alerts.enabled) return [skipped('push.subject', 'push', 'Push notifications', 'Alerts are off (alerts.enabled: false).')];
  const checks: DiagnosticCheck[] = [];
  const subject = config.alerts.vapidSubject;
  const p = vapidSubjectProblem(subject);
  const fixSubject = `# In ${configPath}, under alerts:, with your real email address:\n  vapidSubject: "mailto:you@your-domain.com"\n# then:\n${RESTART}`;
  checks.push(
    p
      ? check('push.subject', 'push', 'VAPID contact (alerts.vapidSubject)', p.status, `"${subject}" ${p.why}.`, { fix: fixSubject, docs: DOC.push })
      : check('push.subject', 'push', 'VAPID contact (alerts.vapidSubject)', 'ok', `"${subject}".`),
  );

  const https = config.publicUrl?.startsWith('https://');
  checks.push(
    https
      ? check('push.https', 'push', 'HTTPS for iPhone and iPad', 'ok', `Devices subscribe at ${config.publicUrl}; notification taps open it.`)
      : check(
          'push.https',
          'push',
          'HTTPS for iPhone and iPad',
          config.demo ? 'skip' : 'warn',
          'iPhone and iPad only allow push from a Home Screen app opened over HTTPS with a trusted certificate, and notification taps need an absolute https:// publicUrl.',
          {
            fix: 'Create an HTTPS proxy host for the dashboard (Nginx Proxy Manager: Let\'s Encrypt certificate, Websockets on), then set publicUrl: "https://<that name>" and restart pve1-dash.',
            docs: 'docs/SETUP.md',
          },
        ),
  );

  const { file, error } = readPushFile(config.dataDir);
  if (error) {
    checks.push(check('push.devices', 'push', 'Push devices', 'warn', `${join(config.dataDir, 'push.json')}: ${error}.`, { fix: `ls -l ${shq(join(config.dataDir, 'push.json'))}   # owner pve1dash, mode 0600` }));
  } else {
    const devices = Array.isArray(file?.devices) ? file.devices : [];
    // a successful send deletes lastError, so its presence means the latest notification to that device failed
    const failing = devices.filter((d) => typeof d.lastError === 'string' && d.lastError !== '');
    if (!devices.length) {
      checks.push(
        check('push.devices', 'push', 'Push devices', 'ok', `No device has turned on notifications yet. iPhone/iPad: open ${config.publicUrl ?? 'the dashboard over HTTPS'} in Safari → Share → Add to Home Screen, open it from there → Settings → Notifications.`),
      );
    } else if (failing.length) {
      const bad = failing.map((d) => `• ${d.name ?? '?'} (${d.endpointHost ?? '?'}): ${d.lastError}`);
      const jwt = failing.some((d) => /BadJwtToken|VapidPkHashMismatch|403/.test(d.lastError ?? ''));
      checks.push(
        check('push.devices', 'push', 'Push devices', 'warn', `${failing.length} of ${devices.length} devices failed their last notification:\n${bad.join('\n')}`, {
          fix: jwt
            ? `Fix alerts.vapidSubject (see above), restart pve1-dash, then on each device: Settings → Notifications → Send test.`
            : 'On that device: Settings → Notifications → Send test. If it keeps failing, turn notifications off and on again there.',
          docs: DOC.push,
        }),
      );
    } else {
      checks.push(check('push.devices', 'push', 'Push devices', 'ok', `${devices.length} device(s): ${devices.map((d) => d.name ?? '?').join(', ')}.`));
    }
  }
  return checks;
}

// ─────────────────────────────────────────────────────────────── system

export function nodeVersionCheck(version = process.versions.node): DiagnosticCheck {
  const [maj = 0, min = 0] = version.split('.').map(Number);
  const okVersion = maj > MIN_NODE[0] || (maj === MIN_NODE[0] && min >= MIN_NODE[1]);
  return okVersion
    ? check('system.node', 'system', 'Node.js', 'ok', `Node.js ${version}.`)
    : check('system.node', 'system', 'Node.js', 'fail', `Node.js ${version} is too old; pve1-dash needs ${MIN_NODE.join('.')} or newer.`, {
        fix: 'In the container: pve1-dash-update (installs the supported Node.js), or re-run the installer on the host.',
      });
}

const MIB = 1024 * 1024;

export function dataDirChecks(dataDir: string, ctHostname = hostname()): DiagnosticCheck[] {
  const checks: DiagnosticCheck[] = [];
  const title = 'Data directory';
  try {
    const st = statSync(dataDir);
    if (!st.isDirectory()) throw Object.assign(new Error('not a directory'), { code: 'ENOTDIR' });
    accessSync(dataDir, constants.W_OK | constants.R_OK);
    checks.push(check('system.dataDir', 'system', title, 'ok', `${dataDir} is writable.`));
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    const fix =
      code === 'ENOENT'
        ? `install -d -o pve1dash -g pve1dash -m 0750 ${shq(dataDir)}`
        : code === 'EROFS'
          ? 'The file system is read-only: check the container disk on the host (pct fsck <ctid>).'
          : `chown -R pve1dash:pve1dash ${shq(dataDir)} && chmod 0750 ${shq(dataDir)}`;
    checks.push(check('system.dataDir', 'system', title, 'fail', `${dataDir}: ${code === 'ENOENT' ? 'does not exist' : code === 'EACCES' ? 'not writable by this user' : errText(err)}. Alerts, push devices and history cannot be saved.`, { fix }));
    return checks;
  }
  try {
    const fs = statfsSync(dataDir);
    const free = fs.bavail * fs.bsize;
    const total = fs.blocks * fs.bsize;
    const resize = `# On the Proxmox host:\npct resize "$(pct list | awk '$NF=="${ctHostname}" {print $1}')" rootfs +2G`;
    if (free < 200 * MIB) checks.push(check('system.disk', 'system', 'Free disk space', 'fail', `Only ${bytes(free)} free of ${bytes(total)} on ${dataDir}: state files and updates will fail.`, { fix: resize }));
    else if (free < 1024 * MIB) checks.push(check('system.disk', 'system', 'Free disk space', 'warn', `${bytes(free)} free of ${bytes(total)}: an update builds next to the running version and needs about 1 GiB.`, { fix: resize }));
    else checks.push(check('system.disk', 'system', 'Free disk space', 'ok', `${bytes(free)} free of ${bytes(total)}.`));
  } catch (err) {
    checks.push(check('system.disk', 'system', 'Free disk space', 'skip', `Could not read free space: ${errText(err)}.`));
  }
  return checks;
}

export function memoryCheck(total = totalmem(), free = freemem(), rss = process.memoryUsage.rss(), ctHostname = hostname()): DiagnosticCheck {
  const detail = `${bytes(free)} available of ${bytes(total)}; this process uses ${bytes(rss)}.`;
  if (free < 64 * MIB || free / total < 0.05) {
    return check('system.memory', 'system', 'Memory', 'warn', `Low memory: ${detail}`, {
      fix: `# On the Proxmox host:\npct set "$(pct list | awk '$NF=="${ctHostname}" {print $1}')" --memory 1024`,
    });
  }
  return check('system.memory', 'system', 'Memory', 'ok', detail);
}

export function clockCheck(skewMs: number | undefined): DiagnosticCheck {
  const title = 'Clock';
  if (skewMs === undefined) return skipped('system.clock', 'system', title, 'Not compared (no answer from Proxmox).');
  const s = Math.round(Math.abs(skewMs) / 1000);
  const dir = skewMs > 0 ? 'ahead of' : 'behind';
  if (s < 30) return check('system.clock', 'system', title, 'ok', `In sync with the Proxmox host (${s} s apart).`);
  return check('system.clock', 'system', title, s > 300 ? 'fail' : 'warn', `This machine's clock is ${s} s ${dir} the Proxmox host's: alert times, "since" texts and chart ends are off.`, {
    fix: '# An LXC uses the host kernel clock, so fix time on the Proxmox host:\nchronyc tracking; timedatectl status',
  });
}
