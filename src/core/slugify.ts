export function slugify(title: string): string {
  return title
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60)
    // The cut above can land on a separator, which would leave a trailing '-'.
    // Stripping leading/trailing separators before the cut is not enough: it makes
    // slugify() non-idempotent, so a note's own slug no longer slugifies back to
    // itself and `[[that-slug]]` can never resolve by exact slug match.
    .replace(/-+$/, '');
}

/**
 * Slug forms to try when resolving a wikilink target, most specific first.
 *
 * Vaults written before the trailing-separator fix contain slugs that end with
 * '-'. `slugify()` strips trailing separators, so such a slug never comes back
 * out of `slugify()` and an exact-slug lookup misses it in both directions:
 * `[[some-long-title-]]` and `[[some-long-title]]` both fail to match the stored
 * `some-long-title-`.
 *
 * Trying `<slug>-` after `<slug>` repairs those links without renaming any file.
 */
export function slugVariants(target: string): string[] {
  const slug = slugify(target);
  if (!slug) return [];
  return [slug, `${slug}-`];
}
