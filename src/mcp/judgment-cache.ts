/**
 * A cache for capture-time link judgments.
 *
 * Why it is worth having, measured on the real vault: the candidate distribution is
 * heavy-tailed. `quivr` is a candidate for **147** different source notes, `the-vibe-company`
 * for 133, `companion-hermes-fleet` for 108. Every one of those captures asks Jev the same
 * question about the same pair, and nothing remembers the answer.
 *
 * The key includes a hash of the source body, not just the pair. A judgment is a statement
 * about the source's wording, so a note that has been edited must be judged again — a cache
 * keyed on the pair alone would serve a verdict about text that no longer exists, which is
 * the same class of silent wrongness this whole layer exists to avoid.
 *
 * The table is created on first use rather than in the index schema. Adding it to
 * `SCHEMA_VERSION` would make `openDatabase` delete and rebuild every user's index on upgrade,
 * which is a large side effect for a performance feature.
 */
import { createHash } from 'node:crypto';
import type Database from 'better-sqlite3';

/**
 * Bumped whenever the QUESTION SHAPE changes — the option sets, the criteria wording, or the
 * questions asked — because those move verdicts as surely as a model swap does. This PR
 * measured exactly that: adding the type and tag questions shifted 1 of 14 link decisions.
 * It is folded into the hash rather than stored in a column, so a bump invalidates every
 * entry by construction instead of relying on someone comparing it.
 */
const QUESTION_SHAPE = 'q2';

/** How long a judgment stays valid without the source changing. Bounded by vocabulary drift. */
export const DEFAULT_MAX_AGE_DAYS = 30;

function ensureTable(db: Database.Database): void {
  db.prepare(`
    CREATE TABLE IF NOT EXISTS judgment_cache (
      source_slug   TEXT NOT NULL,
      source_hash   TEXT NOT NULL,
      candidate     TEXT NOT NULL,
      model         TEXT NOT NULL,
      verdict       TEXT NOT NULL,
      probability   REAL NOT NULL,
      created_at    TEXT NOT NULL,
      PRIMARY KEY (source_slug, source_hash, candidate, model)
    )
  `).run();
}

/**
 * Hash everything the judgment depends on: the source's wording, the candidate's title (it is
 * in both the state and the criteria), and the question shape.
 *
 * The candidate title is included because a renamed candidate still matching through an alias
 * would otherwise re-use a verdict whose `true` criterion names the old title.
 */
export function sourceHash(title: string, body: string, candidateTitle = '', shape = QUESTION_SHAPE): string {
  return createHash('sha256')
    .update(`${shape}\u0000${title}\n${body}\u0000${candidateTitle}`)
    .digest('hex')
    .slice(0, 32);
}

export interface CachedVerdict {
  candidate: string;
  probability: number;
}

/**
 * The routing judgment for a note, cached under the same (slug, hash, model) key as its link
 * verdicts so a cache hit returns the whole judgment rather than half of it. Without this a
 * warm capture reported links but lost the type and tags, which reads as "Jev could not tell".
 */
const ROUTING_ROW = '\u0000routing';

export interface CachedRouting {
  note_type?: string;
  tags?: string[];
}

export function writeCachedRouting(
  db: Database.Database,
  args: { sourceSlug: string; hash: string; model: string; routing: CachedRouting },
): void {
  if (!args.routing.note_type && !args.routing.tags?.length) return;
  try {
    ensureTable(db);
    db.prepare(`
      INSERT OR REPLACE INTO judgment_cache
        (source_slug, source_hash, candidate, model, verdict, probability, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(
      args.sourceSlug, args.hash, ROUTING_ROW, args.model,
      JSON.stringify(args.routing), 0, new Date().toISOString(),
    );
  } catch {
    // Same rule as the verdict write: a cache miss is fine, a failed capture is not.
  }
}

export function readCachedRouting(
  db: Database.Database,
  args: { sourceSlug: string; hash: string; model: string; maxAgeDays?: number },
): CachedRouting | undefined {
  try {
    ensureTable(db);
    const row = db.prepare(`
      SELECT verdict, created_at FROM judgment_cache
      WHERE source_slug = ? AND source_hash = ? AND candidate = ? AND model = ?
    `).get(args.sourceSlug, args.hash, ROUTING_ROW, args.model) as
      | { verdict: string; created_at: string }
      | undefined;
    if (!row) return undefined;
    // The routing row was exempt from the age limit while link verdicts were not, so a tag the
    // vault stopped using could be proposed indefinitely.
    const maxAgeDays = args.maxAgeDays ?? DEFAULT_MAX_AGE_DAYS;
    const cutoff = new Date(Date.now() - maxAgeDays * 86_400_000).toISOString();
    if (row.created_at < cutoff) return undefined;
    return JSON.parse(row.verdict) as CachedRouting;
  } catch {
    return undefined;
  }
}

export function readCachedJudgments(
  db: Database.Database,
  args: { sourceSlug: string; hash: string; model: string; candidates: string[]; maxAgeDays?: number },
): Map<string, number> {
  const out = new Map<string, number>();
  if (args.candidates.length === 0) return out;
  try {
    ensureTable(db);
  } catch {
    return out; // a read-only or locked database simply has no cache
  }
  // A default age limit, because the option sets (tags, types) are read fresh per call and can
  // change without the source note changing. Without it the only invalidation is a source edit.
  const maxAgeDays = args.maxAgeDays ?? DEFAULT_MAX_AGE_DAYS;
  const cutoff = new Date(Date.now() - maxAgeDays * 86_400_000).toISOString();

  try {
    const stmt = db.prepare(`
      SELECT candidate, probability, created_at FROM judgment_cache
      WHERE source_slug = ? AND source_hash = ? AND model = ? AND candidate = ?
    `);
    for (const candidate of args.candidates) {
      const row = stmt.get(args.sourceSlug, args.hash, args.model, candidate) as
        | { probability: number; created_at: string }
        | undefined;
      if (!row) continue;
      if (cutoff && row.created_at < cutoff) continue;
      out.set(candidate, row.probability);
    }
  } catch {
    // An uncacheable database is a cache miss, never an error the caller has to handle.
  }
  return out;
}

/**
 * One call writes every verdict for a capture, in a single transaction.
 *
 * The hash is per entry because it covers the candidate's title. Writing per candidate instead
 * turned one transaction into up to 24 on the synchronous capture path, where each blocked
 * statement can burn the full busy timeout against a concurrent writer — a stall of up to two
 * minutes on the daemon's event loop, for a cache.
 */
export function writeCachedJudgments(
  db: Database.Database,
  args: { sourceSlug: string; model: string; verdicts: Array<CachedVerdict & { hash: string }> },
): void {
  if (args.verdicts.length === 0) return;
  // Everything, including the `prepare`, is inside the guard: preparing a statement against a
  // schema that cannot hold it throws, and that throw would otherwise surface as a failed
  // capture. A cache write is never worth failing a capture for.
  try {
    ensureTable(db);
    const stmt = db.prepare(`
      INSERT OR REPLACE INTO judgment_cache
        (source_slug, source_hash, candidate, model, verdict, probability, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `);
    const now = new Date().toISOString();
    const insertAll = db.transaction((rows: Array<CachedVerdict & { hash: string }>) => {
      for (const v of rows) {
        stmt.run(args.sourceSlug, v.hash, v.candidate, args.model, '', v.probability, now);
      }
    });
    insertAll(args.verdicts);
  } catch {
    // Uncacheable is fine. Loud would not be.
  }
}
