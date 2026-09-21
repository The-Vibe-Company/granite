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

/** How much of one hop's neighbourhood a pool actually returned. */
export interface PoolDistanceSummary {
  /** Graph hops from the anchor. */
  distance: number;
  /** Real notes at this distance, whether or not they were returned. */
  reachable: number;
  /** How many of them this pool returned. */
  shown: number;
}

export interface EntityPool {
  anchor: string;
  anchor_title: string;
  /** Total notes reachable within the depth, before the limit was applied. */
  reachable: number;
  /** Notes actually returned, nearest first. */
  candidates: PoolEntry[];
  /**
   * Per-hop reachable/shown counts, so a truncated pool says what it left out instead of
   * implying the neighbourhood it returned is the whole neighbourhood.
   */
  by_distance: PoolDistanceSummary[];
  /**
   * True when sentences were left out because the nearest band is large. Titles alone cost
   * roughly a fifth of titles plus sentences, so a big neighbourhood is returned cheaply and
   * the caller asks for sentences only on what it intends to read.
   */
  sentences_omitted?: boolean;
}

/** An `AboutEntity` with its groups narrowed to the requested types. */
export interface FilteredAbout extends AboutEntity {
  /** The types that were requested, or undefined when nothing was filtered. */
  filtered_by?: string[];
  /**
   * The entity's total references before any filter. Kept so a renderer can tell "nothing
   * points at this note at all" from "nothing of the type you asked for does" — reporting
   * the first when the second is true is a false statement about the vault.
   */
  unfiltered_counts?: { incoming: number; outgoing: number };
}

/**
 * Narrow an entity's references to the requested types.
 *
 * The counts are recomputed from the filtered groups rather than carried over, because they
 * describe what a caller is about to read. Keeping the unfiltered totals printed
 * "3 note(s) link here" directly above a two-note group.
 */
export function filterAbout(entity: AboutEntity, types?: string[]): FilteredAbout {
  const wanted = types?.filter(Boolean) ?? [];
  const unfiltered_counts = { ...entity.counts };
  if (wanted.length === 0) return { ...entity, unfiltered_counts };

  const keep = (group: Record<string, EntityReference[]>) =>
    Object.fromEntries(Object.entries(group).filter(([type]) => wanted.includes(type)));
  const count = (group: Record<string, EntityReference[]>) =>
    Object.values(group).reduce((total, list) => total + list.length, 0);

  const incoming = keep(entity.incoming);
  const outgoing = keep(entity.outgoing);
  return {
    ...entity,
    incoming,
    outgoing,
    counts: { incoming: count(incoming), outgoing: count(outgoing) },
    filtered_by: wanted,
    unfiltered_counts,
  };
}

/**
 * A line that is metadata rather than prose: `sourceNotionId: ...`, `File: [...]`.
 *
 * Imported notes put these at the very top, so a first-N read spent its whole budget on
 * them and never reached the body.
 *
 * The pattern is deliberately narrow. A first version accepted any short key before a colon
 * (`^[\w-]{2,24}:`) and silently deleted real prose — "Price: …", "Budget: …",
 * "Decision: …", "Note: …" are all sentences that could answer something. Only
 * identifier-shaped keys count: camelCase, snake_case, or a known field-ish word. Losing a
 * sentence is unrecoverable; keeping a metadata line costs one slot.
 */
const METADATA_LINE = /^\s{0,3}(?:[-*+]\s+)?(?:[a-z]+[A-Z][A-Za-z]*|[a-z]+_[a-z_]+|File|Source|Author|Created|Modified|Tags?|Aliases?):\s*\S/;

/** Every sentence in a body that could answer something, in document order. */
function allCandidateSentences(body: string): string[] {
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
    if (line.length >= 30 && line.length <= 400 && !METADATA_LINE.test(line)) {
      out.push(line);
    }
  }
  return out;
}

