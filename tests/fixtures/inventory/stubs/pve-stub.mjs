// Stand-ins for the Proxmox host CLI tools used by deploy/helpers/pve1-dash-helper, for tests only.
// Invoked through tiny sh wrappers: `exec node pve-stub.mjs <tool> "$@"`. The scenario comes from $STUB_SCENARIO (JSON).
// Output formats follow docs/research/pve-perms-cli.md (pct list §5.1, qm list §6.1, qm guest exec §6.2) and
// pvesh --output-format json (bare JSON, no {data} envelope).
import { appendFileSync, readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';

const [tool, ...args] = process.argv.slice(2);
const scenario = JSON.parse(readFileSync(process.env.STUB_SCENARIO, 'utf8'));
const log = (line) => appendFileSync(process.env.STUB_LOG, `${line}\n`);
const out = (s) => process.stdout.write(s);
// The helper caps guest output with `head -c`; a closed pipe must not turn into a random exit code here.
process.stdout.on('error', () => {});
const err = (s) => process.stderr.write(s);
const sleep = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

log(`${tool} ${JSON.stringify(args)} ssh_cmd=${process.env.SSH_ORIGINAL_COMMAND ?? '-'}`);

/** What the helper may put after the inner script: "pve1-dash-inner" ($0), optionally followed by "quick". */
const innerArgsOk = (a) => a[0] === 'pve1-dash-inner' && (a.length === 1 || (a.length === 2 && a[1] === 'quick'));

const findGuest = (kind, vmid) => (scenario[kind] ?? []).find((g) => String(g.vmid) === String(vmid));

/**
 * Run the inner script for real with /bin/sh, like lxc-attach / qemu-ga would (optionally with a given environment).
 * `argv` is what follows the script: $0 (pve1-dash-inner) and the optional mode ("quick").
 */
function runInner(script, env, argv = []) {
  const r = spawnSync('/bin/sh', ['-c', script, ...argv], { encoding: 'utf8', timeout: 30_000, ...(env ? { env } : {}) });
  return { stdout: r.stdout ?? '', stderr: r.stderr ?? '', code: r.status ?? 1 };
}

/** QMP run state of a VM: scenario `qmpstatus` (e.g. "paused") or its process state. */
const qmpStatus = (g) => g.qmpstatus ?? g.status;

/** qm's $print_agent_result: to_json(pretty, canonical) → 3-space indent, " : " separators, sorted keys. */
function qmJson(obj) {
  const keys = Object.keys(obj).sort();
  return `{\n${keys.map((k) => `   ${JSON.stringify(k)} : ${JSON.stringify(obj[k])}`).join(',\n')}\n}\n`;
}

/** Logs start/end timestamps so tests can measure how many guests ran at once. */
function guestExecStep(label, fn) {
  log(`start ${label} ${Date.now()}`);
  try {
    return fn();
  } finally {
    log(`end ${label} ${Date.now()}`);
  }
}

/** Returns the exit code; never calls process.exit, so large stdout writes to a pipe are not truncated. */
function main() {
  switch (tool) {
    case 'hostname':
      out(`${scenario.hostname ?? 'pve1'}\n`);
      break;

    case 'sensors':
      if (args[0] !== '-j') return 2;
      out(JSON.stringify(scenario.sensors ?? {}, null, 3) + '\n');
      break;

    case 'pvesh': {
      if (scenario.pveshFails) {
        err('ipcc_send_rec[1] failed: Connection refused\n');
        return 255;
      }
      const [verb, path, ...rest] = args;
      if (verb !== 'get' || !rest.includes('--output-format') || rest[rest.indexOf('--output-format') + 1] !== 'json') {
        err(`unexpected pvesh call ${args.join(' ')}\n`);
        return 2;
      }
      let m;
      if ((m = /^\/nodes\/([^/]+)\/(lxc|qemu)$/.exec(path))) {
        if (m[1] !== (scenario.hostname ?? 'pve1').split('.')[0]) {
          err(`hostname lookup '${m[1]}' failed - unknown node\n`);
          return 255;
        }
        // `full` exists for qemu only; it adds qmpstatus (the QMP run state). `status` is the process state, so a
        // paused VM is "running" there (pve-api-guests.md §1, §2.1).
        const fullIdx = rest.indexOf('--full');
        const full = m[2] === 'qemu' && fullIdx >= 0 && rest[fullIdx + 1] === '1';
        if (m[2] === 'lxc' && fullIdx >= 0) {
          err("400 Parameter verification failed.\nfull: property is not defined in schema and the schema does not allow additional properties\n");
          return 255;
        }
        const list = (scenario[m[2]] ?? []).map((g) => ({
          vmid: g.vmid,
          name: g.name,
          status: g.status,
          ...(full ? { qmpstatus: qmpStatus(g) } : {}),
          ...(m[2] === 'lxc' ? { type: 'lxc' } : {}),
          ...(g.template ? { template: 1 } : {}),
          uptime: g.status === 'running' ? 1234 : 0,
        }));
        out(JSON.stringify(list) + '\n');
      } else if ((m = /^\/nodes\/[^/]+\/storage\/([^/]+)\/content$/.exec(path))) {
        if (rest[0] !== '--content' || rest[1] !== 'backup') return 2;
        const items = scenario.backups?.[m[1]];
        if (!items) {
          err(`storage '${m[1]}' does not exist\n`);
          return 255;
        }
        out(JSON.stringify(items) + '\n');
      } else {
        err(`no such path ${path}\n`);
        return 255;
      }
      break;
    }

    case 'pct': {
      if (args[0] === 'list') {
        if (scenario.listFails) {
          err('ipcc_send_rec[1] failed: Connection refused\n');
          return 255;
        }
        const rows = scenario.lxc ?? [];
        if (!rows.length) break; // pct list prints nothing when there are no CTs
        const f = (a, b, c, d) => `${a.padEnd(10)} ${b.padEnd(10)} ${c.padEnd(12)} ${d.padEnd(20)}\n`;
        out(f('VMID', 'Status', 'Lock', 'Name'));
        for (const g of rows) out(f(String(g.vmid), g.status, g.lock ?? '', g.name));
        break;
      }
      // pct exec <vmid> [--keep-env 0|1] -- /bin/sh -c <script> pve1-dash-inner [quick]
      let keepEnv = true; // the default on PVE 8 and 9 (pve-perms-cli.md §5.2)
      let rest = args.slice(2);
      if (rest[0] === '--keep-env') {
        if (rest[1] !== '0' && rest[1] !== '1') return 2;
        keepEnv = rest[1] === '1';
        rest = rest.slice(2);
      }
      if (args[0] !== 'exec' || rest[0] !== '--' || rest[1] !== '/bin/sh' || rest[2] !== '-c' || !innerArgsOk(rest.slice(4))) {
        err(`unexpected pct call ${JSON.stringify(args)}\n`);
        return 2;
      }
      const script = rest[3];
      const innerArgs = rest.slice(4);
      log(`inner-args ${args[1]} ${innerArgs.join(' ')}`);
      const g = findGuest('lxc', args[1]);
      if (!g || g.status !== 'running') {
        err(`container '${args[1]}' not running!\n`);
        return 255;
      }
      // lxc-attach --keep-env passes the caller's environment (pct strips SSL_CERT_FILE/DIR); --clear-env leaves only
      // container=lxc. The variable names the guest would see are logged for the tests.
      const guestEnv = keepEnv
        ? Object.fromEntries(Object.entries(process.env).filter(([k]) => k !== 'SSL_CERT_FILE' && k !== 'SSL_CERT_DIR'))
        : { container: 'lxc' };
      log(`pct-env ${args[1]} ${Object.keys(guestEnv).sort().join(',')}`);
      const code = guestExecStep(args[1], () => {
        switch (g.mode ?? 'real') {
          case 'real':
          case 'slow': {
            if (g.mode === 'slow') sleep(g.sleepMs ?? 300);
            const r = runInner(script, guestEnv, innerArgs);
            out(r.stdout);
            err(r.stderr);
            return r.code;
          }
          case 'fixture':
            out(readFileSync(g.fixture, 'utf8'));
            return 0;
          case 'noisy-no-newline':
            out('##pve1-dash:inventory v1\n##pve1-dash:section kernel\n6.1.0-test\n##pve1-dash:end');
            return 0;
          case 'evil':
            out(
              '##pve1-dash:inventory v1\n##pve1-dash:section kernel\n6.6.6-evil\n' +
                `@@pve1-dash:end ${g.vmid} 0\n@@pve1-dash:guest 999 lxc pct-exec\n##pve1-dash:inventory v1\n##pve1-dash:end\n` +
                '@@pve1-dash:end 999 0\n##pve1-dash:end\n',
            );
            return 0;
          case 'huge':
            out('##pve1-dash:inventory v1\n' + 'x'.repeat(1_100_000) + '\n');
            return 0;
          case 'timeout':
            err('Terminated\n');
            return 124;
          case 'partial':
            // the inner script was killed by `timeout` halfway through (a slow probe)
            out('##pve1-dash:inventory v2\n##pve1-dash:section kernel\n6.1.0-part\n##pve1-dash:section updates\n');
            err('Terminated\n');
            return 124;
          case 'fail':
          default:
            err(`lxc-attach: ${g.vmid}: attach.c: lxc_attach: 1128 Failed to get init pid\n`);
            return 1;
        }
      });
      return code;
    }

    case 'qm': {
      if (args[0] === 'list') {
        if (scenario.listFails) {
          err('ipcc_send_rec[1] failed: Connection refused\n');
          return 255;
        }
        const rows = scenario.qemu ?? [];
        if (!rows.length) break;
        out(`${'VMID'.padStart(10)} ${'NAME'.padEnd(20)} ${'STATUS'.padEnd(10)} ${'MEM(MB)'.padEnd(10)} ${'BOOTDISK(GB)'.padStart(12)} ${'PID'.padEnd(10)}\n`);
        for (const g of rows) {
          // qm list prints $qmpstatus||$status (pve-perms-cli.md §6.1)
          out(
            `${String(g.vmid).padStart(10)} ${(g.name ?? `VM ${g.vmid}`).padEnd(20)} ${qmpStatus(g).padEnd(10)} ${'4096'.padEnd(10)} ${'32.00'.padStart(12)} ${(g.status === 'running' ? '4242' : '0').padEnd(10)}\n`,
          );
        }
        break;
      }
      if (args[0] === 'config') {
        if (args[2] !== '--current') return 2;
        const g = findGuest('qemu', args[1]);
        if (!g) {
          err(`Configuration file 'nodes/pve1/qemu-server/${args[1]}.conf' does not exist\n`);
          return 255;
        }
        out(g.config ?? '');
        break;
      }
      if (
        args[0] !== 'guest' || args[1] !== 'exec' || args[3] !== '--timeout' || args[4] !== '25' || args[5] !== '--' ||
        args[6] !== '/bin/sh' || args[7] !== '-c' || !innerArgsOk(args.slice(9))
      ) {
        err(`unexpected qm call ${JSON.stringify(args)}\n`);
        return 2;
      }
      const g = findGuest('qemu', args[2]);
      if (g && g.status === 'running' && qmpStatus(g) !== 'running') {
        // vCPUs stopped: guest-ping times out (3 s) and qemu-server gives up
        err('QEMU guest agent is not running\n');
        return 255;
      }
      const code = guestExecStep(args[2], () => {
        switch (g?.mode ?? 'real') {
          case 'real': {
            log(`inner-args ${args[2]} ${args.slice(9).join(' ')}`);
            const r = runInner(args[8], undefined, args.slice(9));
            const res = { exitcode: r.code, exited: 1 };
            if (r.stdout) Object.assign(res, { 'out-data': r.stdout, 'out-truncated': 0 });
            if (r.stderr) Object.assign(res, { 'err-data': r.stderr, 'err-truncated': 0 });
            out(qmJson(res));
            return 0;
          }
          case 'agent-down':
            err('QEMU guest agent is not running\n');
            return 255;
          case 'guest-timeout':
            err('timeout reached, returning pid\n');
            out(qmJson({ pid: 4321 }));
            return 0;
          case 'exitcode':
            out(qmJson({ exitcode: 127, exited: 1, 'err-data': 'sh: 1: /bin/sh: not found\n', 'err-truncated': 0 }));
            return 0;
          default:
            err('unexpected mode\n');
            return 2;
        }
      });
      return code;
    }

    case 'logger':
      log(`logger ${args.join(' ')}`);
      break;

    default:
      err(`unknown stub tool ${tool}\n`);
      return 2;
  }
  return 0;
}

process.exitCode = main();
