import type Database from 'better-sqlite3';
import { slugify, slugVariants } from './slugify.js';

export interface ResolveMatch {
  slug: string;
  title: string;
  type: string;
  score: number;
  reason: 'slug' | 'title' | 'alias' | 'fts';
}

export interface ResolveOptions {
  target_type?: string;
  limit?: number;
}

/**
 * Deterministic text → note slug resolver.
 * Preference order: exact slug → exact title → exact alias → FTS.
 * Never invokes an LLM.
 */
export function resolveText(
  db: Database.Database,
  text: string,
  options: ResolveOptions = {},
): ResolveMatch[] {
  const trimmed = text.trim();
  if (!trimmed) return [];

  const limit = Math.max(1, Math.min(options.limit ?? 5, 20));
  const typeFilter = options.target_type;
  const matches = new Map<string, ResolveMatch>();

  const addMatch = (m: ResolveMatch) => {
    if (typeFilter && m.type !== typeFilter) return;
    const existing = matches.get(m.slug);
    if (!existing || existing.score < m.score) {
      matches.set(m.slug, m);
    }
  };

  // Legacy slugs can end with a separator, so try the exact slug then its `<slug>-` form.
  for (const candidate of slugVariants(trimmed)) {
    const slugRow = db.prepare('SELECT slug, title, type FROM notes WHERE slug = ? LIMIT 1')
      .get(candidate) as { slug: string; title: string; type: string } | undefined;
    if (slugRow) {
      addMatch({ ...slugRow, score: 1.0, reason: 'slug' });
      break;
    }
  }

  const titleRows = db.prepare('SELECT slug, title, type FROM notes WHERE lower(title) = ?')
    .all(trimmed.toLowerCase()) as Array<{ slug: string; title: string; type: string }>;
  for (const row of titleRows) {
    addMatch({ ...row, score: 0.95, reason: 'title' });
  }

  const aliasRows = db.prepare('SELECT slug, title, type, aliases FROM notes')
    .all() as Array<{ slug: string; title: string; type: string; aliases: string }>;
  for (const row of aliasRows) {
    try {
      const aliases = JSON.parse(row.aliases || '[]') as unknown[];
      if (aliases.some(a => typeof a === 'string' && a.toLowerCase() === trimmed.toLowerCase())) {
        addMatch({ slug: row.slug, title: row.title, type: row.type, score: 0.9, reason: 'alias' });
      }
    } catch {
      continue;
    }
  }

  if (matches.size < limit) {
    try {
      const ftsQuery = trimmed.replace(/"/g, '').split(/\s+/).filter(Boolean).map(w => `"${w}"`).join(' OR ');
      if (ftsQuery) {
        const ftsRows = db.prepare(`
          SELECT n.slug, n.title, n.type, bm25(notes_fts) AS rank
          FROM notes_fts
          JOIN notes n ON n.rowid = notes_fts.rowid
          WHERE notes_fts MATCH ?
          ORDER BY rank
          LIMIT ?
        `).all(ftsQuery, limit) as Array<{ slug: string; title: string; type: string; rank: number }>;
        for (const row of ftsRows) {
          const score = 0.5 - Math.min(0.4, row.rank * 0.01);
          addMatch({ slug: row.slug, title: row.title, type: row.type, score, reason: 'fts' });
        }
      }
    } catch {
      // FTS errors (e.g. empty query) are non-fatal
    }
  }

  return Array.from(matches.values())
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);
}

export interface ResolveSuggestedStub {
  type: string;
  title: string;
  slug: string;
}

export function suggestStub(text: string, targetType: string): ResolveSuggestedStub {
  return {
    type: targetType,
    title: text.trim(),
    slug: slugify(text.trim()) || 'untitled',
  };
}
