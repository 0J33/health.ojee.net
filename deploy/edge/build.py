#!/usr/bin/env python3
"""Builds deploy/edge/worker.js from page.html, the favicon and the landing's font.

   python3 deploy/edge/build.py && (cd deploy/edge && npx wrangler@4 deploy)

The Worker answers rep.ojee.net and health.ojee.net (wrangler.toml):
  - health.ojee.net: pages always go to rep.ojee.net, as the server's own legacyhost.js does, with the
    same exceptions (the API, /mcp, the sign-in callbacks Google and Strava are registered with, the
    Strava webhook, /sw.js, and older installed apps' web views).
  - Everything else goes to the real server first; only when it does not answer (Cloudflare 52x,
    502-504) does the Worker answer: this page, its font and favicon, or JSON 503 for /api/. So when
    the server comes back, rep. is back by itself.
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

export default {
  async fetch(req) {
    const url = new URL(req.url);
    const ua = req.headers.get('user-agent') || '';
    if (url.hostname === 'health.ojee.net' && (req.method === 'GET' || req.method === 'HEAD') && !keepOnOld(url.pathname) && !appShell(ua)) {
      return Response.redirect(`https://rep.ojee.net${url.pathname}${url.search}`, 301);
    }
    try {
      const r = await fetch(req);
      if (!DOWN.includes(r.status)) return r;
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
