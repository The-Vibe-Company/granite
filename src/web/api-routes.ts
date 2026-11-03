import { Hono } from 'hono';
import path from 'node:path';
import fs from 'node:fs';
import type { GraniteConfig } from '../core/types.js';
import { ensureIndex } from '../core/index-db.js';
import { findNoteBySlug, listNotes } from '../core/note.js';
import { searchNotes } from '../core/search.js';
import { getBacklinks } from '../core/backlinks.js';
import { parseWikilinks, resolveWikilinks } from '../core/wikilinks.js';

export interface ReadOnlyApiSource {
  vaultRoot: string;
  getConfig: () => GraniteConfig;
}

// The read-only vault API shared by the local web UI (`granite serve`) and the
// remote web surface (`granite mcp --transport http --web-api`). Writes are
// deliberately excluded — they only exist on the local server.
export function registerReadOnlyApiRoutes(
  app: Hono,
  source: ReadOnlyApiSource,
  options: { prefix?: string; secureAssets?: boolean } = {},
): void {
  const { vaultRoot } = source;
  const prefix = options.prefix ?? '';

  app.get(`${prefix}/api/notes`, (c) => {
    const config = source.getConfig();
    const db = ensureIndex(vaultRoot, config);
    const typeFilter = c.req.query('type');
    let query = 'SELECT slug, title, type, created, modified, tags FROM notes';
    const params: string[] = [];
    const conditions: string[] = [];
    if (typeFilter) {
      conditions.push('type = ?');
      params.push(typeFilter);
    }
    const tagFilter = c.req.query('tag');
    if (tagFilter) {
      conditions.push('EXISTS (SELECT 1 FROM json_each(notes.tags) WHERE value = ?)');
      params.push(tagFilter);
    }
    if (conditions.length) query += ` WHERE ${conditions.join(' AND ')}`;
    query += ' ORDER BY modified DESC';
    const notes = db.prepare(query).all(...params);
    db.close();
    return c.json({ notes });
  });

  app.get(`${prefix}/api/notes/:slug`, (c) => {
    const config = source.getConfig();
    const slug = c.req.param('slug');
    const db = ensureIndex(vaultRoot, config);
    const allNotes = listNotes(vaultRoot, config);
    const note = findNoteBySlug(vaultRoot, config, slug);

    if (!note) {
      db.close();
      return c.json({ error: 'Note not found' }, 404);
    }

    const links = parseWikilinks(note.body);
    const resolvedLinks = resolveWikilinks(links, allNotes);
    const backlinks = getBacklinks(db, slug);
    db.close();

    return c.json({
      slug: note.slug,
      title: note.frontmatter.title,
      type: note.frontmatter.type,
      created: note.frontmatter.created,
      modified: note.frontmatter.modified,
      tags: note.frontmatter.tags,
      aliases: note.frontmatter.aliases,
      status: note.frontmatter.status,
      source: note.frontmatter.source,
      review_state: note.frontmatter.review_state,
      durability: note.frontmatter.durability,
      derived_from: note.frontmatter.derived_from,
      body: note.body,
      outgoing_links: resolvedLinks,
      backlinks,
    });
  });

  app.get(`${prefix}/api/search`, (c) => {
    const q = c.req.query('q');
    if (!q) return c.json({ query: '', results: [] });

    const db = ensureIndex(vaultRoot, source.getConfig());
    const results = searchNotes(db, q, { type: c.req.query('type'), tag: c.req.query('tag') });
    db.close();

    return c.json({ query: q, results });
  });

  app.get(`${prefix}/api/backlinks/:slug`, (c) => {
    const slug = c.req.param('slug');
    const db = ensureIndex(vaultRoot, source.getConfig());
    const backlinks = getBacklinks(db, slug);
    db.close();
    return c.json({ slug, backlinks });
  });

  app.get(`${prefix}/api/types`, (c) => {
    return c.json({ types: source.getConfig().note_types });
  });

  // Graph data — all nodes and edges
  app.get(`${prefix}/api/graph`, (c) => {
    const db = ensureIndex(vaultRoot, source.getConfig());
    const nodes = db.prepare('SELECT slug, title, type FROM notes').all();
    const edges = db.prepare('SELECT source_slug AS source, target_slug AS target FROM links WHERE target_slug IS NOT NULL').all();
    db.close();
    return c.json({ nodes, edges });
  });

  // Serve vault assets (images, files) from {vault}/assets/
  app.get(`${prefix}/assets/*`, (c) => {
    let assetPath: string;
    try { assetPath = decodeURIComponent(c.req.path.slice(`${prefix}/assets/`.length)); }
    catch { return c.notFound(); }
    const assetsRoot = path.resolve(vaultRoot, 'assets');
    const fullPath = path.resolve(assetsRoot, assetPath);

    // This route is also exposed remotely (--web-api): never escape assets/.
    if (fullPath !== assetsRoot && !fullPath.startsWith(assetsRoot + path.sep)) {
      return c.notFound();
    }

    if (!fs.existsSync(fullPath) || !fs.statSync(fullPath).isFile()) {
      return c.notFound();
    }

    if (options.secureAssets) {
      const canonicalRoot = path.join(fs.realpathSync(vaultRoot), 'assets');
      // Reject symlinked roots and files resolving outside assets/.
      if (fs.realpathSync(assetsRoot) !== canonicalRoot || !fs.realpathSync(fullPath).startsWith(canonicalRoot + path.sep)) return c.notFound();
    }

    const content = fs.readFileSync(fullPath);
    const ext = path.extname(fullPath).toLowerCase();
    const mimeTypes: Record<string, string> = {
      '.png': 'image/png',
      '.jpg': 'image/jpeg',
      '.jpeg': 'image/jpeg',
      '.gif': 'image/gif',
      '.webp': 'image/webp',
      '.svg': 'image/svg+xml',
      '.mp4': 'video/mp4',
      '.webm': 'video/webm',
      '.pdf': 'application/pdf',
    };
    const contentType = mimeTypes[ext] || 'application/octet-stream';
    return new Response(content, {
      headers: {
        'Content-Type': contentType,
        'Cache-Control': options.secureAssets ? 'no-store' : 'public, max-age=3600',
        ...(options.secureAssets && !['.png', '.jpg', '.jpeg', '.gif', '.webp', '.mp4', '.webm'].includes(ext)
          ? { 'Content-Disposition': 'attachment', 'Content-Security-Policy': "sandbox; default-src 'none'; frame-ancestors 'none'" }
          : {}),
      },
    });
  });
}
