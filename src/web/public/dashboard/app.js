/**
 * Granite — hosted dashboard (/ui)
 *
 * A read-only reader for one vault: a table of contents (newest first) with
 * full-text search and type/tag filters, and a reader for one note with its
 * links and backlinks. Every request is a same-origin GET under /ui/api; the
 * state lives in the URL (?q=&type=&tag=&note=) so Back, reload and links work.
 */

// Pure text helpers: everything that turns note content into HTML outside the
// markdown renderer goes through escapeHtml. Kept DOM-free so it is unit-tested.
window.GraniteDashboardText = (() => {
  'use strict';

  function escapeHtml(value) {
    return String(value ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
  }

  function plural(n, word) { return `${n} ${n === 1 ? word : /(s|sh|ch|x)$/.test(word) ? `${word}es` : `${word}s`}`; }

  // Search snippets mark hits with >>> and <<<; escape first, then mark.
  function snippetHtml(snippet) {
    const plain = String(snippet || '')
      .replace(/\[\[([^\]|]+)\|?([^\]]*)\]\]/g, (_, t, d) => d || t)
      .replace(/!\[([^\]]*)\]\([^)]*\)?/g, '$1')    // images: keep the alt text
      .replace(/\[([^\]]+)\]\([^)]*\)?/g, '$1')     // links: keep the label
      .replace(/\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)*\|?/g, ' ') // table rules
      .replace(/\s*\|\s*/g, ' · ')               // table cells
      .replace(/(?:\s*·\s*){2,}/g, ' · ')
      .replace(/^\s*·\s*/, '')
      .replace(/(^|\s)>\s+/g, '$1')              // blockquotes
      .replace(/(^|\s)#{1,6}\s+/g, '$1')        // heading markers
      .replace(/\*\*|__|`/g, '')                // bold and code markers
      .replace(/(^|\s)[-*+]\s+/g, '$1')         // list bullets
      .replace(/\s{2,}/g, ' ')
      .replace(/\s*·\s*$/, '')
      .trim();
    return escapeHtml(plain)
      .replace(/&gt;&gt;&gt;/g, '<mark>').replace(/&lt;&lt;&lt;/g, '</mark>');
  }

  function cleanContext(context) {
    return String(context || '').trim().replace(/^(?:[-*+]|\d+\.|#{1,6}|>)\s+/, '').replace(/\*\*|__|`/g, '').replace(/\[\[([^\]|]+)\|?([^\]]*)\]\]/g, (_, t, d) => `\u0000${d || t}\u0001`);
  }

  return { escapeHtml, plural, snippetHtml, cleanContext };
})();

