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
import { suggestLinks } from '../core/suggest.js';
import { model as judgeModel, proposeLinks, requireApiKey, type LinkProposalResult } from './judge.js';

/** How many candidates one capture may judge. Bounds the request on a densely linked note. */
export const MAX_CAPTURE_CANDIDATES = 24;

export interface LinkableNote {
  slug: string;
  title: string;
  body: string;
}

export async function proposeLinksAtCapture(
  db: Database.Database,
  note: LinkableNote,
): Promise<LinkProposalResult | undefined> {
  const candidates = suggestLinks(db, {
    slug: note.slug,
    title: note.title,
    body: note.body,
  } as never)
    .slice(0, MAX_CAPTURE_CANDIDATES)
    .map(suggestion => ({ slug: suggestion.target_slug, title: suggestion.target_title }));

  if (candidates.length === 0) return undefined;

  try {
    return await proposeLinks(
      { slug: note.slug, title: note.title, body: note.body },
      candidates,
      requireApiKey(),
      judgeModel(),
    );
  } catch {
    // The capture already succeeded. Reporting "we could not judge" is honest; throwing here
    // would turn a network hiccup into a lost note, which is strictly worse.
    return { note: note.slug, proposed: [], rejected: [], not_judged: candidates.length };
  }
}
