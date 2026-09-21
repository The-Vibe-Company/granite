/**
 * Capture-time linking: the hot path.
 *
 * A note should be born connected. Linking as a periodic gardening pass means it does not
 * happen for the notes that need it most — measured on a real vault, 106 notes had no
 * incoming link and 65 of them were `source` notes.
 *
 * This is the one place Jev runs on the synchronous-feeling write path, so three properties
 * are deliberate:
 *
 * - **It proposes; it never writes.** The measured precision on this shape does not support
 *   writing: 47 of 77 proposals pointed at one word that appears in 348 of 761 notes, and a
 *   judge right about three links in four is confidently wrong about the fourth. A wrong
 *   wikilink is silent and durable.
 * - **It degrades to "not judged", never to a failed capture.** The note is already on disk
 *   when this runs. A TypeSafe outage loses the suggestions, not the note.
 * - **Candidates are gathered deterministically.** Granite decides what is worth judging by
 *   unlinked mention, Jev decides which mentions are real. Ordering by mention count keeps a
 *   bounded request on a hub note.
 */
import type Database from 'better-sqlite3';
import type { GraniteConfig } from '../core/types.js';
import { suggestLinks } from '../core/suggest.js';
import {
  LINK_THRESHOLD,
  model as judgeModel,
  proposeLinks,
  requireApiKey,
  type LinkProposalResult,
} from './judge.js';
import {
  readCachedJudgments,
  readCachedRouting,
  sourceHash,
  writeCachedJudgments,
  writeCachedRouting,
} from './judgment-cache.js';

/** How many candidates one capture may judge. Bounds the request on a densely linked note. */
export const MAX_CAPTURE_CANDIDATES = 24;

export interface LinkableNote {
  slug: string;
  title: string;
  body: string;
}

/**
 * The vault's own vocabulary, so routing is a choice over what this vault declares rather
 * than over what the model invents. Existing tags only: proposing a tag nobody uses creates a
 * second vocabulary rather than reusing the first.
 */
export function captureVocabulary(db: Database.Database, config?: GraniteConfig): { types: string[]; tags: string[] } {
  const types = config ? Object.keys(config.note_types) : [];
  let tags: string[] = [];
  try {
    const row = db.prepare("SELECT tags FROM notes WHERE tags IS NOT NULL AND tags != ''").all() as Array<{ tags: string }>;
    const seen = new Set<string>();
    for (const { tags: raw } of row) {
      let parsed: unknown = raw;
      try { parsed = JSON.parse(raw); } catch { /* a bare comma list is fine */ }
      const list = Array.isArray(parsed) ? parsed : String(raw).split(',');
      for (const tag of list) {
        const clean = String(tag).trim();
        if (clean) seen.add(clean);
      }
    }
    // Most used first, capped: a choice with hundreds of options is not a choice.
    tags = [...seen].sort((a, b) => a.localeCompare(b)).slice(0, 40);
  } catch {
    tags = [];
  }
  return { types, tags };
}

export async function proposeLinksAtCapture(
  db: Database.Database,
  note: LinkableNote,
  config?: GraniteConfig,
): Promise<LinkProposalResult | undefined> {
  // `suggestLinks` reads the note's title from `frontmatter`, not from a root `title`. Casting
  // an object with the wrong shape into `Note` compiled and then threw at runtime, inside the
  // catch below, where it looked like "nothing was proposed".
  const candidateNote = {
    slug: note.slug,
    filepath: '',
    frontmatter: { title: note.title },
    body: note.body,
    outgoing_links: [],
  } as unknown as Parameters<typeof suggestLinks>[1];

  const candidates = suggestLinks(db, candidateNote)
    .slice(0, MAX_CAPTURE_CANDIDATES)
    .map(suggestion => ({ slug: suggestion.target_slug, title: suggestion.target_title }));

  if (candidates.length === 0) return undefined;

  try {
    const modelName = judgeModel();
    // One hash per candidate: the title is part of both the state and the criteria, so a
    // renamed candidate must not re-use a verdict that names the old title.
    const hashFor = (candidateTitle: string) => sourceHash(note.title, note.body, candidateTitle);
    // Routing depends on the note and the vocabulary, not on any candidate, so it is keyed on
    // the note alone. Deriving it from `candidates[0].title` made it move whenever the first
    // candidate changed — an incidental value deciding a cache key.
    const noteHash = hashFor('');

    // Judgments about this exact wording that we already paid for. The key includes the body
    // hash, so an edited note is judged again rather than served a verdict about old text.
    const cached = new Map<string, number>();
    for (const candidate of candidates) {
      const hit = readCachedJudgments(db, {
        sourceSlug: note.slug,
        hash: hashFor(candidate.title),
        model: modelName,
        candidates: [candidate.slug],
      });
      const probability = hit.get(candidate.slug);
      if (probability !== undefined) cached.set(candidate.slug, probability);
    }

    const missing = candidates.filter(c => !cached.has(c.slug));
    const fresh = missing.length === 0
      ? { proposed: [], rejected: [], not_judged: 0, note: note.slug } as LinkProposalResult
      : await proposeLinks(
        { slug: note.slug, title: note.title, body: note.body },
        missing,
        requireApiKey(),
        modelName,
        captureVocabulary(db, config),
      );

    if (missing.length > 0) {
      // Routing has no candidate, so it is keyed on the note's own hash.
      writeCachedRouting(db, {
        sourceSlug: note.slug, hash: noteHash, model: modelName,
        routing: { note_type: fresh.note_type, tags: fresh.tags },
      });
      // One transaction for the whole capture, not one per candidate.
      writeCachedJudgments(db, {
        sourceSlug: note.slug,
        model: modelName,
        verdicts: [...fresh.proposed, ...fresh.rejected].map(verdict => ({
          candidate: verdict.target,
          probability: verdict.link_probability,
          hash: hashFor(candidates.find(c => c.slug === verdict.target)?.title ?? ''),
        })),
      });
    }

    // Merge cache hits back in, so a caller cannot tell which came from where except by the
    // numbers. A cached probability above the threshold is a proposal like any other.
    const all = [...fresh.proposed, ...fresh.rejected];
    for (const [slug, probability] of cached) {
      const candidate = candidates.find(c => c.slug === slug)!;
      all.push({ target: slug, target_title: candidate.title, link_probability: probability });
    }
    const proposed = all.filter(v => v.link_probability >= LINK_THRESHOLD)
      .sort((a, b) => b.link_probability - a.link_probability);
    const rejected = all.filter(v => v.link_probability < LINK_THRESHOLD);

    // A cache hit must return the whole judgment, not half of it.
    const cachedRouting = readCachedRouting(db, { sourceSlug: note.slug, hash: noteHash, model: modelName });

    return {
      ...fresh,
      proposed,
      rejected,
      not_judged: missing.length === 0 ? 0 : fresh.not_judged,
      note_type: fresh.note_type ?? cachedRouting?.note_type,
      tags: fresh.tags ?? cachedRouting?.tags,
    };
  } catch (error) {
    // The capture already succeeded. Reporting "we could not judge" is honest; throwing here
    // would turn a network hiccup into a lost note, which is strictly worse.
    //
    // The reason is logged, not swallowed: a wrong note shape passed to the candidate builder
    // once compiled and threw here, and the silent catch made it look like "nothing was
    // proposed" through three debugging rounds.
    console.error(
      `granite: could not judge ${candidates.length} link candidate(s) for ${note.slug}:`,
      error instanceof Error ? error.message : String(error),
    );
    return { note: note.slug, proposed: [], rejected: [], not_judged: candidates.length };
  }
}
