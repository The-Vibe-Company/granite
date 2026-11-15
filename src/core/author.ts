import type { NoteFrontmatter } from './types.js';

export const AUTHOR_HISTORY_LIMIT = 10;
export const AUTHOR_PATTERN = /^[a-z0-9][a-z0-9_-]{0,63}$/;
export interface AuthorHistoryEntry { author: string; date: string }

export function validateAuthor(author: unknown): asserts author is string {
  if (typeof author !== 'string' || !AUTHOR_PATTERN.test(author) || author === 'unknown') {
    throw new Error('Pass author: a 1–64 character lowercase slug (letters, digits, hyphen, underscore), e.g. "stan", "dave", or "granite"; "unknown" is reserved.');
  }
}

export function normalizeAuthor(author: unknown): string {
  return typeof author === 'string' && AUTHOR_PATTERN.test(author) ? author : 'unknown';
}

export function normalizeAuthorHistory(value: unknown): AuthorHistoryEntry[] {
  if (!Array.isArray(value)) return [];
  return value.filter((entry): entry is AuthorHistoryEntry =>
    entry !== null && typeof entry === 'object' &&
    typeof entry.author === 'string' && AUTHOR_PATTERN.test(entry.author) &&
    typeof entry.date === 'string' && !Number.isNaN(Date.parse(entry.date)))
    .map(entry => ({ author: entry.author, date: entry.date }))
    .slice(-AUTHOR_HISTORY_LIMIT);
}

export function creationAttribution(author: unknown, date: string) {
  validateAuthor(author);
  return { creator: author, last_modifier: author, author_history: [{ author, date }] };
}

export function recordModification(frontmatter: NoteFrontmatter, author: unknown, date = new Date().toISOString()): void {
  validateAuthor(author);
  frontmatter.creator = normalizeAuthor(frontmatter.creator);
  frontmatter.last_modifier = author;
  frontmatter.author_history = [...normalizeAuthorHistory(frontmatter.author_history), { author, date }].slice(-AUTHOR_HISTORY_LIMIT);
}
