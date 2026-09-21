import type Database from 'better-sqlite3';

/**
 * Everything the vault knows about one entity.
 *
 * Why this exists
 * ---------------
 * Measured on a real vault, lexical search retrieves the note that answers a question
 * only **13% of the time** when the question is asked in a different language than the
 * note was written in, and it fails even when both languages share the word: 43 notes
 * contained "migration" and the right one was not in the top ten. A vault whose content
 * is half French and half English is therefore half unreachable by its own search.
 *
 * The link graph does not have that problem. An entity's incoming and outgoing links are
 * a language-independent index: `monka-care` has 144 incoming and 52 outgoing links, and
 * they find French and English notes alike. This turns that graph into an access path.
 *
 * Deliberately deterministic: no model is called. It is a read of the graph Granite
 * already maintains.
 */

export interface EntityReference {
  slug: string;
  title: string;
  type: string;
  /** Why this note points at the entity, or how the entity points at it. */
  contexts: string[];
}

export interface AboutEntity {
  slug: string;
  title: string;
  type: string;
  status: string;
  /** Notes that link to this entity, grouped by their type. */
  incoming: Record<string, EntityReference[]>;
  /** Notes this entity links to, grouped by their type. */
  outgoing: Record<string, EntityReference[]>;
  counts: { incoming: number; outgoing: number };
}

function tidyContext(value: string | null | undefined, limit = 160): string {
  const text = (value ?? '').replace(/\s+/g, ' ').trim();
  return text.length > limit ? `${text.slice(0, limit - 1)}…` : text;
}

/**
 * Collapse repeated references to one note into a single entry.
 *
 * A note that names an entity three times is still one note; showing it three times
 * inflates the view and hides the other notes that mention it.
 */
function collect(
  db: Database.Database,
  rows: Array<{ slug: string | null; context: string | null }>,
): Record<string, EntityReference[]> {
  const bySlug = new Map<string, { slug: string; title: string; type: string; contexts: string[] }>();

  for (const row of rows) {
    if (!row.slug) continue;
    let entry = bySlug.get(row.slug);
    if (!entry) {
      const meta = db
        .prepare('SELECT title, type FROM notes WHERE slug = ?')
        .get(row.slug) as { title: string; type: string } | undefined;
      if (!meta) continue; // dangling link target: not a real note
      entry = { slug: row.slug, title: meta.title ?? row.slug, type: meta.type ?? 'unknown', contexts: [] };
      bySlug.set(row.slug, entry);
    }
    const context = tidyContext(row.context);
    // Distinct contexts only: the same sentence twice is not two reasons.
    if (context && !entry.contexts.includes(context) && entry.contexts.length < 3) {
      entry.contexts.push(context);
    }
  }

  const grouped: Record<string, EntityReference[]> = {};
  for (const entry of [...bySlug.values()].sort((a, b) => a.title.localeCompare(b.title))) {
    (grouped[entry.type] ??= []).push({
      slug: entry.slug,
      title: entry.title,
      type: entry.type,
      contexts: entry.contexts,
    });
  }
  return grouped;
}

export function aboutEntity(db: Database.Database, slug: string): AboutEntity | undefined {
  const note = db
    .prepare('SELECT slug, title, type, status FROM notes WHERE slug = ?')
    .get(slug) as { slug: string; title: string; type: string; status: string } | undefined;
  if (!note) return undefined;

  const incomingRows = db
    .prepare('SELECT source_slug AS slug, context FROM links WHERE target_slug = ?')
    .all(slug) as Array<{ slug: string; context: string | null }>;
  const outgoingRows = db
    .prepare('SELECT target_slug AS slug, context FROM links WHERE source_slug = ? AND target_slug IS NOT NULL')
    .all(slug) as Array<{ slug: string; context: string | null }>;

  const incoming = collect(db, incomingRows);
  const outgoing = collect(db, outgoingRows);
  const count = (g: Record<string, EntityReference[]>) =>
    Object.values(g).reduce((total, list) => total + list.length, 0);

  return {
    slug: note.slug,
    title: note.title,
    type: note.type,
    status: note.status,
    incoming,
    outgoing,
    counts: { incoming: count(incoming), outgoing: count(outgoing) },
  };
}

export interface PoolEntry {
  slug: string;
  title: string;
  type: string;
  /** Graph distance from the anchor. 1 = directly linked. */
  distance: number;
  /**
   * Candidate sentences, empty when the caller asked for titles only.
   *
   * This is an array rather than `null` on purpose: the field is serialised into JSON and
   * read by consumers in other languages, where a null and an absent key both turn into
   * awkward branches (and `len(None)` is a crash, not an empty list).
   */
  sentences: string[];
}

