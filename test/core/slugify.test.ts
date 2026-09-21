import { describe, it, expect } from 'vitest';
import { slugify, slugVariants } from '../../src/core/slugify.js';

describe('slugify', () => {
  it('lowercases and replaces spaces with hyphens', () => {
    expect(slugify('My First Note')).toBe('my-first-note');
  });

  it('strips accents', () => {
    expect(slugify('Café résumé')).toBe('cafe-resume');
  });

  it('removes special characters', () => {
    expect(slugify('Hello, World! #2024')).toBe('hello-world-2024');
  });

  it('trims leading/trailing hyphens', () => {
    expect(slugify('---test---')).toBe('test');
  });

  it('truncates at 60 characters', () => {
    const long = 'a'.repeat(100);
    expect(slugify(long).length).toBeLessThanOrEqual(60);
  });

  it('handles empty string', () => {
    expect(slugify('')).toBe('');
  });

  it('collapses multiple spaces/hyphens', () => {
    expect(slugify('foo   bar---baz')).toBe('foo-bar-baz');
  });

  it('never leaves a trailing separator after the 60-character cut', () => {
    // Regression: separators were stripped *before* the cut, so a cut landing on a
    // separator put one back and the slug ended with '-'.
    const title = 'OpenAI × Hugging Face — model evaluation security incident (July 2026)';
    const slug = slugify(title);
    expect(slug.endsWith('-')).toBe(false);
    expect(slug).toBe('openai-hugging-face-model-evaluation-security-incident-july');
  });

  it('is idempotent, including for titles cut on a separator', () => {
    const titles = [
      'OpenAI × Hugging Face — model evaluation security incident (July 2026)',
      'Notion Ship OS — agent-native product development workflow in Notion',
      `${'a'.repeat(59)} ${'b'.repeat(30)}`,
      'Short title',
    ];
    for (const title of titles) {
      const once = slugify(title);
      expect(slugify(once)).toBe(once);
      expect(once.endsWith('-')).toBe(false);
    }
  });

  it('only returns the dash-suffixed form from slugVariants as a fallback', () => {
    expect(slugVariants('Some Note')).toEqual(['some-note', 'some-note-']);
    expect(slugVariants('')).toEqual([]);
  });

  it("keeps the author's separator form first when the target ends with a separator", () => {
    // A vault can hold both `foo.md` and the legacy `foo-.md`. A target written with
    // the separator names the legacy note, so collapsing it onto `foo` first would
    // hand the link and its backlinks to the wrong note.
    expect(slugVariants('foo-')).toEqual(['foo-', 'foo']);
    expect(slugVariants('Some Note-')).toEqual(['some-note-', 'some-note']);
  });
});
