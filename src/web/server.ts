import { Hono } from 'hono';
import type { MiddlewareHandler } from 'hono';
import { serve } from '@hono/node-server';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { GraniteConfig } from '../core/types.js';
import { syncVaultIndexAfterNoteWrite } from '../core/index-db.js';
import { createNote } from '../core/note.js';
import { registerReadOnlyApiRoutes } from './api-routes.js';
import type { CloudInstance } from './instances.js';

export const LOCAL_INSTANCE_ID = 'local';
const CLOUD_INSTANCE_PREFIX = 'cloud:';
const INSTANCE_HEADER = 'x-granite-instance';
const INSTANCE_QUERY_PARAM = 'instance';
const DEFAULT_PROXY_TIMEOUT_MS = 15_000; // headroom for cold-sprite wake + index build

export interface CreateAppOptions {
  cloudInstances?: CloudInstance[];
  fetchImpl?: typeof fetch;
  proxyTimeoutMs?: number;
}

export function createApp(
  vaultRoot: string | null,
  config: GraniteConfig | null,
  options: CreateAppOptions = {},
) {
  const app = new Hono();
  const cloudInstances = options.cloudInstances ?? [];
  const cloudById = new Map(cloudInstances.map(instance => [cloudSelectorId(instance.id), instance]));
  const fetchImpl = options.fetchImpl ?? fetch;
  const proxyTimeoutMs = options.proxyTimeoutMs ?? DEFAULT_PROXY_TIMEOUT_MS;
  const hasLocalVault = vaultRoot !== null && config !== null;
  const defaultInstance = hasLocalVault
    ? LOCAL_INSTANCE_ID
    : cloudSelectorId(cloudInstances.find(instance => instance.webApi)?.id ?? cloudInstances[0]?.id) ?? LOCAL_INSTANCE_ID;

  // Which vault sources this gateway can serve. Tokens and sprite URLs stay
  // server-side — the browser only ever sees ids and labels.
  app.get('/api/instances', (c) => {
    const instances = [
      ...(hasLocalVault ? [{
        id: LOCAL_INSTANCE_ID,
        label: 'Local vault',
        kind: 'local' as const,
        version: null as string | null,
        web_api: true,
      }] : []),
      ...cloudInstances.map(instance => ({
        id: cloudSelectorId(instance.id),
        label: instance.label,
        kind: 'cloud' as const,
        name: instance.id,
        version: instance.version,
        web_api: instance.webApi,
      })),
    ];
    return c.json({ instances, default: defaultInstance });
  });

  // Route /api/* and /assets/* to the requested instance. The SPA selects via
  // the X-Granite-Instance header; <img> tags (which cannot carry headers)
  // fall back to an ?instance= query param.
  const routeInstance: MiddlewareHandler = async (c, next) => {
    if (c.req.path === '/api/instances') {
      await next();
      return;
    }

    const requested = c.req.header(INSTANCE_HEADER) ?? c.req.query(INSTANCE_QUERY_PARAM) ?? defaultInstance;

    if (requested === LOCAL_INSTANCE_ID) {
      if (!hasLocalVault) {
        return c.json({ error: 'No local vault available.', code: 'no-local-vault' }, 404);
      }
      await next();
      return;
    }

    const instance = cloudById.get(requested);
    if (!instance) {
      return c.json({ error: `Unknown instance "${requested}".`, code: 'unknown-instance' }, 404);
    }
    return proxyToInstance(c.req.raw, instance, fetchImpl, proxyTimeoutMs);
  };

  app.use('/api/*', routeInstance);
  app.use('/assets/*', routeInstance);

  if (hasLocalVault) {
    registerReadOnlyApiRoutes(app, { vaultRoot, getConfig: () => config });

    // Create a new note (local vault only — cloud instances are read-only)
    app.post('/api/notes', async (c) => {
      const body = await c.req.json();
      const { type, title, body: noteBody, author } = body;

      if (!type || !title) {
        return c.json({ error: 'type and title are required' }, 400);
      }

      try {
        const note = createNote(vaultRoot, config, type, title, noteBody || undefined, { author });
        syncVaultIndexAfterNoteWrite(vaultRoot, config, note, { rebuild: true });

        return c.json({
          slug: note.slug,
          title: note.frontmatter.title,
          type: note.frontmatter.type,
          created: note.frontmatter.created,
          review_state: note.frontmatter.review_state,
          durability: note.frontmatter.durability,
          derived_from: note.frontmatter.derived_from,
        });
      } catch (err: any) {
        return c.json({ error: err.message }, 400);
      }
    });
  }

  // Static files — serve from the web/public directory
  // We need to resolve the path relative to where the source files are
  const publicDir = path.join(path.dirname(fileURLToPath(import.meta.url)), 'public');

  app.get('/*', (c) => {
    const reqPath = c.req.path === '/' ? '/index.html' : c.req.path;
    const filePath = path.join(publicDir, reqPath);

    if (!fs.existsSync(filePath)) {
      // SPA fallback
      const indexPath = path.join(publicDir, 'index.html');
      const html = fs.readFileSync(indexPath, 'utf-8');
      return c.html(html);
    }

    const content = fs.readFileSync(filePath);
    const ext = path.extname(filePath);
    const mimeTypes: Record<string, string> = {
      '.html': 'text/html',
      '.css': 'text/css',
      '.js': 'application/javascript',
      '.json': 'application/json',
      '.png': 'image/png',
      '.svg': 'image/svg+xml',
    };
    const contentType = mimeTypes[ext] || 'application/octet-stream';
    return new Response(content, { headers: { 'Content-Type': contentType } });
  });

  return app;
}

