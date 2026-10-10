/** Settings → About: versions, mode, and links. */
import { BookOpen, Code2, ExternalLink, Info, LifeBuoy, Server, Shapes } from 'lucide-react';
import { ListGroup, ListRow, StatusBadge } from '../../components';
import { useSnapshot } from '../../store';

/** The project's home (README "Install"). */
export const PROJECT_URL = 'https://github.com/orangesunshine321/Tiny-Ecowitt-Monitor';

export function AboutSection() {
  const meta = useSnapshot((s) => s.meta, Object.is);
  const node = useSnapshot((s) => ({ name: s.node.node, pveVersion: s.node.pveVersion, kernel: s.node.kernel }));
  const pveUi = /^https?:\/\//i.test(meta.pveUiUrl) ? meta.pveUiUrl : '';

  return (
    <ListGroup header="About" footer="pve1-dash only reads from Proxmox: it has no power controls, and consoles open in Proxmox’s own UI.">
      <ListRow
        icon={<Info strokeWidth={2} />}
        title="pve1-dash"
        subtitle={meta.demo ? 'Demo mode: simulated homelab data' : 'Read-only dashboard'}
        value={
          <span className="set-about-version">
            {meta.demo && <StatusBadge tone="info" size="small" icon={null} label="Demo" />}
            {meta.appVersion ? `Version ${meta.appVersion}` : '–'}
          </span>
        }
      />
      <ListRow
        icon={<Server strokeWidth={2} />}
        title="Proxmox VE"
        subtitle={[node.name, node.kernel ? `kernel ${node.kernel}` : ''].filter(Boolean).join(' · ')}
        value={node.pveVersion ?? '–'}
      />
      {pveUi && <ListRow icon={<ExternalLink strokeWidth={2} />} title="Open Proxmox" subtitle={pveUi} href={pveUi} />}
      <ListRow icon={<BookOpen strokeWidth={2} />} title="Setup guide" href={`${PROJECT_URL}/blob/main/docs/SETUP.md`} />
      <ListRow icon={<LifeBuoy strokeWidth={2} />} title="Troubleshooting" href={`${PROJECT_URL}/blob/main/docs/TROUBLESHOOTING.md`} />
      <ListRow icon={<Code2 strokeWidth={2} />} title="Source code" subtitle="MIT license" href={PROJECT_URL} />
      <ListRow
        icon={<Shapes strokeWidth={2} />}
        title="App icons"
        subtitle="dashboard-icons by homarr-labs (Apache-2.0)"
        href="https://github.com/homarr-labs/dashboard-icons"
      />
    </ListGroup>
  );
}
