/**
 * Which guest network interfaces and addresses are worth showing / linking to.
 * Shared by the Proxmox mapping (guest agent, LXC interfaces) and the SSH inventory parser so both agree.
 */

/**
 * Virtual/internal interfaces whose addresses are not reachable from the LAN (and are often identical on many guests,
 * e.g. 10.42.0.1 on every k3s node, 192.168.122.1 on every libvirt host): loopback, Docker (docker0,
 * docker_gwbridge, br-<12 hex>), veths, libvirt, LXC/LXD/Incus bridges, Podman, Kubernetes CNIs (cni0, flannel.1,
 * cali*, vxlan.calico, cilium_*, weave, tunl0, kube-ipvs0), Home Assistant's hassio, and Windows pseudo-interfaces.
 * VPN interfaces (tailscale0, wg0, zt*) are deliberately kept, as is an OpenWrt-style br-lan.
 */
export const VIRTUAL_IFACE_RE =
  /^(?:lo\d*|docker.*|br-[0-9a-f]{12}|veth.*|virbr\d*(?:-nic)?|cni.*|podman\d*|flannel.*|cilium.*|vxlan\.calico|kube-.*|weave.*|calico.*|cali[0-9a-f]+|tunl\d*|hassio|lxcbr\d*|lxdbr\d*|incusbr\d*|Loopback Pseudo-Interface.*|isatap.*|Teredo.*)$/i;

export function isVirtualInterface(name: string | undefined): boolean {
  return !!name && VIRTUAL_IFACE_RE.test(name);
}

/** Addresses never useful to a LAN client: loopback, link-local, unspecified, and multicast. */
export function isUnusableAddress(addr: string): boolean {
  const a = addr.toLowerCase().split('%')[0] ?? '';
  if (a === '' || a === '0.0.0.0' || a === '::' || a === '::1') return true;
  if (/^127\./.test(a)) return true; // IPv4 loopback
  if (/^169\.254\./.test(a)) return true; // IPv4 link-local
  if (/^fe[89ab][0-9a-f]:/.test(a)) return true; // fe80::/10 link-local
  if (/^(22[4-9]|23\d)\./.test(a) || a.startsWith('ff')) return true; // multicast
  return false;
}
