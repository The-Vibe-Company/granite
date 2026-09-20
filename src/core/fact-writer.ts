import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { GraniteConfig, NoteFrontmatter } from './types.js';
import { serializeFrontmatter } from './frontmatter.js';
import { getGraniteDir } from './vault.js';

/**
 * Autonomously commit accepted fact proposals into the vault.
 *
 * This is what lets Jev *decide* instead of merely advising. Three invariants make
 * that safe, and they are enforced here rather than requested in a prompt, because
 * measurement says a model cannot be trusted with them:
 *
 * 1. **No provenance, no write.** A fact without a source note and a verbatim span
 *    is refused, and the asserted object must actually appear inside the span, so a
 *    value cannot be laundered through a real-looking quote. Write-gate validation
 *    is a documented blind spot in every memory architecture surveyed.
 * 2. **Deterministic slugs.** The slug is derived from the fact's identity plus its
 *    source, so applying the same proposal twice is a no-op rather than a
 *    duplicate. Idempotency is what makes re-running a pipeline safe.
 * 3. **Additive and reversible.** The write path never retires an existing fact: a
 *    newer fact wins under the ledger's recency rule and the older one stays in
 *    history. Every write appends an event to `.granite/audit.jsonl`.
 *
 * Automatic retirement is deliberately absent. It was measured wrong on 70% of
 * facts across two independent corpora, so retiring stays a human or agent action
 * through the ledger, not something this pipeline does on its own.
 */

export interface FactProposal {
  /** The note this fact was extracted from. */
  source: string;
  /** Verbatim text from the source note. Required as evidence. */
  span: string;
  subject: string;
  relation: string;
  object: string;
  valid_from: string;
  valid_to?: string;
  /** Model confidence in [0,1], recorded for audit and future calibration. */
  confidence?: number;
  /** What produced the proposal, e.g. the model id. */
  proposed_by?: string;
}

export interface RejectedProposal {
  proposal: FactProposal;
  reason: string;
}

export interface FactWriteResult {
  written: string[];
  existing: string[];
  rejected: RejectedProposal[];
}

function fold(value: string): string {
  return value
    .normalize('NFD')
    .replace(/\p{M}+/gu, '')
    .toLowerCase();
}

function slugPart(value: string): string {
  return fold(value)
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40);
}

/** Keep the human-readable title clean without changing its meaning. */
function tidy(value: string): string {
  return value
    .normalize('NFD')
    .replace(/\p{M}+/gu, m => m)
    .replace(/[^\p{L}\p{N}\s.,'&()/-]+/gu, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 80);
}

/**
 * Derive a stable slug from the fact's identity plus its source.
 *
 * Two identical facts from two different notes stay separate, because they are
 * independent pieces of evidence; the same fact re-extracted from the same note is
 * one note.
 */
export function factSlug(proposal: FactProposal): string {
  return [
    slugPart(proposal.subject),
    slugPart(proposal.relation),
    slugPart(proposal.object),
    proposal.valid_from.slice(0, 10),
    slugPart(proposal.source),
  ]
    .filter(Boolean)
    .join('--')
    .slice(0, 180);
}

function isIsoDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}/.test(value)) return false;
  return !Number.isNaN(Date.parse(value));
}

/** Returns a reason when the proposal must not be written. */
export function rejectionReason(proposal: FactProposal): string | undefined {
  if (!proposal.source?.trim()) return 'no source note';
  if (!proposal.span?.trim()) return 'no verbatim span, so the claim is not traceable';
  if (!proposal.subject?.trim()) return 'no subject';
  if (!proposal.relation?.trim()) return 'no relation';
  if (!proposal.object?.trim()) return 'no object';
  if (!isIsoDate(proposal.valid_from)) return `valid_from is not an ISO date: ${proposal.valid_from}`;
  if (proposal.valid_to && !isIsoDate(proposal.valid_to)) {
    return `valid_to is not an ISO date: ${proposal.valid_to}`;
  }
  const haystack = fold(proposal.span);
  const needle = fold(proposal.object).trim();
  if (needle.length >= 3 && !haystack.includes(needle)) {
    return `object does not appear in the span (object=${proposal.object})`;
  }
  return undefined;
}

