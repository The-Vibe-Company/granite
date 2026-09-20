import { loadConfig } from '../core/config.js';
import { requireVaultRoot } from '../core/vault.js';
import { ensureIndex } from '../core/index-db.js';
import {
  findAlignmentCandidates,
  planAlignment,
  readEntityNotes,
} from '../core/entities.js';
import { jsonSuccess } from '../core/json-output.js';

export interface EntitiesOptions {
  json?: boolean;
  /** Only show candidates that need a human decision. */
  review?: boolean;
  /** Restrict to these note types. */
  types?: string[];
}

export function entitiesCommand(options: EntitiesOptions): void {
  const vaultRoot = requireVaultRoot();
  const config = loadConfig(vaultRoot);
  const db = ensureIndex(vaultRoot, config);

  try {
    const notes = readEntityNotes(db, options.types);
    const candidates = findAlignmentCandidates(notes);
    const plan = planAlignment(candidates);

    if (options.json) {
      console.log(jsonSuccess({
        scanned: notes.length,
        candidates: candidates.length,
        planned_aliases: plan.aliases,
        review: plan.review.map(entry => ({
          reason: entry.candidate.reason,
          matched_on: entry.candidate.matched_on,
          cross_type: entry.candidate.cross_type,
          a: { slug: entry.candidate.a.slug, title: entry.candidate.a.title, type: entry.candidate.a.type },
          b: { slug: entry.candidate.b.slug, title: entry.candidate.b.title, type: entry.candidate.b.type },
          why: entry.why,
        })),
      }));
      return;
    }

    if (candidates.length === 0) {
      console.log(`No alignment candidates among ${notes.length} note(s).`);
      console.log('');
      console.log('Two notes are candidates when their folded titles are identical, or');
      console.log('when they claim the same alias.');
      return;
    }

    console.log(`${notes.length} note(s) scanned · ${candidates.length} candidate pair(s)`);
    console.log('');

    if (plan.review.length > 0 && !options.review) {
      console.log(`Needs a decision (${plan.review.length}) — not applied automatically:`);
      for (const entry of plan.review) {
        const c = entry.candidate;
        console.log(`  ${c.a.slug} (${c.a.type})`);
        console.log(`  ${c.b.slug} (${c.b.type})`);
        console.log(`    matched on "${c.matched_on}" · ${c.reason}`);
        console.log(`    ${entry.why}`);
        console.log('');
      }
    }

    if (options.review) return;

    if (plan.aliases.length > 0) {
      console.log(`Safe to apply as aliases (${plan.aliases.length}) — reversible, same type:`);
      for (const alias of plan.aliases) {
        console.log(`  ${alias.target}`);
        console.log(`    += "${alias.alias}"  (from ${alias.from})`);
      }
      console.log('');
    }

    console.log('Granite plans these; it does not apply them. Adding an alias is');
    console.log('reversible, merging two notes is not.');
  } finally {
    db.close();
  }
}
