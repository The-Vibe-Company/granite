import type Database from 'better-sqlite3';

/**
 * Facts and their validity over time.
 *
 * Why this is deterministic
 * -------------------------
 * Measured results on agent memory under evolving knowledge are unambiguous about
 * where the policy belongs:
 *
 * - Splitting *evidence identification* (a model) from *applying the freshness
 *   policy* (code) lifts FactConsolidation from <=54% single-hop / <=7% multi-hop
 *   to 82-93% / 27-41%, and most of that gain comes from the separation itself.
 * - Letting a model retire facts silently loses true ones: hand-labelling an
 *   automatic edge-retirement run found 70% of the retired facts were still true,
 *   and two independent model judges could not adjudicate contradictions
 *   (Cohen's kappa 0.39). The failure is silent - the write reports success and
 *   the fact simply stops appearing.
 * - On the STALE benchmark every memory framework tested collapses on implicit
 *   state invalidation (5-8%) while retrieval is not the bottleneck: new evidence
 *   was retrieved 77.5% of the time but ranked top-1 only 5.2%.
 *
 * So Granite owns the ordering and the retirement rule, in code, with no model in
 * the loop. A model may *propose* facts; it never decides which one is current.
 *
 * Interval model
 * --------------
 * A fact has a `valid_from` and an optional `valid_to`, both ISO dates or
 * datetimes. An open `valid_to` means "still holds". Retirement never deletes a
 * note: it closes an interval. The ledger is derived from note frontmatter, so it
 * is reproducible and the markdown stays the source of truth.
 */

export interface FactInterval {
  valid_from: string;
  valid_to?: string;
}

/** A fact as read from the vault. */
export interface Fact {
  slug: string;
  title: string;
  subject: string;
  relation: string;
  object: string;
  valid_from: string;
  valid_to?: string;
  /** Optional explicit declaration; the deterministic rule does not depend on it. */
  supersedes?: string[];
  source?: string;
  confidence?: number;
}

export type FactStatus = 'current' | 'superseded' | 'future' | 'expired';

export interface LedgerEntry {
  fact: Fact;
  status: FactStatus;
  /** Slug of the fact that displaced this one, when the rule retired it. */
  superseded_by?: string;
  /** Why the status was assigned, so a decision can be audited. */
  reason: string;
}

export interface Contradiction {
  subject: string;
  relation: string;
  /** Two or more open facts asserting different objects for the same subject+relation. */
  facts: Fact[];
  detail: string;
}

export interface FactLedger {
  entries: LedgerEntry[];
  /** Open facts that share a subject+relation but assert different objects. */
  contradictions: Contradiction[];
  /** Facts whose interval is open and that no other fact displaces. */
  current: Fact[];
}

function toTime(value: string | undefined): number | undefined {
  if (!value) return undefined;
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? undefined : parsed;
}

/**
 * Normalise a subject or relation for grouping. Case- and whitespace-insensitive
 * so "Monka.care" and "monka.care " group together. Deliberately conservative: it
 * does not stem or translate, because a wrong merge silently loses a fact.
 */
export function normalizeKey(value: string): string {
  return value.trim().toLowerCase().replace(/\s+/g, ' ');
}

/** True when the interval covers `at` (defaults to now). */
export function isOpenAt(fact: Fact, at: number = Date.now()): boolean {
  const from = toTime(fact.valid_from);
  if (from !== undefined && from > at) return false;
  const to = toTime(fact.valid_to);
  if (to !== undefined && to <= at) return false;
  return true;
}

/**
 * Compare two facts about the same subject+relation to decide which is current.
 *
 * Policy, in order — all of it deterministic and auditable:
 *  1. An open interval beats a closed one (a fact that still holds wins).
 *  2. A later `valid_from` beats an earlier one (newer knowledge wins).
 *  3. A higher confidence beats a lower one, when both are declared.
 *  4. Lexicographic slug order, so the result never depends on input order.
 *
 * Returns a negative number when `a` should be considered more current than `b`.
 */