export function auditLogPath(vaultRoot: string): string {
  return path.join(getGraniteDir(vaultRoot), 'audit.jsonl');
}

/** Append one JSON line per run. Append-only, so a run can be reconstructed. */
export function appendAuditEvent(vaultRoot: string, event: Record<string, unknown>): void {
  try {
    const target = auditLogPath(vaultRoot);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.appendFileSync(
      target,
      `${JSON.stringify({ at: new Date().toISOString(), ...event })}\n`,
      'utf-8',
    );
  } catch {
    // An unwritable audit log must not lose the fact that was already written;
    // the note itself carries the provenance.
  }
}

export interface WriteFactsOptions {
  /** false plans the writes and creates nothing. */
  apply?: boolean;
  /** Current time, injectable so tests are deterministic. */
  now?: Date;
}

/**
 * Write accepted proposals as fact notes.
 *
 * Detected by fields rather than by a type name, which is how the ledger works, so
 * `type` is `note`: no new note type and no config change are required, and an
 * existing vault is unaffected.
 */
export function writeFacts(
  vaultRoot: string,
  config: GraniteConfig,
  proposals: FactProposal[],
  options: WriteFactsOptions = {},
): FactWriteResult {
  const apply = options.apply ?? false;
  const now = options.now ?? new Date();
  const iso = now.toISOString();
  const folder = path.join(vaultRoot, config.note_types.note.folder);
  const result: FactWriteResult = { written: [], existing: [], rejected: [] };
  const inserted: string[] = [];

  for (const proposal of proposals) {
    // Deduplicate within the batch as well as against disk.
    if (result.written.includes(factSlug(proposal))) {
      result.existing.push(factSlug(proposal));
      continue;
    }
    const reason = rejectionReason(proposal);
    if (reason) {
      result.rejected.push({ proposal, reason });
      continue;
    }

    const slug = factSlug(proposal);
    const filepath = path.join(folder, `${slug}.md`);
    if (fs.existsSync(filepath)) {
      result.existing.push(slug);
      continue;
    }

    if (!apply) {
      result.written.push(slug);
      continue;
    }

    const frontmatter: NoteFrontmatter = {
      // Deterministic id, so re-creating the same fact yields the same note.
      id: crypto.createHash('sha256').update(slug).digest('hex').slice(0, 32),
      title: `${tidy(proposal.subject)} ${tidy(proposal.relation)} — ${tidy(proposal.object)}`.slice(0, 160),
      type: config.defaults.note_type,
      created: iso,
      modified: iso,
      tags: [],
      aliases: [],
      status: 'active',
      source: 'agent',
      review_state: 'draft',
      durability: 'canonical',
      derived_from: [proposal.source],
      subject: proposal.subject,
      relation: proposal.relation,
      object: proposal.object,
      valid_from: proposal.valid_from,
      ...(proposal.valid_to ? { valid_to: proposal.valid_to } : {}),
      ...(proposal.confidence !== undefined ? { confidence: proposal.confidence } : {}),
      source_note: `[[${proposal.source}]]`,
      claim_span: proposal.span.trim(),
      ...(proposal.proposed_by ? { proposed_by: proposal.proposed_by } : {}),
    };

    const body = [
      '## Claim',
      '',
      proposal.span.trim(),
      '',
      '## Basis',
      '',
      `Extracted from [[${proposal.source}]].`,
      proposal.proposed_by ? `Proposed by \`${proposal.proposed_by}\`.` : '',
      '',
    ]
      .filter(line => line !== '')
      .join('\n');

    fs.mkdirSync(folder, { recursive: true });
    fs.writeFileSync(filepath, serializeFrontmatter(frontmatter, body), 'utf-8');
    inserted.push(slug);
    result.written.push(slug);
  }

  if (apply && (inserted.length > 0 || result.rejected.length > 0)) {
    appendAuditEvent(vaultRoot, {
      action: 'facts.write',
      inserted,
      rejected: result.rejected.map(r => ({
        source: r.proposal.source,
        subject: r.proposal.subject,
        reason: r.reason,
      })),
    });
  }

  return result;
}