/**
 * Candidate sentences, chosen deterministically so recall stays in code.
 *
 * Frontmatter, fenced code, markdown markers and metadata lines are stripped: a citation
 * marker or a `sourceNotionId` line is not a sentence that can answer anything.
 *
 * Selection is a **coverage sample with a prefix**, not a bare stride. A pure stride is
 * strictly worse than a prefix on the opening lines — at 8 candidates for a budget of 6 it
 * dropped indices 2 and 5, which the old prefix kept — so half the budget stays a prefix,
 * and the other half walks the rest at an even stride ending on the last candidate. A
 * structured note states its context first and its figures last, so both ends must survive.
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
  const all = allCandidateSentences(body);
  if (all.length <= limit) return all;
  if (limit === 1) return [all[0]];

  // With no room to both prefix and stride, keep the opening: it is the cheapest useful
  // summary of a note we cannot afford to read.
  if (limit === 2) return [all[0], all[all.length - 1]];

  const prefix = Math.max(1, Math.floor(limit / 2));
  const picked: string[] = all.slice(0, prefix);
  const tailBudget = limit - prefix;
  for (let i = 0; i < tailBudget; i++) {
    const from = all.length - 1 - (tailBudget - 1 - i) * 2;
    picked.push(all[Math.max(prefix, from)]);
  }
  return picked;
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

  // The default has to be both a floor and a ceiling, and "the nearest band" was neither.
  // A leaf with one neighbour defaulted to a one-candidate pool while dozens were reachable;
  // a hub returned 141 candidates and ~30k tokens. A fixed 30 was worse still: it dropped the
  // note holding a client's price, which sat 54th of 87 direct neighbours, and said nothing.
  //
  // DEFAULT_NEAREST is a floor — it keeps taking the distance-sorted candidates until the
  // pool is useful, so a degenerate band fills up from the next one — and MAX_CANDIDATES is
  // the ceiling, chosen so a batched judge request stays inside a sane context even with
  // sentences. `by_distance` reports whatever either bound dropped.
  const DEFAULT_NEAREST = 60;
  const MAX_CANDIDATES = 255;
  const limit = Math.max(1, Math.min(options.limit ?? DEFAULT_NEAREST, MAX_CANDIDATES));

  // Sentences are the expensive field, not the candidates: measured ~211 tokens per candidate
  // with them against ~42 without. The decision therefore uses the number of candidates the
  // pool will actually return, not the limit that was asked for — a small vault must not lose
  // its sentences because the default limit is generous. An explicit `sentences` always wins.
  const CANDIDATES_THAT_FIT_WITH_SENTENCES = 30;
  const effectiveLimit = Math.min(limit, ordered.length);
  const sentenceCount = options.sentences
    ?? (effectiveLimit > CANDIDATES_THAT_FIT_WITH_SENTENCES ? 0 : 6);
  const sentencesOmitted = sentenceCount === 0 && options.sentences === undefined;

  // Prepared once: the per-hop counts and the candidate loop both ask this question, and
  // a pool around a hub can ask it several hundred times.
  const noteExists = db.prepare('SELECT 1 FROM notes WHERE slug = ?');

  const candidates: PoolEntry[] = [];
  const shownByDistance = new Map<number, number>();
  const seenByDistance = new Map<number, number>();
  for (const [, hop] of ordered) seenByDistance.set(hop, (seenByDistance.get(hop) ?? 0) + 1);

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
    shownByDistance.set(hop, (shownByDistance.get(hop) ?? 0) + 1);
  }

  // What the caller did NOT get, per hop. A pool that returns 30 of 87 direct neighbours
  // and says only "363 reachable" is quietly letting a caller believe it saw the whole
  // neighbourhood — which is how a note holding the answer goes missing without anyone
  // noticing. Counting the rest is a handful of existence queries, not a second walk.
  const byDistance = [...seenByDistance.keys()].sort((a, b) => a - b).map(hop => {
    let existing = 0;
    for (const [s, h] of ordered) {
      if (h !== hop) continue;
      if (noteExists.get(s)) existing++;
    }
    return { distance: hop, reachable: existing, shown: shownByDistance.get(hop) ?? 0 };
  });

  return {
    anchor,
    anchor_title: note.title ?? anchor,
    reachable: distance.size,
    candidates,
    by_distance: byDistance,
    sentences_omitted: sentencesOmitted,
  };
}

/**
 * Render an entity as markdown, for callers that return text rather than printing.
 *
 * Empty groups are omitted, and an entity with no references says so explicitly: "no other
 * note leads here" is information a reader acts on, and silence is not the same answer.
 */
