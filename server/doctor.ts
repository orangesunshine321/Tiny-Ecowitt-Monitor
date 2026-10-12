/**
 * pve1-dash-doctor: read-only self-test CLI (bundled to dist/server/doctor.js; /usr/local/bin/pve1-dash-doctor runs it
 * as the pve1dash user). See server/diagnostics/doctor.ts and `pve1-dash-doctor --help`.
 */
import { runDoctor } from './diagnostics/doctor.js';

runDoctor(process.argv.slice(2), process.env, {
  out: (s) => process.stdout.write(s),
  err: (s) => process.stderr.write(s),
  isTTY: process.stdout.isTTY === true,
}).then(
  (code) => {
    process.exitCode = code;
  },
  (err: unknown) => {
    process.stderr.write(`pve1-dash-doctor crashed: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}\n`);
    process.exitCode = 3;
  },
);
