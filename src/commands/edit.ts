import { validateAuthor, recordModification } from '../core/author.js';
import fs from 'node:fs';
import { execSync } from 'node:child_process';
import { loadConfig } from '../core/config.js';
import { requireVaultRoot } from '../core/vault.js';
import { findNoteBySlug, readNote } from '../core/note.js';
import { parseFrontmatter, serializeFrontmatter } from '../core/frontmatter.js';
import {
  validateDurability,
  validateReviewState,
  validateStatus,
  validateSource,
} from '../core/json-output.js';
import { recommendNote, formatRecommendations } from '../core/recommendations.js';
import { syncVaultIndexAfterNoteWrite } from '../core/index-db.js';

interface EditOptions {
  author?: string;
  body?: string;
  append?: string;
  title?: string;
  tag?: string;
  alias?: string;
  status?: string;
  source?: string;
  reviewState?: string;
  durability?: string;
  derivedFrom?: string;
}

export function editCommand(slug: string, options: EditOptions): void {
  validateAuthor(options.author);
  const vaultRoot = requireVaultRoot();
  const config = loadConfig(vaultRoot);
  const note = findNoteBySlug(vaultRoot, config, slug);

  if (!note) {
    console.error(`Note not found: ${slug}`);
    process.exit(1);
  }
  const existingNote = note;

  const hasFlags = options.body !== undefined
    || options.append !== undefined
    || options.title !== undefined
    || options.tag !== undefined
    || options.alias !== undefined
    || options.status !== undefined
    || options.source !== undefined
    || options.reviewState !== undefined
    || options.durability !== undefined
    || options.derivedFrom !== undefined;

  if (hasFlags) {
    // Programmatic edit (agent mode)
    let { frontmatter, body } = parseFrontmatter(fs.readFileSync(existingNote.filepath, 'utf-8'));

    if (options.title) {
      frontmatter.title = options.title;
    }

    if (options.tag) {
      const newTags = options.tag.split(',').map(t => t.trim()).filter(Boolean);
      const existing = new Set(frontmatter.tags);
      for (const t of newTags) existing.add(t);
      frontmatter.tags = [...existing];
    }

    if (options.alias) {
      const newAliases = options.alias.split(',').map(a => a.trim()).filter(Boolean);
      const existing = new Set(frontmatter.aliases);
      for (const a of newAliases) existing.add(a);
      frontmatter.aliases = [...existing];
    }

    if (options.status !== undefined) {
      validateStatus(options.status);
      frontmatter.status = options.status;
    }

    if (options.source !== undefined) {
      validateSource(options.source);
      frontmatter.source = options.source;
    }

    if (options.reviewState !== undefined) {
      validateReviewState(options.reviewState);
      frontmatter.review_state = options.reviewState;
    }

    if (options.durability !== undefined) {
      validateDurability(options.durability);
      frontmatter.durability = options.durability;
    }

    if (options.derivedFrom !== undefined) {
      frontmatter.derived_from = options.derivedFrom.split(',').map(value => value.trim()).filter(Boolean);
    }

    if (options.body !== undefined) {
      body = options.body + '\n';
    }

    if (options.append !== undefined) {
      body = body.trimEnd() + '\n' + options.append + '\n';
    }

    frontmatter.modified = new Date().toISOString();
    recordModification(frontmatter, options.author);
    fs.writeFileSync(existingNote.filepath, serializeFrontmatter(frontmatter, body), 'utf-8');

    const updatedNote = readNote(existingNote.filepath);
    const requiresFullRebuild = options.title !== undefined || options.alias !== undefined;
    syncVaultIndexAfterNoteWrite(vaultRoot, config, updatedNote, { rebuild: requiresFullRebuild });

    console.log(existingNote.filepath);
    printRecommendations(vaultRoot, config, existingNote.filepath, 'incremental');
  } else {
    // Interactive edit (human mode) — open in $EDITOR
    const editor = config.defaults.editor === '$EDITOR'
      ? process.env.EDITOR || 'vi'
      : config.defaults.editor;
    const statBefore = fs.statSync(existingNote.filepath).mtimeMs;

    try {
      execSync(`${editor} "${existingNote.filepath}"`, { stdio: 'inherit' });
    } catch {
      console.error(`Failed to open editor: ${editor}`);
      process.exit(1);
    }

    // If file was modified, update the modified timestamp in frontmatter
    const statAfter = fs.statSync(existingNote.filepath).mtimeMs;
    if (statAfter !== statBefore) {
      const { frontmatter, body } = parseFrontmatter(fs.readFileSync(existingNote.filepath, 'utf-8'));
      frontmatter.creator = existingNote.frontmatter.creator;
      frontmatter.author_history = existingNote.frontmatter.author_history;
      frontmatter.modified = new Date().toISOString();
      recordModification(frontmatter, options.author);
      fs.writeFileSync(existingNote.filepath, serializeFrontmatter(frontmatter, body), 'utf-8');
      syncVaultIndexAfterNoteWrite(vaultRoot, config, readNote(existingNote.filepath), { rebuild: true });

      console.log(`Updated: ${existingNote.filepath}`);
      printRecommendations(vaultRoot, config, existingNote.filepath, 'incremental');
    }
  }
}

function printRecommendations(
  vaultRoot: string,
  config: ReturnType<typeof loadConfig>,
  filepath: string,
  strategy: 'rebuild' | 'incremental',
): void {
  const updatedNote = readNote(filepath);
  const recommendations = recommendNote(vaultRoot, config, updatedNote, { strategy });
  const lines = formatRecommendations(recommendations);

  if (lines.length > 0) {
    console.log('');
    console.log('Recommendations:');
    for (const line of lines) {
      console.log(line);
    }
  }

  console.log('');
  console.log(`Next: Check connections → granite suggest-links ${updatedNote.slug} | Compile → granite recommend ${updatedNote.slug}`);
}