export function renderAboutMarkdown(
  entity: FilteredAbout,
  options: { incoming?: boolean; outgoing?: boolean } = {},
): string {
  const lines: string[] = [`# ${entity.title}`, '', `${entity.type} · ${entity.status}`, ''];

  // `counts` is already filtered, so an entity that has references but none of the
  // requested type is not the same as an entity nothing points at.
  const total = entity.unfiltered_counts ?? entity.counts;
  const entityIsUnreferenced = total.incoming + total.outgoing === 0;
  const filteredToNothing = entity.counts.incoming + entity.counts.outgoing === 0;
  const requested = entity.filtered_by?.join(', ');

  if (filteredToNothing) {
    if (entityIsUnreferenced) {
      lines.push('Nothing links to this note and it links to nothing.');
      lines.push('');
      lines.push('That is worth knowing: no other note leads here.');
    } else {
      lines.push(`No ${requested} note references this one, though ${total.incoming} note(s) link here in total.`);
    }
    return lines.join('\n');
  }

  lines.push(`${entity.counts.incoming} note(s) link here · it links to ${entity.counts.outgoing}`, '');

  // Both sections are the default; `--incoming`/`--outgoing` narrow, they do not exclude.
  const showIncoming = options.incoming || !options.outgoing;
  const showOutgoing = options.outgoing || !options.incoming;

  const renderGroup = (label: string, grouped: Record<string, EntityReference[]>) => {
    const entries = Object.entries(grouped).filter(([, list]) => list.length > 0);
    if (entries.length === 0) return;
    // Largest groups first: the type with most references is usually the useful one.
    entries.sort((a, b) => b[1].length - a[1].length || a[0].localeCompare(b[0]));
    for (const [type, refs] of entries) {
      lines.push(`## ${label} — ${type} (${refs.length})`, '');
      for (const ref of refs) {
        lines.push(`- **${ref.title}** \`${ref.slug}\``);
        for (const context of ref.contexts) lines.push(`  - ${context}`);
      }
      lines.push('');
    }
  };

  if (showIncoming) renderGroup('Referenced by', entity.incoming);
  if (showOutgoing) renderGroup('References', entity.outgoing);
  return lines.join('\n').trimEnd();
}

/**
 * Render a candidate pool as markdown, for callers that return text rather than printing.
 *
 * Every candidate carries its graph distance and its deterministic sentences, because the
 * distance is the ordering signal and the sentences are what a judge actually reads. The
 * note about judging is deliberately explicit: this function never decides anything.
 */
export function renderPoolMarkdown(pool: EntityPool): string {
  const lines: string[] = [
    `# Candidate pool around ${pool.anchor_title}`,
    '',
    `${pool.candidates.length} candidate(s) of ${pool.reachable} note(s) reachable by graph distance.`,
    '',
    'Nothing is judged here: this is the set a judge would decide on. Ordering is by graph',
    'distance only, never by lexical overlap with a question.',
  ];

  // Say what was left out, per hop. A caller reading "30 candidates of 363 reachable" may
  // still assume the nearest neighbourhood is complete; it usually is not, and a note
  // holding the answer can be one of the ones dropped.
  const truncated = pool.by_distance.filter(band => band.shown < band.reachable);
  if (truncated.length > 0) {
    lines.push('', 'Reachable vs returned, per graph distance:');
    for (const band of pool.by_distance) {
      const note = band.shown < band.reachable ? `  (${band.reachable - band.shown} not returned)` : '';
      lines.push(`- distance ${band.distance}: ${band.shown} returned of ${band.reachable}${note}`);
    }
    lines.push('', 'If the note you expect is not here, it may be one of the ones not returned: raise `limit` or lower `depth` rather than concluding the vault does not have it.');
  }
  if (pool.sentences_omitted) {
    lines.push('', 'Sentences were omitted because the nearest band is large: this listing is titles only. '
      + 'Call again with `sentences: 6` (and a smaller `limit` if you want to read only part of it) '
      + 'for the text a judge needs to cite.');
  }

  if (pool.candidates.length === 0) {
    lines.push('', 'Nothing is reachable from this note. There is no candidate set to judge.');
    return lines.join('\n');
  }

  lines.push('');
  for (const candidate of pool.candidates) {
    lines.push(`## [${candidate.distance}] ${candidate.title} \`${candidate.slug}\``, '');
    lines.push(`${candidate.type}`);
    for (const sentence of candidate.sentences) lines.push(`- ${sentence}`);
    lines.push('');
  }
  return lines.join('\n').trimEnd();
}
