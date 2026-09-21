import { loadConfig } from '../core/config.js';
import { requireVaultRoot } from '../core/vault.js';
import { ensureIndex } from '../core/index-db.js';
import { entityPool } from '../core/about.js';
import { jsonSuccess, jsonError } from '../core/json-output.js';

export interface PoolOptions {
  json?: boolean;
  depth?: number;
  limit?: number;
  sentences?: number;
}

/**
 * Emit the bounded candidate set a judge should decide on.
 *
 * This command exists so the deterministic and the semantic halves of retrieval stay
 * separable: Granite decides *what is worth judging* (free, testable, no network), and a
 * companion may decide *which candidate answers the question*. Without this, every caller
 * re-implements the graph walk — which is how a lexical pre-rank crept into the first
 * prototype and silently dropped the note that held the answer.
 */
export function poolCommand(anchor: string, options: PoolOptions): void {
  const vaultRoot = requireVaultRoot();
  const config = loadConfig(vaultRoot);
  const db = ensureIndex(vaultRoot, config);

  try {
    const pool = entityPool(db, anchor, {
      depth: options.depth,
      limit: options.limit,
      sentences: options.sentences,
    });
    if (!pool) {
      if (options.json) console.log(jsonError(`Note not found: ${anchor}`));
      else console.error(`Note not found: "${anchor}"`);
      process.exit(1);
    }

    if (options.json) {
      console.log(jsonSuccess(pool));
      return;
    }

    console.log(`Pool around ${pool.anchor_title}  (${pool.reachable} reachable)`);
    console.log('');
    if (pool.candidates.length === 0) {
      console.log('Nothing is reachable from this note. There is no candidate set to judge.');
      return;
    }
    for (const candidate of pool.candidates) {
      console.log(`  [${candidate.distance}] ${candidate.title}  (${candidate.type})`);
      for (const sentence of candidate.sentences) console.log(`        · ${sentence}`);
    }
    console.log('');
    console.log(`${pool.candidates.length} candidate(s) of ${pool.reachable} reachable.`);
    console.log('Nothing is judged here: this is the set a judge would decide on.');
  } finally {
    db.close();
  }
}