async function proxyToInstance(
  request: Request,
  instance: CloudInstance,
  fetchImpl: typeof fetch,
  timeoutMs: number,
): Promise<Response> {
  const isApiPath = new URL(request.url).pathname.startsWith('/api/');

  if (request.method !== 'GET' && request.method !== 'HEAD') {
    return jsonResponse({ error: 'Cloud instances are read-only from the web UI.', code: 'instance-read-only' }, 405);
  }

  if (!instance.webApi) {
    return jsonResponse({
      error: `Instance "${instance.id}" runs granite-mem ${instance.version ?? 'unknown'} without web UI support. Update it: granite deploy ${instance.id}`,
      code: 'instance-outdated',
    }, 502);
  }

  const source = new URL(request.url);
  const target = new URL(instance.baseUrl);
  target.pathname = source.pathname;
  for (const [key, value] of source.searchParams) {
    if (key !== INSTANCE_QUERY_PARAM) target.searchParams.append(key, value);
  }

  let upstream: Response;
  try {
    upstream = await fetchImpl(target, {
      method: request.method,
      headers: { Authorization: `Bearer ${instance.token}` },
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch {
    return jsonResponse({
      error: `Instance "${instance.id}" did not respond — it may be waking up. Retry in a few seconds.`,
      code: 'instance-unreachable',
    }, 504);
  }

  if (upstream.status === 401 || upstream.status === 403) {
    return jsonResponse({
      error: `Instance "${instance.id}" rejected the stored token. Re-run: granite deploy ${instance.id}`,
      code: 'instance-auth',
    }, 502);
  }

  const contentType = upstream.headers.get('content-type') ?? '';
  // An older granite without --web-api answers API paths with Hono's plain-text
  // 404 (a real /api/notes/:slug miss is JSON) — surface it as "outdated".
  if (upstream.status === 404 && isApiPath && !contentType.includes('application/json')) {
    return jsonResponse({
      error: `Instance "${instance.id}" does not expose the web API. Update it: granite deploy ${instance.id}`,
      code: 'instance-outdated',
    }, 502);
  }

  const headers = new Headers();
  if (contentType) headers.set('Content-Type', contentType);
  if (isApiPath) {
    headers.set('Cache-Control', 'no-store');
  } else {
    const cacheControl = upstream.headers.get('cache-control');
    if (cacheControl) headers.set('Cache-Control', cacheControl);
  }

  return new Response(upstream.body, { status: upstream.status, headers });
}

function jsonResponse(payload: unknown, status: number): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function cloudSelectorId(instanceId: string | undefined): string | undefined {
  return instanceId ? `${CLOUD_INSTANCE_PREFIX}${instanceId}` : undefined;
}

export function startServer(
  vaultRoot: string | null,
  config: GraniteConfig | null,
  port: number,
  cloudInstances: CloudInstance[] = [],
) {
  const app = createApp(vaultRoot, config, { cloudInstances });

  console.log(`Granite — serving at http://localhost:${port}`);
  if (vaultRoot) console.log(`Local vault: ${vaultRoot}`);
  if (cloudInstances.length > 0) {
    console.log(`Cloud instances: ${cloudInstances.map(instance => instance.id).join(', ')}`);
  }
  console.log('');

  serve({ fetch: app.fetch, port });
}