(function () {
  'use strict';
  if (typeof document === 'undefined' || !document.getElementById('results')) return;
  const { escapeHtml, plural, snippetHtml, cleanContext } = window.GraniteDashboardText;

  const baseMeta = document.querySelector('meta[name="granite-base"]');
  const base = '/' + String(baseMeta?.content || '/ui').split('/').filter(Boolean).join('/');
  const renderer = window.MarkdownRenderer;
  const typeFilters = window.GraniteTypeFilters;

  const $ = (id) => document.getElementById(id);
  const el = {
    body: document.body,
    q: $('q'), form: $('search-form'), sub: $('toc-sub'),
    types: $('type-filters'), tags: $('tag-filters'), tagDetails: $('tag-details'), tagCurrent: $('tag-current'),
    count: $('count'), results: $('results'),
    reader: $('reader'), back: $('back'), backKept: $('back-kept'),
    noteType: $('note-type'), noteTitle: $('note-title'), noteDates: $('note-dates'), noteTags: $('note-tags'),
    noteBody: $('note-body'), endnotes: $('endnotes'),
    outLinks: $('out-links'), outCount: $('out-count'), backLinks: $('back-links'), backCount: $('back-count'),
    navContents: $('nav-contents'), navSearch: $('nav-search'),
    noteSkeleton: $('note-skeleton'), noteContent: $('note-content'),
  };

  let state = readUrl();
  // Lay the page out for the note before anything loads, so nothing moves later.
  if (state.note) { el.body.classList.add('reading'); el.reader.hidden = false; }
  let notes = [];            // [{slug,title,type,created,modified,tags}]
  let bySlug = new Map();
  let bySlugObject = {};
  let typeNames = [];
  let tagNames = [];
  let loaded = false;
  let searchToken = 0;
  let searchTimer = 0;
  let noteToken = 0;
  let expired = false;
  const noteCache = new Map();

  // ---------------------------------------------------------------- utilities


  function tagsOf(note) {
    if (Array.isArray(note?.tags)) return note.tags.filter((t) => typeof t === 'string' && t);
    if (typeof note?.tags === 'string') {
      try { const parsed = JSON.parse(note.tags); if (Array.isArray(parsed)) return parsed.filter((t) => typeof t === 'string' && t); } catch { /* plain string */ }
      return note.tags ? [note.tags] : [];
    }
    return [];
  }

  const DAY = 86400000;
  function startOfDay(d) { const x = new Date(d); x.setHours(0, 0, 0, 0); return x.getTime(); }
  function relativeDate(iso) {
    const d = new Date(iso);
    if (!iso || Number.isNaN(d.getTime())) return '';
    const days = Math.round((startOfDay(Date.now()) - startOfDay(d)) / DAY);
    if (days <= 0) return 'today';
    if (days === 1) return 'yesterday';
    if (days < 7) return `${days} days ago`;
    return longDate(iso);
  }
  function longDate(iso) {
    const d = new Date(iso);
    if (!iso || Number.isNaN(d.getTime())) return '';
    const sameYear = d.getFullYear() === new Date().getFullYear();
    return d.toLocaleDateString('en', sameYear ? { month: 'short', day: 'numeric' } : { month: 'short', day: 'numeric', year: 'numeric' });
  }
  function isThisWeek(iso) {
    const d = new Date(iso);
    return !Number.isNaN(d.getTime()) && startOfDay(Date.now()) - startOfDay(d) < 7 * DAY;
  }



  function typeBadge(type) {
    const known = ['note', 'source', 'synthesis', 'output'].includes(type) ? ` t-${type}` : '';
    return `<span class="type${known}">${escapeHtml(type)}</span>`;
  }

  // ---------------------------------------------------------------- URL state

  function readUrl() {
    const p = new URLSearchParams(window.location.search);
    return { q: p.get('q') || '', type: p.get('type') || '', tag: p.get('tag') || '', note: p.get('note') || '' };
  }
  function urlFor(next) {
    const p = new URLSearchParams();
    for (const key of ['q', 'type', 'tag', 'note']) if (next[key]) p.set(key, next[key]);
    const qs = p.toString();
    return base + (qs ? `?${qs}` : '');
  }
  function go(patch, { replace = false, focus = null } = {}) {
    const next = { ...state, ...patch };
    const url = urlFor(next);
    if (url !== window.location.pathname + window.location.search) {
      window.history[replace ? 'replaceState' : 'pushState'](null, '', url);
    }
    const listChanged = next.q !== state.q || next.type !== state.type || next.tag !== state.tag;
    const noteChanged = next.note !== state.note;
    const previousNote = state.note;
    state = next;
    if (listChanged) renderList();
    else markActive();
    if (noteChanged || !next.note) renderReader({ focus, previousNote });
    renderChrome();
  }

  // ---------------------------------------------------------------- network

  function expireSession() {
    if (expired) return;
    expired = true;
    noteCache.clear();
    notes = []; bySlug = new Map();
    // Replace the page synchronously so no private note stays on screen.
    document.body.replaceChildren();
    const message = document.createElement('p');
    message.className = 'noscript';
    message.setAttribute('role', 'status');
    message.textContent = 'Your session expired. Redirecting to sign in…';
    document.body.appendChild(message);
    window.location.assign(base + '/login');
  }

  async function api(path) {
    const res = await fetch(base + path, { headers: { Accept: 'application/json' }, credentials: 'same-origin' });
    if (res.status === 401) { expireSession(); throw new Error('expired'); }
    if (res.status === 404) return null;
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return res.json();
  }

  // ---------------------------------------------------------------- filters

  function renderFilters() {
    const searching = Boolean(state.q);
    const pool = notes.filter((n) => !state.tag || tagsOf(n).includes(state.tag));
    const counts = new Map();
    for (const n of pool) counts.set(n.type, (counts.get(n.type) || 0) + 1);
    const typeOption = (value, label, n) => {
      const pressed = (state.type || '') === value;
      const zero = !searching && n === 0 && !pressed;
      return `<li><button type="button" class="opt${zero ? ' zero' : ''}" data-type="${escapeHtml(value)}" aria-pressed="${pressed}">${escapeHtml(label)}${searching ? '' : `<span class="n">${n}</span>`}</button></li>`;
    };
    el.types.innerHTML = typeOption('', 'All', pool.length) + typeNames.map((t) => typeOption(t, t, counts.get(t) || 0)).join('');

    el.tags.innerHTML = tagNames.map((t) => `<li><button type="button" class="opt" data-tag="${escapeHtml(t)}" aria-pressed="${state.tag === t}">${escapeHtml(t)}</button></li>`).join('')
      || '<li class="none">No tags in this vault yet.</li>';
    el.tagCurrent.textContent = state.tag ? `· ${state.tag}` : '· any';
  }

  function filterChips() {
    const chip = (key, label, value) => `<button type="button" class="chip" data-clear="${key}" aria-label="Remove ${label} ${escapeHtml(value)}"><span>${escapeHtml(value)}</span><svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" aria-hidden="true"><path d="m4 4 6 6M10 4l-6 6"/></svg></button>`;
    const chips = [];
    if (state.q) chips.push(chip('q', 'search', `“${state.q}”`));
    if (state.type) chips.push(chip('type', 'type', state.type));
    if (state.tag) chips.push(chip('tag', 'tag', state.tag));
    return chips;
  }

  function renderCount(n, noun = 'note') {
    const chips = filterChips();
    el.count.innerHTML = `<strong>${plural(n, noun)}</strong>${chips.join('')}${chips.length ? '<button type="button" class="clear" data-clear="all">Clear all</button>' : ''}`;
  }

  // ---------------------------------------------------------------- list

  function entryHtml(note, { snippet = null } = {}) {
    const meta = bySlug.get(note.slug) || note;
    const tags = tagsOf(meta);
    const date = relativeDate(meta.modified);
    const current = state.note === note.slug ? ' aria-current="page"' : '';
    return `<li><a class="entry" href="${escapeHtml(urlFor({ ...state, note: note.slug }))}" data-note="${escapeHtml(note.slug)}"${current}>
      <span class="line"><span class="t">${escapeHtml(note.title || note.slug)}</span><span class="leader" aria-hidden="true"></span>${date ? `<span class="d">${escapeHtml(date)}</span>` : ''}</span>
      <span class="meta">${typeBadge(typeFilters.noteType(note, bySlugObject))}${tags.length ? `<span class="tg">${tags.map(escapeHtml).join(' · ')}</span>` : ''}</span>
      ${snippet !== null ? `<span class="snip">${snippetHtml(snippet)}</span>` : ''}
    </a></li>`;
  }

  function emptyHtml() {
    const what = state.q ? `Nothing in the vault matches “${escapeHtml(state.q)}”` : 'No note has this type and tag';
    return `<div class="empty" role="status">
      <h2>No notes here</h2>
      <p>${what}${state.q && (state.type || state.tag) ? ' with these filters' : ''}. Try fewer filters, or another word.</p>
      <button type="button" class="btn" data-clear="all">Clear search and filters</button>
    </div>`;
  }

  function errorHtml() {
    return `<div class="empty" role="alert">
      <h2>The vault did not answer</h2>
      <p>Your notes could not be loaded. Check the connection, then try again.</p>
      <button type="button" class="btn" data-retry>Try again</button>
    </div>`;
  }

  async function renderList() {
    if (!loaded) return;
    renderFilters();
    el.q.value === state.q || document.activeElement === el.q || (el.q.value = state.q);
    if (state.q) return runSearch();
    searchToken++;
    const list = notes.filter((n) => (!state.type || n.type === state.type) && (!state.tag || tagsOf(n).includes(state.tag)));
    el.sub.textContent = 'Newest first, by last change';
    renderCount(list.length);
    el.results.setAttribute('aria-busy', 'false');
    if (!list.length) { el.results.innerHTML = emptyHtml(); return; }
    const recent = list.filter((n) => isThisWeek(n.modified));
    const earlier = list.filter((n) => !isThisWeek(n.modified));
    const part = (label, items) => items.length ? `<h2 class="part">${label}</h2><ul class="toc">${items.map((n) => entryHtml(n)).join('')}</ul>` : '';
    el.results.innerHTML = part('This week', recent) + part(recent.length ? 'Earlier' : 'All notes', earlier);
  }

  function runSearch() {
    const token = ++searchToken;
    clearTimeout(searchTimer);
    el.results.setAttribute('aria-busy', 'true');
    searchTimer = setTimeout(async () => {
      const params = new URLSearchParams({ q: state.q });
      if (state.type) params.set('type', state.type);
      if (state.tag) params.set('tag', state.tag);
      try {
        const data = await api(`/api/search?${params}`);
        if (token !== searchToken) return;
        const results = data?.results || [];
        el.sub.textContent = 'Best matches first';
        renderCount(results.length, 'match');
        el.results.setAttribute('aria-busy', 'false');
        el.results.innerHTML = results.length
          ? `<ul class="toc">${results.map((r) => entryHtml(r, { snippet: r.snippet })).join('')}</ul>`
          : emptyHtml();
      } catch (err) {
        if (token !== searchToken || expired) return;
        el.results.setAttribute('aria-busy', 'false');
        el.results.innerHTML = errorHtml();
      }
    }, 160);
  }

  function markActive() {
    for (const a of el.results.querySelectorAll('a.entry')) {
      if (a.dataset.note === state.note) a.setAttribute('aria-current', 'page');
      else a.removeAttribute('aria-current');
      a.href = urlFor({ ...state, note: a.dataset.note });
    }
  }

  // ---------------------------------------------------------------- reader

  function wordStats(body) {
    const words = String(body || '').replace(/```[\s\S]*?```/g, ' ').split(/\s+/).filter(Boolean).length;
    return `${plural(words, 'word')} · ${Math.max(1, Math.round(words / 220))} min read`;
  }

  function linkTitle(slug, fallback) { return bySlug.get(slug)?.title || fallback || slug; }


  function renderNote(note) {
    document.title = `${note.title || note.slug} · Granite`;
    const known = ['note', 'source', 'synthesis', 'output'].includes(note.type) ? ` t-${note.type}` : '';
    el.noteType.className = `type${known}`;
    el.noteType.textContent = note.type || '';
    el.noteType.hidden = !note.type;
    el.noteTitle.textContent = note.title || note.slug;
    const dates = [];
    if (note.modified) dates.push(`<li>Modified <b>${escapeHtml(relativeDate(note.modified))}</b></li>`);
    if (note.created) dates.push(`<li>Created <b>${escapeHtml(longDate(note.created))}</b></li>`);
    dates.push(`<li>${escapeHtml(wordStats(note.body))}</li>`);
    el.noteDates.innerHTML = dates.join('');
    const tags = tagsOf(note);
    el.noteTags.hidden = !tags.length;
    el.noteTags.innerHTML = tags.map((t) => `<li><a class="opt" href="${escapeHtml(urlFor({ q: '', type: '', tag: t, note: '' }))}" data-tag-link="${escapeHtml(t)}">${escapeHtml(t)}</a></li>`).join('');

    el.noteBody.innerHTML = renderer.render(note.body || '', note.outgoing_links || []);
    for (const a of el.noteBody.querySelectorAll('a.wikilink[data-slug]')) {
      a.href = urlFor({ ...state, note: a.dataset.slug });
      a.dataset.note = a.dataset.slug;
      a.removeAttribute('role');
    }
    for (const table of el.noteBody.querySelectorAll('.md-table-wrap')) {
      table.tabIndex = 0;
      table.setAttribute('role', 'region');
      table.setAttribute('aria-label', 'Table');
    }

    const seen = new Set();
    const outgoing = [];
    for (const link of note.outgoing_links || []) {
      const key = link.resolved ? link.resolved_slug : `?${link.target}`;
      if (seen.has(key)) continue;
      seen.add(key);
      outgoing.push(link);
    }
    el.outCount.textContent = String(outgoing.length);
    el.outLinks.innerHTML = outgoing.length ? outgoing.map((link, i) => {
      if (!link.resolved) {
        return `<li><span class="dead"><span class="num">${i + 1}</span><span class="t">${escapeHtml(link.display || link.target)}</span><span class="ty">not in the vault</span></span></li>`;
      }
      const target = bySlug.get(link.resolved_slug);
      return `<li><a href="${escapeHtml(urlFor({ ...state, note: link.resolved_slug }))}" data-note="${escapeHtml(link.resolved_slug)}"><span class="num">${i + 1}</span><span class="t">${escapeHtml(linkTitle(link.resolved_slug, link.display))}</span><span class="ty">${escapeHtml(target?.type || '')}</span></a></li>`;
    }).join('') : '<li class="none">This note links to no other note.</li>';

    const backlinks = note.backlinks || [];
    el.backCount.textContent = String(backlinks.length);
    el.backLinks.innerHTML = backlinks.length ? backlinks.map((b) => {
      const context = escapeHtml(cleanContext(b.context)).replace(/\u0000/g, '<b>').replace(/\u0001/g, '</b>');
      return `<li><a href="${escapeHtml(urlFor({ ...state, note: b.source_slug }))}" data-note="${escapeHtml(b.source_slug)}"><span class="t">${escapeHtml(b.source_title || b.source_slug)}</span>${context ? `<q>${context}</q>` : ''}</a></li>`;
    }).join('') : '<li class="none">No note links here yet.</li>';
    el.endnotes.hidden = false;
  }

  function renderMissing(slug) {
    document.title = 'Note not found · Granite';
    el.noteType.textContent = '';
    el.noteType.className = 'type';
    el.noteType.hidden = true;
    el.noteTitle.textContent = 'This note is not in the vault';
    el.noteDates.innerHTML = '';
    el.noteTags.innerHTML = '';
    el.noteBody.innerHTML = `<p>No note has the address “${escapeHtml(slug)}”. It may have been renamed or archived.</p>`;
    el.endnotes.hidden = true;
  }

  async function renderReader({ focus = null, previousNote = '' } = {}) {
    const slug = state.note;
    el.body.classList.toggle('reading', Boolean(slug));
    if (!slug) {
      el.reader.hidden = true;
      document.title = 'Contents · Granite';
      if (focus === 'list' && previousNote) {
        const entry = el.results.querySelector(`a.entry[data-note="${CSS.escape(previousNote)}"]`);
        (entry || el.q).focus({ preventScroll: false });
      }
      return;
    }
    const token = ++noteToken;
    el.reader.hidden = false;
    el.reader.setAttribute('aria-busy', 'true');
    el.noteType.hidden = false;
    if (!noteCache.has(slug)) { el.noteContent.hidden = true; el.noteSkeleton.hidden = false; }
    try {
      const note = noteCache.get(slug) ?? await api(`/api/notes/${encodeURIComponent(slug)}`);
      if (token !== noteToken) return;
      if (note) { noteCache.set(slug, note); renderNote(note); } else renderMissing(slug);
    } catch (err) {
      if (token !== noteToken || expired) return;
      el.noteTitle.textContent = 'The note did not load';
      el.noteBody.innerHTML = '<p>Check the connection, then open it again from the contents.</p>';
      el.noteDates.innerHTML = ''; el.noteTags.innerHTML = ''; el.endnotes.hidden = true;
    }
    el.noteSkeleton.hidden = true;
    el.noteContent.hidden = false;
    el.reader.setAttribute('aria-busy', 'false');
    if (focus === 'note') {
      el.reader.scrollIntoView({ block: 'start' });
      window.scrollTo({ top: 0 });
      el.noteTitle.focus({ preventScroll: true });
    }
  }

  function renderChrome() {
    const kept = [state.q && `“${state.q}”`, state.type, state.tag].filter(Boolean);
    el.backKept.textContent = kept.length ? `· ${kept.join(' · ')}` : '';
    el.back.href = urlFor({ ...state, note: '' });
    el.navContents.href = urlFor({ ...state, note: '' });
    const current = state.note ? '' : state.q ? 'search' : 'contents';
    for (const [name, link] of [['contents', el.navContents], ['search', el.navSearch]]) {
      if (current === name) link.setAttribute('aria-current', 'page');
      else link.removeAttribute('aria-current');
    }
  }

  // ---------------------------------------------------------------- events

  function plainClick(event) {
    return event.button === 0 && !event.metaKey && !event.ctrlKey && !event.shiftKey && !event.altKey;
  }

  document.addEventListener('click', (event) => {
    const target = event.target instanceof Element ? event.target : null;
    if (!target) return;

    const link = target.closest('a[data-note]');
    if (link && plainClick(event)) {
      event.preventDefault();
      go({ note: link.dataset.note }, { focus: 'note' });
      return;
    }
    const tagLink = target.closest('a[data-tag-link]');
    if (tagLink && plainClick(event)) {
      event.preventDefault();
      go({ q: '', type: '', tag: tagLink.dataset.tagLink, note: '' }, { focus: 'list' });
      return;
    }
    if (target.closest('#back, #nav-contents, .brand') && plainClick(event)) {
      event.preventDefault();
      go({ note: '' }, { focus: 'list' });
      return;
    }
    if (target.closest('#nav-search') && plainClick(event)) {
      event.preventDefault();
      if (state.note) go({ note: '' });
      el.q.focus();
      el.q.select();
      return;
    }
    const typeBtn = target.closest('button[data-type]');
    if (typeBtn) { go({ type: typeBtn.dataset.type }); return; }
    const tagBtn = target.closest('button[data-tag]');
    if (tagBtn) { go({ tag: state.tag === tagBtn.dataset.tag ? '' : tagBtn.dataset.tag }); return; }
    const clear = target.closest('[data-clear]');
    if (clear) {
      const key = clear.dataset.clear;
      if (key === 'all') { el.q.value = ''; go({ q: '', type: '', tag: '' }); el.q.focus(); }
      else { if (key === 'q') el.q.value = ''; go({ [key]: '' }); el.q.focus(); }
      return;
    }
    if (target.closest('[data-retry]')) { boot(); }
  });

  el.form.addEventListener('submit', (event) => {
    event.preventDefault();
    go({ q: el.q.value.trim(), note: '' });
  });
  el.q.addEventListener('input', () => {
    go({ q: el.q.value.trim() }, { replace: true });
  });
  el.q.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && el.q.value) { event.preventDefault(); el.q.value = ''; go({ q: '' }, { replace: true }); }
  });

  document.addEventListener('keydown', (event) => {
    if (event.key !== '/' || event.metaKey || event.ctrlKey || event.altKey) return;
    const active = document.activeElement;
    if (active && (active.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(active.tagName))) return;
    event.preventDefault();
    el.q.focus();
    el.q.select();
  });

  window.addEventListener('popstate', () => {
    const previous = state;
    state = readUrl();
    el.q.value = state.q;
    if (previous.q !== state.q || previous.type !== state.type || previous.tag !== state.tag) renderList();
    else markActive();
    renderReader({ previousNote: previous.note });
    renderChrome();
  });

  // ---------------------------------------------------------------- boot

  async function boot() {
    el.results.setAttribute('aria-busy', 'true');
    try {
      const [typesPayload, notesPayload] = await Promise.all([api('/api/types'), api('/api/notes')]);
      notes = (notesPayload?.notes || []).map((n) => ({ ...n, tags: tagsOf(n) }));
      bySlug = new Map(notes.map((n) => [n.slug, n]));
      bySlugObject = Object.fromEntries(bySlug);
      typeNames = typeFilters.visibleTypeNames(typesPayload?.types || {}, notes);
      const tagCounts = new Map();
      for (const n of notes) for (const t of n.tags) tagCounts.set(t, (tagCounts.get(t) || 0) + 1);
      tagNames = [...tagCounts.keys()].sort((a, b) => tagCounts.get(b) - tagCounts.get(a) || a.localeCompare(b));
      loaded = true;
      el.q.value = state.q;
      renderList();
      renderReader();
      renderChrome();
    } catch (err) {
      if (expired) return;
      el.results.setAttribute('aria-busy', 'false');
      el.count.textContent = '';
      el.results.innerHTML = errorHtml();
    }
  }

  boot();
  if (window.location.hash === '#q') el.q.focus();
})();
