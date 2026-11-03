import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { describe, expect, it } from 'vitest';

interface MarkdownRendererApi {
  render: (body: string, outgoingLinks?: unknown[]) => string;
  parseInline: (text: string, outgoingLinks?: unknown[]) => string;
  isSafeLinkUrl: (value: string) => boolean;
  resolveImageSource: (value: string) => string | null;
}

function loadRenderer(base = ''): MarkdownRendererApi {
  const source = fs.readFileSync(
    path.resolve(process.cwd(), 'src/web/public/markdown-renderer.js'),
    'utf8',
  );
  const window = {
    GRANITE_INSTANCE: 'cloud:work',
    location: { href: 'https://granite.example/ui/', origin: 'https://granite.example' },
  };
  const document = {
    querySelector: (selector: string) => selector === 'meta[name="granite-base"]' && base
      ? { content: base }
      : null,
  };
  const context = vm.createContext({ window, document, URL });
  vm.runInContext(source, context, { filename: 'markdown-renderer.js' });
  return (window as typeof window & { MarkdownRenderer: MarkdownRendererApi }).MarkdownRenderer;
}

describe('web markdown renderer URL safety', () => {
  it('renders normal web and relative links, while rejecting active and protocol-relative URLs', () => {
    const renderer = loadRenderer();
    const html = renderer.render([
      '[web](https://example.test/page)',
      '[mail](mailto:reader@example.test)',
      '[anchor](#section)',
      '[script](javascript:alert(1))',
      '[mixed case](JaVaScRiPt:alert(1))',
      '[tab scheme](java\tscript:alert(1))',
      '[entity tab](java&#x09;script:alert(1))',
      '[named entity tab](java&Tab;script:alert(1))',
      '[entity scheme](&#106;avascript:alert(1))',
      '[data](data:text/html,hello)',
      '[protocol relative](//tracker.example/path)',
    ].join('\n'));

    expect(html).toContain('href="https://example.test/page"');
    expect(html).toContain('href="mailto:reader@example.test"');
    expect(html).toContain('href="#section"');
    expect((html.match(/<a /g) || []).length).toBe(3);
    expect(html).not.toMatch(/javascript:|data:text|tracker\.example/);
  });

  it('escapes ampersands and both quote characters in generated attributes', () => {
    const renderer = loadRenderer();
    const html = renderer.render('![an "image" & more](assets/pic.png?x=1&y=2)');

    expect(html).toContain('src="/assets/pic.png?x=1&amp;y=2&amp;instance=cloud%3Awork"');
    expect(html).toContain('alt="an &quot;image&quot; &amp; more"');
    expect(html).not.toContain('onerror=');
  });

  it('keeps hosted markdown images under the authenticated same-origin assets route', () => {
    const renderer = loadRenderer('/ui');
    const html = renderer.render([
      '![local](assets/diagram.png)',
      '![absolute path](/assets/photo.png)',
      '![same origin](https://granite.example/ui/assets/portrait.png)',
      '![remote](https://tracker.example/pixel.png)',
      '![protocol relative](//tracker.example/pixel.png)',
      '![data](data:image/png;base64,abc)',
      '![parent traversal](../private.png)',
    ].join('\n'));

    expect(html).toContain('src="/ui/assets/diagram.png"');
    expect(html).toContain('src="/ui/assets/photo.png"');
    expect(html).toContain('src="/ui/assets/portrait.png"');
    expect((html.match(/<img /g) || []).length).toBe(3);
    expect(html).not.toContain('tracker.example');
    expect(html).not.toContain('data:image');
    expect(html).not.toContain('private.png');
  });

  it('retains local instance-aware assets and exposes URL guards for review', () => {
    const renderer = loadRenderer();

    expect(renderer.resolveImageSource('diagram.png')).toBe('/assets/diagram.png?instance=cloud%3Awork');
    expect(renderer.isSafeLinkUrl('https://example.test/a?x=1&y=2')).toBe(true);
    expect(renderer.isSafeLinkUrl('java&#x09;script:alert(1)')).toBe(false);
    expect(renderer.isSafeLinkUrl('//tracker.example')).toBe(false);
  });
});
