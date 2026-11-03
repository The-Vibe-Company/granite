/**
 * Granite — Constellation Home
 *
 * Wires the WebGL graph engine (graph-engine.js) + Hono API to a
 * dark full-screen constellation with a floating paper reader.
 * All state lives in this IIFE.
 */
(function () {
  'use strict';

  const baseMeta = document.querySelector('meta[name="granite-base"]');
  const baseSegments = String(baseMeta?.content || '').split('/').filter(Boolean);
  const graniteBase = baseSegments.length ? '/' + baseSegments.join('/') : '';
  const hostedMode = graniteBase !== '';

  // ======================================================================
  //  Constants
  // ======================================================================

  const WORLD_W = 2400;
  const WORLD_H = 1800;
  const BRAND_CYCLE = [
    { hex: '#ba6844', soft: 'rgba(186,104,68,0.16)' }, // accent / terracotta
    { hex: '#2e6b5b', soft: 'rgba(46,107,91,0.18)'  }, // forest
    { hex: '#735bb0', soft: 'rgba(113,88,170,0.18)' }, // violet
    { hex: '#987b43', soft: 'rgba(152,123,67,0.18)' }, // gold
  ];
  const ALL_FILTER = { hex: 'rgba(255,236,220,0.6)', soft: 'rgba(255,236,220,0.12)' };

  // ======================================================================
  //  State
  // ======================================================================

  let sim = null;
  let renderer = null;
  let invalidateDraw = () => {}; // rebound once the graph boots
  let nodes = [];           // [{slug, title, type}]
  let links = [];           // [{source, target}]
  let byslug = {};          // slug -> node meta
  let adj = {};             // slug -> Set<slug>
  let types = [];           // ['note','source',...]
  let typeColor = {};       // type -> {hex, soft}
  let typeFilter = 'all';

  let activeSlug = null;
  let activeNote = null;    // full /api/notes/:slug payload
  let history = [];         // slug[]
  const noteCache = new Map(); // slug -> full note payload
  let sessionExpired = false;
  let readerWidth = null;
  let readerProgress = 0;
  let hoveredIdx = -1;

  const view = { tx: 0, ty: 0, k: 1 };

  // ======================================================================
  //  DOM refs
  // ======================================================================

  const $ = (id) => document.getElementById(id);
  const stage        = $('stage');
  const canvas       = $('graph-canvas');
  const labels       = $('graph-labels');
  const typeFilters  = $('type-filters');
  const subEl        = $('dirA-sub');
  const statNotes    = $('stat-notes');
  const statEdges    = $('stat-edges');
  const statCommunities = $('stat-communities');
  const statDensity  = $('stat-density');
  const zoomVal      = $('zoom-val');
  const emptyHint    = $('empty-hint');
  const reader       = $('reader');
  const readerBody   = $('reader-body');
  const readerBreadcrumb = $('reader-breadcrumb');
  const readerKicker = $('reader-kicker');
  const readerTitle  = $('reader-title');
  const readerDeck   = $('reader-deck');
  const readerMeta   = $('reader-metaline');
  const readerArticle= $('reader-article');
  const readerLinks  = $('reader-links');
  const readerProg   = $('reader-progress');
  const readerResizer = $('reader-resizer');
  const wlPreview    = $('wikilink-preview');
  const cmdOverlay   = $('command-bar-overlay');
  const cmdInput     = $('command-input');
  const cmdResults   = $('command-results');
  const cmdType      = $('command-type-filter');
  const cmdTag       = $('command-tag-filter');
  const logoutLink   = $('logout-link');

  // ======================================================================
  //  Utilities
  // ======================================================================

  function escapeHtml(s) {
    return String(s ?? '').replace(/[&<>"']/g, c => (
      { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
    ));
  }

  function formatDate(iso) {
    if (!iso) return '';
    const d = new Date(iso);
    if (isNaN(d.getTime())) return '';
    const months = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
    return `${months[d.getMonth()]} ${d.getDate()}, ${d.getFullYear()}`;
  }

  function wordCount(body) {
    return ((body || '').trim().match(/\S+/g) || []).length;
  }

  function readingTime(body) {
    return Math.max(1, Math.ceil(wordCount(body) / 220));
  }

  function normalizeList(value) {
    if (Array.isArray(value)) return value.filter(item => item != null).map(item => String(item));
    if (typeof value !== 'string' || value.trim() === '') return [];
    try {
      const parsed = JSON.parse(value);
      if (Array.isArray(parsed)) return parsed.filter(item => item != null).map(item => String(item));
    } catch {}
    return value.split(',').map(item => item.trim()).filter(Boolean);
  }

  function apiPath(path) {
    return graniteBase + (path.startsWith('/') ? path : '/' + path);
  }

  function expireHostedSession() {
    if (!hostedMode || sessionExpired) return;
    sessionExpired = true;
    noteCache.clear();
    nodes = []; links = []; byslug = {}; adj = {}; types = [];
    activeSlug = null; activeNote = null; history = [];
    sim = null; renderer = null;
    cmdItems = [];
    browseAllNotes = null;
    tagOptionsReady = false;
    cmdToken++;
    clearTimeout(cmdTimer);
    delete window.__granite;
    window.GRANITE_INSTANCE = null;
    // Replace the app synchronously so no private note or graph remains
    // visible while the browser navigates to the sign-in page.
    document.body.replaceChildren();
    const message = document.createElement('p');
    message.setAttribute('role', 'status');
    message.textContent = 'Your session expired. Redirecting to sign in…';
    document.body.appendChild(message);
    window.location.assign(apiPath('/login'));
  }

  // First paragraph-ish chunk, stripped of markdown noise, clipped to 160 chars.
  function deriveDeck(body) {
    if (!body) return '';
    const lines = body.split('\n');
    for (const raw of lines) {
      const line = raw.trim();
      if (!line) continue;
      if (line.startsWith('#')) continue;
      if (line.startsWith('>')) continue;
      if (line.startsWith('```')) continue;
      if (line.startsWith('|')) continue;
      const clean = line
        .replace(/`([^`]+)`/g, '$1')
        .replace(/\*\*([^*]+)\*\*/g, '$1')
        .replace(/\[\[([^\]|]+)(\|([^\]]+))?\]\]/g, (_, t, __, d) => d || t)
        .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1');
      if (clean.length < 12) continue;
      return clean.length > 160 ? clean.slice(0, 157).trimEnd() + '…' : clean;
    }
    return '';
  }

  function colorForType(t) {
    return typeColor[t] || BRAND_CYCLE[0];
  }

  // ======================================================================
  //  Boot
  // ======================================================================

  // ---- Instance selection (local vault vs deployed cloud instances) ------
  const INSTANCE_KEY = 'granite.instance';
  let currentInstance = hostedMode ? null : localStorage.getItem(INSTANCE_KEY);

  // All API calls go through this wrapper so the gateway knows which instance
  // to serve. <img> assets can't carry headers — see markdown-renderer.js.
  function apiFetch(url) {
    const headers = !hostedMode && currentInstance ? { 'X-Granite-Instance': currentInstance } : {};
    return fetch(apiPath(url), { headers }).then(res => {
      if (res.status === 401) expireHostedSession();
      return res;
    });
  }

  async function loadInstances() {
    if (hostedMode) {
      currentInstance = null;
      window.GRANITE_INSTANCE = null;
      if (logoutLink) {
        logoutLink.href = apiPath('/logout');
        logoutLink.hidden = false;
      }
      return;
    }
    const res = await fetch('/api/instances');
    const data = await res.json();
    const instances = data.instances || [];
    const known = new Set(instances.map(i => i.id));

    if (!currentInstance || !known.has(currentInstance)) {
      currentInstance = data.default || 'local';
      localStorage.removeItem(INSTANCE_KEY);
    }
    window.GRANITE_INSTANCE = currentInstance === 'local' ? null : currentInstance;

    const select = document.getElementById('instance-switcher');
    if (select && instances.length > 1) {
      select.innerHTML = '';
      for (const instance of instances) {
        const option = document.createElement('option');
        option.value = instance.id;
        option.textContent = instance.kind === 'cloud'
          ? `☁ ${instance.label}${instance.web_api ? '' : ' (outdated)'}`
          : instance.label;
        option.selected = instance.id === currentInstance;
        select.appendChild(option);
      }
      select.hidden = false;
      select.addEventListener('change', () => {
        localStorage.setItem(INSTANCE_KEY, select.value);
        location.reload();
      });
    }
  }

  async function boot() {
    try {
      try {
        await loadInstances();
      } catch (err) {
        console.error('[granite] instance discovery failed', err);
      }

      const [graphRes, typesRes] = await Promise.all([
        apiFetch('/api/graph').then(r => readApiResponse(r)),
        apiFetch('/api/types').then(r => readApiResponse(r)),
      ]);
      if (sessionExpired) return;

      nodes = graphRes.nodes || [];
      const rawEdges = graphRes.edges || [];
      const typesRaw = typesRes.types || [];
      types = window.GraniteTypeFilters.visibleTypeNames(typesRaw, nodes);
      populateTypeFilterOptions();

      // Map types → palette colors
      typeColor = {};
      types.forEach((t, i) => { typeColor[t] = BRAND_CYCLE[i % BRAND_CYCLE.length]; });

      // De-dup & canonicalise edges (undirected, no self-loops, both ends in nodes)
      const slugSet = new Set(nodes.map(n => n.slug));
      const linkSet = new Set();
      for (const e of rawEdges) {
        if (!e.source || !e.target) continue;
        if (e.source === e.target) continue;
        if (!slugSet.has(e.source) || !slugSet.has(e.target)) continue;
        const k = e.source < e.target ? e.source + '|' + e.target : e.target + '|' + e.source;
        linkSet.add(k);
      }
      links = [...linkSet].map(k => { const [s, t] = k.split('|'); return { source: s, target: t }; });

      byslug = Object.fromEntries(nodes.map(n => [n.slug, n]));
      adj = {};
      for (const n of nodes) adj[n.slug] = new Set();
      for (const l of links) { adj[l.source].add(l.target); adj[l.target].add(l.source); }

      renderFilters();
      renderStats();
      buildGraph();
      bindGlobalEvents();

      if (!nodes.length) {
        subEl.textContent = 'Your vault is empty. Create a note with `granite new` to light up the sky.';
      }
    } catch (err) {
      if (sessionExpired) return;
      console.error('[granite] boot failed', err);
      subEl.textContent = err && err.graniteMessage
        ? err.graniteMessage
        : 'Could not load the vault. Is the API running?';
    }
  }

  // Parse an API response; surface gateway errors (502/504 with a code) with
  // their human message so instance problems are actionable from the UI.
  async function readApiResponse(res) {
    if (sessionExpired) throw new Error('Hosted session expired');
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      const err = new Error(data.error || ('API error ' + res.status));
      if (data.code) err.graniteMessage = data.error;
      throw err;
    }
    return data;
  }

  // ======================================================================
  //  Filters + stats
  // ======================================================================

  function renderFilters() {
    const buttons = [{ k: 'all', label: 'All', c: ALL_FILTER.hex }];
    for (const t of Object.keys(typeColor)) buttons.push({ k: t, label: t, c: typeColor[t].hex });
    typeFilters.innerHTML = '';
    for (const f of buttons) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'dirA-filter' + (typeFilter === f.k ? ' active' : '');
      btn.style.setProperty('--tc', f.c);
      btn.dataset.k = f.k;
      btn.innerHTML = `<span class="dot" style="--tc:${f.c}"></span>${escapeHtml(f.label)}`;
      btn.addEventListener('click', () => setTypeFilter(f.k));
      typeFilters.appendChild(btn);
    }
  }

  function populateTypeFilterOptions() {
    if (!cmdType) return;
    const selected = cmdType.value;
    cmdType.replaceChildren(new Option('All types', ''));
    for (const type of types) cmdType.add(new Option(type, type));
    if (types.includes(selected)) cmdType.value = selected;
  }

  function setTypeFilter(k) {
    typeFilter = k;
    for (const btn of typeFilters.querySelectorAll('.dirA-filter')) {
      btn.classList.toggle('active', btn.dataset.k === k);
    }
    applyTypeFilter();
    lastLabelHtml = ''; // force label recompute
    // Invalidate the draw cache so shouldWork() lets the loop redraw.
    invalidateDraw();
  }

  // Node visibility follows the active type filter. Unmatched nodes fade way
  // down; the active note stays lit so you don't lose it when filtering.
  function applyTypeFilter() {
    if (!sim) return;
    if (typeFilter === 'all') {
      for (let i = 0; i < sim.n; i++) sim.alpha[i] = 1;
      return;
    }
    const activeIdx = activeSlug ? sim.idxOf[activeSlug] : -1;
    for (let i = 0; i < sim.n; i++) {
      const slug = sim.slugOf[i];
      const note = byslug[slug];
      if (!note) continue;
      if (note.type === typeFilter || i === activeIdx) sim.alpha[i] = 1;
      else sim.alpha[i] = 0.12;
    }
  }

  function renderStats() {
    statNotes.textContent = nodes.length;
    statEdges.textContent = links.length;
    statDensity.textContent = nodes.length ? (links.length / nodes.length).toFixed(1) : '0.0';
    // Communities filled in once sim exists
    if (sim) statCommunities.textContent = sim.K;
    subEl.textContent = `${nodes.length} notes · ${links.length} edges${sim ? ' · ' + sim.K + ' communities' : ''}, laid out in real time. Drag any star, hover to part the crowd, scroll to zoom deep.`;
  }

  // ======================================================================
  //  Graph engine + render loop
  // ======================================================================

  function buildGraph() {
    if (!nodes.length) return;

    sim = window.GraphEngine.createSimulation(nodes, links, WORLD_W, WORLD_H);
    renderer = window.GraphEngine.createRenderer(canvas, sim);
    window.__granite = { sim, renderer, view, nodes, links };
    statCommunities.textContent = sim.K;
    renderStats();

    // Pre-bake physics so the final layout is known immediately, then freeze
    // it. The arrival animation (started below) will reset alpha to 0 and
    // fade everything back in. If the animation fails to fire for any reason,
    // nodes stay visible (alpha defaults to 1), so the app never boots blank.
    sim.prebake(280);
    sim.freeze();

    new ResizeObserver(() => { renderer.resize(); if (!activeSlug) fitView(false); }).observe(stage);
    // Wait until the stage has real dimensions, then fit + launch the
    // arrival animation. First paint can report a 0×0 rect.
    function bootArrival(attempt = 0) {
      if (sessionExpired) return;
      const rect = stage.getBoundingClientRect();
      if (rect.width === 0 || rect.height === 0) {
        if (attempt > 30) return;
        return requestAnimationFrame(() => bootArrival(attempt + 1));
      }
      try {
        renderer.resize();
        fitView(true);
        startArrivalAnimation();
      } catch (e) { console.error('[granite] arrival boot failed', e); }
    }
    requestAnimationFrame(() => bootArrival(0));

    let phase = 0;
    // Snapshot of the last state we drew. When nothing interesting has
    // changed we skip the whole step/draw/labels work — important since
    // physics is frozen 99 % of the time.
    const lastDrawn = { k: NaN, tx: NaN, ty: NaN, active: null, hovered: -2, revealDone: false };
    invalidateDraw = () => { lastDrawn.k = NaN; lastDrawn.revealDone = false; };
    function shouldWork() {
      // Physics still moving?
      if (sim.cooling > 0) return true;
      if (sim.pinnedIdx >= 0) return true;
      // Arrival reveal still in flight?
      if (!lastDrawn.revealDone) {
        let allFull = true;
        for (let i = 0; i < sim.n; i++) if (sim.alpha[i] < 0.999) { allFull = false; break; }
        if (!allFull || sim.edgeAlpha < 0.999) return true;
        lastDrawn.revealDone = true;
      }
      // Anything changed since we last drew?
      if (view.k !== lastDrawn.k || view.tx !== lastDrawn.tx || view.ty !== lastDrawn.ty) return true;
      if (activeSlug !== lastDrawn.active) return true;
      if (hoveredIdx !== lastDrawn.hovered) return true;
      return false;
    }
    function loop() {
      if (sessionExpired) return;
      if (shouldWork()) {
        // Only run the simulation when positions can actually change —
        // pan/zoom triggers redraws but not a physics step.
        const physicsActive = sim.cooling > 0 || sim.pinnedIdx >= 0;
        const revealActive = !lastDrawn.revealDone;
        if (physicsActive || revealActive) sim.step(1 / 60);
        renderer.draw(phase);
        phase += 0.016;
        updateLabels();
        lastDrawn.k = view.k; lastDrawn.tx = view.tx; lastDrawn.ty = view.ty;
        lastDrawn.active = activeSlug; lastDrawn.hovered = hoveredIdx;
      }
      requestAnimationFrame(loop);
    }
    requestAnimationFrame(loop);
  }

  // =====================================================================
  //  Arrival animation — punches the camera in, reveals nodes in community
  //  waves ordered by degree, draws edges on top, then freezes physics.
  // =====================================================================

  function startArrivalAnimation() {
    if (!sim || !renderer) return;
    // Reset the reveal state here so the fallback (animation never runs)
    // leaves the graph visible.
    for (let i = 0; i < sim.n; i++) sim.alpha[i] = 0;
    sim.edgeAlpha = 0;
    const start = performance.now();
    const DUR_NODES = 1400;   // node reveal window
    const DUR_EDGES = 900;    // edges fade in during second half
    const DUR_ZOOM  = 1800;   // camera pullback from punched-in state
    const kFinal = view.k;
    const kStart = Math.min(1.2, kFinal * 1.45);
    // Start slightly zoomed-in on the bbox centre.
    const rect = stage.getBoundingClientRect();
    let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
    for (let i = 0; i < sim.n; i++) {
      const x = sim.x[i], y = sim.y[i];
      if (x < minX) minX = x; if (x > maxX) maxX = x;
      if (y < minY) minY = y; if (y > maxY) maxY = y;
    }
    const cx = (minX + maxX) / 2, cy = (minY + maxY) / 2;
    view.k = kStart;
    view.tx = rect.width / (2 * kStart) - cx;
    view.ty = rect.height / (2 * kStart) - cy;
    renderer.setView(view);

    // Assign a per-node reveal start time: earlier for higher-degree hubs,
    // staggered by community so each cluster lights up as a wave.
    const revealStart = new Float32Array(sim.n);
    const perCommunity = new Map(); // communityId → sorted member list
    for (let i = 0; i < sim.n; i++) {
      const c = sim.community[i];
      if (!perCommunity.has(c)) perCommunity.set(c, []);
      perCommunity.get(c).push(i);
    }
    const commOrder = [...perCommunity.keys()].sort((a, b) => perCommunity.get(b).length - perCommunity.get(a).length);
    const totalNodeReveal = DUR_NODES * 0.6; // window where staggers happen
    commOrder.forEach((c, ci) => {
      const members = perCommunity.get(c).sort((a, b) => sim.degree[b] - sim.degree[a]);
      const baseOffset = (ci / commOrder.length) * (totalNodeReveal * 0.6);
      members.forEach((i, mi) => {
        const spread = (mi / Math.max(1, members.length - 1)) * (totalNodeReveal * 0.4);
        revealStart[i] = baseOffset + spread;
      });
    });

    const ease = (t) => 1 - Math.pow(1 - t, 3); // easeOutCubic
    const easeInOut = (t) => t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;

    function step() {
      if (sessionExpired) return;
      const elapsed = performance.now() - start;

      // Node per-node fade-in
      const NODE_FADE = 520;
      for (let i = 0; i < sim.n; i++) {
        const localT = elapsed - revealStart[i];
        if (localT <= 0) { sim.alpha[i] = 0; continue; }
        const t = Math.min(1, localT / NODE_FADE);
        sim.alpha[i] = ease(t);
      }

      // Edges fade in during the second half
      const edgeT = Math.min(1, Math.max(0, (elapsed - (DUR_NODES - DUR_EDGES)) / DUR_EDGES));
      sim.edgeAlpha = ease(edgeT);

      // Camera pullback
      const zT = Math.min(1, elapsed / DUR_ZOOM);
      const ek = kStart + (kFinal - kStart) * easeInOut(zT);
      const txTarget = rect.width / (2 * ek) - cx;
      const tyTarget = rect.height / (2 * ek) - cy;
      view.k = ek; view.tx = txTarget; view.ty = tyTarget;
      renderer.setView(view);
      zoomVal.textContent = Math.round(ek * 100) + '%';

      if (elapsed < Math.max(DUR_NODES, DUR_ZOOM) + 60) {
        requestAnimationFrame(step);
      } else {
        // Hard-lock everything at the end state and freeze physics.
        for (let i = 0; i < sim.n; i++) sim.alpha[i] = 1;
        sim.edgeAlpha = 1;
        view.k = kFinal;
        view.tx = rect.width / (2 * kFinal) - cx;
        view.ty = rect.height / (2 * kFinal) - cy;
        renderer.setView(view);
        zoomVal.textContent = Math.round(kFinal * 100) + '%';
        sim.freeze();
      }
    }
    requestAnimationFrame(step);
  }

  function fitView(updateZoom = true) {
    const rect = stage.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0 || !sim) return;
    // Fit the actual node cloud, not the abstract world canvas. This keeps
    // the graph packed and avoids wasting half the screen on empty space.
    let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
    for (let i = 0; i < sim.n; i++) {
      const x = sim.x[i], y = sim.y[i], r = sim.radius[i];
      if (x - r < minX) minX = x - r; if (x + r > maxX) maxX = x + r;
      if (y - r < minY) minY = y - r; if (y + r > maxY) maxY = y + r;
    }
    if (!isFinite(minX)) return;
    const pad = 80;
    const w = Math.max(1, maxX - minX);
    const h = Math.max(1, maxY - minY);
    // Fit the full cloud. Allow lower zoom than the "nice" floor because a
    // graph that overflows the viewport feels worse than tiny nodes.
    const kRaw = Math.min((rect.width - pad * 2) / w, (rect.height - pad * 2) / h);
    const k = Math.max(0.22, Math.min(1.2, kRaw));
    const cx = (minX + maxX) / 2;
    const cy = (minY + maxY) / 2;
    const tx = rect.width / (2 * k) - cx;
    const ty = rect.height / (2 * k) - cy;
    view.tx = tx; view.ty = ty; view.k = k;
    renderer.setView(view);
    if (updateZoom) zoomVal.textContent = Math.round(k * 100) + '%';
  }

  // ======================================================================
  //  Label overlay
  // ======================================================================

  let lastLabelHtml = '';
  let labelFrame = 0;
  const labelShown = new Set();         // idx -> shown last frame
  const labelStreak = new Map();        // idx -> consecutive frames shown

  function updateLabels() {
    if (!sim) return;
    // Only recompute the set every 4 frames — kills most jitter without
    // feeling laggy. Positions still update inside the kept set on every frame.
    const recomputeSet = (labelFrame++ % 4) === 0;
    const rect = stage.getBoundingClientRect();
    const k = view.k;
    const n = sim.n;
    const hop1 = activeHops.hop1;

    let kept;

    if (recomputeSet) {
      const want = new Set();
      if (activeSlug != null) {
        const ai = sim.idxOf[activeSlug];
        if (ai != null) want.add(ai);
        for (const s of hop1) if (sim.idxOf[s] != null) want.add(sim.idxOf[s]);
      }
      if (hoveredIdx >= 0) want.add(hoveredIdx);

      const degThreshold = k < 0.3 ? 30 : k < 0.6 ? 14 : k < 1.0 ? 7 : 3;
      for (let i = 0; i < n; i++) {
        if (sim.degree[i] >= degThreshold) want.add(i);
      }
      // Hysteresis: anything already shown stays in contention so we don't
      // pop labels in and out every frame as nodes drift by a pixel.
      for (const i of labelShown) want.add(i);

      const items = [];
      for (const i of want) {
        if (i == null || i < 0) continue;
        const slug = sim.slugOf[i];
        const note = byslug[slug];
        if (!note) continue;
        if (typeFilter !== 'all' && note.type !== typeFilter && i !== sim.idxOf[activeSlug]) continue;
        const sx = (sim.x[i] + view.tx) * k;
        const sy = (sim.y[i] + view.ty) * k;
        if (sx < -60 || sx > rect.width + 60 || sy < -40 || sy > rect.height + 40) continue;
        items.push({ i, sx, sy, r: sim.radius[i] * k, title: note.title || slug });
      }

      const priority = (it) => {
        if (it.i === sim.idxOf[activeSlug]) return 10000;
        if (it.i === hoveredIdx) return 9000;
        if (hop1.has(sim.slugOf[it.i])) return 5000 + sim.degree[it.i];
        // Stickiness bonus for labels we already committed to.
        const stickBonus = labelShown.has(it.i) ? 2000 + Math.min(500, (labelStreak.get(it.i) || 0) * 20) : 0;
        return sim.degree[it.i] + stickBonus;
      };
      items.sort((a, b) => priority(b) - priority(a));

      const placed = [];
      const keptLocal = [];
      for (const it of items) {
        const approxW = Math.min(140, 6.5 * it.title.length + 10);
        const approxH = 16;
        const box = { x: it.sx - approxW / 2, y: it.sy + it.r + 4, w: approxW, h: approxH };
        let overlap = false;
        for (const p of placed) {
          if (box.x < p.x + p.w && box.x + box.w > p.x && box.y < p.y + p.h && box.y + box.h > p.y) { overlap = true; break; }
        }
        if (overlap) continue;
        placed.push(box);
        keptLocal.push({ ...it, box });
        if (keptLocal.length > 80) break;
      }
      kept = keptLocal;

      labelShown.clear();
      for (const it of kept) {
        labelShown.add(it.i);
        labelStreak.set(it.i, (labelStreak.get(it.i) || 0) + 1);
      }
      // Decay streaks for nodes we stopped showing.
      for (const [i] of labelStreak) if (!labelShown.has(i)) labelStreak.delete(i);
      lastKeptCache = kept;
    } else {
      // Reuse the committed set, just refresh screen positions.
      kept = [];
      for (const prev of lastKeptCache) {
        const i = prev.i;
        const slug = sim.slugOf[i];
        const note = byslug[slug];
        if (!note) continue;
        const sx = (sim.x[i] + view.tx) * k;
        const sy = (sim.y[i] + view.ty) * k;
        if (sx < -60 || sx > rect.width + 60 || sy < -40 || sy > rect.height + 40) continue;
        const title = note.title || slug;
        const approxW = Math.min(140, 6.5 * title.length + 10);
        const approxH = 16;
        kept.push({ i, sx, sy, r: sim.radius[i] * k, title, box: { x: sx - approxW / 2, y: sy + sim.radius[i] * k + 4, w: approxW, h: approxH } });
      }
    }

    let html = '';
    for (const it of kept) {
      const slug = sim.slugOf[it.i];
      const isActive = slug === activeSlug;
      const isHop1 = hop1.has(slug);
      const cls = isActive ? 'dirA-lbl active' : isHop1 ? 'dirA-lbl hop1' : 'dirA-lbl';
      html += `<div class="${cls}" style="left:${it.box.x.toFixed(1)}px;top:${it.box.y.toFixed(1)}px;width:${it.box.w.toFixed(0)}px">${escapeHtml(it.title)}</div>`;
    }
    if (html !== lastLabelHtml) {
      labels.innerHTML = html;
      lastLabelHtml = html;
    }
  }
  let lastKeptCache = [];

  // ======================================================================
  //  Hops (active + neighbours)
  // ======================================================================

  let activeHops = { hop1: new Set(), hop2: new Set() };

  function computeHops(slug) {
    const hop1 = new Set(adj[slug] || []);
    const hop2 = new Set();
    for (const n of hop1) {
      for (const m of (adj[n] || [])) {
        if (m !== slug && !hop1.has(m)) hop2.add(m);
      }
    }
    return { hop1, hop2 };
  }

  function pushHops() {
    if (!sim || !renderer) return;
    sim.setActive(activeSlug);
    renderer.setHops(activeHops);
  }

  // ======================================================================
  //  Stage interaction (pan / drag node / click / wheel)
  // ======================================================================

  let drag = null;

  stage.addEventListener('mousedown', (e) => {
    if (!sim) return;
    const rect = stage.getBoundingClientRect();
    const sx = e.clientX - rect.left, sy = e.clientY - rect.top;
    const wx = sx / view.k - view.tx;
    const wy = sy / view.k - view.ty;
    const hit = sim.pickNode(wx, wy, 14 / view.k);
    if (hit >= 0) {
      drag = { kind: 'node', idx: hit, moved: false, x0: e.clientX, y0: e.clientY };
    } else {
      drag = { kind: 'pan', x0: e.clientX, y0: e.clientY, tx: view.tx, ty: view.ty };
    }
  });

  window.addEventListener('mousemove', (e) => {
    if (!sim) return;
    const rect = stage.getBoundingClientRect();
    const sx = e.clientX - rect.left, sy = e.clientY - rect.top;
    if (sx < 0 || sy < 0 || sx > rect.width || sy > rect.height) {
      if (!drag) return;
    }
    const wx = sx / view.k - view.tx;
    const wy = sy / view.k - view.ty;

    // Hover never shoves nodes around — they should feel solid.
    sim.clearHover();

    if (!drag) {
      const hit = sim.pickNode(wx, wy, 14 / view.k);
      hoveredIdx = hit;
      renderer.setHovered(hit);
      stage.style.cursor = hit >= 0 ? 'pointer' : 'grab';
      return;
    }
    if (drag.kind === 'pan') {
      view.tx = drag.tx + (e.clientX - drag.x0) / view.k;
      view.ty = drag.ty + (e.clientY - drag.y0) / view.k;
      renderer.setView(view);
      stage.classList.add('dragging');
    } else if (drag.kind === 'node') {
      const dx = e.clientX - drag.x0, dy = e.clientY - drag.y0;
      if (!drag.moved && (dx * dx + dy * dy) > 9) drag.moved = true;
      if (drag.moved) {
        sim.pinnedIdx = drag.idx;
        sim.pinX = wx; sim.pinY = wy;
        sim.cooling = Math.max(sim.cooling, 0.8);
        stage.classList.add('dragging');
      }
    }
  });

  window.addEventListener('mouseup', () => {
    if (!sim) return;
    if (drag && drag.kind === 'node' && !drag.moved) {
      const slug = sim.slugOf[drag.idx];
      if (slug) {
        const note = byslug[slug];
        if (typeFilter === 'all' || !note || note.type === typeFilter) navigateTo(slug);
      }
    }
    sim.pinnedIdx = -1;
    drag = null;
    stage.classList.remove('dragging');
  });

  stage.addEventListener('mouseleave', () => {
    if (!sim) return;
    sim.clearHover();
    hoveredIdx = -1;
    renderer.setHovered(-1);
  });

  stage.addEventListener('wheel', (e) => {
    if (!sim) return;
    e.preventDefault();
    const rect = stage.getBoundingClientRect();
    const mx = e.clientX - rect.left, my = e.clientY - rect.top;
    const delta = -e.deltaY * 0.0015;
    const kNew = Math.max(0.15, Math.min(3, view.k * (1 + delta)));
    const wx = mx / view.k - view.tx;
    const wy = my / view.k - view.ty;
    view.k = kNew;
    view.tx = mx / kNew - wx;
    view.ty = my / kNew - wy;
    renderer.setView(view);
    zoomVal.textContent = Math.round(kNew * 100) + '%';
  }, { passive: false });

  // ======================================================================
  //  Zoom buttons
  // ======================================================================

  function zoomBy(factor) {
    if (!sim) return;
    const rect = stage.getBoundingClientRect();
    const mx = rect.width / 2, my = rect.height / 2;
    const kNew = Math.max(0.15, Math.min(3, view.k * factor));
    const wx = mx / view.k - view.tx;
    const wy = my / view.k - view.ty;
    view.k = kNew;
    view.tx = mx / kNew - wx;
    view.ty = my / kNew - wy;
    renderer.setView(view);
    zoomVal.textContent = Math.round(kNew * 100) + '%';
  }

  $('zoom-in').addEventListener('click', () => zoomBy(1.2));
  $('zoom-out').addEventListener('click', () => zoomBy(1 / 1.2));
  $('zoom-reset').addEventListener('click', () => fitView(true));

  // ======================================================================
  //  Reader
  // ======================================================================

  async function navigateTo(slug) {
    if (sessionExpired || !slug || !byslug[slug]) return;
    activeSlug = slug;
    activeHops = computeHops(slug);
    pushHops();
    history = history[history.length - 1] === slug ? history : [...history, slug].slice(-6);
    if (sim) sim.cooling = Math.min(1, sim.cooling + 0.15);
    hideWikilinkPreview();
    emptyHint.hidden = true;
    focusActive();

    try {
      const note = noteCache.get(slug) || await fetchNote(slug);
      // Ignore stale responses
      if (sessionExpired || activeSlug !== slug) return;
      activeNote = note;
      renderReader(note);
    } catch (err) {
      console.error('[granite] fetch note failed', slug, err);
    }
  }

  async function fetchNote(slug) {
    const res = await apiFetch('/api/notes/' + encodeURIComponent(slug));
    const note = await readApiResponse(res);
    if (sessionExpired) throw new Error('Hosted session expired');
    noteCache.set(slug, note);
    return note;
  }

  // Smooth-pan so the active node sits in the free area (space not covered
  // by the reader panel). Also nudges zoom in a bit when the view is wide.
  let focusTween = null;
  function focusActive() {
    if (!sim || !activeSlug) return;
    const idx = sim.idxOf[activeSlug];
    if (idx == null || idx < 0) return;
    const stageRect = stage.getBoundingClientRect();
    if (stageRect.width === 0) return;

    // Reader opens right after fetchNote resolves, so we anticipate its
    // width rather than depending on the current DOM state.
    const readerW = readerWidth ?? Math.min(900, window.innerWidth * 0.62);
    const readerGap = 24; // matches .dirA-reader right offset
    const freeRight = Math.max(280, stageRect.width - readerW - readerGap);
    const targetScreenX = freeRight / 2;
    const targetScreenY = stageRect.height / 2;

    const kTarget = Math.max(view.k, 0.55);
    const start = performance.now();
    const duration = 520;
    const tx0 = view.tx, ty0 = view.ty, k0 = view.k;
    if (focusTween) cancelAnimationFrame(focusTween);
    const ease = (t) => 1 - Math.pow(1 - t, 3); // easeOutCubic
    function step() {
      const t = Math.min(1, (performance.now() - start) / duration);
      const e = ease(t);
      // Recompute the target every frame so we track the node as physics
      // keeps nudging it and snap to the exact landing when t reaches 1.
      const nx = sim.x[idx], ny = sim.y[idx];
      const txTarget = targetScreenX / kTarget - nx;
      const tyTarget = targetScreenY / kTarget - ny;
      view.tx = tx0 + (txTarget - tx0) * e;
      view.ty = ty0 + (tyTarget - ty0) * e;
      view.k  = k0  + (kTarget  - k0 ) * e;
      renderer.setView(view);
      zoomVal.textContent = Math.round(view.k * 100) + '%';
      if (t < 1) {
        focusTween = requestAnimationFrame(step);
      } else {
        // Hard-lock at end so any late ResizeObserver refit doesn't linger.
        view.tx = txTarget;
        view.ty = tyTarget;
        view.k  = kTarget;
        renderer.setView(view);
        focusTween = null;
      }
    }
    focusTween = requestAnimationFrame(step);
  }

  function closeReader() {
    if (sessionExpired) return;
    activeSlug = null;
    activeNote = null;
    activeHops = { hop1: new Set(), hop2: new Set() };
    pushHops();
    reader.hidden = true;
    emptyHint.hidden = false;
    hideWikilinkPreview();
  }

  function renderReader(note) {
    if (sessionExpired) return;
    reader.hidden = false;
    const tc = colorForType(note.type);
    const words = wordCount(note.body);
    const mins = readingTime(note.body);
    const deck = deriveDeck(note.body);

    // Breadcrumb
    const crumbs = history.map(s => byslug[s]).filter(Boolean);
    readerBreadcrumb.innerHTML = '';
    const icon = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    icon.setAttribute('width', '12'); icon.setAttribute('height', '12');
    icon.setAttribute('viewBox', '0 0 24 24'); icon.setAttribute('fill', 'none');
    icon.setAttribute('stroke', 'currentColor'); icon.setAttribute('stroke-width', '1.5');
    icon.setAttribute('stroke-linecap', 'round'); icon.setAttribute('stroke-linejoin', 'round');
    icon.innerHTML = '<path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z"/><path d="M14 3v5h5"/>';
    readerBreadcrumb.appendChild(icon);
    crumbs.forEach((n, i) => {
      if (i > 0) {
        const sep = document.createElement('span');
        sep.className = 'sep'; sep.textContent = '›';
        readerBreadcrumb.appendChild(sep);
      }
      const span = document.createElement('span');
      span.className = 'crumb' + (i === crumbs.length - 1 ? ' current' : '');
      span.title = n.title || n.slug;
      span.textContent = n.title || n.slug;
      if (i !== crumbs.length - 1) span.addEventListener('click', () => navigateTo(n.slug));
      readerBreadcrumb.appendChild(span);
    });

    // Kicker
    const parts = [`<span class="dirA-reader-type" style="background:${tc.soft};color:${tc.hex}">${escapeHtml(note.type || 'note')}</span>`];
    if (note.modified) parts.push(`<span>${escapeHtml(formatDate(note.modified))}</span>`);
    parts.push(`<span>· ${mins} min read</span>`);
    parts.push(`<span>· ${words} words</span>`);
    readerKicker.innerHTML = parts.join('');

    // Title + deck
    readerTitle.textContent = note.title || note.slug;
    readerDeck.textContent = deck;

    // Keep protocol metadata visible beside the note body. Some vaults still
    // store array fields as JSON strings, so normalize those at the edge.
    const tags = normalizeList(note.tags);
    const aliases = normalizeList(note.aliases);
    const derivedFrom = normalizeList(note.derived_from);
    const metadata = [
      ['Slug', note.slug],
      ['Created', formatDate(note.created) || note.created],
      ['Modified', formatDate(note.modified) || note.modified],
      ['Type', note.type],
      ['Tags', tags.length ? tags.map(tag => '#' + tag).join(', ') : '—'],
      ['Aliases', aliases.length ? aliases.join(', ') : '—'],
      ['Status', note.status],
      ['Source', note.source],
      ['Review state', note.review_state],
      ['Durability', note.durability],
      ['Derived from', derivedFrom.length ? derivedFrom.join(', ') : '—'],
    ];
    const metaParts = metadata.map(([label, value]) => (
      `<span class="meta-field"><span class="meta-label">${escapeHtml(label)}</span><span>${escapeHtml(value || '—')}</span></span>`
    ));
    readerMeta.innerHTML = metaParts.join('');

    // Article body
    readerArticle.innerHTML = window.MarkdownRenderer.render(note.body || '', note.outgoing_links || []);

    // Links out + backlinks
    renderReaderLinks(note);

    // Reset scroll / progress
    readerBody.scrollTop = 0;
    readerProgress = 0;
    readerProg.style.width = '0%';
  }

  function renderReaderLinks(note) {
    const out = [];
    const outgoing = (note.outgoing_links || []).filter(l => l.resolved && l.resolved_slug);
    // Unique outgoing slugs
    const seen = new Set();
    const outSlugs = [];
    for (const l of outgoing) {
      if (l.resolved_slug === note.slug) continue;
      if (seen.has(l.resolved_slug)) continue;
      seen.add(l.resolved_slug); outSlugs.push(l.resolved_slug);
    }
    if (outSlugs.length) {
      out.push(`<div><div class="dirA-links-section-label">Links out <span class="count">${outSlugs.length}</span></div><div class="dirA-links-list">`);
      for (const slug of outSlugs) {
        const n = byslug[slug] || { title: slug, slug, type: 'note' };
        const tc = colorForType(n.type);
        out.push(`<button class="dirA-linkcard" data-nav="${escapeHtml(slug)}"><span class="dirA-linkcard-dot" style="background:${tc.hex}"></span><div><div class="dirA-linkcard-title">${escapeHtml(n.title || slug)}</div><div class="dirA-linkcard-deck">${escapeHtml(n.deck || '')}</div></div><span class="dirA-linkcard-arrow">→</span></button>`);
      }
      out.push(`</div></div>`);
    }

    const back = note.backlinks || [];
    if (back.length) {
      // De-dup backlinks by source_slug so multiple contexts from the same note collapse.
      const seenBack = new Set();
      const backRows = [];
      for (const b of back) {
        const slug = b.source_slug || b.slug;
        if (!slug || seenBack.has(slug)) continue;
        seenBack.add(slug);
        const node = byslug[slug];
        const title = node?.title || b.source_title || slug;
        const type = node?.type || 'note';
        backRows.push({ slug, title, type, context: b.context || '' });
      }
      out.push(`<div><div class="dirA-links-section-label">Backlinks <span class="count">${backRows.length}</span></div><div class="dirA-links-list">`);
      for (const r of backRows) {
        const tc = colorForType(r.type);
        out.push(`<button class="dirA-linkcard" data-nav="${escapeHtml(r.slug)}"><span class="dirA-linkcard-dot" style="background:${tc.hex}"></span><div><div class="dirA-linkcard-title">${escapeHtml(r.title)}</div><div class="dirA-linkcard-deck">${escapeHtml(r.context)}</div></div><span class="dirA-linkcard-arrow">←</span></button>`);
      }
      out.push(`</div></div>`);
    }
    readerLinks.innerHTML = out.join('');
  }

  readerLinks.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-nav]');
    if (btn) navigateTo(btn.getAttribute('data-nav'));
  });

  readerBody.addEventListener('scroll', () => {
    const max = readerBody.scrollHeight - readerBody.clientHeight;
    readerProgress = max > 0 ? Math.min(1, readerBody.scrollTop / max) : 0;
    readerProg.style.width = (readerProgress * 100) + '%';
  });

  // Reader resize handle
  readerResizer.addEventListener('mousedown', (e) => {
    e.preventDefault();
    reader.classList.add('resizing');
    const startX = e.clientX;
    const startW = readerWidth ?? Math.min(900, window.innerWidth * 0.62);
    function onMove(ev) {
      const delta = startX - ev.clientX;
      const w = Math.max(480, Math.min(window.innerWidth - 80, startW + delta));
      readerWidth = w;
      reader.style.setProperty('--reader-w', w + 'px');
    }
    function onUp() {
      reader.classList.remove('resizing');
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
    }
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
  });

  $('reader-close').addEventListener('click', closeReader);
  $('reader-prev').addEventListener('click', () => cycleNeighbour(-1));
  $('reader-next').addEventListener('click', () => cycleNeighbour(1));

  function cycleNeighbour(dir) {
    if (!activeSlug) {
      // Pick first node with highest degree
      if (!sim) return;
      let best = 0;
      for (let i = 1; i < sim.n; i++) if (sim.degree[i] > sim.degree[best]) best = i;
      const s = sim.slugOf[best];
      if (s) navigateTo(s);
      return;
    }
    const order = [activeSlug, ...activeHops.hop1].filter(s => byslug[s]);
    if (order.length < 2) return;
    const i = order.indexOf(activeSlug);
    const next = order[((i + dir) % order.length + order.length) % order.length];
    if (next) navigateTo(next);
  }

  // ======================================================================
  //  Wikilink clicks + hover preview inside the reader article
  // ======================================================================

  readerArticle.addEventListener('click', (e) => {
    const a = e.target.closest('a.wikilink');
    if (!a) return;
    e.preventDefault();
    const slug = a.getAttribute('data-slug');
    if (slug) navigateTo(slug);
  });

  let hoverFetchToken = 0;
  readerArticle.addEventListener('mouseover', async (e) => {
    const a = e.target.closest('a.wikilink');
    if (!a) return;
    const slug = a.getAttribute('data-slug');
    if (!slug) return;
    const rect = a.getBoundingClientRect();
    const token = ++hoverFetchToken;
    try {
      const note = noteCache.get(slug) || await fetchNote(slug);
      if (token !== hoverFetchToken) return;
      // Confirm still hovering (cheap: a is still in DOM and matches)
      if (!document.contains(a)) return;
      showWikilinkPreview(note, rect);
    } catch {}
  });
  readerArticle.addEventListener('mouseout', (e) => {
    const a = e.target.closest('a.wikilink');
    if (!a) return;
    hoverFetchToken++;
    hideWikilinkPreview();
  });

  function showWikilinkPreview(note, anchorRect) {
    const tc = colorForType(note.type);
    const deck = deriveDeck(note.body);
    const words = wordCount(note.body);
    const mins = readingTime(note.body);
    wlPreview.innerHTML = `
      <div class="wl-preview-header">
        <span class="wl-preview-type" style="background:${tc.soft};color:${tc.hex}">${escapeHtml(note.type || 'note')}</span>
        <span class="wl-preview-meta">${mins}min · ${words} words</span>
      </div>
      <div class="wl-preview-title">${escapeHtml(note.title || note.slug)}</div>
      <div class="wl-preview-snippet">${escapeHtml(deck)}</div>
      <div class="wl-preview-footer"><span class="wl-preview-slug">${escapeHtml(note.slug)}</span></div>
    `;
    wlPreview.hidden = false;
    const w = 340;
    let top = anchorRect.bottom + 10;
    let left = anchorRect.left - 20;
    if (top + 240 > window.innerHeight) top = anchorRect.top - 240;
    if (left + w + 12 > window.innerWidth) left = window.innerWidth - w - 12;
    if (left < 12) left = 12;
    wlPreview.style.top = top + 'px';
    wlPreview.style.left = left + 'px';
  }
  function hideWikilinkPreview() { wlPreview.hidden = true; wlPreview.innerHTML = ''; }

  // ======================================================================
  //  ⌘K command palette
  // ======================================================================

  $('search-trigger').addEventListener('click', openCommandBar);

  function openCommandBar() {
    if (sessionExpired) return;
    cmdOverlay.classList.remove('hidden');
    cmdInput.value = '';
    cmdType.value = '';
    cmdTag.value = '';
    cmdResults.innerHTML = '<div class="command-empty">Loading notes…</div>';
    cmdInput.setAttribute('aria-expanded', 'true');
    cmdInput.focus();
    executeCommandQuery();
  }
  function closeCommandBar() {
    cmdToken++;
    clearTimeout(cmdTimer);
    cmdOverlay.classList.add('hidden');
    cmdInput.blur();
    cmdInput.setAttribute('aria-expanded', 'false');
    cmdInput.removeAttribute('aria-activedescendant');
  }
  cmdOverlay.addEventListener('click', (e) => {
    if (e.target === cmdOverlay) closeCommandBar();
  });

  let cmdToken = 0;
  let cmdTimer = null;
  let cmdIndex = 0;
  let cmdItems = [];
  let browseAllNotes = null;
  let tagOptionsReady = false;

  function populateTagFilterOptions(notes) {
    if (tagOptionsReady) return;
    const tags = new Set();
    for (const note of notes) for (const tag of normalizeList(note.tags)) tags.add(tag);
    const selected = cmdTag.value;
    cmdTag.replaceChildren(new Option('All tags', ''));
    for (const tag of [...tags].sort((a, b) => a.localeCompare(b))) cmdTag.add(new Option(tag, tag));
    if (tags.has(selected)) cmdTag.value = selected;
    tagOptionsReady = true;
  }

  async function executeCommandQuery() {
    if (sessionExpired) return;
    const token = ++cmdToken;
    const q = cmdInput.value.trim();
    const type = cmdType.value;
    const tag = cmdTag.value;
    if (!q && !type && !tag && browseAllNotes) {
      renderCommandResults(browseAllNotes);
      return;
    }

    const params = new URLSearchParams();
    if (q) params.set('q', q);
    if (type) params.set('type', type);
    if (tag) params.set('tag', tag);
    const route = q ? '/api/search' : '/api/notes';
    cmdInput.removeAttribute('aria-activedescendant');
    cmdResults.innerHTML = `<div class="command-empty">${q ? 'Searching…' : 'Loading notes…'}</div>`;

    try {
      const query = params.toString();
      const res = await apiFetch(route + (query ? '?' + query : ''));
      const data = await readApiResponse(res);
      if (sessionExpired || token !== cmdToken) return;
      if (!q && !type && !tag) {
        browseAllNotes = data.notes || [];
        populateTagFilterOptions(browseAllNotes);
      }
      const rows = q ? (data.results || []) : (data.notes || []);
      renderCommandResults(filterCommandResults(rows, type, tag));
    } catch (err) {
      if (sessionExpired || token !== cmdToken) return;
      console.error('[granite] browse/search failed', err);
      cmdItems = [];
      cmdIndex = -1;
      cmdResults.innerHTML = '<div class="command-empty command-error">Could not load notes. Try again.</div>';
    }
  }

  cmdInput.addEventListener('input', () => {
    cmdToken++;
    clearTimeout(cmdTimer);
    cmdTimer = setTimeout(executeCommandQuery, cmdInput.value.trim() ? 120 : 0);
  });
  cmdType.addEventListener('change', executeCommandQuery);
  cmdTag.addEventListener('change', executeCommandQuery);

  function filterCommandResults(results, type, tag) {
    if (!type && !tag) return results;
    const tagsBySlug = new Map((browseAllNotes || []).map(note => [note.slug, normalizeList(note.tags)]));
    return results.filter(note => {
      if (type && window.GraniteTypeFilters.noteType(note, byslug) !== type) return false;
      if (tag) {
        const tags = note.tags == null ? (tagsBySlug.get(note.slug) || []) : normalizeList(note.tags);
        if (!tags.includes(tag)) return false;
      }
      return true;
    });
  }

  function renderCommandResults(results) {
    cmdItems = results;
    cmdIndex = 0;
    if (!results.length) {
      cmdIndex = -1;
      cmdInput.removeAttribute('aria-activedescendant');
      const emptyMessage = !nodes.length
        ? 'No notes in this vault yet.'
        : cmdInput.value.trim() ? 'No matches.' : 'No notes match these filters.';
      cmdResults.innerHTML = `<div class="command-empty">${emptyMessage}</div>`;
      return;
    }
    cmdResults.innerHTML = results.map((r, i) => {
      const type = window.GraniteTypeFilters.noteType(r, byslug);
      const tc = colorForType(type);
      const tags = normalizeList(r.tags);
      const secondary = tags.length ? tags.map(tag => '#' + tag).join(' · ') : r.slug;
      return `<button class="command-result${i === 0 ? ' active' : ''}" id="command-result-${i}" type="button" role="option" aria-selected="${i === 0}" tabindex="-1" data-idx="${i}" data-slug="${escapeHtml(r.slug)}">
        <span class="command-result-dot" style="background:${tc.hex}"></span>
        <div class="command-result-body">
          <div class="command-result-title">${escapeHtml(r.title || r.slug)}</div>
          <div class="command-result-slug">${escapeHtml(secondary)}</div>
        </div>
        <span class="command-result-type" title="${escapeHtml(type)}" style="background:${tc.soft};color:${tc.hex}">${escapeHtml(type)}</span>
      </button>`;
    }).join('');
    cmdInput.setAttribute('aria-activedescendant', 'command-result-0');
  }

  cmdResults.addEventListener('click', (e) => {
    const el = e.target.closest('.command-result');
    if (!el) return;
    const slug = el.getAttribute('data-slug');
    if (slug) { closeCommandBar(); navigateTo(slug); }
  });

  cmdInput.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') { e.preventDefault(); closeCommandBar(); return; }
    if (e.key === 'ArrowDown') { e.preventDefault(); cmdIndex = Math.min(cmdItems.length - 1, cmdIndex + 1); updateCmdActive(); return; }
    if (e.key === 'ArrowUp')   { e.preventDefault(); cmdIndex = Math.max(0, cmdIndex - 1); updateCmdActive(); return; }
    if (e.key === 'Enter')     {
      e.preventDefault();
      const r = cmdItems[cmdIndex];
      if (r) { closeCommandBar(); navigateTo(r.slug); }
    }
  });

  function updateCmdActive() {
    const els = cmdResults.querySelectorAll('.command-result');
    els.forEach((el, i) => {
      el.classList.toggle('active', i === cmdIndex);
      el.setAttribute('aria-selected', String(i === cmdIndex));
    });
    const el = els[cmdIndex];
    if (el) {
      cmdInput.setAttribute('aria-activedescendant', el.id);
      el.scrollIntoView({ block: 'nearest' });
    } else {
      cmdInput.removeAttribute('aria-activedescendant');
    }
  }

  // ======================================================================
  //  Global keyboard
  // ======================================================================

  function bindGlobalEvents() {
    window.addEventListener('keydown', (e) => {
      const tag = (e.target && e.target.tagName) || '';
      const inField = tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || tag === 'BUTTON';
      const isMeta = e.metaKey || e.ctrlKey;

      if (isMeta && (e.key === 'k' || e.key === 'K')) {
        e.preventDefault();
        if (cmdOverlay.classList.contains('hidden')) openCommandBar();
        else closeCommandBar();
        return;
      }
      if (e.key === 'Escape') {
        if (!cmdOverlay.classList.contains('hidden')) { closeCommandBar(); return; }
        if (activeSlug) { closeReader(); return; }
        return;
      }
      if (inField) return;

      if (e.key === 'ArrowLeft' || e.key === 'k') { e.preventDefault(); cycleNeighbour(-1); return; }
      if (e.key === 'ArrowRight' || e.key === 'j') { e.preventDefault(); cycleNeighbour(1); return; }
    });

    // Close preview when scrolling anywhere
    window.addEventListener('scroll', hideWikilinkPreview, true);
  }

  // ======================================================================
  //  Go
  // ======================================================================

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }
})();
