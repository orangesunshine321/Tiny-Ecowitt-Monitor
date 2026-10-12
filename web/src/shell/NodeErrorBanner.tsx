import { Check, Clock, Copy, KeyRound, ShieldAlert, ShieldX, Stethoscope, TriangleAlert, Unplug } from 'lucide-react';
import { useEffect, useState, type ReactNode } from 'react';
import { RelativeTime } from '../components/RelativeTime';
import { Link } from '../router';
import { useConnection, useSnapshot } from '../store';
import { DIAGNOSTICS_PATH, describeNodeError, type PveErrorKind } from './freshness';
import './NodeErrorBanner.css';

const ICON: Record<PveErrorKind, ReactNode> = {
  auth: <KeyRound size={18} strokeWidth={2.2} />,
  permission: <ShieldX size={18} strokeWidth={2.2} />,
  tls: <ShieldAlert size={18} strokeWidth={2.2} />,
  unreachable: <Unplug size={18} strokeWidth={2.2} />,
  timeout: <Clock size={18} strokeWidth={2.2} />,
  proxmox: <TriangleAlert size={18} strokeWidth={2.2} />,
  other: <TriangleAlert size={18} strokeWidth={2.2} />,
};

/** Copy text (async clipboard on https/localhost, a hidden textarea elsewhere, e.g. plain-http LAN access). */
async function copyText(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard && window.isSecureContext) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    /* fall through */
  }
  try {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.setAttribute('readonly', '');
    ta.style.cssText = 'position:fixed;top:0;left:0;opacity:0';
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand('copy');
    ta.remove();
    return ok;
  } catch {
    return false;
  }
}

function CopyCommand({ command }: { command: string }) {
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (!copied) return;
    const t = setTimeout(() => setCopied(false), 1800);
    return () => clearTimeout(t);
  }, [copied]);
  return (
    <div className="shell-nodeerr-cmd">
      <code>{command}</code>
      <button type="button" className="shell-nodeerr-copy" onClick={() => void copyText(command).then(setCopied)} aria-label={copied ? 'Copied' : 'Copy command'}>
        {copied ? <Check size={14} strokeWidth={2.6} aria-hidden="true" /> : <Copy size={14} strokeWidth={2.2} aria-hidden="true" />}
      </button>
      <span className="sr-only" aria-live="polite">
        {copied ? 'Copied to the clipboard' : ''}
      </span>
    </div>
  );
}

/**
 * The "Proxmox isn't answering / rejected the token / …" banner (decision 5): what went wrong in plain English, since
 * when the values are frozen, the server's one-line fix (with a copy button when it is a command), and a link to
 * Settings → Diagnostics. Renders nothing while the node is online, and nothing while the dashboard itself is
 * unreachable (the Live indicator and the waiting screen cover that).
 *
 * The page header shows it on every page (PageHeader `nodeBanner`); use it directly anywhere else.
 */
export function NodeErrorBanner({ className }: { className?: string }) {
  const node = useSnapshot((s) => ({
    online: s.node.online,
    error: s.node.error,
    errorKind: s.node.errorKind,
    errorHint: s.node.errorHint,
    lastUpdated: s.node.lastUpdated,
    // an empty snapshot (before data) has online:false too: only real snapshots count
    known: s.meta.serverTime > 0,
  }));
  const { connection } = useConnection();
  const info = node.known ? describeNodeError(node) : null;
  if (!info || connection === 'offline' || connection === 'connecting') return null;
  return (
    <section className={`shell-nodeerr ${className ?? ''}`} role="status" aria-label={info.title} data-kind={info.kind ?? 'other'}>
      <span className="shell-nodeerr-icon" aria-hidden="true">
        {ICON[info.kind ?? 'other']}
      </span>
      <div className="shell-nodeerr-body">
        <p className="shell-nodeerr-title">{info.title}</p>
        <p className="shell-nodeerr-text">
          {node.lastUpdated !== undefined ? (
            <>
              Showing values from <RelativeTime time={node.lastUpdated} format="long" />.
            </>
          ) : (
            'No data from Proxmox yet.'
          )}
          {info.detail && <span className="shell-nodeerr-detail"> {info.detail}</span>}
        </p>
        {info.command ? (
          <>
            {info.hintLead && <p className="shell-nodeerr-hint">{info.hintLead}</p>}
            <CopyCommand command={info.command} />
          </>
        ) : (
          info.hint && <p className="shell-nodeerr-hint">{info.hint}</p>
        )}
      </div>
      <Link className="shell-nodeerr-link" to={DIAGNOSTICS_PATH}>
        <Stethoscope size={15} strokeWidth={2.2} aria-hidden="true" />
        Open Diagnostics
      </Link>
    </section>
  );
}
