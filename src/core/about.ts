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
