import type Database from 'better-sqlite3';
import type { SearchResult } from './types.js';

/** Upper bound on rows read from FTS, so a caller cannot ask for an unbounded pool. */
const MAX_LIMIT = 100;

/**
 * Convert a natural language query into an FTS5 OR query.
 * "Cursor cost cognitive" → "Cursor OR cost OR cognitive"
 *
 * Preserves explicit FTS5 operators (AND, OR, NOT, NEAR, quotes, *)
 * so power users can still write raw FTS5 syntax.
 */
function toOrQuery(query: string): string {
  const trimmed = query.trim();

  // If the query already contains FTS5 operators, pass it through as-is
  if (/\b(AND|OR|NOT|NEAR)\b/.test(trimmed) || trimmed.includes('"') || trimmed.includes('*')) {
    return trimmed;
  }

  // Split into words, filter empties, join with OR
  const words = trimmed.split(/\s+/).filter(w => w.length > 0);
  if (words.length <= 1) return trimmed;

  return words.join(' OR ');
}

export interface SearchOptions {
  /** Final number of results returned. */
  limit?: number;
  /**
   * Size of the candidate pool handed to ranking. Defaults to `limit`.
   *
   * Raising it widens recall for a downstream reranker (a semantic judge, or a
   * human) at no cost beyond the extra rows read: FTS5 already ranks the pool
   * with BM25, and the final cut happens after ranking. Keep `limit` small and
   * `candidateLimit` generous when the caller intends to rerank.
   */
  candidateLimit?: number;
}

export function searchNotes(
  db: Database.Database,
  query: string,
  limitOrOptions: number | SearchOptions = 20,
): SearchResult[] {
  const options: SearchOptions =
    typeof limitOrOptions === 'number' ? { limit: limitOrOptions } : limitOrOptions;
  const limit = Math.max(1, Math.min(options.limit ?? 20, 100));
  // Read the wider pool first, then cut, so a reranker sees more than the
  // final result count.
  const poolSize = Math.max(limit, Math.min(options.candidateLimit ?? limit, MAX_LIMIT));
  const ftsQuery = toOrQuery(query);

  const stmt = db.prepare(`
    SELECT
      n.slug,
      n.title,
      n.type,
      snippet(notes_fts, 1, '>>>', '<<<', '...', 30) as snippet,
      rank
    FROM notes_fts
    JOIN notes n ON n.rowid = notes_fts.rowid
    WHERE notes_fts MATCH ?
    ORDER BY rank
    LIMIT ?
  `);

  try {
    const rows = stmt.all(ftsQuery, poolSize) as Array<{
      slug: string;
      title: string;
      type: string;
      snippet: string;
      rank: number;
    }>;

    return rows.slice(0, limit).map(r => ({
      slug: r.slug,
      title: r.title,
      type: r.type,
      snippet: r.snippet,
      score: r.rank,
    }));
  } catch {
    // If the FTS query fails (bad syntax), fall back to a simple prefix search
    const fallback = db.prepare(`
      SELECT
        n.slug,
        n.title,
        n.type,
        substr(n.body, 1, 200) as snippet,
        0 as rank
      FROM notes n
      WHERE n.title LIKE ? OR n.body LIKE ?
      LIMIT ?
    `);
    const pattern = `%${query}%`;
    const rows = fallback.all(pattern, pattern, poolSize) as Array<{
      slug: string;
      title: string;
      type: string;
      snippet: string;
      rank: number;
    }>;

    return rows.slice(0, limit).map(r => ({
      slug: r.slug,
      title: r.title,
      type: r.type,
      snippet: r.snippet,
      score: r.rank,
    }));
  }
}
