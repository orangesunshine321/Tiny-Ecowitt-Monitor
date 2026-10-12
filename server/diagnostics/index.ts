import type { Config } from '../config.js';
import type { CommandRunner } from '../context.js';
import type { Store } from '../state.js';
import type { DiagnosticsReport } from '../../shared/types.js';

export interface DiagnosticsOptions {
  config: Config;
  appVersion: string;
  /** live store of the running server (collector freshness, last errors); absent for the standalone CLI */
  store?: Store;
  /** SSH runner for the helper checks; absent → SSH checks are skipped */
  runner?: CommandRunner;
  /** true when called from the running server (skip checks that only make sense standalone) */
  live?: boolean;
}

/**
 * Read-only self-test shared by GET /api/diagnostics and the pve1-dash-doctor CLI.
 * (Contract stub — implemented by the diagnostics stream.)
 */
export async function runDiagnostics(opts: DiagnosticsOptions): Promise<DiagnosticsReport> {
  return { generatedAt: Date.now(), appVersion: opts.appVersion, checks: [] };
}
