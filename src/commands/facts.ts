import { loadConfig } from '../core/config.js';
import { requireVaultRoot } from '../core/vault.js';
import { listNotes } from '../core/note.js';
import {
  buildFactLedger,
  currentStateOf,
  factsFromNotes,
  type FactLedger,
} from '../core/facts.js';
import { jsonSuccess } from '../core/json-output.js';

export interface FactsOptions {
  json?: boolean;
  /** Only report contradictions. */
  contradictions?: boolean;
  /** Only report superseded facts. */
  superseded?: boolean;
  /** Ask for the current state of one subject. */
  subject?: string;
  relation?: string;
}

function renderLedger(ledger: FactLedger): void {
  const current = ledger.entries.filter(e => e.status === 'current');
  const superseded = ledger.entries.filter(e => e.status === 'superseded');
  const expired = ledger.entries.filter(e => e.status === 'expired');
  const future = ledger.entries.filter(e => e.status === 'future');

  if (current.length === 0 && ledger.entries.length === 0) {
    console.log('No facts yet.');
    console.log('');
    console.log('A fact is a note of type "fact" asserting subject / relation / object:');
    console.log('  granite new "Monka runs on Scaleway" --type fact');
    return;
  }

  if (current.length > 0) {
    console.log(`Current (${current.length}):`);
    for (const entry of current) {
      const f = entry.fact;
      console.log(`  ${f.subject} · ${f.relation} = ${f.object}`);
      console.log(`    since ${f.valid_from}${f.source ? `  · source ${f.source}` : ''}  (${f.slug})`);
    }
    console.log('');
  }

  if (ledger.contradictions.length > 0) {
    // Surfaced, never resolved: the note that disagrees is worth a human look.
    console.log(`Contradictions (${ledger.contradictions.length}) — not resolved automatically:`);
    for (const c of ledger.contradictions) {
      console.log(`  ${c.subject} · ${c.relation}`);
      for (const f of c.facts) {
        console.log(`    = ${f.object}  (from ${f.valid_from}, ${f.slug})`);
      }
    }
    console.log('');
  }

  if (superseded.length > 0) {
    console.log(`Superseded (${superseded.length}):`);
    for (const entry of superseded) {
      console.log(`  ${entry.fact.subject} · ${entry.fact.relation} = ${entry.fact.object}`);
      console.log(`    -> replaced by ${entry.superseded_by}`);
    }
    console.log('');
  }

  if (expired.length > 0) console.log(`Expired: ${expired.length}`);
  if (future.length > 0) console.log(`Future-dated: ${future.length}`);
  console.log(`${ledger.entries.length} fact(s) in the ledger.`);
}

export function factsCommand(options: FactsOptions): void {
  const vaultRoot = requireVaultRoot();
  const config = loadConfig(vaultRoot);

  // Any type that carries the fields can be a fact, but the built-in `fact` type
  // is the default. A vault with no facts is not an error.
  const notes = listNotes(vaultRoot, config);
  const facts = factsFromNotes(notes);
  const ledger = buildFactLedger(facts);

  if (options.subject) {
    const state = currentStateOf(ledger, options.subject, options.relation);
    if (options.json) {
      console.log(jsonSuccess({
        subject: options.subject,
        relation: options.relation ?? null,
        current: state,
      }));
      return;
    }
    if (state.length === 0) {
      console.log(`No current fact for "${options.subject}".`);
      console.log('');
      console.log('Either nothing is recorded yet, or every fact about it was retired.');
      console.log('Inspect the history: granite facts --superseded');
      return;
    }
    for (const f of state) {
      console.log(`${f.subject} · ${f.relation} = ${f.object}  (since ${f.valid_from})`);
    }
    return;
  }

  if (options.contradictions || options.superseded) {
    const filtered: FactLedger = options.contradictions
      ? { ...ledger, entries: [], current: [] }
      : { ...ledger, entries: ledger.entries.filter(e => e.status === 'superseded'), contradictions: [] };
    if (options.json) {
      console.log(jsonSuccess(options.contradictions ? { contradictions: ledger.contradictions } : { superseded: filtered.entries }));
      return;
    }
    renderLedger(options.contradictions ? { ...ledger, entries: ledger.entries } : filtered);
    return;
  }

  if (options.json) {
    console.log(jsonSuccess({
      total: ledger.entries.length,
      current: ledger.current,
      contradictions: ledger.contradictions,
      entries: ledger.entries.map(e => ({
        slug: e.fact.slug,
        subject: e.fact.subject,
        relation: e.fact.relation,
        object: e.fact.object,
        valid_from: e.fact.valid_from,
        valid_to: e.fact.valid_to ?? null,
        status: e.status,
        superseded_by: e.superseded_by ?? null,
        reason: e.reason,
      })),
    }));
    return;
  }

  renderLedger(ledger);
}
