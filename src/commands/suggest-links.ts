import { loadConfig } from '../core/config.js';
import { requireVaultRoot } from '../core/vault.js';
import { ensureIndex } from '../core/index-db.js';
import { findNoteBySlug } from '../core/note.js';
import { suggestLinks } from '../core/suggest.js';
import { jsonSuccess, jsonError } from '../core/json-output.js';

export function suggestLinksCommand(slug: string, options: { json?: boolean; limit?: number }): void {
  const vaultRoot = requireVaultRoot();
  const config = loadConfig(vaultRoot);
  const note = findNoteBySlug(vaultRoot, config, slug);

  if (!note) {
    if (options.json) {
      console.log(jsonError(`Note not found: ${slug}`));
    } else {
      console.error(`Note not found: "${slug}"`);
    }
    process.exit(1);
  }
  const existingNote = note;

  const db = ensureIndex(vaultRoot, config);
  const suggestions = suggestLinks(db, existingNote, options.limit ?? 20);
  db.close();

  if (options.json) {
    console.log(jsonSuccess(suggestions));
    return;
  }

  if (suggestions.length === 0) {
    console.log(`No unlinked mentions found for "${existingNote.frontmatter.title}".`);
    console.log('');
    console.log(`All mentions are linked. See what else to do: granite recommend ${slug}`);
    return;
  }

  console.log(`Unlinked mentions in "${existingNote.frontmatter.title}":`);
  console.log('');
  for (const s of suggestions) {
    console.log(`  → [[${s.target_title}]] — ${s.mentions} mention${s.mentions > 1 ? 's' : ''}`);
  }

  console.log('');
  console.log(`Add [[wikilinks]] to strengthen the graph. Then: granite recommend ${slug}`);
}
