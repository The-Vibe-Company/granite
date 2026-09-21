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

const MODEL_VERSION = 'v1';

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

/** Hash the part of a note a judgment depends on: its wording. */
export function sourceHash(title: string, body: string): string {
  return createHash('sha256').update(`${title}\n${body}`).digest('hex').slice(0, 32);
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
  args: { sourceSlug: string; hash: string; model: string },
): CachedRouting | undefined {
  try { ensureTable(db); } catch { return undefined; }
  const row = db.prepare(`
    SELECT verdict FROM judgment_cache
    WHERE source_slug = ? AND source_hash = ? AND candidate = ? AND model = ?
  `).get(args.sourceSlug, args.hash, ROUTING_ROW, args.model) as { verdict: string } | undefined;
  if (!row) return undefined;
  try { return JSON.parse(row.verdict) as CachedRouting; } catch { return undefined; }
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
  const cutoff = args.maxAgeDays === undefined
    ? null
    : new Date(Date.now() - args.maxAgeDays * 86_400_000).toISOString();

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

export function writeCachedJudgments(
  db: Database.Database,
  args: { sourceSlug: string; hash: string; model: string; verdicts: CachedVerdict[] },
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
    const insertAll = db.transaction((rows: CachedVerdict[]) => {
      for (const v of rows) {
        stmt.run(args.sourceSlug, args.hash, v.candidate, args.model, MODEL_VERSION, v.probability, now);
      }
    });
    insertAll(args.verdicts);
  } catch {
    // Uncacheable is fine. Loud would not be.
  }
}
