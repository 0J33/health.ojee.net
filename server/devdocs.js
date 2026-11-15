/* ============================================================
   health.ojee.net — the developer pages: docs/DEVELOPERS.md at
   /developers and docs/API.md at /developers/api, rendered here from
   the same Markdown the repository keeps (so the site and the repo
   never disagree), and the OpenAPI description at
   /developers/openapi.json (openapi.js).

   The Markdown is ours, so this renders the parts we write: headings,
   paragraphs, lists (nested, with code inside), fenced code, tables,
   quotes, rules, and inline code, bold, italics and links. Everything
   is escaped first; nothing in a document runs.
   ============================================================ */

import { readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const DOCS = fileURLToPath(new URL('../docs/', import.meta.url));

const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
export const slug = (t) => String(t).toLowerCase().replace(/<[^>]+>/g, '').replace(/&[a-z]+;/g, '').replace(/[^a-z0-9 _-]/g, '').trim().replace(/[\s_]+/g, '-').replace(/-+/g, '-');

/** Inline Markdown: code spans kept as they are, then links, bold, italics. */
export function inline(text) {
  const codes = [];
  let s = String(text).replace(/`([^`]+)`/g, (_, c) => { codes.push(c); return `\u0000${codes.length - 1}\u0000`; });
  s = esc(s);
  s = s.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (_, t, u) => {
    const safe = /^(https?:\/\/|\/|#|mailto:)/.test(u) ? u : '#';
    const ext = /^https?:\/\//.test(safe);
    return `<a href="${safe}"${ext ? ' target="_blank" rel="noopener noreferrer"' : ''}>${t}</a>`;
  });
  s = s.replace(/\*\*([^*]+)\*\*/g, '<b>$1</b>').replace(/(^|[^*\w])\*([^*\s][^*]*?)\*(?!\w)/g, '$1<i>$2</i>');
  // Where inline code may break when it must: after / . _ - (a path or a name in a narrow table
  // column breaks there, not mid-word). devdocs.css lets table code break only at these.
  return s.replace(/\u0000(\d+)\u0000/g, (_, i) => `<code>${esc(codes[Number(i)]).replace(/([/._-])(?=[A-Za-z0-9])/g, '$1<wbr>')}</code>`);
}

const indentOf = (l) => l.match(/^ */)[0].length;
const MARK = /^( *)([-*]|\d+\.) +(.*)$/;
const FENCE = /^( *)```(\S*)\s*$/;
const isTableSep = (l) => /^\s*\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)*\|?\s*$/.test(l);
const cells = (l) => l.trim().replace(/^\||\|$/g, '').split(/(?<!\\)\|/).map((c) => c.trim().replace(/\\\|/g, '|'));

