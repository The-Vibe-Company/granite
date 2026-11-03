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

  // Presentation only, needed by the unauthenticated sign-in page: the
  // stylesheet, its self-hosted fonts and the icon. A closed list, so nothing
  // else under /ui is reachable without a session.
  const publicFiles: Record<string, [string, string]> = {
    'style.css': ['dashboard/style.css', 'text/css'],
    'favicon.svg': ['dashboard/favicon.svg', 'image/svg+xml'],
    ...Object.fromEntries(DASHBOARD_FONTS.map(font => [`fonts/${font}.woff2`, [`dashboard/fonts/${font}.woff2`, 'font/woff2']])),
  };
  for (const [file, [source, mime]] of Object.entries(publicFiles)) {
    app.get(`/ui/${file}`, c => c.body(fs.readFileSync(path.join(publicDir, source)), 200, { 'Content-Type': mime }));
  }

  app.get('/ui/login', c => {
    if (session(c)) return c.redirect('/ui', 303);
    logins.delete(getCookie(c, LOGIN_COOKIE) ?? '');
    const id = nonce();
    const csrf = nonce();
    insert(logins, id, { csrf, expires: now() + LOGIN_SECONDS * 1000 });
    setCookie(c, LOGIN_COOKIE, id, { ...cookieOptions, maxAge: LOGIN_SECONDS });
    return c.html(formPage('Sign in to Granite', `<p>Your vault, read only. Browse, search and read your notes.</p>
      <form method="post" action="/ui/login">
      <input type="hidden" name="csrf" value="${csrf}">
      <label for="password">Dashboard password</label>
      <input id="password" name="password" type="password" autocomplete="current-password" required autofocus>
      <button class="btn" type="submit">Sign in</button></form>
      <p class="note">It cannot change your vault. A session lasts 12 hours.</p>`, { shot: 'contents' }));
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
  app.get('/ui/logout', c => c.html(formPage('Sign out of Granite', `<p>This ends your session on the server, on this device.</p>
    <form method="post" action="/ui/logout">
    <input type="hidden" name="csrf" value="${session(c)!.csrf}">
    <button class="btn" type="submit">Sign out</button></form><a class="alt" href="/ui">Back to the vault</a>`, { signedIn: true, shot: 'sleep' })));
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
  // The hosted reader has its own front (public/dashboard/); the local
  // `granite serve` constellation is not served here.
  const staticFiles: Record<string, string> = {
    'app.js': 'dashboard/app.js',
    'markdown-renderer.js': 'markdown-renderer.js',
    'type-filters.js': 'type-filters.js',
  };
  for (const [file, source] of Object.entries(staticFiles)) {
    app.get(`/ui/${file}`, c => c.body(fs.readFileSync(path.join(publicDir, source)), 200, { 'Content-Type': 'application/javascript' }));
  }
  const index = (c: Context) => c.html(fs.readFileSync(path.join(publicDir, 'dashboard', 'index.html'), 'utf8'));
  app.get('/ui', index);
  app.get('/ui/', index);
  return app;
}

// Self-hosted fonts served to the sign-in page (see public/dashboard/fonts/README.md).
const DASHBOARD_FONTS = ['literata-latin', 'literata-latin-ext', 'literata-latin-italic', 'literata-latin-ext-italic', 'atkinson-latin', 'atkinson-latin-ext'];

const BRAND_MARK = '<svg class="mark" width="22" height="22" viewBox="0 0 32 32" aria-hidden="true"><rect x="2" y="2" width="28" height="28" rx="7" fill="none" stroke="currentColor" stroke-width="2.5"/><g fill="currentColor"><circle cx="11" cy="10" r="1.9"/><circle cx="20" cy="8.5" r="1.3"/><circle cx="17" cy="16" r="2.1"/><circle cx="9" cy="20" r="1.4"/><circle cx="22" cy="21" r="1.7"/><circle cx="14" cy="23.5" r="1.1"/></g></svg>';

// A product shot of the reader in HTML/CSS: placeholder bars only, so it
// never shows vault content to someone who has not signed in.
// The same reader asleep, as an e-ink device shows when it is switched off.
function sleepShot(): string {
  return `<figure class="shot" aria-hidden="true"><div class="device"><div class="screen sleep">
    <svg class="sleep-mark" width="96" height="96" viewBox="0 0 32 32"><rect x="2" y="2" width="28" height="28" rx="7" fill="none" stroke="currentColor" stroke-width="1.6"/><g fill="currentColor"><circle cx="11" cy="10" r="1.9"/><circle cx="20" cy="8.5" r="1.3"/><circle cx="17" cy="16" r="2.1"/><circle cx="9" cy="20" r="1.4"/><circle cx="22" cy="21" r="1.7"/><circle cx="14" cy="23.5" r="1.1"/></g></svg>
    <span class="sleep-name">Granite</span><span class="sleep-line">Asleep. Your notes stay where they are.</span>
  </div></div></figure>`;
}

function productShot(): string {
  const row = (type: string, width: number, date: string, on = false) => `<div class="s-row${on ? ' on' : ''}">
    <div class="l"><span class="bar-line title w${width}"></span><span class="leader"></span><span class="d">${date}</span></div>
    <div class="m"><span class="type t-${type}">${type}</span><span class="bar-line w${width - 2}"></span></div></div>`;
  return `<figure class="shot" aria-hidden="true"><div class="device"><div class="screen">
    <div class="s-bar">${BRAND_MARK}<span>Granite</span><span class="ro">Read only</span></div>
    <div class="s-title">Contents</div>
    <div class="s-search"><span class="bar-line w3"></span></div>
    <div class="s-types"><span>All</span><span>note</span><span>source</span><span>synthesis</span><span>output</span></div>
    ${row('synthesis', 6, 'today', true)}${row('note', 4, 'yesterday')}${row('source', 5, '3 days ago')}${row('note', 3, '4 days ago')}${row('output', 5, 'Oct 27')}
  </div></div></figure>`;
}

const NAV = `<nav class="nav" aria-label="Dashboard"><ul>
  <li><a href="/ui"><svg width="20" height="20" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" aria-hidden="true"><path d="M7 5h10M7 10h10M7 15h10"/><circle cx="3.5" cy="5" r=".6" fill="currentColor"/><circle cx="3.5" cy="10" r=".6" fill="currentColor"/><circle cx="3.5" cy="15" r=".6" fill="currentColor"/></svg><span>Contents</span></a></li>
  <li><a href="/ui#q"><svg width="20" height="20" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" aria-hidden="true"><circle cx="8.5" cy="8.5" r="5.5"/><path d="m13 13 4.5 4.5"/></svg><span>Search</span></a></li>
  <li><a href="/ui/logout" class="out" aria-current="page"><svg width="20" height="20" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M8 3.5H4.5v13H8"/><path d="M12 6.5 15.5 10 12 13.5M15.5 10H7.5"/></svg><span>Sign out</span></a></li>
</ul></nav>`;

function formPage(title: string, body: string, options: { shot?: 'contents' | 'sleep'; signedIn?: boolean } = {}): string {
  // Only server-authored text and generated hex nonces are interpolated.
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
    <title>${title}</title><meta name="description" content="A private, read-only reader for one Granite vault.">
    <meta name="robots" content="noindex, nofollow"><meta name="theme-color" content="#e7e5df">
    <link rel="icon" href="/ui/favicon.svg" type="image/svg+xml"><link rel="stylesheet" href="/ui/style.css"></head>
    <body class="auth${options.signedIn ? ' app' : ''}"><a class="skip" href="#main">Skip to content</a>
    <header class="bar"><div class="bar-in">${options.signedIn ? `<a class="brand" href="/ui">${BRAND_MARK}<span>Granite</span></a>` : `<span class="brand">${BRAND_MARK}<span>Granite</span></span>`}<span class="ro">Read only</span>${options.signedIn ? NAV : ''}</div></header>
    <main id="main" class="auth-main${options.shot ? '' : ' solo'}"><section class="auth-card"><h1>${title}</h1>${body}</section>${options.shot === 'contents' ? productShot() : options.shot === 'sleep' ? sleepShot() : ''}</main></body></html>`;
}
function messagePage(message: string): string {
  return formPage('Granite', `<p class="alert" role="alert">${message}</p><a class="btn" href="/ui/login">Return to sign in</a>`);
}