export interface EntityPool {
  anchor: string;
  anchor_title: string;
  /** Total notes reachable within the depth, before the limit was applied. */
  reachable: number;
  /** Notes actually returned, nearest first. */
  candidates: PoolEntry[];
}

/**
 * Candidate sentences, chosen deterministically so recall stays in code.
 *
 * Frontmatter, fenced code and markdown markers are stripped: a citation marker or a
 * `sourceNotionId` line is not a sentence that can answer anything.
 */
export function candidateSentences(body: string, limit = 6): string[] {
  // No frontmatter strip here on purpose. `body` is gray-matter output, so frontmatter is
  // already gone upstream; a strip would only fire on a real body that legitimately begins
  // with a horizontal rule and contains a later `---`, silently deleting the content
  // between them. A dead `\A` pattern that never matched was the earlier version of this
  // mistake: it looked defensive and was unreachable, while its "fix" became destructive.
  //
  // Asked for nothing, return nothing. Without this the loop below always pushes one
  // sentence before it can test the bound, so `limit: 0` — the documented "titles only"
  // mode — handed back a sentence anyway.
  if (limit <= 0) return [];
  const text = (body ?? '')
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/^#{1,6}\s.*$/gm, ' ');
  const out: string[] = [];
  for (const raw of text.split(/(?<=[.!?])\s+|\n+/)) {
    const line = raw
      .replace(/\*\*|__|`/g, '')
      .replace(/\s{2,}/g, ' ')
      .replace(/^\s*[-*|\s]+/, '')
      .trim();
    if (line.length >= 30 && line.length <= 400) {
      out.push(line);
      if (out.length >= limit) break;
    }
  }
  return out;
}

/**
 * Build a bounded, judge-ready candidate set around an anchor.
 *
 * This is the deterministic half of semantic retrieval: it decides *what is worth
 * judging*, and a model decides which of those actually answers a question. Keeping the
 * two apart is what makes the model's job a selection rather than a search — and a
 * selection is the judgment it is measurably good at.
 *
 * Ordering is by **graph distance only**. An earlier version ordered by lexical overlap
 * with the question, which reintroduced the exact failure this exists to fix: on a real
 * vault the note holding the answer was one hop away and shared no vocabulary with the
 * English question, so a lexical pre-rank pushed it out of the pool and the answer was
 * reported absent.
 */
export function entityPool(
  db: Database.Database,
  anchor: string,
  options: { depth?: number; limit?: number; sentences?: number } = {},
): EntityPool | undefined {
  const depth = Math.max(1, options.depth ?? 2);
  const limit = Math.max(1, options.limit ?? 30);
  const sentenceCount = options.sentences ?? 6;

  const note = db
    .prepare('SELECT title FROM notes WHERE slug = ?')
    .get(anchor) as { title: string } | undefined;
  if (!note) return undefined;

  const distance = new Map<string, number>();
  let frontier = new Set<string>([anchor]);
  for (let hop = 1; hop <= depth; hop++) {
    const next = new Set<string>();
    for (const slug of frontier) {
      for (const row of db
        .prepare('SELECT target_slug AS s FROM links WHERE source_slug = ? AND target_slug IS NOT NULL')
        .all(slug) as Array<{ s: string }>) {
        next.add(row.s);
      }
      for (const row of db
        .prepare('SELECT source_slug AS s FROM links WHERE target_slug = ?')
        .all(slug) as Array<{ s: string }>) {
        next.add(row.s);
      }
    }
    next.delete(anchor);
    for (const slug of next) if (!distance.has(slug)) distance.set(slug, hop);
    frontier = next;
  }

  const ordered = [...distance.entries()].sort((a, b) => a[1] - b[1] || a[0].localeCompare(b[0]));

  const candidates: PoolEntry[] = [];
  for (const [slug, hop] of ordered) {
    // The limit is applied after the existence filter, so a dangling target does not
    // consume one of the requested slots and the caller gets the number they asked for.
    if (candidates.length >= limit) break;
    const row = db
      .prepare('SELECT title, type, body FROM notes WHERE slug = ?')
      .get(slug) as { title: string; type: string; body: string } | undefined;
    if (!row) continue; // dangling link target: not a real note
    candidates.push({
      slug,
      title: row.title ?? slug,
      type: row.type ?? 'unknown',
      distance: hop,
      sentences: candidateSentences(row.body, sentenceCount),
    });
  }

  return {
    anchor,
    anchor_title: note.title ?? anchor,
    reachable: distance.size,
    candidates,
  };
}
