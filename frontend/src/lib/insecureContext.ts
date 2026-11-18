// Browsers only treat https pages and localhost as secure contexts.
// On a plain http address (a LAN or tailnet IP) several features are
// unavailable: service workers (so no PWA install and no offline
// shell), fullscreen, and every secure-context-only browser API. The
// app still works there, so this only drives the explanatory notice.
export function isPlainHttpRemote(location: Location): boolean {
  if (location.protocol !== 'http:') return false;
  const host = location.hostname;
  if (host === 'localhost' || host.endsWith('.localhost')) return false;
  if (host === '::1' || host === '[::1]' || host.startsWith('127.')) return false;
  return true;
}

export const INSECURE_CONTEXT_NOTICE =
  'このページは暗号化されていない HTTP で開かれているため、PWA のインストール、オフライン表示、全画面表示などの一部機能が使えません。HTTPS またはローカルホストで開くと、すべての機能が使えます。';
