import fs from 'node:fs';
import { validateAuthor } from './author.js';
import path from 'node:path';
import { attachAsset, type AttachedAsset } from './assets.js';
import { parseFrontmatter, serializeFrontmatter } from './frontmatter.js';
import { createNote, readNote } from './note.js';
import type { GraniteConfig, Note } from './types.js';

export interface ImportDocumentOptions {
  author?: string;
  title?: string;
  tags?: string[];
  aliases?: string[];
  content?: string;
}

export interface ImportedDocument {
  note: Note;
  asset: AttachedAsset;
}

export function importDocument(
  vaultRoot: string,
  config: GraniteConfig,
  filePath: string,
  options: ImportDocumentOptions = {},
): ImportedDocument {
  validateAuthor(options.author);
  const asset = attachAsset(vaultRoot, filePath);
  const title = normalizeTitle(options.title) ?? defaultImportedDocumentTitle(filePath);
  const created = createNote(vaultRoot, config, 'source', title, buildImportedDocumentBody(asset, options.content), { author: options.author });

  const raw = fs.readFileSync(created.filepath, 'utf-8');
  const { frontmatter, body } = parseFrontmatter(raw);

  frontmatter.status = 'inbox';
  frontmatter.source = 'extraction';
  frontmatter.review_state = 'draft';
  frontmatter.durability = 'canonical';
  frontmatter.tags = mergeUnique(frontmatter.tags, options.tags ?? []);
  frontmatter.aliases = mergeUnique(frontmatter.aliases, options.aliases ?? []);
  frontmatter.document_file = asset.file;
  frontmatter.document_path = asset.relative_path;
  frontmatter.document_mime = asset.mime_type;
  frontmatter.document_sha256 = asset.sha256;
  frontmatter.document_resource_uri = asset.resource_uri;

  fs.writeFileSync(created.filepath, serializeFrontmatter(frontmatter, body), 'utf-8');

  return {
    note: readNote(created.filepath),
    asset,
  };
}

export function defaultImportedDocumentTitle(filePath: string): string {
  const base = path.basename(filePath, path.extname(filePath)).trim();
  if (!base) {
    return 'Imported Document';
  }

  const tokens = base
    .replace(/[_-]+/g, ' ')
    .split(/\s+/)
    .filter(Boolean);

  if (tokens.length === 0) {
    return 'Imported Document';
  }

  return tokens.map(token => {
    const [first = '', ...rest] = token;
    return `${first.toUpperCase()}${rest.join('').toLowerCase()}`;
  }).join(' ');
}

function buildImportedDocumentBody(asset: AttachedAsset, content?: string): string {
  const normalizedContent = normalizeContent(content);
  if (normalizedContent) {
    return [
      '## Document',
      '',
      `- File: [${asset.file}](${asset.relative_path})`,
      '',
      '## Content',
      '',
      normalizedContent,
      '',
      '## Links',
      '',
    ].join('\n');
  }

  return [
    '## Document',
    '',
    `- File: [${asset.file}](${asset.relative_path})`,
    '',
    '## Summary',
    '',
    '## Key Facts',
    '',
    '- ',
    '',
    '## Questions',
    '',
    '## Links',
    '',
  ].join('\n');
}

function mergeUnique(existing: string[], incoming: string[]): string[] {
  const merged = new Set(existing);
  for (const value of incoming) {
    const trimmed = value.trim();
    if (trimmed) {
      merged.add(trimmed);
    }
  }
  return [...merged];
}

function normalizeTitle(value?: string): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

function normalizeContent(value?: string): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}
