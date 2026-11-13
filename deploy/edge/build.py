#!/usr/bin/env python3
"""Builds deploy/edge/worker.js from page.html, the favicon and the landing's font.

   python3 deploy/edge/build.py && (cd deploy/edge && npx wrangler@4 deploy)

The Worker answers rep.ojee.net and health.ojee.net (wrangler.toml):
  - health.ojee.net: pages always go to rep.ojee.net, as the server's own legacyhost.js does, with the
    same exceptions (the API, /mcp, the sign-in callbacks Google and Strava are registered with, the
    Strava webhook, /sw.js, and older installed apps' web views).
  - While rep. runs from the live copy on the HP box (deploy/failover-hp.sh, started by hand or by
    deploy/standby-watch.sh), everything goes there, through HP's own tunnel (rep-standby.ojee.net),
    even once disinteg answers again: HP's data is then the newer one until it is brought back.
    Whether HP is serving is asked of its /api/health at most every 30 s per Cloudflare location.
  - Everything else goes to the real server first; only when it does not answer (Cloudflare 52x,
    502-504) does the Worker answer: this page, its font and favicon, or JSON 503 for /api/. So when
    the server comes back, rep. is back by itself.
  - rep-standby.ojee.net itself is not for visitors: asked directly, it is a 404.
"""
import base64, json, os, urllib.parse

HERE = os.path.dirname(os.path.abspath(__file__))
WEB = os.path.join(HERE, '..', '..', 'web')
fav = open(os.path.join(WEB, 'favicon.svg')).read().strip()
font = base64.b64encode(open(os.path.join(WEB, 'fonts', 'instrument-sans.woff2'), 'rb').read()).decode()
fav_uri = 'data:image/svg+xml,' + urllib.parse.quote(fav)
page = open(os.path.join(HERE, 'page.html')).read().replace('{{FAV_URI}}', fav_uri)

js = '''// Built by deploy/edge/build.py from page.html: edit those, not this file. See build.py for what it does.
const PAGE = %s;
const FAV = %s;
const FONT_B64 = %s;
const DOWN = [502, 503, 504, 520, 521, 522, 523, 524, 525, 526, 530];
// Older installed apps load the old address and must not be sent away (legacyhost.js).
const appShell = (ua) => /; wv\\)/.test(ua) || (/iPhone|iPad/.test(ua) && /Mobile\\//.test(ua) && !/Safari\\//.test(ua)) || (/Electron\\//.test(ua) && !/\\brep\\/\\d/.test(ua));
const keepOnOld = (path) => path.startsWith('/api/') || path === '/mcp' || /^\\/auth\\/[a-z]+\\/callback$/.test(path) || path === '/sw.js';
const fontBytes = () => Uint8Array.from(atob(FONT_B64), (c) => c.charCodeAt(0));
const STANDBY = 'https://rep-standby.ojee.net';
// Is rep. running from the copy on HP? Remembered here for 30 s (60 s once it is).
async function standbyUp(ctx) {
  const key = new Request(`${STANDBY}/__edge/standby-state`);
  const cache = caches.default;
  const hit = await cache.match(key).catch(() => null);
  if (hit) return (await hit.text()) === 'up';
  let up = false;
  try {
    const r = await fetch(`${STANDBY}/api/health`, { headers: { 'cache-control': 'no-store' }, signal: AbortSignal.timeout(3000) });
    up = r.ok && (await r.json().catch(() => ({}))).ok === true;
  } catch { up = false; }
  ctx.waitUntil(cache.put(key, new Response(up ? 'up' : 'down', { headers: { 'cache-control': `max-age=${up ? 60 : 30}` } })).catch(() => {}));
  return up;
}

export default {
  async fetch(req, env, ctx) {
    const url = new URL(req.url);
    if (url.hostname === 'rep-standby.ojee.net') return new Response('Not found', { status: 404 });
    // What the Worker sees of HP's rep. (for checking the failover; it says only whether it answers).
    if (url.pathname === '/__edge/standby') {
      const r = await fetch(`${STANDBY}/api/health`, { signal: AbortSignal.timeout(5000) }).catch(() => null);
      return new Response(JSON.stringify({ status: r ? r.status : null, body: r ? (await r.text()).slice(0, 200) : null }), { headers: { 'content-type': 'application/json', 'cache-control': 'no-store' } });
    }
    const ua = req.headers.get('user-agent') || '';
    if (url.hostname === 'health.ojee.net' && (req.method === 'GET' || req.method === 'HEAD') && !keepOnOld(url.pathname) && !appShell(ua)) {
      return Response.redirect(`https://rep.ojee.net${url.pathname}${url.search}`, 301);
    }
    try {
      if (await standbyUp(ctx)) {
        const r = await fetch(new Request(`${STANDBY}${url.pathname}${url.search}`, req));
        if (!DOWN.includes(r.status)) { const out = new Response(r.body, r); out.headers.set('x-rep-origin', 'standby'); return out; }
      } else {
        const r = await fetch(req);
        if (!DOWN.includes(r.status)) return r;
      }
    } catch { /* unreachable: answered below */ }
    const h = { 'cache-control': 'no-store', 'retry-after': '3600' };
    if (url.pathname === '/favicon.svg' || url.pathname === '/favicon.ico') return new Response(FAV, { headers: { 'content-type': 'image/svg+xml', 'cache-control': 'no-store' } });
    if (url.pathname === '/fonts/instrument-sans.woff2') return new Response(fontBytes(), { headers: { 'content-type': 'font/woff2', 'cache-control': 'no-store' } });
    if (url.pathname.startsWith('/api/') || url.pathname.startsWith('/auth/') || url.pathname === '/mcp') {
      return new Response(JSON.stringify({ error: 'rep. is down for maintenance. Back soon.', code: 'maintenance' }), { status: 503, headers: { ...h, 'content-type': 'application/json' } });
    }
    return new Response(PAGE, { status: 503, headers: { ...h, 'content-type': 'text/html; charset=utf-8' } });
  },
};
''' % (json.dumps(page), json.dumps(fav), json.dumps(font))
open(os.path.join(HERE, 'worker.js'), 'w').write(js)
print(f'worker.js written ({len(js) // 1024} KB)')
