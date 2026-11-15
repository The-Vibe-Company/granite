import matter from 'gray-matter';
import { normalizeAuthor, normalizeAuthorHistory } from './author.js';
import type { NoteFrontmatter } from './types.js';
import {
  normalizeDurability,
  normalizeReviewState,
  normalizeSource,
  normalizeStatus,
  normalizeStringArray,
} from './json-output.js';

export function parseFrontmatter(content: string): { frontmatter: NoteFrontmatter; body: string } {
  const { data, content: body } = matter(content);
  const fm: NoteFrontmatter = {
    creator: normalizeAuthor(data.creator),
    last_modifier: normalizeAuthor(data.last_modifier),
    author_history: normalizeAuthorHistory(data.author_history),
    id: toFrontmatterString(data.id),
    title: toFrontmatterString(data.title),
    type: toFrontmatterString(data.type),
    created: toFrontmatterString(data.created),
    modified: toFrontmatterString(data.modified),
    tags: normalizeStringArray(data.tags),
    aliases: normalizeStringArray(data.aliases),
    status: normalizeStatus(data.status),
    source: normalizeSource(data.source),
    review_state: normalizeReviewState(data.review_state),
    durability: normalizeDurability(data.durability),
    derived_from: normalizeStringArray(data.derived_from),
  };
  // Preserve any extra type-specific fields
  for (const [key, value] of Object.entries(data)) {
    if (!(key in fm)) {
      fm[key] = value;
    }
  }
  return { frontmatter: fm, body };
}

export function serializeFrontmatter(fm: NoteFrontmatter, body: string): string {
  return matter.stringify(body, fm);
}

function toFrontmatterString(value: unknown): string {
  if (value === null || value === undefined) return '';
  if (value instanceof Date) return value.toISOString();
  return String(value);
}
