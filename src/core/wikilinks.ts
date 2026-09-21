import { slugVariants } from './slugify.js';
import type { WikiLink, Note } from './types.js';

const WIKILINK_RE = /\[\[([^\]]+)\]\]/g;
const FENCED_CODE_RE = /^```[\s\S]*?^```/gm;
const INLINE_CODE_RE = /`[^`]+`/g;

export function parseWikilinks(body: string): WikiLink[] {
  // Strip code blocks to avoid parsing links inside them
  const stripped = body
    .replace(FENCED_CODE_RE, '')
    .replace(INLINE_CODE_RE, '');

  const links: WikiLink[] = [];
  let match: RegExpExecArray | null;

  while ((match = WIKILINK_RE.exec(stripped)) !== null) {
    const inner = match[1];
    const parts = inner.split('|');
    const target = parts[0].trim();
    const display = parts.length > 1 ? parts[1].trim() : target;

    links.push({
      raw: match[0],
      target,
      display,
      resolved: false,
    });
  }

  return links;
}

export function resolveWikilinks(links: WikiLink[], allNotes: Note[]): WikiLink[] {
  return links.map(link => {
    // 1. Exact slug match, tolerating legacy slugs that end with a separator.
    let found: Note | undefined;
    for (const candidate of slugVariants(link.target)) {
      found = allNotes.find(n => n.slug === candidate);
      if (found) break;
    }

    // 2. Title match (case-insensitive)
    if (!found) {
      found = allNotes.find(n => n.frontmatter.title.toLowerCase() === link.target.toLowerCase());
    }

    // 3. Alias match
    if (!found) {
      found = allNotes.find(n =>
        n.frontmatter.aliases.some(a => a.toLowerCase() === link.target.toLowerCase())
      );
    }

    return {
      ...link,
      resolved: !!found,
      resolved_slug: found?.slug,
    };
  });
}
