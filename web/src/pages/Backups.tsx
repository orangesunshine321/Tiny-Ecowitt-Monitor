/**
 * Backups (DESIGN §5): coverage summary, per-guest coverage, backup jobs (human schedule + raw calendar event + next
 * run), recent vzdump tasks (log sheet) and the archives grouped by guest. When the server could only use the
 * read-only prunebackups fallback, a banner explains what is missing.
 * Deep links: /backups?vmid=102 expands that guest's archives; /backups?task=<UPID> opens a task log.
 */
import { Archive, ChevronsDownUp, ChevronsUpDown, ShieldCheck } from 'lucide-react';
import { useCallback, useEffect, useMemo, useState } from 'react';
import type { TaskEntry } from '../../../shared/types';
import { Button, Card, CardGrid, EmptyState, PageHeader } from '../components';
import { plural } from '../format';
import { useServerNow } from '../hooks/useNow';
import { setQuery, useQueryParam } from '../router';
import { useSnapshot } from '../store';
import { ArchiveGroup, CoverageTable, JobCard, RecentBackupTasks, SummaryCard } from './backups/BackupsParts';
import { backupTasks, groupByGuest, matchesQuery, nextJobRun, sortCoverage, sortJobs, summarizeCoverage } from './backups/backupsModel';
import { Banner, SearchField, Section, SelectField, useCollectorIssue } from './storage/ui';
import { TaskLogSheet } from './tasks/TaskLogSheet';
import './storage/ui.css';
import './backups/backups.css';

