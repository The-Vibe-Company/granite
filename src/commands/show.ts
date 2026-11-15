import fs from 'node:fs';
import { loadConfig } from '../core/config.js';
import { requireVaultRoot } from '../core/vault.js';
import { findNoteBySlug } from '../core/note.js';
import { jsonSuccess, jsonError } from '../core/json-output.js';

export function showCommand(slug: string, options: { json?: boolean; body?: boolean }): void {
  const vaultRoot = requireVaultRoot();
  const config = loadConfig(vaultRoot);
  const note = findNoteBySlug(vaultRoot, config, slug);

  if (!note) {
    if (options.json) {
      console.log(jsonError(`Note not found: ${slug}`));
    } else {
      console.error(`Note not found: ${slug}`);
    }
    process.exit(1);
  }
  const existingNote = note;

  if (options.json) {
    console.log(jsonSuccess({
      slug: existingNote.slug,
      title: existingNote.frontmatter.title,
      type: existingNote.frontmatter.type,
      created: existingNote.frontmatter.created,
      modified: existingNote.frontmatter.modified,
      tags: existingNote.frontmatter.tags,
      aliases: existingNote.frontmatter.aliases,
      status: existingNote.frontmatter.status,
      source: existingNote.frontmatter.source,
      creator: existingNote.frontmatter.creator,
      last_modifier: existingNote.frontmatter.last_modifier,
      author_history: existingNote.frontmatter.author_history,
      review_state: existingNote.frontmatter.review_state,
      durability: existingNote.frontmatter.durability,
      derived_from: existingNote.frontmatter.derived_from,
      body: existingNote.body,
      filepath: existingNote.filepath,
    }));
    return;
  }

  if (options.body) {
    process.stdout.write(existingNote.body);
    return;
  }

  // Default: print full file content
  console.log(`# ${existingNote.frontmatter.title}  (${existingNote.slug})`);
  console.log(
    `# type: ${existingNote.frontmatter.type}  |  modified: ${existingNote.frontmatter.modified.slice(0, 10)}  |  review: ${existingNote.frontmatter.review_state}  |  durability: ${existingNote.frontmatter.durability}`,
  );
  console.log('');
  const content = fs.readFileSync(existingNote.filepath, 'utf-8');
  console.log(content);
}
