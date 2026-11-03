import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { writeDefaultConfig, loadConfig } from '../../src/core/config.js';
import { createNote } from '../../src/core/note.js';
import { serializeFrontmatter } from '../../src/core/frontmatter.js';
import { GraniteMcpRuntime } from '../../src/mcp/runtime.js';
import { createGraniteMcpHttpApp } from '../../src/mcp/server.js';

// Supply a connection address, never an untrusted forwarded header.
vi.mock('@hono/node-server/conninfo', () => ({
  getConnInfo: (c: { env?: { testIp?: string } }) => ({ remote: { address: c.env?.testIp ?? '127.0.0.1' } }),
}));
const origin = 'https://dashboard.example';
const randomSecret = () => randomBytes(32).toString('hex');
const csrfFrom = (html: string) => /name="csrf" value="([a-f0-9]+)"/.exec(html)![1];
const cookieFrom = (response: Response) => response.headers.getSetCookie().find(c => !c.includes('Max-Age=0'))!.split(';')[0];

describe('personal hosted dashboard', () => {
  let vault: string;
  let runtime: GraniteMcpRuntime;
  let password: string;
  let mcpToken: string;
  let time: number;

  beforeEach(() => {
    password = randomSecret();
    mcpToken = randomSecret();
    vi.stubEnv('GRANITE_UI_PASSWORD', password);
    time = Date.now();
    vi.spyOn(Date, 'now').mockImplementation(() => time);
    vault = fs.mkdtempSync(path.join(os.tmpdir(), 'granite-dashboard-'));
    writeDefaultConfig(vault);
    const config = loadConfig(vault);
    for (const type of Object.values(config.note_types)) fs.mkdirSync(path.join(vault, type.folder), { recursive: true });
    const first = createNote(vault, config, 'note', 'First note', 'A searchable constellation. [[Second note]]');
    first.frontmatter.tags = ['personal', 'two words'];
    fs.writeFileSync(first.filepath, serializeFrontmatter(first.frontmatter, first.body));
    createNote(vault, config, 'source', 'Second note', 'A searchable source.');
    fs.mkdirSync(path.join(vault, 'assets'));
    fs.writeFileSync(path.join(vault, 'assets', 'sample.png'), randomBytes(20));
    fs.writeFileSync(path.join(vault, 'assets', 'active.svg'), '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>');
    runtime = new GraniteMcpRuntime(vault, { indexCheckIntervalMs: 0 });
  });
  afterEach(() => {
    runtime.close();
    fs.rmSync(vault, { recursive: true, force: true });
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  });
  const makeApp = () => createGraniteMcpHttpApp(runtime, { host: '0.0.0.0', port: 8080, authToken: mcpToken });
  type App = ReturnType<typeof makeApp>;
  async function request(app: App, url: string, init?: RequestInit, ip = '127.0.0.1') {
    return app.fetch(new Request(origin + url, init), { testIp: ip });
  }
  async function loginForm(app: App, ip?: string) {
    const response = await request(app, '/ui/login', undefined, ip);
    return { cookie: cookieFrom(response), csrf: csrfFrom(await response.text()) };
  }
  async function signIn(app: App, secret = password, ip?: string) {
    const form = await loginForm(app, ip);
    return request(app, '/ui/login', {
      method: 'POST', headers: { Cookie: form.cookie, Origin: origin, 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ csrf: form.csrf, password: secret }),
    }, ip);
  }

  it.each([undefined, ''])('returns 404 for every /ui surface when password is %s', async value => {
    if (value === undefined) delete process.env.GRANITE_UI_PASSWORD;
    else process.env.GRANITE_UI_PASSWORD = value;
    const app = makeApp();
    for (const url of ['/ui', '/ui/', '/ui/login', '/ui/logout', '/ui/api', '/ui/api/notes', '/ui/app.js', '/ui/assets/sample.png', '/ui/anything']) {
      for (const method of ['GET', 'POST', 'PUT', 'PATCH', 'DELETE']) {
        expect((await request(app, url, { method })).status).toBe(404);
      }
    }
  });
  it('rejects a weak configured password without echoing it', () => {
    vi.stubEnv('GRANITE_UI_PASSWORD', randomBytes(3).toString('hex'));
    expect(makeApp).toThrow('at least 16');
  });
  it('redirects HTML and returns 401 for API/assets without a session, even with MCP auth', async () => {
    const app = makeApp();
    for (const url of ['/ui', '/ui/', '/ui/app.js', '/ui/logout', '/ui/missing']) {
      const response = await request(app, url);
      expect(response.status).toBe(303);
      expect(response.headers.get('location')).toBe('/ui/login');
    }
    for (const url of ['/ui/api', '/ui/api/notes', '/ui/api/graph', '/ui/assets/sample.png']) {
      expect((await request(app, url, { headers: { Authorization: `Bearer ${mcpToken}` } })).status).toBe(401);
    }
    const stylesheet = await request(app, '/ui/style.css');
    expect(stylesheet.status).toBe(200);
    expect(stylesheet.headers.get('content-type')).toBe('text/css');
  });
  it('rejects a wrong password and does not use the MCP token as the password', async () => {
    const app = makeApp();
    expect((await signIn(app, randomSecret())).status).toBe(401);
    expect((await signIn(app, mcpToken)).status).toBe(401);
  });
  it('logs in, scopes a secure opaque session, renders the prefixed SPA, and logs out server-side', async () => {
    const app = makeApp();
    const login = await signIn(app);
    expect(login.status).toBe(303);
    expect(login.headers.get('location')).toBe('/ui');
    const setCookie = login.headers.getSetCookie().find(c => c.startsWith('__Secure-granite-ui='))!;
    for (const attribute of ['HttpOnly', 'Secure', 'SameSite=Strict', 'Path=/ui', 'Max-Age=43200']) expect(setCookie).toContain(attribute);
    const cookie = cookieFrom(login);
    expect(cookie.includes(password)).toBe(false);
    const html = await request(app, '/ui', { headers: { Cookie: cookie } });
    expect(html.status).toBe(200);
    const text = await html.text();
    expect(text).toContain('name="granite-base" content="/ui"');
    expect(text).toContain('src="/ui/app.js"');
    expect(text).not.toContain('fonts.googleapis.com');
    expect(text.includes(password)).toBe(false);
    expect((await request(app, '/ui/app.js', { headers: { Cookie: cookie } })).status).toBe(200);
    expect((await request(app, '/ui/api/notes', { headers: { Cookie: cookie } })).status).toBe(200);
    const confirmation = await request(app, '/ui/logout', { headers: { Cookie: cookie } });
    const csrf = csrfFrom(await confirmation.text());
    // GET is a confirmation only, not a state-changing logout.
    expect((await request(app, '/ui/api/notes', { headers: { Cookie: cookie } })).status).toBe(200);
    const logout = await request(app, '/ui/logout', {
      method: 'POST', headers: { Cookie: cookie, Origin: origin, 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ csrf }),
    });
    expect(logout.status).toBe(303);
    expect(logout.headers.get('set-cookie')).toContain('Max-Age=0');
    expect((await request(app, '/ui/api/notes', { headers: { Cookie: cookie } })).status).toBe(401);
  });
  it('enforces one-use, expiring, browser-bound login CSRF and same origin', async () => {
    const app = makeApp();
    const form = await loginForm(app);
    async function submit(cookie: string, csrf: string, originHeader = origin) {
      return request(app, '/ui/login', {
        method: 'POST', headers: { Cookie: cookie, Origin: originHeader, 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ csrf, password }),
      });
    }
    expect((await submit('', form.csrf)).status).toBe(403);
    expect((await submit(form.cookie, '')).status).toBe(403);
    expect((await submit(form.cookie, randomSecret())).status).toBe(403);
    expect((await submit(form.cookie, form.csrf, 'https://other.example')).status).toBe(403);
    expect((await submit(form.cookie, form.csrf, '')).status).toBe(403);
    expect((await submit(form.cookie, form.csrf)).status).toBe(303);
    expect((await submit(form.cookie, form.csrf)).status).toBe(403);
    const expired = await loginForm(app);
    time += 10 * 60_000 + 1;
    expect((await submit(expired.cookie, expired.csrf)).status).toBe(403);
  });
  it('enforces session-bound logout CSRF and expires sessions server-side', async () => {
    const app = makeApp();
    const cookie = cookieFrom(await signIn(app));
    const otherCookie = cookieFrom(await signIn(app));
    const otherForm = await request(app, '/ui/logout', { headers: { Cookie: otherCookie } });
    const otherCsrf = csrfFrom(await otherForm.text());
    for (const csrf of ['', randomSecret(), otherCsrf]) {
      const result = await request(app, '/ui/logout', {
        method: 'POST', headers: { Cookie: cookie, Origin: origin, 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ csrf }),
      });
      expect(result.status).toBe(403);
    }
    expect((await request(app, '/ui/api/notes', { headers: { Cookie: cookie + 'f' } })).status).toBe(401);
    time += 12 * 60 * 60_000 + 1;
    expect((await request(app, '/ui/api/notes', { headers: { Cookie: cookie } })).status).toBe(401);
  });
  it('limits per connection IP and enforces global backoff across different IPs', async () => {
    const app = makeApp();
    for (let i = 0; i < 5; i++) expect((await signIn(app, randomSecret())).status).toBe(401);
    const blocked = await signIn(app);
    expect(blocked.status).toBe(429);
    expect(blocked.headers.get('retry-after')).toBe('1');
    // Other connection IPs can still try, until the global threshold.
    for (let i = 0; i < 5; i++) expect((await signIn(app, randomSecret(), `192.0.2.${i}`)).status).toBe(401);
    expect((await signIn(app, password, '192.0.2.100')).status).toBe(429);
    time += 1001;
    expect((await signIn(app, password, '192.0.2.100')).status).toBe(303);
  });
  it('cannot bypass the IP bucket by changing forwarded headers', async () => {
    const app = makeApp();
    for (let i = 0; i < 5; i++) await signIn(app, randomSecret());
    const response = await request(app, '/ui/login', {
      method: 'POST', headers: { 'X-Forwarded-For': '192.0.2.100', 'X-Real-IP': '192.0.2.100' },
    });
    expect(response.status).toBe(429);
  });
  it('mounts only GET read routes and POST login/logout, with no proxy or unprefixed API', async () => {
    const app = makeApp();
    const cookie = cookieFrom(await signIn(app));
    const writes = app.routes.filter(r => r.path.startsWith('/ui') && !['GET', 'ALL'].includes(r.method));
    expect(writes.map(r => [r.method, r.path])).toEqual([['POST', '/ui/login'], ['POST', '/ui/logout']]);
    for (const method of ['POST', 'PUT', 'PATCH', 'DELETE']) {
      for (const url of ['/ui/api/notes', '/ui/api/notes/first-note', '/ui/api/search', '/ui/assets/sample.png']) {
        expect((await request(app, url, { method, headers: { Cookie: cookie } })).status).toBe(404);
      }
    }
    for (const url of ['/api/notes', '/assets/sample.png', '/ui/api/instances']) {
      expect((await request(app, url, { headers: { Cookie: cookie } })).status).toBe(404);
    }
  });
  it('browses, searches and combines type/tag filters and exposes note links/metadata', async () => {
    const app = makeApp();
    const cookie = cookieFrom(await signIn(app));
    const read = async (url: string) => (await request(app, url, { headers: { Cookie: cookie } })).json() as Promise<any>;
    expect((await read('/ui/api/notes')).notes).toHaveLength(2);
    expect((await read('/ui/api/notes?type=note&tag=personal')).notes.map((n: any) => n.slug)).toEqual(['first-note']);
    expect((await read('/ui/api/notes?tag=person')).notes).toEqual([]);
    expect((await read('/ui/api/notes?tag=two%20words')).notes).toHaveLength(1);
    expect((await read('/ui/api/search?q=searchable&type=source')).results.map((n: any) => n.slug)).toEqual(['second-note']);
    expect((await read('/ui/api/search?q=searchable&tag=personal')).results.map((n: any) => n.slug)).toEqual(['first-note']);
    expect((await read('/ui/api/search?q=searchable&type=source&tag=personal')).results).toEqual([]);
    const note = await read('/ui/api/notes/first-note');
    expect(note.tags).toContain('personal');
    expect(note.outgoing_links[0]).toMatchObject({ resolved: true, resolved_slug: 'second-note' });
    expect((await read('/ui/api/notes/second-note')).backlinks[0].source_slug).toBe('first-note');
    expect(note.created).toBeTruthy();
    expect(note.modified).toBeTruthy();
  });
  it('sets security/no-store headers and contains active assets and symlink escapes', async () => {
    const app = makeApp();
    const cookie = cookieFrom(await signIn(app));
    for (const url of ['/ui', '/ui/api/notes', '/ui/assets/sample.png', '/ui/login', '/ui/missing']) {
      const response = await request(app, url, { headers: { Cookie: cookie } });
      expect(response.headers.get('cache-control')).toBe('no-store');
      expect(response.headers.get('x-frame-options')).toBe('DENY');
      expect(response.headers.get('x-content-type-options')).toBe('nosniff');
      expect(response.headers.get('referrer-policy')).toBe('same-origin');
      expect(response.headers.get('content-security-policy')).toContain("frame-ancestors 'none'");
      expect(response.headers.get('content-security-policy')).not.toContain("script-src 'unsafe-inline'");
    }
    const active = await request(app, '/ui/assets/active.svg', { headers: { Cookie: cookie } });
    expect(active.headers.get('content-disposition')).toBe('attachment');
    expect(active.headers.get('content-security-policy')).toContain('sandbox');
    fs.symlinkSync(path.join(vault, 'granite.yml'), path.join(vault, 'assets', 'escape.png'));
    expect((await request(app, '/ui/assets/escape.png', { headers: { Cookie: cookie } })).status).toBe(404);
    expect((await request(app, '/ui/assets/%2e%2e%2fgranite.yml', { headers: { Cookie: cookie } })).status).toBe(404);
    expect((await request(app, '/ui/assets/%FF', { headers: { Cookie: cookie } })).status).toBe(404);
  });
  it('keeps the exact strict CSP and hardening headers on pages, assets and errors', async () => {
    const app = makeApp();
    const cookie = cookieFrom(await signIn(app));
    // Pinned verbatim: a redesign must never loosen it (no 'unsafe-inline' scripts,
    // no external origins). Change it only with a security review.
    const csp = "default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self'; font-src 'self'; connect-src 'self'; base-uri 'none'; object-src 'none'; frame-ancestors 'none'; form-action 'self'";
    const urls = ['/ui', '/ui/', '/ui/login', '/ui/logout', '/ui/style.css', '/ui/app.js', '/ui/favicon.svg', '/ui/api/notes', '/ui/missing'];
    for (const url of urls) {
      for (const headers of [{ Cookie: cookie }, {}] as Record<string, string>[]) {
        const response = await request(app, url, { headers });
        expect(response.headers.get('content-security-policy'), url).toBe(csp);
        expect(response.headers.get('cache-control'), url).toBe('no-store');
        expect(response.headers.get('x-frame-options'), url).toBe('DENY');
        expect(response.headers.get('x-content-type-options'), url).toBe('nosniff');
        expect(response.headers.get('referrer-policy'), url).toBe('same-origin');
        expect(response.headers.get('permissions-policy'), url).toBe('camera=(), microphone=(), geolocation=()');
      }
    }
  });
  it('serves only presentation before sign-in: the stylesheet, its self-hosted fonts and the icon', async () => {
    const app = makeApp();
    const css = await (await request(app, '/ui/style.css')).text();
    const fonts = [...css.matchAll(/url\(["']?([^"')]+)["']?\)/g)].map(m => m[1]);
    expect(fonts.length).toBeGreaterThan(0);
    for (const url of fonts) {
      expect(url).toMatch(/^\/ui\/fonts\/[a-z0-9-]+\.woff2$/);
      const response = await request(app, url);
      expect(response.status, url).toBe(200);
      expect(response.headers.get('content-type')).toBe('font/woff2');
    }
    const icon = await request(app, '/ui/favicon.svg');
    expect(icon.status).toBe(200);
    expect(icon.headers.get('content-type')).toBe('image/svg+xml');
    expect(await icon.text()).not.toMatch(/<script|on[a-z]+=|href=/i);
    // Anything outside the closed list still needs a session, including look-alikes.
    for (const url of ['/ui/fonts/missing.woff2', '/ui/fonts/..%2fapp.js', '/ui/fonts/', '/ui/dashboard/app.js', '/ui/graph-engine.js']) {
      expect((await request(app, url)).status, url).toBe(303);
    }
  });
  it('renders self-contained pages: same-origin assets only, no inline script or handlers', async () => {
    const app = makeApp();
    const login = await request(app, '/ui/login');
    const cookie = cookieFrom(await signIn(app));
    const pages = [await login.text(), await (await request(app, '/ui', { headers: { Cookie: cookie } })).text(),
      await (await request(app, '/ui/logout', { headers: { Cookie: cookie } })).text()];
    for (const html of pages) {
      expect(html).not.toMatch(/https?:\/\//);
      expect(html).not.toMatch(/\son[a-z]+\s*=/i);
      expect(html).not.toMatch(/\sstyle\s*=/i);
      for (const tag of html.match(/<script\b[^>]*>/g) ?? []) expect(tag).toMatch(/\ssrc="\/ui\/[a-z-]+\.js"/);
      for (const tag of html.match(/<link\b[^>]*>/g) ?? []) expect(tag).toMatch(/\shref="\/ui\/[a-z0-9./-]+"/);
    }
    for (const asset of ['/ui/style.css', '/ui/app.js', '/ui/markdown-renderer.js', '/ui/type-filters.js']) {
      const response = await request(app, asset, { headers: { Cookie: cookie } });
      expect(response.status, asset).toBe(200);
      expect(await response.text(), asset).not.toMatch(/https?:\/\/(?!www\.w3\.org\/2000\/svg)/);
    }
  });
  it('limits form size', async () => {
    const app = makeApp();
    const result = await request(app, '/ui/login', {
      method: 'POST', headers: { Origin: origin, 'Content-Type': 'application/x-www-form-urlencoded' },
      body: randomBytes(4097).toString('hex'),
    });
    expect(result.status).toBe(413);
  });
  it('keeps MCP bearer authentication and health unchanged', async () => {
    const app = makeApp();
    const cookie = cookieFrom(await signIn(app));
    expect((await request(app, '/health')).status).toBe(200);
    expect((await request(app, '/mcp')).status).toBe(401);
    expect((await request(app, '/mcp', { headers: { Cookie: cookie } })).status).toBe(401);
    expect((await request(app, '/mcp', { headers: { Authorization: `Bearer ${password}` } })).status).toBe(401);
    const response = await request(app, '/mcp', {
      method: 'POST', headers: { Authorization: `Bearer ${mcpToken}`, 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'dashboard-test', version: '1.0' } } }),
    });
    expect(response.status).toBe(200);
  });
});