export function compareRecency(a: Fact, b: Fact): number {
  const aOpen = a.valid_to === undefined || a.valid_to === '';
  const bOpen = b.valid_to === undefined || b.valid_to === '';
  if (aOpen !== bOpen) return aOpen ? -1 : 1;

  const aFrom = toTime(a.valid_from);
  const bFrom = toTime(b.valid_from);
  if (aFrom !== undefined && bFrom !== undefined && aFrom !== bFrom) {
    return bFrom - aFrom; // later valid_from first
  }
  if (aFrom === undefined && bFrom !== undefined) return 1;
  if (aFrom !== undefined && bFrom === undefined) return -1;

  const aConf = a.confidence ?? 0;
  const bConf = b.confidence ?? 0;
  if (aConf !== bConf) return bConf - aConf;

  return a.slug.localeCompare(b.slug);
}

/**
 * Build the ledger: assign each fact a status, and surface contradictions.
 *
 * Retirement is per (subject, relation) group. Within a group the most current
 * fact per `compareRecency` stays `current`; the others are `superseded` and point
 * at the winner. Facts with no group peers are simply `current`, `future` or
 * `expired` according to their interval.
 *
 * Contradictions are **reported, never auto-resolved**: two open facts claiming
 * different objects for the same subject+relation are exactly the case where a
 * silent automatic choice loses true information. The caller decides.
 */
export function buildFactLedger(facts: Fact[], at: number = Date.now()): FactLedger {
  const groups = new Map<string, Fact[]>();
  for (const fact of facts) {
    const key = `${normalizeKey(fact.subject)}\u0000${normalizeKey(fact.relation)}`;
    const bucket = groups.get(key);
    if (bucket) bucket.push(fact);
    else groups.set(key, [fact]);
  }

  const entries: LedgerEntry[] = [];
  const contradictions: Contradiction[] = [];

  for (const bucket of groups.values()) {
    // Deterministic order regardless of how the caller supplied the facts.
    const ordered = [...bucket].sort(compareRecency);
    const winner = ordered[0];
    const now = at;

    for (const fact of ordered) {
      const from = toTime(fact.valid_from);
      const to = toTime(fact.valid_to);

      if (from !== undefined && from > now) {
        entries.push({
          fact,
          status: 'future',
          reason: `valid_from ${fact.valid_from} is in the future`,
        });
        continue;
      }
      if (to !== undefined && to <= now) {
        entries.push({
          fact,
          status: 'expired',
          reason: `valid_to ${fact.valid_to} has passed`,
        });
        continue;
      }
      if (fact.slug === winner.slug) {
        entries.push({
          fact,
          status: 'current',
          reason: bucket.length > 1
            ? 'most recent open fact for this subject and relation'
            : 'only fact for this subject and relation',
        });
        continue;
      }
      // An explicitly closed fact that is still within its own interval is not
      // retired by recency; it was ended deliberately.
      if (to !== undefined && to > now) {
        entries.push({
          fact,
          status: 'current',
          reason: `interval explicitly closes at ${fact.valid_to}, still within it`,
        });
        continue;
      }
      entries.push({
        fact,
        status: 'superseded',
        superseded_by: winner.slug,
        reason: `displaced by ${winner.slug} (${winner.valid_from}) under the recency rule`,
      });
    }

    // Surface, do not resolve: open facts asserting different objects.
    const openFacts = ordered.filter(f => isOpenAt(f, now));
    const distinctObjects = new Set(openFacts.map(f => normalizeKey(f.object)));
    if (openFacts.length > 1 && distinctObjects.size > 1) {
      contradictions.push({
        subject: winner.subject,
        relation: winner.relation,
        facts: openFacts,
        detail:
          `${openFacts.length} open facts assert ${distinctObjects.size} different values ` +
          `for ${winner.subject} / ${winner.relation}. Not resolved automatically.`,
      });
    }
  }

  entries.sort((a, b) => a.fact.slug.localeCompare(b.fact.slug));
  contradictions.sort(
    (a, b) => a.subject.localeCompare(b.subject) || a.relation.localeCompare(b.relation),
  );

  return {
    entries,
    contradictions,
    current: entries.filter(e => e.status === 'current').map(e => e.fact),
  };
}

