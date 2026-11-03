import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { describe, expect, it } from 'vitest';

interface DashboardText {
  escapeHtml: (value: unknown) => string;
  plural: (n: number, word: string) => string;
  snippetHtml: (snippet: string) => string;
  cleanContext: (context: string) => string;
}

// The hosted dashboard injects search snippets and backlink context as HTML.
// Load its DOM-free helpers the way the browser does, with no document.
function loadText(): DashboardText {
  const source = fs.readFileSync(path.resolve(process.cwd(), 'src/web/public/dashboard/app.js'), 'utf8');
  const window: { GraniteDashboardText?: DashboardText } = {};
  vm.runInContext(source, vm.createContext({ window }), { filename: 'app.js' });
  return window.GraniteDashboardText!;
}

describe('hosted dashboard text helpers', () => {
  const text = loadText();

  it('escapes note content in search snippets and marks only FTS hits', () => {
    const html = text.snippetHtml('<img src=x onerror=alert(1)> "quoted" & >>>celadon<<< <script>x</script>');
    expect(html).not.toMatch(/<(img|script)/);
    expect(html).toContain('&lt;img src=x onerror=alert(1)&gt;');
    expect(html).toContain('&quot;quoted&quot; &amp;');
    expect(html).toContain('<mark>celadon</mark>');
    expect(html.replace(/<\/?mark>/g, '')).not.toMatch(/[<>]/);
  });

  it('reads markdown out of snippets instead of showing its syntax', () => {
    expect(text.snippetHtml('## Summary **Two** percent [[Celadon base recipe]] ![tiles](/assets/a.png) [shop](https://x.test)'))
      .toBe('Summary Two percent Celadon base recipe tiles shop');
    expect(text.snippetHtml('| Shelf | Pots | | --- | --- | | North | 16 |')).toBe('Shelf · Pots · North · 16');
  });

  it('keeps backlink context as text, with wikilink targets marked for emphasis', () => {
    const context = text.cleanContext('- see [[Why celadon crawls|the crawl note]] <b onclick=x>');
    expect(context.startsWith('see ')).toBe(true);
    expect(text.escapeHtml(context)).toContain('&lt;b onclick=x&gt;');
    expect(context).toContain('\u0000the crawl note\u0001');
  });

  it('counts in plain English', () => {
    expect(text.plural(1, 'note')).toBe('1 note');
    expect(text.plural(18, 'note')).toBe('18 notes');
    expect(text.plural(9, 'match')).toBe('9 matches');
    expect(text.plural(0, 'match')).toBe('0 matches');
  });
});