export default function BackupsPage() {
  const backups = useSnapshot((s) => s.backups, Object.is);
  const guests = useSnapshot((s) => s.guests, Object.is);
  const tasks = useSnapshot((s) => s.tasks, Object.is);
  const staleDays = useSnapshot((s) => s.meta.thresholds.backupStaleDays);
  const backupsIssue = useCollectorIssue('backups');
  const now = useServerNow(30_000);

  const lookup = useMemo(() => {
    const byId = new Map(guests.map((g) => [g.vmid, g]));
    return (vmid: number) => byId.get(vmid);
  }, [guests]);

  const summary = useMemo(() => summarizeCoverage(backups.coverage), [backups.coverage]);
  const coverage = useMemo(() => sortCoverage(backups.coverage), [backups.coverage]);
  const jobs = useMemo(() => sortJobs(backups.jobs), [backups.jobs]);
  const next = useMemo(() => nextJobRun(backups.jobs, now), [backups.jobs, now]);
  const recent = useMemo(() => backupTasks(tasks), [tasks]);
  const groups = useMemo(() => groupByGuest(backups.items), [backups.items]);
  const newest = useMemo(() => backups.items.reduce<(typeof backups.items)[number] | undefined>((a, b) => (!a || b.ctime > a.ctime ? b : a), undefined), [backups.items]);
  const storages = useMemo(() => [...new Set(backups.items.map((i) => i.storage))].sort(), [backups.items]);
  const totalSize = useMemo(() => {
    const sizes = backups.items.map((i) => i.size).filter((s): s is number => typeof s === 'number');
    return sizes.length ? sizes.reduce((a, b) => a + b, 0) : undefined;
  }, [backups.items]);

  // ── archives: search, storage filter, expanded groups (deep link ?vmid=)
  const [query, setQueryText] = useState('');
  const [storage, setStorage] = useState('');
  const vmidParam = useQueryParam('vmid');
  const [expanded, setExpanded] = useState<Set<number>>(() => new Set(vmidParam ? [Number(vmidParam)] : []));
  useEffect(() => {
    if (!vmidParam) return;
    const vmid = Number(vmidParam);
    setExpanded((s) => (s.has(vmid) ? s : new Set([...s, vmid])));
    // window.scrollTo, not scrollIntoView: the latter also scrolls overflow-hidden shell wrappers and shifts the chrome
    const t = setTimeout(() => {
      const el = document.getElementById(`guest-${vmid}`);
      if (!el) return;
      const margin = parseFloat(getComputedStyle(el).scrollMarginTop) || 80;
      // instant: this positions a deep link on arrival, it isn't a user-initiated jump
      window.scrollTo(0, Math.max(0, el.getBoundingClientRect().top + window.scrollY - margin));
    }, 150);
    return () => clearTimeout(t);
  }, [vmidParam]);

  const visibleGroups = useMemo(
    () =>
      groups
        .map((g) => (storage ? { ...g, items: g.items.filter((i) => i.storage === storage) } : g))
        .filter((g) => g.items.length > 0 && matchesQuery(g, lookup(g.vmid)?.name, query)),
    [groups, storage, query, lookup],
  );
  const allOpen = visibleGroups.length > 0 && visibleGroups.every((g) => expanded.has(g.vmid));
  const toggle = useCallback((vmid: number) => setExpanded((s) => {
    const n = new Set(s);
    if (n.has(vmid)) n.delete(vmid);
    else n.add(vmid);
    return n;
  }), []);

  // ── task log sheet (?task=UPID)
  const taskParam = useQueryParam('task');
  const openTask = useMemo(() => (taskParam ? (tasks.find((t) => t.upid === taskParam) ?? null) : null), [taskParam, tasks]);
  const showTask = useCallback((t: TaskEntry) => setQuery({ task: t.upid }), []);
  const closeTask = useCallback(() => setQuery({ task: null }), []);

  const subtitle = [
    plural(backups.items.length, 'archive'),
    plural(backups.jobs.length, 'job'),
    summary.total ? `${summary.covered} of ${summary.total} guests covered` : '',
  ]
    .filter(Boolean)
    .join(' · ');

  return (
    <>
      <PageHeader title="Backups" subtitle={subtitle} />
      <div className="inf-page">
        {backups.source === 'prunebackups' && (
          <Banner tone="info" title="Limited backup details">
            The read-only API token can only list backups through a prune dry run, so sizes, formats, notes and verification
            states are missing. Enable the SSH host helper to see the full listing.
          </Banner>
        )}

        <SummaryCard
          summary={summary}
          staleDays={staleDays}
          next={next}
          newest={newest}
          archives={backups.items.length}
          totalSize={totalSize}
          storages={storages.length}
          source={backups.source}
        />

        <Section id="coverage" title="Coverage" subtitle={`Guests without a backup in the last ${plural(staleDays, 'day')} come first`}>
          <Card padding="none" className="bk-coverage">
            {coverage.length ? (
              <CoverageTable rows={coverage} lookup={lookup} now={now} />
            ) : (
              <EmptyState compact icon={<ShieldCheck size={24} strokeWidth={1.8} />} title="No coverage data yet" message={backupsIssue ?? 'Coverage appears once the backup collector has run.'} />
            )}
          </Card>
        </Section>

        <Section id="jobs" title="Jobs" subtitle="Schedules use the node's local time">
          {jobs.length ? (
            <CardGrid min={400} stretch>
              {jobs.map((j) => (
                <JobCard key={j.id} job={j} />
              ))}
            </CardGrid>
          ) : (
            <Card>
              <EmptyState compact icon={<Archive size={24} strokeWidth={1.8} />} title="No backup jobs" message="Create one in Proxmox VE under Datacenter → Backup." />
            </Card>
          )}
        </Section>

        <Section id="tasks" title="Recent backup tasks" subtitle={recent.length ? 'Tap a task for its log' : undefined}>
          <Card padding="none" className="bk-tasks">
            {recent.length ? (
              <RecentBackupTasks tasks={recent} lookup={lookup} now={now} onOpen={showTask} />
            ) : (
              <EmptyState compact title="No backup tasks" message="No vzdump task is in the node's recent task history." />
            )}
          </Card>
        </Section>

        <Section
          id="archives"
          title="Archives"
          subtitle={`${plural(visibleGroups.length, 'guest')} · ${plural(
            visibleGroups.reduce((n, g) => n + g.items.length, 0),
            'backup',
          )}`}
          accessory={
            <>
              <SearchField value={query} onChange={setQueryText} placeholder="Search archives" />
              {storages.length > 1 && (
                <SelectField
                  ariaLabel="Storage"
                  value={storage}
                  onChange={setStorage}
                  options={[{ value: '', label: 'All storages' }, ...storages.map((s) => ({ value: s, label: s }))]}
                />
              )}
              {visibleGroups.length > 1 && (
                <Button
                  variant="gray"
                  size="small"
                  icon={allOpen ? <ChevronsDownUp size={14} strokeWidth={2.4} /> : <ChevronsUpDown size={14} strokeWidth={2.4} />}
                  onClick={() => setExpanded(allOpen ? new Set() : new Set(visibleGroups.map((g) => g.vmid)))}
                >
                  {allOpen ? 'Collapse all' : 'Expand all'}
                </Button>
              )}
            </>
          }
        >
          <div className="bk-groups material-card">
            {visibleGroups.length ? (
              visibleGroups.map((g) => <ArchiveGroup key={g.vmid} group={g} guest={lookup(g.vmid)} open={expanded.has(g.vmid)} onToggle={() => toggle(g.vmid)} />)
            ) : (
              <EmptyState
                compact
                icon={<Archive size={24} strokeWidth={1.8} />}
                title={backups.items.length ? 'No matching archives' : 'No backups found'}
                message={backups.items.length ? 'Try another search or storage.' : (backupsIssue ?? 'No backup storage lists any archive for this node.')}
              />
            )}
          </div>
        </Section>
      </div>
      <TaskLogSheet task={openTask} onClose={closeTask} />
    </>
  );
}
