/**
 * Granite — HTML Markdown Renderer
 *
 * Converts markdown + wikilinks to semantic HTML.
 * Supports: headings, lists, blockquotes, code, tables, inline formatting, wikilinks.
 */
window.MarkdownRenderer = (() => {

  const baseMeta = typeof document !== 'undefined'
    ? document.querySelector('meta[name="granite-base"]')
    : null;
  const graniteBase = normalizeBase(baseMeta?.content || '');
  const hostedMode = graniteBase !== '';

  function normalizeBase(value) {
    const segments = String(value || '').split('/').filter(Boolean);
    return segments.length ? '/' + segments.join('/') : '';
  }

  function decodeUrlEntities(value) {
    return String(value).replace(/&(?:#(?:x([0-9a-f]{1,6})|(\d{1,7}))|colon|tab|newline|sol|bsol);?/gi, (entity, hex, decimal) => {
      if (hex || decimal) {
        const codePoint = Number.parseInt(hex || decimal, hex ? 16 : 10);
        try { return String.fromCodePoint(codePoint); } catch { return '\uFFFD'; }
      }
      const named = entity.slice(1).replace(/;$/, '').toLowerCase();
      return ({ colon: ':', tab: '\t', newline: '\n', sol: '/', bsol: '\\' })[named] || entity;
    });
  }

  // Normalize enough of the URL syntax that browsers cannot hide a scheme
  // behind HTML entities, ASCII controls, or whitespace before navigation.
  function isSafeLinkUrl(value) {
    const normalized = decodeUrlEntities(value)
      .replace(/[\u0000-\u0020\u007f]/g, '')
      .trim();
    if (!normalized || /^[\\/]{2}/.test(normalized)) return false;
    const scheme = normalized.match(/^([a-z][a-z0-9+.-]*):/i)?.[1]?.toLowerCase();
    return !scheme || ['http', 'https', 'mailto', 'tel'].includes(scheme);
  }

  function resolveImageSource(value) {
    const src = String(value || '').trim();
    if (!src) return null;

    if (hostedMode) {
      // Hosted notes must not cause third-party image requests. Only serve
      // assets from this Granite instance's own /ui/assets route.
      if (src.startsWith(graniteBase + '/assets/')) return src;
      if (/^[a-z][a-z0-9+.-]*:/i.test(decodeUrlEntities(src)) || /^[\\/]{2}/.test(src)) {
        try {
          const url = new URL(src, window.location.href);
          if (url.origin !== window.location.origin || !url.pathname.startsWith(graniteBase + '/assets/')) return null;
          return url.pathname + url.search;
        } catch {
          return null;
        }
      }

      if (/^[\\/]/.test(src) && !src.startsWith(graniteBase + '/assets/')) {
        if (src.startsWith('/assets/')) return graniteBase + src;
        return null;
      }
      const assetName = src.replace(/^\.?\/?assets\//, '');
      if (!assetName || assetName.split(/[\\/]/).includes('..') || /^[\\/]/.test(assetName)) return null;
      return graniteBase + '/assets/' + assetName;
    }

    if (/^https?:\/\//i.test(src)) return src;
    if (/^[a-z][a-z0-9+.-]*:/i.test(decodeUrlEntities(src)) || /^[\\/]{2}/.test(src)) return null;
    let resolvedSrc = '/assets/' + src.replace(/^\.?\/?assets\//, '');
    if (window.GRANITE_INSTANCE) {
      resolvedSrc += (resolvedSrc.includes('?') ? '&' : '?') + 'instance=' + encodeURIComponent(window.GRANITE_INSTANCE);
    }
    return resolvedSrc;
  }

  function parseInline(text, outgoingLinks) {
    const re = /(\[\[([^\]]+)\]\])|(`([^`]+)`)|(\*\*(.+?)\*\*)|(\*(.+?)\*)|(\[([^\]]+)\]\(([^)]+)\))|(!\[([^\]]*)\]\(([^)]+)\))/g;
    let result = '';
    let lastIndex = 0;
    let match;

    while ((match = re.exec(text)) !== null) {
      if (match.index > lastIndex) result += escapeHtml(text.slice(lastIndex, match.index));

      if (match[1]) {
        const inner = match[2];
        const parts = inner.split('|');
        const target = parts[0].trim();
        const display = parts.length > 1 ? parts[1].trim() : target;
        const linkInfo = outgoingLinks?.find(l => l.target === target);
        const resolved = linkInfo?.resolved ?? false;
        const slug = linkInfo?.resolved_slug || null;
        if (resolved && slug) {
          result += `<a class="wikilink" data-slug="${escapeAttr(slug)}" href="#" role="link">${escapeHtml(display)}</a>`;
        } else {
          result += `<span class="wikilink-broken">${escapeHtml(display)}</span>`;
        }
      } else if (match[3]) {
        result += `<code class="inline-code">${escapeHtml(match[4])}</code>`;
      } else if (match[5]) {
        result += `<strong>${escapeHtml(match[6])}</strong>`;
      } else if (match[7]) {
        result += `<em>${escapeHtml(match[8])}</em>`;
      } else if (match[9]) {
        if (isSafeLinkUrl(match[11])) {
          result += `<a class="external-link" href="${escapeAttr(match[11])}" target="_blank" rel="noopener noreferrer">${escapeHtml(match[10])}</a>`;
        } else {
          result += escapeHtml(match[10]);
        }
      } else if (match[12]) {
        // Image: ![alt](src)
        const alt = match[13];
        const src = match[14];
        const resolvedSrc = resolveImageSource(src);
        if (resolvedSrc) {
          result += `<img class="md-image" src="${escapeAttr(resolvedSrc)}" alt="${escapeAttr(alt)}" loading="lazy">`;
        } else {
          result += escapeHtml(alt);
        }
      }
      lastIndex = match.index + match[0].length;
    }
    if (lastIndex < text.length) result += escapeHtml(text.slice(lastIndex));
    return result;
  }

  function render(body, outgoingLinks) {
    const lines = body.split('\n');
    const blocks = [];
    let inCodeBlock = false;
    let codeBuffer = [];
    let codeLang = '';
    let inList = false;
    let listType = null;
    let listItems = [];

    function flushList() {
      if (listItems.length > 0) {
        const tag = listType === 'ol' ? 'ol' : 'ul';
        blocks.push(`<${tag} class="md-list">${listItems.join('')}</${tag}>`);
        listItems = [];
        inList = false;
        listType = null;
      }
    }

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];

      // Code block
      if (line.startsWith('```')) {
        if (inCodeBlock) {
          const langLabel = codeLang ? `<span class="code-lang">${escapeHtml(codeLang)}</span>` : '';
          blocks.push(`<div class="code-block">${langLabel}<pre><code>${escapeHtml(codeBuffer.join('\n'))}</code></pre></div>`);
          codeBuffer = [];
          inCodeBlock = false;
        } else {
          flushList();
          inCodeBlock = true;
          codeLang = line.slice(3).trim();
        }
        continue;
      }
      if (inCodeBlock) { codeBuffer.push(line); continue; }

      // Blank line
      if (line.trim() === '') { flushList(); continue; }

      // Table detection: line starts with |
      if (line.trim().startsWith('|') && line.trim().endsWith('|')) {
        flushList();
        const tableLines = [];
        let j = i;
        while (j < lines.length && lines[j].trim().startsWith('|') && lines[j].trim().endsWith('|')) {
          tableLines.push(lines[j]);
          j++;
        }
        if (tableLines.length >= 2) {
          blocks.push(renderTable(tableLines, outgoingLinks));
          i = j - 1;
          continue;
        }
      }

      // Headings
      const hMatch = line.match(/^(#{1,3})\s+(.+)/);
      if (hMatch) {
        flushList();
        const level = hMatch[1].length;
        blocks.push(`<h${level} class="md-h${level}">${parseInline(hMatch[2], outgoingLinks)}</h${level}>`);
        continue;
      }

      // HR
      if (/^(-{3,}|\*{3,}|_{3,})$/.test(line.trim())) {
        flushList();
        blocks.push('<hr class="md-hr">');
        continue;
      }

      // Blockquote
      if (line.startsWith('>')) {
        flushList();
        const text = line.replace(/^>\s?/, '');
        blocks.push(`<blockquote class="md-blockquote">${parseInline(text, outgoingLinks)}</blockquote>`);
        continue;
      }

      // Unordered list
      const bulletMatch = line.match(/^(\s*)[*\-+]\s+(.+)/);
      if (bulletMatch) {
        if (listType !== 'ul') flushList();
        inList = true;
        listType = 'ul';
        listItems.push(`<li>${parseInline(bulletMatch[2], outgoingLinks)}</li>`);
        continue;
      }

      // Ordered list
      const numMatch = line.match(/^(\s*)\d+\.\s+(.+)/);
      if (numMatch) {
        if (listType !== 'ol') flushList();
        inList = true;
        listType = 'ol';
        listItems.push(`<li>${parseInline(numMatch[2], outgoingLinks)}</li>`);
        continue;
      }

      // Paragraph
      flushList();
      blocks.push(`<p class="md-body">${parseInline(line, outgoingLinks)}</p>`);
    }

    flushList();
    if (inCodeBlock && codeBuffer.length > 0) {
      blocks.push(`<div class="code-block"><pre><code>${escapeHtml(codeBuffer.join('\n'))}</code></pre></div>`);
    }
    return blocks.join('\n');
  }

  function renderTable(tableLines, outgoingLinks) {
    const parseRow = (line) => line.trim().replace(/^\||\|$/g, '').split('|').map(cell => cell.trim());
    const headers = parseRow(tableLines[0]);
    // Skip separator row (index 1)
    const rows = tableLines.slice(2).map(parseRow);

    let html = '<div class="md-table-wrap"><table class="md-table"><thead><tr>';
    for (const h of headers) html += `<th>${parseInline(h, outgoingLinks)}</th>`;
    html += '</tr></thead><tbody>';
    for (const row of rows) {
      html += '<tr>';
      for (const cell of row) html += `<td>${parseInline(cell, outgoingLinks)}</td>`;
      html += '</tr>';
    }
    html += '</tbody></table></div>';
    return html;
  }

  function escapeHtml(str) {
    return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  function escapeAttr(str) {
    return str.replace(/[&<>"']/g, c => (
      { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
    ));
  }

  return { render, parseInline, escapeHtml, escapeAttr, isSafeLinkUrl, resolveImageSource };
})();