/** Markdown blocks to HTML. `heads` collects the headings for the contents. */
export function render(md, heads = []) {
  const lines = String(md).replace(/\r\n?/g, '\n').split('\n');
  const out = [];
  let i = 0;
  const used = new Map();
  const blank = (l) => !l || !l.trim();
  const startsBlock = (l) => FENCE.test(l) || /^#{1,6} /.test(l) || MARK.test(l) || /^ *>/.test(l) || /^ *\|/.test(l) || /^ *(-{3,}|\*{3,}) *$/.test(l);

  while (i < lines.length) {
    const l = lines[i];
    if (blank(l)) { i += 1; continue; }
    let m;
    if ((m = FENCE.exec(l))) {
      const pad = m[1].length; const lang = m[2];
      const body = []; i += 1;
      while (i < lines.length && !/^ *```\s*$/.test(lines[i])) { body.push(lines[i].slice(Math.min(pad, indentOf(lines[i])))); i += 1; }
      i += 1;
      out.push(`<pre class="dd-code"${lang ? ` data-lang="${esc(lang)}"` : ''}><code>${esc(body.join('\n'))}</code></pre>`);
      continue;
    }
    if ((m = /^(#{1,6}) +(.*?)\s*#*$/.exec(l))) {
      const level = m[1].length; const html = inline(m[2]);
      let id = slug(html) || `s${i}`;
      const n = used.get(id) || 0; used.set(id, n + 1); if (n) id = `${id}-${n + 1}`;
      heads.push({ level, id, html });
      out.push(`<h${level} id="${id}"><a class="dd-anchor" href="#${id}" aria-hidden="true" tabindex="-1">#</a>${html}</h${level}>`);
      i += 1; continue;
    }
    if (/^ *(-{3,}|\*{3,}) *$/.test(l)) { out.push('<hr>'); i += 1; continue; }
    if (/^ *\|/.test(l) && isTableSep(lines[i + 1] || '')) {
      const head = cells(l); i += 2;
      const rows = [];
      while (i < lines.length && /^ *\|/.test(lines[i])) { rows.push(cells(lines[i])); i += 1; }
      out.push(`<div class="dd-table"><table><thead><tr>${head.map((c) => `<th>${inline(c)}</th>`).join('')}</tr></thead><tbody>${rows.map((r) => `<tr>${r.map((c) => `<td>${inline(c)}</td>`).join('')}</tr>`).join('')}</tbody></table></div>`);
      continue;
    }
    if (/^ *>/.test(l)) {
      const body = [];
      while (i < lines.length && /^ *>/.test(lines[i])) { body.push(lines[i].replace(/^ *> ?/, '')); i += 1; }
      out.push(`<blockquote>${render(body.join('\n'), [])}</blockquote>`);
      continue;
    }
    if ((m = MARK.exec(l))) {
      const base = m[1].length; const ordered = /\d/.test(m[2]);
      const items = [];
      while (i < lines.length) {
        const mm = MARK.exec(lines[i]);
        if (!mm || mm[1].length !== base || /\d/.test(mm[2]) !== ordered) break;
        const inner = base + mm[2].length + 1;
        const body = [mm[3]]; i += 1;
        while (i < lines.length) {
          const x = lines[i];
          if (blank(x)) {
            // A blank line inside an item only when what follows is indented under it.
            let j = i; while (j < lines.length && blank(lines[j])) j += 1;
            if (j < lines.length && indentOf(lines[j]) >= inner) { for (; i < j; i += 1) body.push(''); continue; }
            break;
          }
          const xm = MARK.exec(x);
          if (indentOf(x) < inner && (xm || startsBlock(x.trimStart()))) break;
          body.push(x.slice(Math.min(inner, indentOf(x))));
          i += 1;
        }
        const inner_html = render(body.join('\n'), []);
        // One plain paragraph: no <p> around it, as a list reads.
        items.push(/^<p>[\s\S]*<\/p>$/.test(inner_html) && inner_html.indexOf('<p>', 1) < 0 ? inner_html.slice(3, -4) : inner_html);
        while (i < lines.length && blank(lines[i]) && MARK.exec(lines[i + 1] || '')?.[1].length === base) i += 1;
      }
      const tag = ordered ? 'ol' : 'ul';
      out.push(`<${tag}>${items.map((x) => `<li>${x}</li>`).join('')}</${tag}>`);
      continue;
    }
    const para = [];
    while (i < lines.length && !blank(lines[i]) && (!para.length || !startsBlock(lines[i]))) { para.push(lines[i].trim()); i += 1; }
    out.push(`<p>${inline(para.join(' '))}</p>`);
  }
  return out.join('\n');
}

/** The page around a document: the site's look, a contents column, copy buttons on code. */
export function page({ title, description, body, heads, current, canonical }) {
  const toc = heads.filter((h) => h.level === 2 || (current === 'guide' && h.level === 3));
  const nav = [['guide', '/developers', 'Guide'], ['api', '/developers/api', 'API reference'], ['openapi', '/developers/openapi.json', 'OpenAPI']];
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
  <title>${esc(title)} · health</title>
  <meta name="description" content="${esc(description)}">
  ${canonical ? `<link rel="canonical" href="${esc(canonical)}">` : ''}
  <meta name="theme-color" content="#ffffff" media="(prefers-color-scheme: light)">
  <meta name="theme-color" content="#000000" media="(prefers-color-scheme: dark)">
  <meta name="color-scheme" content="light dark">
  <link rel="icon" href="/favicon.ico?v=3" sizes="48x48">
  <link rel="icon" href="/favicon.svg?v=3" type="image/svg+xml">
  <link rel="stylesheet" href="/css/app.css">
  <link rel="stylesheet" href="/css/devdocs.css">
  <script src="/js/theme.js"></script>
  <script src="/js/devdocs.js" defer></script>
</head>
<body>
  <header class="dd-top">
    <a class="dd-home" href="/">rep.ojee.net</a>
    <nav class="dd-tabs" aria-label="Developer pages">${nav.map(([k, href, t]) => `<a href="${href}"${k === current ? ' aria-current="page"' : ''}>${t}</a>`).join('')}</nav>
    <a class="dd-keys" href="/settings/api">Your keys</a>
  </header>
  <div class="dd">
    <aside class="dd-side"><details class="dd-toc" open><summary>On this page</summary><ol>${toc.map((h) => `<li class="dd-toc__l${h.level}"><a href="#${h.id}">${h.html.replace(/<a [^>]*>|<\/a>/g, '')}</a></li>`).join('')}</ol></details></aside>
    <main class="dd-main" id="top">${body}</main>
  </div>
</body>
</html>`;
}

/** The handler for /developers, /developers/api and /developers/openapi.json; null when not one of them. */
export function createDevDocs({ docs = DOCS, origin, openapi, send, baseHeaders }) {
  const cache = new Map();   // file -> { mtime, html }
  async function doc(file, meta) {
    const path = join(docs, file);
    const st = await stat(path);
    const hit = cache.get(file);
    if (hit && hit.mtime === st.mtimeMs) return hit.html;
    const md = await readFile(path, 'utf8');
    const heads = [];
    // The reference starts with its own title and a note for the repository: the page has the title.
    const body = render(md, heads);
    const html = page({ ...meta, body, heads, canonical: origin() ? `${origin()}${meta.path}` : null });
    cache.set(file, { mtime: st.mtimeMs, html });
    return html;
  }
  return async function devdocs(req, res, p) {
    if (req.method !== 'GET' && req.method !== 'HEAD') return null;
    const path = p.replace(/\/+$/, '') || '/';
    let html;
    if (path === '/developers') html = await doc('DEVELOPERS.md', { path, current: 'guide', title: 'Developers', description: 'Your health data from your own code and AI assistants: personal API keys, the REST API and the MCP server.' });
    else if (path === '/developers/api') html = await doc('API.md', { path, current: 'api', title: 'API reference', description: 'Every endpoint and field of the health.ojee.net API.' });
    else if (path === '/developers/openapi.json') {
      return send(res, 200, openapi(origin() || `https://${req.headers.host || 'health.ojee.net'}`), { 'cache-control': 'public, max-age=300', 'access-control-allow-origin': '*' });
    } else return null;
    res.writeHead(200, { ...baseHeaders, 'content-type': 'text/html; charset=utf-8', 'cache-control': 'public, max-age=300' });
    return res.end(req.method === 'HEAD' ? undefined : html);
  };
}
