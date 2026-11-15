import fs from 'node:fs';
import { validateAuthor, creationAttribution } from './author.js';
import path from 'node:path';
import { v4 as uuidv4 } from 'uuid';
import type Database from 'better-sqlite3';
import { slugify } from './slugify.js';
import { parseFrontmatter, serializeFrontmatter } from './frontmatter.js';
import { applyOnCreateHooks } from './hooks.js';
import {
  normalizeDurability,
  normalizeReviewState,
  normalizeSource,
  normalizeStatus,
  normalizeStringArray,
} from './json-output.js';
import type { GraniteConfig, Note, NoteFrontmatter } from './types.js';

export interface CreateNoteOptions {
  author?: string;
  db?: Database.Database;
  extraFrontmatter?: Record<string, unknown>;
}

export function createNote(
  vaultRoot: string,
  config: GraniteConfig,
  typeName: string,
  title: string,
  bodyOverride?: string,
  options: CreateNoteOptions = {},
): Note {
  validateAuthor(options.author);
  const typeConfig = config.note_types[typeName];
  if (!typeConfig) {
    throw new Error(`Unknown note type: "${typeName}". Available: ${Object.keys(config.note_types).join(', ')}`);
  }

  const folder = path.join(vaultRoot, typeConfig.folder);
  let finalSlug: string;

  if (typeConfig.slug_format === 'date') {
    // Date-based slug: 2026-03-30-a1b2
    const now = new Date();
    const date = now.toISOString().slice(0, 10);
    const rand = Math.random().toString(36).slice(2, 6);
    finalSlug = `${date}-${rand}`;
    while (fs.existsSync(path.join(folder, `${finalSlug}.md`))) {
      const r = Math.random().toString(36).slice(2, 6);
      finalSlug = `${date}-${r}`;
    }
  } else {
    let slug = slugify(title);
    if (!slug) slug = 'untitled';
    finalSlug = slug;
    let counter = 2;
    while (fs.existsSync(path.join(folder, `${finalSlug}.md`))) {
      finalSlug = `${slug}-${counter}`;
      counter++;
    }
  }

  const now = new Date().toISOString();
  const defaults = typeConfig.frontmatter_defaults ?? {};
  const sanitizedExtra = stripReservedFields(options.extraFrontmatter ?? {});
  const frontmatter: NoteFrontmatter = {
    id: uuidv4(),
    title,
    type: typeName,
    created: now,
    modified: now,
    tags: [],
    aliases: [],
    status: normalizeStatus(defaults.status),
    source: normalizeSource(defaults.source),
    review_state: normalizeReviewState(defaults.review_state),
    durability: normalizeDurability(defaults.durability),
    derived_from: normalizeStringArray(defaults.derived_from),
    ...sanitizedExtra,
    ...creationAttribution(options.author, now),
  };

  const body = bodyOverride ?? typeConfig.template;
  const filepath = path.join(folder, `${finalSlug}.md`);

  const hookResult = applyOnCreateHooks(frontmatter, typeConfig, {
    vaultRoot,
    config,
    db: options.db,
    reservedSlugs: new Set([finalSlug]),
  });

  for (const stub of hookResult.created_stubs) {
    const stubType = config.note_types[stub.type];
    if (!stubType) continue;
    if (findNoteBySlug(vaultRoot, config, stub.slug)) continue;
    const stubFolder = path.join(vaultRoot, stubType.folder);
    const stubPath = path.join(stubFolder, `${stub.slug}.md`);
    fs.mkdirSync(stubFolder, { recursive: true });
    const stubNow = new Date().toISOString();
    const stubFrontmatter: NoteFrontmatter = {
      id: uuidv4(),
      title: stub.title,
      type: stub.type,
      created: stubNow,
      modified: stubNow,
      tags: ['stub'],
      aliases: [],
      status: 'inbox',
      source: 'agent',
      review_state: 'draft',
      durability: normalizeDurability(stubType.frontmatter_defaults?.durability),
      derived_from: [],
      ...creationAttribution(options.author, stubNow),
    };
    fs.writeFileSync(stubPath, serializeFrontmatter(stubFrontmatter, stubType.template), 'utf-8');
  }

  Object.assign(hookResult.frontmatter, creationAttribution(options.author, now));
  const content = serializeFrontmatter(hookResult.frontmatter, body);

  fs.mkdirSync(folder, { recursive: true });
  fs.writeFileSync(filepath, content, 'utf-8');

  return {
    slug: finalSlug,
    filepath,
    frontmatter: hookResult.frontmatter,
    body,
    outgoing_links: [],
  };
}

const RESERVED_IMMUTABLE_FIELDS = new Set(['id', 'type', 'title', 'created', 'modified', 'creator', 'last_modifier', 'author_history']);

function stripReservedFields(extra: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(extra)) {
    if (RESERVED_IMMUTABLE_FIELDS.has(key)) continue;
    out[key] = value;
  }
  return out;
}

export function readNote(filepath: string): Note {
  const content = fs.readFileSync(filepath, 'utf-8');
  const { frontmatter, body } = parseFrontmatter(content);
  const slug = path.basename(filepath, '.md');
  return { slug, filepath, frontmatter, body, outgoing_links: [] };
}

export function listNotes(vaultRoot: string, config: GraniteConfig): Note[] {
  const notes: Note[] = [];
  for (const typeConfig of Object.values(config.note_types)) {
    const folder = path.join(vaultRoot, typeConfig.folder);
    if (!fs.existsSync(folder)) continue;
    const files = fs.readdirSync(folder).filter(f => f.endsWith('.md'));
    for (const file of files) {
      const filepath = path.join(folder, file);
      notes.push(readNote(filepath));
    }
  }
  return notes;
}

export function findNoteBySlug(vaultRoot: string, config: GraniteConfig, slug: string): Note | null {
  for (const typeConfig of Object.values(config.note_types)) {
    const filepath = path.join(vaultRoot, typeConfig.folder, `${slug}.md`);
    if (fs.existsSync(filepath)) {
      return readNote(filepath);
    }
  }
  return null;
}
