import type Database from 'better-sqlite3';
import type { Note } from './types.js';
import { parseWikilinks } from './wikilinks.js';

export interface LinkSuggestion {
  target_slug: string;
  target_title: string;
  mentions: number;
}

/**
 * Fold a string for case-insensitive matching while preserving length, so
 * offsets in the folded string still index into the original body.
 *
 * NFD + dropping combining marks would shorten "é" from 1 code point to 1 base
 * character but would change offsets when the source used a decomposed
 * sequence; replacing the mark with a space keeps every offset stable.
 */
function foldForMatch(text: string): string {
  return text
    .normalize('NFD')
    .replace(/\p{M}+/gu, ' ')
    .toLowerCase();
}

/** Escape a probe so it can be embedded in a RegExp literally. */
function escapeRegex(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Word characters for boundary purposes, incl. accented letters and digits. */
const WORD_CHAR = /[\p{L}\p{N}_]/u;

/**
 * True when the match at `start..end` is bounded by non-word characters.
 * This is what stops an alias like "MoK" from matching inside "mokeup".
 */
function hasWordBoundaries(body: string, start: number, end: number): boolean {
  const before = start > 0 ? body[start - 1] : '';
  const after = end < body.length ? body[end] : '';
  if (before && WORD_CHAR.test(before)) return false;
  if (after && WORD_CHAR.test(after)) return false;
  return true;
}

/** Offsets occupied by `[[wikilinks]]`, so link text is never re-suggested as a mention. */
function linkedSpans(body: string): Array<{ start: number; end: number }> {
  const spans: Array<{ start: number; end: number }> = [];
  const re = /\[\[[^\]]*\]\]/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(body)) !== null) {
    spans.push({ start: m.index, end: m.index + m[0].length });
  }
  return spans;
}

function overlapsAny(
  start: number,
  end: number,
  spans: Array<{ start: number; end: number }>,
): boolean {
  return spans.some(s => start < s.end && end > s.start);
}

interface MentionCandidate {
  slug: string;
  title: string;
  probes: string[];
}

interface SpanHit {
  slug: string;
  title: string;
  start: number;
  end: number;
}

/**
 * Suggest notes that are mentioned by name in the body but not yet linked.
 *
 * Deterministic and lexical by design: a mention is a whole-word occurrence of
 * another note's title or one of its aliases. Matching is whole-word (an alias
 * "MoK" does not match inside "mokeup") and spans already inside `[[wikilinks]]`
 * are ignored, so a note never re-suggests a link that already exists.
 *
 * Where several notes match overlapping spans, the longest match wins: a
 * specific title beats a generic alias covering the same characters.
 *
 * @param limit Cap on returned suggestions, ordered by mention count. Omit for all.
 */
export function suggestLinks(
  db: Database.Database,
  note: Note,
  limit?: number,
): LinkSuggestion[] {
  const body = note.body;
  if (!body) return [];

  const foldedBody = foldForMatch(body);
  const linked = linkedSpans(body);

  // Resolve which notes are already linked: by wikilink target text, by slug,
  // and by the matched spelling itself. Checking the spelling matters because
  // `parseWikilinks` returns the raw target, so [[Some Note|alias]] must also
  // suppress a later plain-text mention of that same alias.
  const alreadyLinked = new Set<string>();
  for (const l of parseWikilinks(body)) {
    const target = l.target.trim();
    if (!target) continue;
    alreadyLinked.add(target.toLowerCase());
    alreadyLinked.add(foldForMatch(target).trim());
  }

  const rows = db
    .prepare('SELECT slug, title, aliases FROM notes WHERE slug != ?')
    .all(note.slug) as Array<{ slug: string; title: string; aliases: string | null }>;

  const candidates: MentionCandidate[] = [];
  for (const row of rows) {
    let aliases: string[] = [];
    if (row.aliases) {
      try {
        const parsed: unknown = JSON.parse(row.aliases);
        if (Array.isArray(parsed)) aliases = parsed.map(a => String(a));
      } catch {
        aliases = [];
      }
    }

    const title = row.title ?? '';
    const probes: string[] = [];
    for (const probe of [title, ...aliases]) {
      const trimmed = probe.trim();
      if (trimmed.length < 2) continue;
      const folded = foldForMatch(trimmed).trim();
      if (!folded) continue;
      // Skip spellings that already resolve to a link in this note.
      if (alreadyLinked.has(folded) || alreadyLinked.has(trimmed.toLowerCase())) continue;
      if (alreadyLinked.has(row.slug)) continue;
      probes.push(trimmed);
    }
    if (probes.length === 0) continue;
    if (foldForMatch(title).trim() === foldForMatch(note.frontmatter.title).trim()) continue;
    candidates.push({ slug: row.slug, title, probes });
  }

  // Collect every whole-word hit, then resolve overlaps longest-first so the
  // most specific spelling claims the characters it covers.
  const hits: SpanHit[] = [];
  for (const candidate of candidates) {
    for (const probe of candidate.probes) {
      const foldedProbe = foldForMatch(probe).trim();
      if (!foldedProbe) continue;
      // Escape first, then widen whitespace: escaping after the replacement
      // would neutralise the \s+ and turn it into a literal search string.
      const re = new RegExp(escapeRegex(foldedProbe).replace(/ /g, '\\s+'), 'gu');
      let m: RegExpExecArray | null;
      while ((m = re.exec(foldedBody)) !== null) {
        const start = m.index;
        const end = start + m[0].length;
        if (!hasWordBoundaries(foldedBody, start, end)) continue;
        if (overlapsAny(start, end, linked)) continue;
        hits.push({ slug: candidate.slug, title: candidate.title, start, end });
        if (m[0].length === 0) re.lastIndex++;
      }
    }
  }

  hits.sort((a, b) => (b.end - b.start) - (a.end - a.start) || a.start - b.start);

  // Count one mention per occurrence. Repeats of the *same* candidate covering
  // the same characters are deduplicated (so a note's title and one of its
  // aliases are not double-counted in one phrase), but genuinely distinct
  // occurrences are all counted, and mentions of different candidates never
  // shadow each other.
  const claimedBySlug = new Map<string, Array<{ start: number; end: number }>>();
  const bySlug = new Map<string, LinkSuggestion>();
  for (const hit of hits) {
    const taken = claimedBySlug.get(hit.slug) ?? [];
    if (overlapsAny(hit.start, hit.end, taken)) continue;
    taken.push({ start: hit.start, end: hit.end });
    claimedBySlug.set(hit.slug, taken);
    const existing = bySlug.get(hit.slug);
    if (existing) {
      existing.mentions++;
    } else {
      bySlug.set(hit.slug, {
        target_slug: hit.slug,
        target_title: hit.title,
        mentions: 1,
      });
    }
  }

  const suggestions = [...bySlug.values()].sort(
    (a, b) => b.mentions - a.mentions || a.target_title.localeCompare(b.target_title),
  );

  return typeof limit === 'number' ? suggestions.slice(0, Math.max(0, limit)) : suggestions;
}
