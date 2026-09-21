import { describe, it, expect } from 'vitest';
import { parseWikilinks, resolveWikilinks } from '../../src/core/wikilinks.js';
import type { Note } from '../../src/core/types.js';

describe('parseWikilinks', () => {
  it('parses simple wikilinks', () => {
    const links = parseWikilinks('See [[My Note]] for details.');
    expect(links).toHaveLength(1);
    expect(links[0].target).toBe('My Note');
    expect(links[0].display).toBe('My Note');
    expect(links[0].raw).toBe('[[My Note]]');
  });

  it('parses aliased wikilinks', () => {
    const links = parseWikilinks('See [[My Note|this note]] for details.');
    expect(links).toHaveLength(1);
    expect(links[0].target).toBe('My Note');
    expect(links[0].display).toBe('this note');
  });

  it('parses multiple wikilinks on one line', () => {
    const links = parseWikilinks('Both [[A]] and [[B]] are linked.');
    expect(links).toHaveLength(2);
    expect(links[0].target).toBe('A');
    expect(links[1].target).toBe('B');
  });

  it('ignores wikilinks inside fenced code blocks', () => {
    const text = '```\n[[Not a link]]\n```\n\n[[Real Link]]';
    const links = parseWikilinks(text);
    expect(links).toHaveLength(1);
    expect(links[0].target).toBe('Real Link');
  });

  it('ignores wikilinks inside inline code', () => {
    const text = 'Use `[[Not a link]]` syntax. See [[Real Link]].';
    const links = parseWikilinks(text);
    expect(links).toHaveLength(1);
    expect(links[0].target).toBe('Real Link');
  });

  it('returns empty array for no wikilinks', () => {
    const links = parseWikilinks('Plain text with no links.');
    expect(links).toHaveLength(0);
  });
});

describe('resolveWikilinks', () => {
  const makeNote = (slug: string, title: string, aliases: string[] = []): Note => ({
    slug,
    filepath: `/notes/${slug}.md`,
    frontmatter: {
      id: slug,
      title,
      type: 'note',
      created: '',
      modified: '',
      tags: [],
      aliases,
    },
    body: '',
    outgoing_links: [],
  });

  const notes = [
    makeNote('machine-learning', 'Machine Learning'),
    makeNote('neural-networks', 'Neural Networks', ['NN', 'deep learning']),
  ];

  it('resolves by slug', () => {
    const links = parseWikilinks('See [[machine-learning]].');
    const resolved = resolveWikilinks(links, notes);
    expect(resolved[0].resolved).toBe(true);
    expect(resolved[0].resolved_slug).toBe('machine-learning');
  });

  it('resolves by title (case-insensitive)', () => {
    const links = parseWikilinks('See [[machine learning]].');
    const resolved = resolveWikilinks(links, notes);
    expect(resolved[0].resolved).toBe(true);
    expect(resolved[0].resolved_slug).toBe('machine-learning');
  });

  it('resolves by alias', () => {
    const links = parseWikilinks('See [[deep learning]].');
    const resolved = resolveWikilinks(links, notes);
    expect(resolved[0].resolved).toBe(true);
    expect(resolved[0].resolved_slug).toBe('neural-networks');
  });

  it('marks unresolved links', () => {
    const links = parseWikilinks('See [[Nonexistent Note]].');
    const resolved = resolveWikilinks(links, notes);
    expect(resolved[0].resolved).toBe(false);
    expect(resolved[0].resolved_slug).toBeUndefined();
  });

  it('resolves a link to a legacy slug that ends with a separator', () => {
    // Regression: vaults written before the trailing-separator fix hold slugs like
    // `long-title-`. slugify() strips trailing separators, so the exact-slug branch
    // could never match, and the note's own canonical slug was reported as broken.
    const legacy = [...notes, makeNote('long-title-', 'Long title cut on a separator')];

    for (const target of ['long-title-', 'long-title']) {
      const resolved = resolveWikilinks(parseWikilinks(`See [[${target}]].`), legacy);
      expect(resolved[0].resolved).toBe(true);
      expect(resolved[0].resolved_slug).toBe('long-title-');
    }
  });

  it('prefers an exact slug over a legacy separator-suffixed slug', () => {
    const both = [
      makeNote('ambiguous', 'Ambiguous'),
      makeNote('ambiguous-', 'Ambiguous legacy'),
    ];
    const resolved = resolveWikilinks(parseWikilinks('See [[ambiguous]].'), both);
    expect(resolved[0].resolved_slug).toBe('ambiguous');
  });
});
