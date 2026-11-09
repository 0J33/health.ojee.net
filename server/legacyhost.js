/* The site moved from health.ojee.net to rep.ojee.net. People who open the
   old address are sent to the new one. What must keep working there:

     /api/, the two sign-in callbacks, /mcp   Google and Strava's registered addresses,
                                     the Strava webhook, link and API keys.
     the installed apps              an older Android, iPhone or desktop app
                                     would open the new address in a browser
                                     and leave the app. They stay until replaced.
     /sw.js                          a worker fetch may not be redirected, so
                                     the old address gets a worker that removes
                                     itself and reloads, or the cached app
                                     would hide the move for ever.                */

const APP_SHELL = /; wv\)|Electron\//;
// An iPhone app's web view says Mobile/ but, unlike Safari, neither Version/ nor Safari/.
const iosWebView = (ua) => /iPhone|iPad/.test(ua) && /Mobile\//.test(ua) && !/Safari\//.test(ua);

/** null: serve as usual. { worker: true }: answer with RETIRED_WORKER. Otherwise { redirect: true }. */
export function movedFrom(config, req, path) {
  if (!config.legacyHosts?.length || !config.origin) return null;
  const host = String(req.headers.host || '').split(':')[0].toLowerCase();
  if (!config.legacyHosts.includes(host)) return null;
  if (req.method !== 'GET' && req.method !== 'HEAD') return null;
  const ua = String(req.headers['user-agent'] || '');
  if (APP_SHELL.test(ua) || iosWebView(ua)) return null;
  if (path === '/sw.js') return { worker: true };
  if (path.startsWith('/api/') || path === '/mcp' || /^\/auth\/[a-z]+\/callback$/.test(path)) return null;
  return { redirect: true };
}

export const RETIRED_WORKER = `self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (e) => e.waitUntil((async () => {
  for (const k of await caches.keys()) await caches.delete(k);
  await self.registration.unregister();
  for (const c of await self.clients.matchAll({ type: 'window' })) c.navigate(c.url);
})()));
`;
