import type Database from 'better-sqlite3';
import type { BacklinkEntry } from './types.js';

export function getBacklinks(db: Database.Database, slug: string): BacklinkEntry[] {
  const stmt = db.prepare(`
    SELECT
      l.source_slug,
      n.title as source_title,
      l.context
    FROM links l
    JOIN notes n ON n.slug = l.source_slug
    -- Keep the first indexed context for each source note, regardless of mention count.
    WHERE l.rowid IN (
      SELECT MIN(rowid)
      FROM links
      WHERE target_slug = ?
      GROUP BY source_slug
    )
    ORDER BY n.title, l.source_slug
  `);

  return stmt.all(slug) as BacklinkEntry[];
}
