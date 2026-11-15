import { loadConfig } from '../core/config.js';
import { requireVaultRoot } from '../core/vault.js';
import { listNotes } from '../core/note.js';
import { jsonSuccess } from '../core/json-output.js';
import type { Note } from '../core/types.js';

const AVAILABLE_FIELDS = ['slug', 'title', 'type', 'created', 'modified', 'tags', 'aliases', 'status', 'source', 'creator', 'last_modifier', 'review_state', 'durability', 'derived_from', 'filepath'];

interface ListOptions {
  creator?: string;
  lastModifier?: string;
  type?: string;
  status?: string;
  source?: string;
  since?: string;
  json?: boolean | string;
}

function pickFields(note: Note, fields: string[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const f of fields) {
    switch (f) {
      case 'slug': out.slug = note.slug; break;
      case 'title': out.title = note.frontmatter.title; break;
      case 'type': out.type = note.frontmatter.type; break;
      case 'created': out.created = note.frontmatter.created; break;
      case 'modified': out.modified = note.frontmatter.modified; break;
      case 'tags': out.tags = note.frontmatter.tags; break;
      case 'aliases': out.aliases = note.frontmatter.aliases; break;
      case 'status': out.status = note.frontmatter.status; break;
      case 'creator': out.creator = note.frontmatter.creator; break;
      case 'last_modifier': out.last_modifier = note.frontmatter.last_modifier; break;
      case 'source': out.source = note.frontmatter.source; break;
      case 'review_state': out.review_state = note.frontmatter.review_state; break;
      case 'durability': out.durability = note.frontmatter.durability; break;
      case 'derived_from': out.derived_from = note.frontmatter.derived_from; break;
      case 'filepath': out.filepath = note.filepath; break;
    }
  }
  return out;
}

export function listCommand(options: ListOptions): void {
  const vaultRoot = requireVaultRoot();
  const config = loadConfig(vaultRoot);
  let notes = listNotes(vaultRoot, config);

  if (options.type) {
    notes = notes.filter(n => n.frontmatter.type === options.type);
  }

  if (options.status) {
    notes = notes.filter(n => n.frontmatter.status === options.status);
  }

  if (options.source) {
    notes = notes.filter(n => n.frontmatter.source === options.source);
  }

  if (options.since) {
    notes = notes.filter(n => n.frontmatter.modified >= options.since!);
  }

  if (options.creator) notes = notes.filter(n => n.frontmatter.creator === options.creator);
  if (options.lastModifier) notes = notes.filter(n => n.frontmatter.last_modifier === options.lastModifier);

  // Sort by modified desc
  notes.sort((a, b) => b.frontmatter.modified.localeCompare(a.frontmatter.modified));

  if (options.json !== undefined && options.json !== false) {
    // --json with field selection: --json slug,title,type
    // --json without value (boolean true): all default fields
    let fields: string[];
    if (typeof options.json === 'string') {
      fields = options.json.split(',').map(f => f.trim()).filter(f => AVAILABLE_FIELDS.includes(f));
      if (fields.length === 0) {
        console.log(`Available fields: ${AVAILABLE_FIELDS.join(', ')}`);
        return;
      }
    } else {
      fields = AVAILABLE_FIELDS;
    }

    const out = notes.map(n => pickFields(n, fields));
    console.log(jsonSuccess(out));
    return;
  }

  if (notes.length === 0) {
    console.log('No notes found.');
    if (options.type) {
      console.log(`\nNo ${options.type} notes yet. Create one: granite new "Title" --type ${options.type}`);
    } else {
      console.log('\nVault is empty. Start: granite add "Your first thought"');
    }
    return;
  }

  for (const note of notes) {
    const date = note.frontmatter.modified.slice(0, 10);
    const type = note.frontmatter.type.padEnd(10);
    const status = note.frontmatter.status?.padEnd(8) ?? 'active  ';
    console.log(`  ${date}  ${type}  ${status}  ${note.frontmatter.title}  (${note.slug})`);
  }

  console.log(`\n${notes.length} note(s)`);

  // Contextual tip based on filter
  if (options.status === 'inbox') {
    console.log('\nProcess inbox: granite show <slug> → granite edit <slug> --status active');
  }
}
