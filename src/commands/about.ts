import { loadConfig } from '../core/config.js';
import { requireVaultRoot } from '../core/vault.js';
import { ensureIndex } from '../core/index-db.js';
import { aboutEntity, type EntityReference } from '../core/about.js';
import { jsonSuccess, jsonError } from '../core/json-output.js';

export interface AboutOptions {
  json?: boolean;
  /** Only show notes that link to the entity. */
  incoming?: boolean;
  /** Only show notes the entity links to. */
  outgoing?: boolean;
  /** Restrict the view to these note types. */
  types?: string[];
}

function renderGroup(label: string, grouped: Record<string, EntityReference[]>): void {
  const total = Object.values(grouped).reduce((n, list) => n + list.length, 0);
  if (total === 0) return;
  console.log(`${label} (${total})`);
  // Largest groups first: the type with most references is usually the useful one.
  for (const type of Object.keys(grouped).sort((a, b) => grouped[b].length - grouped[a].length)) {
    console.log(`  ${type} — ${grouped[type].length}`);
    for (const ref of grouped[type]) {
      console.log(`    ${ref.title}`);
      for (const context of ref.contexts) console.log(`      ↳ ${context}`);
    }
  }
  console.log('');
}

export function aboutCommand(slug: string, options: AboutOptions): void {
  const vaultRoot = requireVaultRoot();
  const config = loadConfig(vaultRoot);
  const db = ensureIndex(vaultRoot, config);

  try {
    const found = aboutEntity(db, slug);
    if (!found) {
      if (options.json) console.log(jsonError(`Note not found: ${slug}`));
      else console.error(`Note not found: "${slug}"`);
      process.exit(1);
    }

    const filterTypes = (g: Record<string, EntityReference[]>) =>
      options.types && options.types.length > 0
        ? Object.fromEntries(Object.entries(g).filter(([type]) => options.types!.includes(type)))
        : g;

    // The counts describe what is about to be rendered, so they are taken from the
    // filtered groups. Reporting the unfiltered totals printed "3 note(s) link here"
    // directly above a two-note group.
    const countRefs = (g: Record<string, EntityReference[]>) =>
      Object.values(g).reduce((total, list) => total + list.length, 0);
    const incoming = filterTypes(found.incoming);
    const outgoing = filterTypes(found.outgoing);

    const payload = {
      ...found,
      incoming,
      outgoing,
      counts: { incoming: countRefs(incoming), outgoing: countRefs(outgoing) },
    };

    if (options.json) {
      console.log(jsonSuccess(payload));
      return;
    }

    console.log(`About ${found.title}  (${found.type}, ${found.status})`);
    console.log('');
    if (payload.counts.incoming + payload.counts.outgoing === 0) {
      console.log('Nothing links to this note and it links to nothing.');
      console.log('That is worth knowing: no other note leads here.');
      return;
    }
    console.log(`${payload.counts.incoming} note(s) link here · it links to ${payload.counts.outgoing}`);
    console.log('');

    // Asking for both sections is the default, not a request to render neither. The
    // previous guards (`if (!outgoing)` / `if (!incoming)`) suppressed both when both
    // flags were passed, so the only combination that showed nothing was "show both".
    const showIncoming = options.incoming || !options.outgoing;
    const showOutgoing = options.outgoing || !options.incoming;
    if (showIncoming) renderGroup('Referenced by', payload.incoming);
    if (showOutgoing) renderGroup('References', payload.outgoing);
  } finally {
    db.close();
  }
}
