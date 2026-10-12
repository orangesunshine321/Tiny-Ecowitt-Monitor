/**
 * Settings (DESIGN §5): Notifications, Appearance, Data sources, Diagnostics and About, as iOS inset-grouped lists.
 * Wide layouts use two columns (notifications, appearance, add-a-VM | data sources, diagnostics, about); sections have
 * anchors (#notifications, #appearance, #data-sources, #diagnostics, #add-vm, #about) so other pages can deep-link
 * (the offline banner and the attention card link to /settings#diagnostics).
 */
import { PageHeader } from '../components';
import { useElementSize } from '../hooks/useElementSize';
import { useSnapshot } from '../store';
import { AboutSection } from './settings/AboutSection';
import { AppearanceSection } from './settings/AppearanceSection';
import { AddVmSection, DataSourcesSection } from './settings/DataSourcesSection';
import { DiagnosticsSection } from './settings/DiagnosticsSection';
import { NotificationsSection } from './settings/NotificationsSection';
import './settings/settings.css';

export default function SettingsPage() {
  const version = useSnapshot((s) => s.meta.appVersion);
  const title = useSnapshot((s) => s.meta.title || s.node.node);
  // two columns from 1000px of content width (matches settings.css); the long "add a VM" guide then moves to the
  // first column to balance the heights, while one-column layouts keep it with the data sources
  const [wrapRef, { width }] = useElementSize<HTMLDivElement>();
  const twoCol = width >= 1000;
  return (
    <>
      <PageHeader title="Settings" subtitle={[title, version ? `pve1-dash ${version}` : ''].filter(Boolean).join(' · ')} />
      <div ref={wrapRef} className="set-wrap">
        <div className="set-page">
          <div className="set-col">
            <section id="notifications" className="set-anchor" aria-label="Notifications">
              <NotificationsSection />
            </section>
            <section id="appearance" className="set-anchor" aria-label="Appearance">
              <AppearanceSection />
            </section>
            {twoCol && <AddVmSection />}
          </div>
          <div className="set-col">
            <section id="data-sources" className="set-anchor" aria-label="Data sources">
              <DataSourcesSection />
            </section>
            <section id="diagnostics" className="set-anchor" aria-label="Diagnostics">
              <DiagnosticsSection />
            </section>
            {!twoCol && <AddVmSection />}
            <section id="about" className="set-anchor" aria-label="About">
              <AboutSection />
            </section>
          </div>
        </div>
      </div>
    </>
  );
}