/** Read fact notes out of the index. A note is a fact when it declares the fields. */
export function readFacts(db: Database.Database, typeName = 'fact'): Fact[] {  const rows = db
    .prepare(
      `SELECT n.slug, n.title, f.field_name, f.field_value
       FROM notes n
       JOIN note_fields f ON f.slug = n.slug
       WHERE n.type = ?`,
    )
    .all(typeName) as Array<{ slug: string; title: string; field_name: string; field_value: string }>;

  const bySlug = new Map<string, { title: string; fields: Record<string, string> }>();
  for (const row of rows) {
    const entry = bySlug.get(row.slug) ?? { title: row.title, fields: {} };
    entry.fields[row.field_name] = row.field_value;
    bySlug.set(row.slug, entry);
  }

  const facts: Fact[] = [];
  for (const [slug, entry] of bySlug) {
    const { subject, relation, object, valid_from, valid_to } = entry.fields;
    // A fact without subject/relation/object cannot be placed in the ledger; skip
    // it rather than inventing a group for it.
    if (!subject || !relation || !object || !valid_from) continue;
    facts.push({
      slug,
      title: entry.title,
      subject,
      relation,
      object,
      valid_from,
      valid_to: valid_to || undefined,
      source: entry.fields.source,
      confidence: entry.fields.confidence ? Number(entry.fields.confidence) : undefined,
    });
  }
  return facts;
}

/**
 * Answer "what is the current state of <subject>?" from the ledger.
 * Only current facts are returned: a superseded value is never served.
 */
export function currentStateOf(
  ledger: FactLedger,
  subject: string,
  relation?: string,
): Fact[] {
  const wantSubject = normalizeKey(subject);
  const wantRelation = relation ? normalizeKey(relation) : undefined;
  return ledger.current.filter(
    f =>
      normalizeKey(f.subject) === wantSubject &&
      (wantRelation === undefined || normalizeKey(f.relation) === wantRelation),
  );
}

/**
 * Read facts straight from note frontmatter.
 *
 * Preferred over `readFacts` where the caller already has the notes: it needs no
 * `indexed_fields` declaration, so a vault can adopt facts without a config change,
 * and it reads the markdown that is the actual source of truth.
 */
function sourceSlug(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const text = value.trim();
  if (!text) return undefined;
  const inner = text.replace(/^\[\[/, '').replace(/\]\]$/, '');
  return (inner.split('|')[0] ?? '').trim() || undefined;
}

export function factsFromNotes(
  notes: Array<{ slug: string; frontmatter: Record<string, unknown> }>,
): Fact[] {
  const facts: Fact[] = [];
  for (const note of notes) {
    const fm = note.frontmatter ?? {};
    // Detected by fields, not by type name. A fact is any note that declares a
    // subject, relation, object and valid_from, so a vault can use the ledger with
    // no config change and no new note type to adopt.
    const subject = typeof fm.subject === 'string' ? fm.subject.trim() : '';
    const relation = typeof fm.relation === 'string' ? fm.relation.trim() : '';
    const object = typeof fm.object === 'string' ? fm.object.trim() : '';
    const validFrom = typeof fm.valid_from === 'string' ? fm.valid_from.trim() : '';
    // A fact that cannot be placed in the ledger is skipped, not guessed at.
    if (!subject || !relation || !object || !validFrom) continue;
    const confidenceRaw = fm.confidence;
    const confidence = typeof confidenceRaw === 'number'
      ? confidenceRaw
      : typeof confidenceRaw === 'string' && confidenceRaw.trim() !== ''
        ? Number(confidenceRaw)
        : undefined;
    facts.push({
      slug: note.slug,
      title: typeof fm.title === 'string' ? fm.title : note.slug,
      subject,
      relation,
      object,
      valid_from: validFrom,
      valid_to: typeof fm.valid_to === 'string' && fm.valid_to.trim() ? fm.valid_to.trim() : undefined,
      // `source_note` is written as a wikilink so the note stays navigable, but the
      // ledger carries the plain slug.
      source: sourceSlug(fm.source_note),
      confidence: confidence !== undefined && !Number.isNaN(confidence) ? confidence : undefined,
    });
  }
  return facts;
}
