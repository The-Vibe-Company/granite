import { loadConfig } from '../core/config.js';
import { requireVaultRoot } from '../core/vault.js';
import { ensureIndex } from '../core/index-db.js';
import { searchNotes } from '../core/search.js';
import { jsonSuccess } from '../core/json-output.js';

export function searchCommand(
  query: string,
  options: { json?: boolean; limit?: number; candidates?: number },
): void {
  const vaultRoot = requireVaultRoot();
  const config = loadConfig(vaultRoot);
  const db = ensureIndex(vaultRoot, config);

  const results = searchNotes(db, query, {
    limit: options.limit ?? 20,
    candidateLimit: options.candidates,
  });
  db.close();

  if (options.json) {
    console.log(jsonSuccess(results));
    return;
  }

  if (results.length === 0) {
    console.log('No results found.');
    console.log('');
    console.log(`Nothing in the vault matches "${query}". Capture it: granite add "${query}"`);
    return;
  }

  for (const r of results) {
    console.log(`  ${r.title} (${r.slug})`);
    console.log(`    ${r.snippet}`);
    console.log('');
  }

  console.log(`${results.length} result(s) for "${query}"`);
  console.log('');
  console.log(`Dive deeper: granite show ${results[0].slug} | granite backlinks ${results[0].slug}`);
}
