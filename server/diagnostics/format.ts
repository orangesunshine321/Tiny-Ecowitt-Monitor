/**
 * Plain-text rendering of a DiagnosticsReport for pve1-dash-doctor: grouped, ✓ / ! / ✗ / – marks, indented details
 * and fixes, optional ANSI colours.
 */
import type { DiagnosticCheck, DiagnosticsReport } from '../../shared/types.js';
import { GROUP_ORDER } from './index.js';

const GROUP_TITLES: Record<DiagnosticCheck['group'], string> = {
  config: 'CONFIG',
  proxmox: 'PROXMOX',
  inventory: 'SSH INVENTORY',
  services: 'SERVICES',
  push: 'PUSH NOTIFICATIONS',
  system: 'SYSTEM',
};

const MARK: Record<DiagnosticCheck['status'], string> = { ok: '✓', warn: '!', fail: '✗', skip: '–' };
const COLOUR: Record<DiagnosticCheck['status'], string> = { ok: '32', warn: '33', fail: '31', skip: '2' };

export interface FormatOptions {
  colour: boolean;
  /** extra lines under the title (config path, live/standalone) */
  header?: string[];
  /** show ok checks' details (default true) */
  verbose?: boolean;
}

export function summarize(checks: readonly DiagnosticCheck[]): Record<DiagnosticCheck['status'], number> {
  const n = { ok: 0, warn: 0, fail: 0, skip: 0 };
  for (const c of checks) n[c.status]++;
  return n;
}

export function formatReport(report: DiagnosticsReport, o: FormatOptions): string {
  const paint = (code: string, s: string) => (o.colour ? `\x1b[${code}m${s}\x1b[0m` : s);
  const bold = (s: string) => paint('1', s);
  const lines: string[] = [];
  lines.push(bold(`pve1-dash doctor ${report.appVersion}`) + paint('2', ` · ${new Date(report.generatedAt).toISOString().replace('T', ' ').slice(0, 19)} UTC`));
  for (const h of o.header ?? []) lines.push(paint('2', h));
  const groups = [...GROUP_ORDER, ...new Set(report.checks.map((c) => c.group).filter((g) => !GROUP_ORDER.includes(g)))];
  for (const g of groups) {
    const list = report.checks.filter((c) => c.group === g);
    if (!list.length) continue;
    lines.push('', bold(GROUP_TITLES[g] ?? g.toUpperCase()));
    for (const c of list) {
      const [first = '', ...rest] = c.detail.split('\n');
      const showDetail = c.status !== 'ok' || o.verbose !== false;
      lines.push(`  ${paint(COLOUR[c.status], MARK[c.status])} ${bold(c.title)}${showDetail && first ? ` — ${first}` : ''}`);
      if (showDetail) for (const r of rest) lines.push(`      ${r}`);
      if (c.fix && c.status !== 'ok') {
        lines.push(`      ${paint('36', 'fix:')}`);
        for (const f of c.fix.split('\n')) lines.push(`        ${f.startsWith('#') ? paint('2', f) : f}`);
      }
      if (c.docs && c.status !== 'ok') lines.push(`      ${paint('2', `docs: ${c.docs}`)}`);
    }
  }
  const n = summarize(report.checks);
  const parts = [
    paint('32', `${n.ok} ok`),
    n.warn ? paint('33', `${n.warn} warning${n.warn === 1 ? '' : 's'}`) : '0 warnings',
    n.fail ? paint('31', `${n.fail} failure${n.fail === 1 ? '' : 's'}`) : '0 failures',
    ...(n.skip ? [paint('2', `${n.skip} skipped`)] : []),
  ];
  lines.push('', `${bold('Summary:')} ${parts.join(', ')}`);
  if (n.fail) lines.push('Fix the first ✗ of each group first: later checks often fail only because of it.');
  return lines.join('\n') + '\n';
}
