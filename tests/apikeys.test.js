/* Personal API keys (server/apikeys.js) on the site's API, and the MCP
   server (server/mcp.js) that is the same API for AI assistants. */

import { refusal } from '../server/apikeys.js';
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { rig } from './helpers.mjs';

let r; let p; let other;
before(async () => {
  r = await rig();
  p = await r.person('keyholder', { persona: 'fitbit' });
  other = await r.person('neighbour', { persona: 'fitbit' });
});
after(async () => { await r.close(); });

const bearer = (key) => ({ authorization: `Bearer ${key}` });
const anon = () => r.client();
const make = async (scope, label = 'My script') => {
  const res = await p.c.post('/api/keys', { label, scope });
  assert.equal(res.status, 200, res.text);
  return res.json.key;
};
const rpc = (key, body, headers = {}) => anon().call('POST', '/mcp', { body, headers: { ...bearer(key), ...headers }, origin: null });

test('a key is shown once, listed without its secret, and needs a name and a scope', async () => {
  const res = await p.c.post('/api/keys', { label: 'Spreadsheet', scope: 'read' });
  assert.equal(res.status, 200);
  assert.match(res.json.key, /^hak_[A-Za-z0-9_-]{43}$/);
  const listed = res.json.keys.find((k) => k.label === 'Spreadsheet');
  assert.deepEqual(Object.keys(listed).sort(), ['createdAt', 'id', 'label', 'last4', 'lastUsedAt', 'scope', 'uses']);
  assert.equal(listed.last4, res.json.key.slice(-4));
  assert.ok(!JSON.stringify((await p.c.get('/api/keys')).json).includes(res.json.key), 'never again');
  assert.equal((await p.c.post('/api/keys', { label: '', scope: 'read' })).status, 400);
  assert.equal((await p.c.post('/api/keys', { label: 'x', scope: 'admin' })).status, 400);
});

test('a read key reads the person\'s data from anywhere, and nobody else\'s account', async () => {
  const key = await make('read');
  const c = anon();
  const me = await c.get('/api/me', { headers: bearer(key) });
  assert.equal(me.json.user.username, 'keyholder');
  const browse = await c.get('/api/browse', { headers: bearer(key) });
  assert.equal(browse.status, 200);
  assert.ok(browse.json.categories.length > 0);
  assert.equal(browse.headers.get('access-control-allow-origin'), '*', 'another site\'s page may call it');
  const metric = await c.get('/api/metric/steps?range=week', { headers: bearer(key) });
  assert.equal(metric.status, 200);
  assert.equal((await c.get('/api/export', { headers: bearer(key) })).status, 200);
  // Writing, the account, keys and admin: not with a read key.
  const w = await c.post('/api/entries', { kind: 'water', ml: 250 }, { headers: bearer(key), origin: null });
  assert.deepEqual([w.status, w.json.code], [403, 'not_allowed']);
  for (const [m, path] of [['GET', '/api/keys'], ['POST', '/api/account/delete'], ['GET', '/api/admin'], ['GET', '/api/link'], ['POST', '/api/ai']]) {
    assert.equal((await c.call(m, path, { headers: bearer(key), body: m === 'GET' ? undefined : {}, origin: null })).status, 403, path);
  }
  // A wrong key is not the cookie's person, nor anybody.
  assert.equal((await c.get('/api/me', { headers: bearer('hak_' + 'x'.repeat(43)) })).status, 401);
});

test('a write key logs entries without an Origin, but never touches the account or what others see', async () => {
  const key = await make('write', 'Shortcuts');
  const c = anon();
  const w = await c.post('/api/entries', { kind: 'bodytemp', celsius: 36.7 }, { headers: bearer(key), origin: null });
  assert.equal(w.status, 200, w.text);
  assert.equal(w.json.entry.value, 36.7);
  const wt = await c.post('/api/weight', { kg: 74.2 }, { headers: bearer(key), origin: null });
  assert.equal(wt.status, 200, wt.text);
  for (const [m, path] of [['PATCH', '/api/settings'], ['PATCH', '/api/profile'], ['POST', '/api/friends/request'], ['POST', '/api/circles'], ['POST', '/api/google/disconnect'], ['POST', '/api/keys']]) {
    assert.equal((await c.call(m, path, { headers: bearer(key), body: {}, origin: null })).status, 403, path);
  }
  // The cookie still needs its Origin, as before.
  assert.equal((await p.c.post('/api/entries', { kind: 'water', ml: 1 }, { origin: null })).status, 403);
});

test('a removed key stops at once; one person\'s key is never another\'s data', async () => {
  const made = await p.c.post('/api/keys', { label: 'Old', scope: 'read' });
  const key = made.json.key;
  assert.equal((await anon().get('/api/me', { headers: bearer(key) })).status, 200);
  assert.equal((await other.c.del(`/api/keys/${made.json.id}`)).status, 404, 'not theirs to remove');
  assert.equal((await p.c.del(`/api/keys/${made.json.id}`)).status, 200);
  assert.equal((await anon().get('/api/me', { headers: bearer(key) })).status, 401);
});

test('preflight: another site may ask, with the key, never with the cookie', async () => {
  const res = await anon().call('OPTIONS', '/api/browse', { origin: 'https://elsewhere.example', headers: { 'access-control-request-method': 'GET', 'access-control-request-headers': 'authorization' } });
  assert.equal(res.status, 204);
  assert.equal(res.headers.get('access-control-allow-origin'), '*');
  assert.equal(res.headers.get('access-control-allow-credentials'), null, 'no cookies across sites');
});

