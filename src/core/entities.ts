import type Database from 'better-sqlite3';

/**
 * Entity alignment: deciding which notes describe the same thing.
 *
 * Division of labour, and why
 * ---------------------------
 * Deciding whether two names denote the same entity is a judgement, and a model is
 * good at it. Applying the result is mechanical, and a model is bad at it.
 *
 * So this module is deterministic and total: it finds *candidates* (same
 * normalised title, or an alias claimed by more than one note) and it can *apply*
 * an accepted alias as a reversible edge. It never decides equivalence itself, and
 * the model never rewrites a note.
 *
 * Two constraints learned from measurement elsewhere:
 *
 * - Candidate generation is scoped structurally, never by unbounded similarity.
 *   Unbounded candidates are what produced a 70% false-retirement rate in a
 *   comparable system.
 * - Cross-type candidates are surfaced but marked, not merged. `person` "Agence
 *   France-Presse (AFP)" and `organization` "Agence France-Presse (AFP)" may be the
 *   same real-world thing, but folding a person record into an organization record
 *   is a modelling decision, not a dedupe.
 */

export interface EntityNote {
  slug: string;
  title: string;
  type: string;
  aliases: string[];
}

export type AlignmentReason = 'same-normalised-title' | 'shared-alias';

export interface AlignmentCandidate {
  /** The two notes that may describe the same thing. */
  a: EntityNote;
  b: EntityNote;
  reason: AlignmentReason;
  /** The alias or title that triggered the match. */
  matched_on: string;
  /** True when the two notes have different types. */
  cross_type: boolean;
}

