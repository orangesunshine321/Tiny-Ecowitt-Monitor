/**
 * Demo mode entry point (PVE1_DASH_DEMO=1): starts the mock Proxmox VE API on a random localhost port and hands back
 * the mock SSH runner and health checker. All three share one simulation, anchored at startup, so the API, the
 * inventory and the service checks describe the same homelab (server/demo/world.ts) at the same moment.
 */
import type { CommandRunner, HealthChecker, Logger } from '../context.js';
import { DemoSim } from './sim.js';
import { startMockProxmox } from './mockProxmox.js';
import { createMockRunner } from './mockRunner.js';
import { createMockChecker } from './mockChecker.js';

export { DemoSim } from './sim.js';
export { startMockProxmox, type MockProxmox, type MockProxmoxOptions } from './mockProxmox.js';
export { createMockRunner, type MockRunnerOptions } from './mockRunner.js';
export { createMockChecker, type MockCheckerOptions } from './mockChecker.js';

export async function startDemo(log: Logger): Promise<{ proxmoxUrl: string; runner: CommandRunner; checker: HealthChecker; stop(): Promise<void> }> {
  const sim = new DemoSim();
  const pve = await startMockProxmox({ sim, log: log.child('mock-pve') });
  const runner = createMockRunner({ sim, log: log.child('mock-ssh') });
  const checker = createMockChecker({ sim });
  log.info('demo mode: simulated homelab ready', { proxmoxUrl: pve.url, anchor: new Date(sim.anchor).toISOString() });
  let stopped = false;
  return {
    proxmoxUrl: pve.url,
    runner,
    checker,
    async stop() {
      if (stopped) return;
      stopped = true;
      runner.close();
      await pve.close();
    },
  };
}