test('MCP: initialize, the tools a key may use, and a call that is the API\'s own answer', async () => {
  const read = await make('read', 'Claude');
  const init = await rpc(read, { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '1' } } });
  assert.equal(init.status, 200, init.text);
  assert.equal(init.json.result.protocolVersion, '2025-06-18');
  assert.equal(init.json.result.serverInfo.name, 'health.ojee.net');
  assert.ok(init.json.result.capabilities.tools);
  assert.equal((await rpc(read, { jsonrpc: '2.0', method: 'notifications/initialized' })).status, 202);

  const list = (await rpc(read, { jsonrpc: '2.0', id: 2, method: 'tools/list' })).json.result.tools.map((t) => t.name);
  assert.ok(list.includes('get_metric') && list.includes('list_metrics'));
  assert.ok(!list.includes('log_entry'), 'a read key is not offered writing');

  const metrics = await rpc(read, { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'list_metrics', arguments: {} } });
  const out = JSON.parse(metrics.json.result.content[0].text);
  assert.ok(out.metrics.some((m) => m.id === 'steps'), 'steps from the persona');
  const steps = await rpc(read, { jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'get_metric', arguments: { metric: 'steps', range: 'month' } } });
  assert.equal(steps.json.result.isError, false);
  const direct = (await anon().get('/api/metric/steps?range=month', { headers: bearer(read) })).json;
  assert.deepEqual(steps.json.result.structuredContent.stats, direct.stats, 'the same answer as REST');

  // A tool the key may not use, and the API's refusals, come back as words the model can use.
  const no = await rpc(read, { jsonrpc: '2.0', id: 5, method: 'tools/call', params: { name: 'log_entry', arguments: { kind: 'water', ml: 200 } } });
  assert.match(no.json.error.message, /only read/);
  const bad = await rpc(read, { jsonrpc: '2.0', id: 6, method: 'tools/call', params: { name: 'get_metric', arguments: { metric: 'nonsense' } } });
  assert.equal(bad.json.result.isError, true);

  const write = await make('write', 'Claude write');
  const logged = await rpc(write, { jsonrpc: '2.0', id: 7, method: 'tools/call', params: { name: 'log_entry', arguments: { kind: 'bodytemp', celsius: 36.9 } } });
  assert.equal(logged.json.result.isError, false, logged.text);
  assert.equal(JSON.parse(logged.json.result.content[0].text).entry.value, 36.9);
  // The API's own words when the group is off: the model can tell the person.
  const off = await rpc(write, { jsonrpc: '2.0', id: 10, method: 'tools/call', params: { name: 'log_entry', arguments: { kind: 'water', ml: 200 } } });
  assert.equal(off.json.result.isError, true);
  assert.match(off.json.result.content[0].text, /Switch on water tracking/);

  // Batches; unknown methods; no key.
  const both = await rpc(read, [{ jsonrpc: '2.0', id: 8, method: 'ping' }, { jsonrpc: '2.0', id: 9, method: 'nope' }]);
  assert.deepEqual(both.json.map((x) => [x.id, !!x.result, x.error?.code ?? null]), [[8, true, null], [9, false, -32601]]);
  const none = await anon().call('POST', '/mcp', { body: { jsonrpc: '2.0', id: 1, method: 'ping' }, origin: null });
  assert.equal(none.status, 401);
  assert.match(none.headers.get('www-authenticate'), /^Bearer /);
  assert.equal((await anon().get('/mcp')).status, 405);
});

test('the developer pages: the guide and the reference from docs/, and the OpenAPI description', async () => {
  const c = anon();
  const guide = await c.get('/developers');
  assert.equal(guide.status, 200);
  assert.match(guide.headers.get('content-type'), /text\/html/);
  assert.match(guide.text, /<h2 id="get-a-key">/);
  assert.match(guide.text, /<h2 id="the-mcp-server-for-ai">/, 'the address Settings links to');
  assert.ok(!/<script>/.test(guide.text) && !guide.text.includes('```'), 'rendered, not raw');
  const ref = await c.get('/developers/api');
  assert.equal(ref.status, 200);
  assert.match(ref.text, /id="post-apientries"/);
  const spec = await c.get('/developers/openapi.json');
  assert.equal(spec.json.openapi, '3.1.0');
  assert.ok(spec.json.paths['/api/metric/{id}'].get.operationId);
  assert.equal(spec.json.components.securitySchemes.apiKey.scheme, 'bearer');
  const ids = Object.values(spec.json.paths).flatMap((x) => Object.values(x).map((o) => o.operationId));
  assert.equal(new Set(ids).size, ids.length, 'operationIds are unique');
});

test('the Markdown: lists with code inside, tables, escaping', async () => {
  const { render } = await import('../server/devdocs.js');
  const html = render('- one `a<b>`\n- two\n  ```json\n  { "x": 1 }\n  ```\n- three **bold** [link](/x)\n\n| a | b |\n|---|---|\n| `c\\|d` | e |\n\n<script>alert(1)</script>');
  assert.match(html, /<ul><li>one <code>a&lt;b&gt;<\/code><\/li><li><p>two<\/p>\n<pre class="dd-code" data-lang="json"><code>\{ &quot;x&quot;: 1 \}<\/code><\/pre><\/li><li>three <b>bold<\/b> <a href="\/x">link<\/a><\/li><\/ul>/);
  assert.match(html, /<td><code>c\|d<\/code><\/td>/);
  assert.ok(!html.includes('<script>'));
});

test('a widget key reads the widget and nothing else', () => {
  assert.equal(refusal('widget', 'GET', '/api/widget'), null);
  assert.ok(refusal('widget', 'GET', '/api/brief'));
  assert.ok(refusal('widget', 'POST', '/api/widget'));
});