/** Fold a name for comparison: case, accents, punctuation and spacing insensitive. */
export function normalizeName(value: string): string {
  return value
    .normalize('NFD')
    .replace(/\p{M}+/gu, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

/** Read the notes that can participate in alignment. */
export function readEntityNotes(db: Database.Database, types?: string[]): EntityNote[] {
  const rows = db
    .prepare('SELECT slug, title, type, aliases FROM notes')
    .all() as Array<{ slug: string; title: string; type: string; aliases: string | null }>;

  const wanted = types && types.length > 0 ? new Set(types) : undefined;
  const notes: EntityNote[] = [];
  for (const row of rows) {
    if (wanted && !wanted.has(row.type)) continue;
    let aliases: string[] = [];
    if (row.aliases) {
      try {
        const parsed: unknown = JSON.parse(row.aliases);
        if (Array.isArray(parsed)) aliases = parsed.map(String);
      } catch {
        aliases = [];
      }
    }
    notes.push({ slug: row.slug, title: row.title ?? '', type: row.type, aliases });
  }
  return notes;
}

/**
 * Find alignment candidates from the graph alone.
 *
 * Two deterministic signals, both high precision by construction:
 *  1. two notes whose normalised titles are identical;
 *  2. an alias claimed by more than one note.
 *
 * No similarity threshold is used. A fuzzy score would need calibrating per
 * corpus and would admit exactly the over-generation that ruins model-based
 * extraction; a shared alias or an identical folded title is a fact about the
 * data, not a heuristic.
 */
export function findAlignmentCandidates(notes: EntityNote[]): AlignmentCandidate[] {
  const candidates: AlignmentCandidate[] = [];
  const seen = new Set<string>();

  const record = (a: EntityNote, b: EntityNote, reason: AlignmentReason, matchedOn: string) => {
    if (a.slug === b.slug) return;
    // One entry per unordered pair, keeping the first (deterministic) reason found.
    const key = [a.slug, b.slug].sort().join('\u0000');
    if (seen.has(key)) return;
    seen.add(key);
    candidates.push({
      a,
      b,
      reason,
      matched_on: matchedOn,
      cross_type: a.type !== b.type,
    });
  };

  // 1. Identical normalised titles.
  const byTitle = new Map<string, EntityNote[]>();
  for (const note of notes) {
    const key = normalizeName(note.title);
    if (!key) continue;
    const bucket = byTitle.get(key);
    if (bucket) bucket.push(note);
    else byTitle.set(key, [note]);
  }
  for (const [key, bucket] of byTitle) {
    for (let i = 0; i < bucket.length; i++) {
      for (let j = i + 1; j < bucket.length; j++) {
        record(bucket[i], bucket[j], 'same-normalised-title', key);
      }
    }
  }

  // 2. An alias claimed by more than one note.
  const byAlias = new Map<string, EntityNote[]>();
  for (const note of notes) {
    // De-duplicate within a note so one note cannot pair with itself.
    const own = new Set<string>();
    for (const alias of [note.title, ...note.aliases]) {
      const key = normalizeName(alias);
      if (!key || own.has(key)) continue;
      own.add(key);
      const bucket = byAlias.get(key);
      if (bucket) bucket.push(note);
      else byAlias.set(key, [note]);
    }
  }
  for (const [key, bucket] of byAlias) {
    const distinct = [...new Map(bucket.map(n => [n.slug, n])).values()];
    for (let i = 0; i < distinct.length; i++) {
      for (let j = i + 1; j < distinct.length; j++) {
        record(distinct[i], distinct[j], 'shared-alias', key);
      }
    }
  }

  candidates.sort(
    (x, y) =>
      x.a.slug.localeCompare(y.a.slug) ||
      x.b.slug.localeCompare(y.b.slug),
  );
  return candidates;
}

export interface AlignmentPlan {
  /** Canonical target slug -> the aliases to attach, from notes folded into it. */
  aliases: Array<{ target: string; alias: string; from: string }>;
  /** Candidates that must not be auto-applied, with the reason. */
  review: Array<{ candidate: AlignmentCandidate; why: string }>;
}

/**
 * Turn accepted alignments into a plan.
 *
 * Deliberately does not write. Folding aliases is reversible and safe; merging two
 * notes is not, so only the alias half is planned automatically, and only when the
 * two notes share a type. Same-type duplicates whose *titles* are identical are
 * surfaced for review instead, because one of them is usually a genuine duplicate
 * whose body should be merged rather than aliased.
 */
export function planAlignment(candidates: AlignmentCandidate[]): AlignmentPlan {
  const aliases: AlignmentPlan['aliases'] = [];
  const review: AlignmentPlan['review'] = [];

  for (const candidate of candidates) {
    if (candidate.cross_type) {
      review.push({
        candidate,
        why:
          `same name but different types (${candidate.a.type} vs ${candidate.b.type}); ` +
          'folding records across types is a modelling decision, not a dedupe',
      });
      continue;
    }
    if (candidate.reason === 'same-normalised-title') {
      review.push({
        candidate,
        why: 'identical titles of the same type; likely a true duplicate — merge the bodies rather than add an alias',
      });
      continue;
    }
    // A shared alias only proves equivalence when it is one of the two titles: that
    // means one note explicitly claims the other's name. When both notes merely claim
    // the same third name, the alias is *contested* — neither note owns it, so folding
    // would fuse two distinct entities and make them answer to one name. Real case: a
    // person note and another person note that each listed "PLB" were paired, and the
    // plan proposed aliasing one person's full name onto the other.
    const aOwnsKey = normalizeName(candidate.a.title) === candidate.matched_on;
    const bOwnsKey = normalizeName(candidate.b.title) === candidate.matched_on;
    if (!aOwnsKey && !bOwnsKey) {
      review.push({
        candidate,
        why:
          `alias "${candidate.matched_on}" is claimed by both notes but is neither title; ` +
          'the alias is contested — decide which note owns it instead of folding one title into the other',
      });
      continue;
    }
    // The note whose title is the shared name is canonical; the other one claimed it.
    const [primary, secondary] = aOwnsKey
      ? [candidate.a, candidate.b]
      : [candidate.b, candidate.a];
    aliases.push({
      target: primary.slug,
      alias: secondary.title,
      from: secondary.slug,
    });
  }

  aliases.sort((x, y) => x.target.localeCompare(y.target) || x.alias.localeCompare(y.alias));
  review.sort((x, y) => x.candidate.a.slug.localeCompare(y.candidate.a.slug));
  return { aliases, review };
}
