import fs from 'node:fs';
import { loadConfig } from '../core/config.js';
import { requireVaultRoot } from '../core/vault.js';
import { listNotes } from '../core/note.js';
import {
  buildFactLedger,
  currentStateOf,
  factsFromNotes,
  type FactLedger,
} from '../core/facts.js';
import { writeFacts, type FactProposal } from '../core/fact-writer.js';
import { jsonSuccess } from '../core/json-output.js';

export interface FactsOptions {
  json?: boolean;
  /** Read proposals as JSON on stdin and commit the ones that pass the invariants. */
  write?: boolean;
  /** Plan the writes without creating anything. */
  dryRun?: boolean;
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
    // Facts are detected by the fields they declare, not by a note type, so the
    // guidance must not tell people to use a type that does not exist.
    console.log('A fact is any note whose frontmatter declares these fields:');
    console.log('  subject, relation, object, valid_from');
    console.log('plus optional valid_to, confidence and source_note.');
    console.log('');
    console.log('For example, in a note about Monka:');
    console.log('  subject: Monka');
    console.log('  relation: hosting');
    console.log('  object: Scaleway');
    console.log('  valid_from: 2026-06-01');
    console.log('');
    console.log('No new note type is required, so an existing vault needs no config change.');
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

/** Read proposal JSON from stdin, so an agent can pipe extraction output straight in. */
function readProposalsFromStdin(): FactProposal[] {
  let raw = '';
  try {
    raw = fs.readFileSync(0, 'utf-8');
  } catch {
    return [];
  }
  if (!raw.trim()) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    // Accept either a bare array or the shape `jev_facts.py facts` already emits.
    if (Array.isArray(parsed)) return parsed as FactProposal[];
    if (parsed && typeof parsed === 'object' && Array.isArray((parsed as { facts?: unknown[] }).facts)) {
      return (parsed as { facts: FactProposal[] }).facts;
    }
  } catch {
    return [];
  }
  return [];
}

export function factsCommand(options: FactsOptions): void {
  const vaultRoot = requireVaultRoot();
  const config = loadConfig(vaultRoot);

  // The autonomous path: turn proposals into fact notes, enforcing provenance,
  // idempotency and an audit trail, with no human in the loop.
  if (options.write || options.dryRun) {
    const proposals = readProposalsFromStdin();
    const result = writeFacts(vaultRoot, config, proposals, { apply: options.write === true && options.dryRun !== true });
    if (options.json) {
      console.log(jsonSuccess({
        applied: options.write === true && options.dryRun !== true,
        written: result.written,
        existing: result.existing,
        rejected: result.rejected.map(r => ({
          source: r.proposal.source,
          subject: r.proposal.subject,
          object: r.proposal.object,
          reason: r.reason,
        })),
        collisions: result.collisions,
        summary: {
          written: result.written.length,
          already_present: result.existing.length,
          rejected: result.rejected.length,
          collisions: result.collisions.length,
        },
      }));
      return;
    }
    if (result.written.length === 0 && result.rejected.length === 0 && result.existing.length === 0) {
      console.log('No proposals on stdin.');
      console.log('');
      console.log('Pipe extraction output in, for example:');
      console.log('  python3 skills/vault-garden/scripts/jev_facts.py facts <slug> | granite facts --write --json');
      return;
    }
    for (const slug of result.written) console.log(`  + ${slug}`);
    for (const slug of result.existing) console.log(`  = ${slug} (already recorded)`);
    if (result.collisions.length > 0) {
      // Surface the ambiguity rather than letting the ledger imply competing facts.
      console.log('Ambiguous — refused until the relation names what is measured:');
      for (const collision of result.collisions) {
        console.log(`  ${collision.subject} · ${collision.relation}`);
        console.log(`    distinct values: ${collision.objects.join(' / ')}`);
      }
    }
    for (const rejection of result.rejected) {
      if (rejection.reason.startsWith('ambiguous:')) continue;
      console.log(`  x ${rejection.proposal.source}: ${rejection.reason}`);
    }
    console.log('');
    console.log(
      `${result.written.length} written, ${result.existing.length} already present, ` +
      `${result.rejected.length} refused${options.write && !options.dryRun ? ' (see .granite/audit.jsonl)' : ' (dry run)'}`,
    );
    return;
  }

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
