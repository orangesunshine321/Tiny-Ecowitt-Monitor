/**
 * A faithful mock of the Proxmox VE 9.0 REST API for demo mode and tests, as seen by a PVEAuditor API token.
 *
 *  - node:http on 127.0.0.1, random free port; GET /api2/json/… only (the dashboard never writes).
 *  - Requires `Authorization: PVEAPIToken=user@realm!tokenid=secret` (401 otherwise) and answers `{"data": …}` like PVE,
 *    errors as `{"data": null, "message": "…\n"}` with the message as HTTP reason phrase, param errors with `errors`.
 *  - Auditor behaviour: apt/update and syslog → 403, backup volumes hidden from storage content, agent reads allowed.
 *  - Values are driven by server/demo/world.ts through the deterministic simulation in server/demo/sim.ts.
 */
import { createServer, STATUS_CODES, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { Logger } from '../context.js';
import { DemoSim } from './sim.js';
import {
  Envelope,
  enumParam,
  GUEST_TIMEFRAMES,
  NODE_TIMEFRAMES,
  NODE,
  permissionDenied,
  PveHttpError,
  requireNode,
  RRD_SETUP,
  vmidParam,
  boolParam,
  type RrdRow,
  type Timeframe,
} from './pveCommon.js';
import { aptVersions, certificates, clusterResources, clusterStatus, nodeNetwork, nodeRrd, nodesIndex, nodeStatus, services, subscription, version } from './pveNode.js';
import { agentCommand, findGuest, guestRrd, lxcConfig, lxcInterfaces, lxcStatus, qemuConfig, qemuStatus } from './pveGuests.js';
import {
  backupJobs,
  diskSmart,
  disksList,
  notBackedUp,
  pruneBackups,
  storageContent,
  storageList,
  taskList,
  taskLog,
  taskStatus,
  zfsDetail,
  zfsList,
} from './pveStorage.js';

export interface MockProxmoxOptions {
  /** shared simulation (default: a new one anchored now) */
  sim?: DemoSim;
  log?: Logger;
  /** default 127.0.0.1 */
  host?: string;
  /** default 0 (random free port) */
  port?: number;
  /** when set, only this exact token is accepted; otherwise any well-formed token is */
  token?: { id: string; secret: string };
  /** add realistic response delays (smartctl-backed endpoints are slow); default true */
  latency?: boolean;
}

export interface MockProxmox {
  /** base URL without /api2/json, e.g. http://127.0.0.1:41234 */
  url: string;
  port: number;
  sim: DemoSim;
  close(): Promise<void>;
}

type Params = Record<string, string>;
type Handler = (p: Params, q: URLSearchParams, nowMs: number) => unknown;

interface Route {
  segments: string[];
  handler: Handler;
  /** extra simulated latency in ms */
  delayMs?: number;
}

/** The token format PVE accepts: user@realm!tokenname, tokenname = [A-Za-z][A-Za-z0-9.\-_]+ */
const TOKEN_ID_RE = /^[^\s@!:]+@[A-Za-z][A-Za-z0-9._-]*![A-Za-z][A-Za-z0-9._-]+$/;

/** Parse the API token from the Authorization header like pve-http-server (key "PVEAPIToken", '=' or ' ' separator). */
export function parseTokenHeader(header: string | undefined): { id: string; secret: string } | null | undefined {
  if (!header) return undefined;
  const m = /(?:^|\s)PVEAPIToken(?:=| )([^;]*)/.exec(header);
  if (!m) return undefined;
  let value: string;
  try {
    value = decodeURIComponent(m[1]!.trim());
  } catch {
    return null;
  }
  const eq = value.lastIndexOf('=');
  if (eq <= 0) return null;
  const id = value.slice(0, eq);
  const secret = value.slice(eq + 1);
  if (!TOKEN_ID_RE.test(id) || !secret) return null;
  return { id, secret };
}

/** Build the router. Exported for tests that want to call handlers without HTTP. */
export function createPveRoutes(sim: DemoSim): Route[] {
  const routes: Route[] = [];
  const add = (path: string, handler: Handler, delayMs?: number) => routes.push({ segments: path.split('/').filter(Boolean), handler, delayMs });
  const node = (p: Params) => requireNode(p.node!);
  const vmid = (p: Params) => vmidParam(p.vmid!);
  const timeframe = (q: URLSearchParams, allowed: readonly Timeframe[]) => enumParam(q, 'timeframe', allowed, true);
  const cf = (q: URLSearchParams) => enumParam(q, 'cf', ['AVERAGE', 'MAX'] as const) ?? 'AVERAGE';

  // RRD answers only change once per bucket; cache them (the dashboard polls hour/day series repeatedly).
  const rrdCache = new Map<string, RrdRow[]>();
  const cachedRrd = (key: string, tf: Timeframe, nowMs: number, build: () => RrdRow[]): RrdRow[] => {
    const bucket = Math.floor(nowMs / 1000 / RRD_SETUP[tf].reso);
    const k = `${key}|${tf}|${bucket}`;
    const hit = rrdCache.get(k);
    if (hit) return hit;
    const rows = build();
    rrdCache.set(k, rows);
    if (rrdCache.size > 64) rrdCache.delete(rrdCache.keys().next().value!);
    return rows;
  };

  add('', () => ['access', 'cluster', 'nodes', 'pools', 'storage', 'version'].map((subdir) => ({ subdir })));
  add('version', () => version());
  add('access/permissions', () => ({
    '/': { 'Datastore.Audit': 1, 'Mapping.Audit': 1, 'Pool.Audit': 1, 'SDN.Audit': 1, 'Sys.Audit': 1, 'VM.Audit': 1, 'VM.GuestAgent.Audit': 1 },
  }));

  // ── cluster
  add('cluster/status', () => clusterStatus());
  add('cluster/resources', (_p, q, now) => clusterResources(sim, now, enumParam(q, 'type', ['vm', 'storage', 'node', 'sdn'] as const)));
  add('cluster/backup', (_p, _q, now) => backupJobs(now, sim.edgeCases));
  add('cluster/backup-info/not-backed-up', () => notBackedUp(sim.edgeCases));

  // ── node
  add('nodes', (_p, _q, now) => nodesIndex(sim, now));
  add('nodes/:node/version', (p) => (node(p), version()));
  add('nodes/:node/status', (p, _q, now) => (node(p), nodeStatus(sim, now)));
  add('nodes/:node/rrddata', (p, q, now) => {
    node(p);
    const tf = timeframe(q, NODE_TIMEFRAMES);
    const c = cf(q);
    return cachedRrd(`node|${c}`, tf, now, () => nodeRrd(sim, tf, c, now));
  });
  add('nodes/:node/netstat', (p, _q, now) => {
    node(p);
    return sim
      .guests()
      .filter((g) => sim.isRunning(g))
      .map((g) => {
        const c = sim.guestCounters(g, now);
        // regex captures → strings; `in` = traffic to the guest (host-side transmit)
        return { vmid: String(g.vmid), dev: 'net0', in: String(c.netin), out: String(c.netout) };
      });
  });
  add('nodes/:node/network', (p, q) => (node(p), nodeNetwork(q)));
  add('nodes/:node/apt/versions', (p) => (node(p), aptVersions()));
  add('nodes/:node/apt/update', (p) => {
    node(p);
    throw permissionDenied(`/nodes/${p.node}`, 'Sys.Modify');
  });
  add('nodes/:node/syslog', (p) => {
    node(p);
    throw permissionDenied(`/nodes/${p.node}`, 'Sys.Syslog');
  });
  add('nodes/:node/journal', (p) => {
    node(p);
    throw permissionDenied(`/nodes/${p.node}`, 'Sys.Syslog');
  });
  add('nodes/:node/subscription', (p) => (node(p), subscription()));
  add('nodes/:node/certificates/info', (p) => (node(p), certificates(sim)));
  add('nodes/:node/services', (p) => (node(p), services()), 120);

  // ── guests
  add('nodes/:node/qemu', (p, q, now) => {
    node(p);
    const full = boolParam(q, 'full') ?? false;
    return sim
      .guests()
      .filter((g) => g.type === 'qemu')
      .map((g) => qemuStatus(sim, g, now, { full, current: false }));
  });
  add('nodes/:node/lxc', (p, _q, now) => {
    node(p);
    return sim
      .guests()
      .filter((g) => g.type === 'lxc')
      .map((g) => lxcStatus(sim, g, now, { current: false }));
  });
  add('nodes/:node/qemu/:vmid/status/current', (p, _q, now) => {
    node(p);
    return qemuStatus(sim, findGuest(sim, 'qemu', vmid(p)), now, { full: true, current: true });
  });
  add('nodes/:node/lxc/:vmid/status/current', (p, _q, now) => {
    node(p);
    return lxcStatus(sim, findGuest(sim, 'lxc', vmid(p)), now, { current: true });
  });
  add('nodes/:node/qemu/:vmid/config', (p, q) => {
    node(p);
    const current = boolParam(q, 'current') ?? false;
    return qemuConfig(findGuest(sim, 'qemu', vmid(p)), sim.anchor, { pending: sim.edgeCases && !current });
  });
  add('nodes/:node/lxc/:vmid/config', (p, q) => (node(p), boolParam(q, 'current'), lxcConfig(findGuest(sim, 'lxc', vmid(p)))));
  for (const type of ['qemu', 'lxc'] as const) {
    add(`nodes/:node/${type}/:vmid/rrddata`, (p, q, now) => {
      node(p);
      const g = findGuest(sim, type, vmid(p));
      const tf = timeframe(q, GUEST_TIMEFRAMES);
      const c = cf(q);
      return cachedRrd(`${type}/${g.vmid}|${c}`, tf, now, () => guestRrd(sim, g, tf, c, now));
    });
  }
  add('nodes/:node/lxc/:vmid/interfaces', (p) => (node(p), lxcInterfaces(sim, findGuest(sim, 'lxc', vmid(p)))));
  // a failing guest-ping waits for its 3 s timeout before PVE gives up
  add('nodes/:node/qemu/:vmid/agent/:command', (p, _q, now) => (node(p), agentCommand(sim, findGuest(sim, 'qemu', vmid(p)), p.command!, now)), 40);

  // ── storage, disks, zfs
  add('nodes/:node/storage', (p, q, now) => (node(p), storageList(sim, now, q)));
  add('nodes/:node/storage/:storage/content', (p, q) => (node(p), storageContent(sim, p.storage!, q)), 60);
  add('nodes/:node/storage/:storage/prunebackups', (p, q) => (node(p), pruneBackups(sim, p.storage!, q)), 250);
  add('nodes/:node/disks/list', (p, q) => (node(p), disksList(q)), 450);
  add('nodes/:node/disks/smart', (p, q, now) => (node(p), diskSmart(sim, q, now)), 180);
  add('nodes/:node/disks/zfs', (p) => (node(p), zfsList()), 40);
  add('nodes/:node/disks/zfs/:name', (p, _q, now) => (node(p), zfsDetail(sim, p.name!, now)), 40);

  // ── tasks
  add('nodes/:node/tasks', (p, q, now) => (node(p), taskList(sim, now, q)));
  add('nodes/:node/tasks/:upid/log', (p, q, now) => (node(p), taskLog(sim, now, p.node!, p.upid!, q)));
  add('nodes/:node/tasks/:upid/status', (p, _q, now) => (node(p), taskStatus(sim, now, p.node!, p.upid!)));

  return routes;
}

function matchRoute(routes: Route[], segments: string[]): { route: Route; params: Params } | undefined {
  for (const route of routes) {
    if (route.segments.length !== segments.length) continue;
    const params: Params = {};
    let ok = true;
    for (let i = 0; i < segments.length; i++) {
      const pat = route.segments[i]!;
      if (pat.startsWith(':')) params[pat.slice(1)] = segments[i]!;
      else if (pat !== segments[i]) {
        ok = false;
        break;
      }
    }
    if (ok) return { route, params };
  }
  return undefined;
}

/** HTTP reason phrases must be a single printable line. */
function reason(text: string): string {
  return text.split('\n')[0]!.replace(/[^\x20-\x7e]/g, '?').slice(0, 200) || 'Error';
}

function send(res: ServerResponse, status: number, body: unknown, reasonPhrase?: string): void {
  const json = JSON.stringify(body);
  res.writeHead(status, reason(reasonPhrase ?? STATUS_CODES[status] ?? 'Unknown'), {
    'Content-Type': 'application/json;charset=UTF-8',
    'Content-Length': Buffer.byteLength(json),
    'Cache-Control': 'max-age=0',
    Pragma: 'no-cache',
    Expires: new Date().toUTCString(),
    Server: 'pve-api-daemon/3.0',
  });
  res.end(json);
}

function sendError(res: ServerResponse, err: PveHttpError): void {
  const body: Record<string, unknown> = { data: null, message: `${err.message}\n` };
  if (err.errors) body.errors = err.errors;
  send(res, err.status, body, err.message);
}

export async function startMockProxmox(opts: MockProxmoxOptions = {}): Promise<MockProxmox> {
  const sim = opts.sim ?? new DemoSim();
  const log = opts.log;
  const latency = opts.latency ?? true;
  const routes = createPveRoutes(sim);

  const handle = (req: IncomingMessage, res: ServerResponse): void => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    const method = req.method ?? 'GET';
    if (url.pathname !== '/api2/json' && !url.pathname.startsWith('/api2/json/')) {
      send(res, 404, { data: null, message: 'Not Found\n' });
      return;
    }
    // Authentication first, like pveproxy (also for unknown paths).
    const auth = parseTokenHeader(req.headers.authorization);
    if (auth === undefined) return sendError(res, new PveHttpError(401, 'No ticket'));
    if (auth === null || (opts.token && (auth.id !== opts.token.id || auth.secret !== opts.token.secret))) {
      return sendError(res, new PveHttpError(401, 'Authentication failed!'));
    }

    let segments: string[];
    try {
      segments = url.pathname.slice('/api2/json'.length).split('/').filter(Boolean).map(decodeURIComponent);
    } catch {
      return sendError(res, new PveHttpError(400, 'invalid URL encoding'));
    }
    const path = `/${segments.join('/')}`;
    const notImplemented = () => new PveHttpError(501, `Method '${method} ${path}' not implemented`);
    const match = method === 'GET' ? matchRoute(routes, segments) : undefined;
    if (!match) return sendError(res, notImplemented());

    const run = () => {
      const started = Date.now();
      try {
        const out = match.route.handler(match.params, url.searchParams, sim.now());
        if (out instanceof Envelope) {
          const body: Record<string, unknown> = { data: out.data };
          if (out.total) body.total = out.total; // pve-http-server omits a falsy total
          send(res, 200, body);
        } else {
          send(res, 200, { data: out });
        }
        log?.debug('mock pve request', { path, status: 200, ms: Date.now() - started });
      } catch (err) {
        if (err instanceof PveHttpError) {
          log?.debug('mock pve request', { path, status: err.status, message: err.message });
          sendError(res, err);
        } else {
          log?.error('mock pve handler failed', { path, err });
          sendError(res, new PveHttpError(500, err instanceof Error ? err.message : String(err)));
        }
      }
    };
    if (!latency) return run();
    setTimeout(run, 2 + Math.floor(Math.random() * 18) + (match.route.delayMs ?? 0));
  };

  const server = createServer(handle);
  server.keepAliveTimeout = 10_000;
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(opts.port ?? 0, opts.host ?? '127.0.0.1', () => {
      server.off('error', reject);
      resolve();
    });
  });
  const { port, address } = server.address() as AddressInfo;
  const host = address.includes(':') ? `[${address}]` : address;
  log?.info('mock Proxmox VE API listening', { url: `http://${host}:${port}`, node: NODE });

  return {
    url: `http://${host}:${port}`,
    port,
    sim,
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections();
      }),
  };
}
