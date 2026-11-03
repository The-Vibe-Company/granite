import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Hono } from 'hono';
import type { Context } from 'hono';
import { getCookie, setCookie } from 'hono/cookie';
import { bodyLimit } from 'hono/body-limit';
import { getConnInfo } from '@hono/node-server/conninfo';
import { registerReadOnlyApiRoutes, type ReadOnlyApiSource } from './api-routes.js';

const SESSION_COOKIE = '__Secure-granite-ui';
const LOGIN_COOKIE = '__Secure-granite-ui-login';
const SESSION_SECONDS = 12 * 60 * 60;
const LOGIN_SECONDS = 10 * 60;
const MAX_ENTRIES = 1000;
const cookieOptions = { httpOnly: true, secure: true, sameSite: 'Strict' as const, path: '/ui' };
const nonce = () => randomBytes(32).toString('hex');
const digest = (value: string) => createHash('sha256').update(value).digest();
const equal = (a: string, b: string) => timingSafeEqual(digest(a), digest(b));

interface Session { expires: number; csrf: string }
interface Failures { count: number; until: number; expires: number }

export interface DashboardOptions {
  password?: string;
  /** Clock injection for expiry/backoff tests. */
  now?: () => number;
}

/** The hosted surface never mounts the local write route or instance proxy. */
export function createDashboard(source: ReadOnlyApiSource, options: DashboardOptions): Hono {
  const app = new Hono();
  if (!options.password) return app;
  if (options.password.trim().length < 16) {
    throw new Error('GRANITE_UI_PASSWORD must contain at least 16 non-padding characters.');
  }
  // Hash to fixed-size buffers before comparing, so length does not leak via comparison.
  const passwordDigest = digest(options.password);
  const now = options.now ?? Date.now;
  const sessions = new Map<string, Session>();
  const logins = new Map<string, Session>();
  const failures = new Map<string, Failures>();
  let globalFailures: Failures = { count: 0, until: 0, expires: 0 };
  const publicDir = path.join(path.dirname(fileURLToPath(import.meta.url)), 'public');

  function prune<T extends { expires: number }>(map: Map<string, T>) {
    for (const [key, value] of map) if (value.expires <= now()) map.delete(key);
  }
  function insert(map: Map<string, Session>, id: string, session: Session) {
    prune(map);
    if (map.size >= MAX_ENTRIES) map.delete(map.keys().next().value!);
    map.set(id, session);
  }
  function session(c: Context): Session | undefined {
    const id = getCookie(c, SESSION_COOKIE) ?? '';
    const value = sessions.get(id);
    if (value && value.expires > now()) return value;
    sessions.delete(id);
  }
  function clearCookie(c: Context, name: string) {
    setCookie(c, name, '', { ...cookieOptions, maxAge: 0 });
  }
  function sameOrigin(c: Context): boolean {
    // Railway terminates TLS. Compare the browser's HTTPS origin to the real
    // request Host, never to caller-controlled X-Forwarded-Host/Proto headers.
    return c.req.header('origin') === `https://${c.req.header('host') ?? new URL(c.req.url).host}`;
  }
  function clientIp(c: Context): string {
    // Do not trust X-Forwarded-For: all clients sharing a proxy share its bucket.
    try { return getConnInfo(c).remote.address ?? 'unknown'; } catch { return 'unknown'; }
  }
  function recordFailure(previous: Failures | undefined, threshold: number): Failures {
    const count = (previous && previous.expires > now() ? previous.count : 0) + 1;
    const delay = count >= threshold ? Math.min(60_000, 1000 * 2 ** Math.min(count - threshold, 6)) : 0;
    return { count, until: now() + delay, expires: now() + 15 * 60_000 };
  }

  app.use('/ui/*', async (c, next) => {
    // Apply even to errors/redirects/assets; no private browser or proxy caches.
    await next();
    c.header('Cache-Control', 'no-store');
    if (!c.res.headers.has('Content-Security-Policy')) {
      c.header('Content-Security-Policy', "default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self'; font-src 'self'; connect-src 'self'; base-uri 'none'; object-src 'none'; frame-ancestors 'none'; form-action 'self'");
    }
    c.header('X-Frame-Options', 'DENY');
    c.header('X-Content-Type-Options', 'nosniff');
    // no-referrer turns native form POST Origin into null in browsers.
    // same-origin preserves CSRF origin checks without leaking referrers off-site.
    c.header('Referrer-Policy', 'same-origin');
    c.header('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
  });
  app.use('/ui/*', bodyLimit({ maxSize: 4096 }));

  // Shared presentation only; needed to style the unauthenticated login form.
  app.get('/ui/style.css', c => c.body(fs.readFileSync(path.join(publicDir, 'style.css')), 200, { 'Content-Type': 'text/css' }));

  app.get('/ui/login', c => {
    if (session(c)) return c.redirect('/ui', 303);
    logins.delete(getCookie(c, LOGIN_COOKIE) ?? '');
    const id = nonce();
    const csrf = nonce();
    insert(logins, id, { csrf, expires: now() + LOGIN_SECONDS * 1000 });
    setCookie(c, LOGIN_COOKIE, id, { ...cookieOptions, maxAge: LOGIN_SECONDS });
    return c.html(formPage('Sign in to Granite', `<p>Your personal vault, read only.</p>
      <form method="post" action="/ui/login">
      <input type="hidden" name="csrf" value="${csrf}">
      <label for="password">Dashboard password</label>
      <input id="password" name="password" type="password" autocomplete="current-password" required autofocus>
      <button type="submit">Sign in</button></form>`));
  });
  app.post('/ui/login', async c => {
    const ip = clientIp(c);
    prune(failures);
    if (globalFailures.expires <= now()) globalFailures = { count: 0, until: 0, expires: 0 };
    const wait = Math.max(failures.get(ip)?.until ?? 0, globalFailures.until) - now();
    if (wait > 0) {
      c.header('Retry-After', String(Math.ceil(wait / 1000)));
      return c.html(messagePage('Too many attempts. Wait a moment and try again.'), 429);
    }
    if (!sameOrigin(c) || !c.req.header('content-type')?.startsWith('application/x-www-form-urlencoded')) {
      return c.text('Invalid form origin or content type.', 403);
    }
    const form = new URLSearchParams(await c.req.text());
    const id = getCookie(c, LOGIN_COOKIE) ?? '';
    const preSession = logins.get(id);
    if (!preSession || preSession.expires <= now() || !equal(form.get('csrf') ?? '', preSession.csrf)) {
      return c.text('Invalid or expired form. Reload the sign-in page.', 403);
    }
    logins.delete(id); // A login form can be used only once.
    clearCookie(c, LOGIN_COOKIE);
    if (!timingSafeEqual(digest(form.get('password') ?? ''), passwordDigest)) {
      if (failures.size >= MAX_ENTRIES && !failures.has(ip)) failures.delete(failures.keys().next().value!);
      failures.set(ip, recordFailure(failures.get(ip), 5));
      globalFailures = recordFailure(globalFailures, 10);
      return c.html(messagePage('Sign-in failed.'), 401);
    }
    // Reauthentication invalidates the old session; never adopt a supplied id.
    sessions.delete(getCookie(c, SESSION_COOKIE) ?? '');
    const sessionId = nonce();
    insert(sessions, sessionId, { csrf: nonce(), expires: now() + SESSION_SECONDS * 1000 });
    setCookie(c, SESSION_COOKIE, sessionId, { ...cookieOptions, maxAge: SESSION_SECONDS });
    failures.delete(ip);
    return c.redirect('/ui', 303);
  });

  app.use('/ui/*', async (c, next) => {
    if (!session(c)) {
      if (c.req.path === '/ui/api' || c.req.path.startsWith('/ui/api/') || c.req.path.startsWith('/ui/assets/')) {
        return c.json({ error: 'Sign in required.' }, 401);
      }
      return c.redirect('/ui/login', 303);
    }
    await next();
  });
  app.get('/ui/logout', c => c.html(formPage('Sign out of Granite', `<form method="post" action="/ui/logout">
    <input type="hidden" name="csrf" value="${session(c)!.csrf}">
    <button type="submit">Sign out</button></form><a href="/ui">Back to vault</a>`)));
  app.post('/ui/logout', async c => {
    if (!sameOrigin(c) || !c.req.header('content-type')?.startsWith('application/x-www-form-urlencoded')) return c.text('Invalid form.', 403);
    const form = new URLSearchParams(await c.req.text());
    if (!equal(form.get('csrf') ?? '', session(c)!.csrf)) return c.text('Invalid form.', 403);
    sessions.delete(getCookie(c, SESSION_COOKIE)!);
    clearCookie(c, SESSION_COOKIE);
    return c.redirect('/ui/login', 303);
  });

  registerReadOnlyApiRoutes(app, source, { prefix: '/ui', secureAssets: true });

  // A closed list prevents traversal and avoids serving arbitrary source files.
  const staticFiles: Record<string, string> = {
    'app.js': 'application/javascript',
    'graph-engine.js': 'application/javascript', 'markdown-renderer.js': 'application/javascript',
    'type-filters.js': 'application/javascript',
  };
  for (const [file, mime] of Object.entries(staticFiles)) {
    app.get(`/ui/${file}`, c => c.body(fs.readFileSync(path.join(publicDir, file)), 200, { 'Content-Type': mime }));
  }
  const index = (c: Context) => {
    const html = fs.readFileSync(path.join(publicDir, 'index.html'), 'utf8')
      .replace(/<link\b[^>]*https:\/\/[^>]*>/g, '')
      .replace('<head>', '<head><meta name="granite-base" content="/ui">')
      .replace(/(href|src)="\/(?!\/)/g, '$1="/ui/');
    return c.html(html);
  };
  app.get('/ui', index);
  app.get('/ui/', index);
  return app;
}

function formPage(title: string, body: string): string {
  // Only server-authored text and generated hex nonces are interpolated.
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
    <title>${title}</title><link rel="stylesheet" href="/ui/style.css"></head>
    <body><main class="dashboard-auth"><h1>${title}</h1>${body}</main></body></html>`;
}
function messagePage(message: string): string {
  return formPage('Granite', `<p role="alert">${message}</p><a href="/ui/login">Return to sign in</a>`);
}
