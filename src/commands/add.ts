import fs from 'node:fs';
import { loadConfig } from '../core/config.js';
import { requireVaultRoot } from '../core/vault.js';
import { syncVaultIndexAfterNoteWrite } from '../core/index-db.js';
import { createNote } from '../core/note.js';
import { jsonSuccess } from '../core/json-output.js';
import { recommendNote, formatRecommendations } from '../core/recommendations.js';
import { ensureIndex } from '../core/index-db.js';
import { proposeLinksAtCapture } from '../mcp/link-capture.js';

export async function addNote(text?: string, options: { json?: boolean } = {}): Promise<void> {
  const vaultRoot = requireVaultRoot();
  const config = loadConfig(vaultRoot);
  const typeName = config.defaults.note_type;

  let content = '';

  if (text) {
    content = text;
  } else if (!process.stdin.isTTY) {
    // Read from stdin (pipe)
    content = fs.readFileSync(0, 'utf-8').trim();
  } else {
    console.error('Usage: granite add "some text" or echo "text" | granite add');
    process.exit(1);
  }

  if (!content) {
    console.error('No content provided.');
    process.exit(1);
  }

  // Auto-generate title from content
  const firstLine = content.split('\n')[0];
  const title = firstLine.length > 60 ? firstLine.slice(0, 60).trim() + '...' : firstLine;

  const note = createNote(vaultRoot, config, typeName, title, content + '\n');
  syncVaultIndexAfterNoteWrite(vaultRoot, config, note, { rebuild: true });
  const recommendations = recommendNote(vaultRoot, config, note, { strategy: 'incremental' });

  // Jev runs at capture: linking as a periodic pass never happens for the notes that need it.
  // It proposes and never writes, and a failed judgment leaves the capture intact.
  const db = ensureIndex(vaultRoot, config);
  const proposed = await proposeLinksAtCapture(db, {
    slug: note.slug,
    title: String(note.frontmatter.title ?? note.slug),
    body: content,
  });
  db.close();

  if (options.json) {
    console.log(jsonSuccess({
      slug: note.slug,
      title: note.frontmatter.title,
      type: typeName,
      filepath: note.filepath,
      recommendations,
      proposed_links: proposed ?? null,
    }));
    return;
  }

  console.log(note.filepath);

  const recommendationLines = formatRecommendations(recommendations);
  if (recommendationLines.length > 0) {
    console.log('');
    console.log('Recommendations:');
    for (const line of recommendationLines) {
      console.log(line);
    }
  }

  console.log('');
  console.log(`Captured as "${note.frontmatter.title}" (${note.slug})`);
  if (proposed && proposed.proposed.length > 0) {
    console.log('');
    console.log(`Jev proposes ${proposed.proposed.length} link(s) — review before applying:`);
    for (const link of proposed.proposed) {
      console.log(`  [[${link.target}]]  (${link.target_title}, p=${link.link_probability})`);
    }
  }
  console.log(`Next: Refine → granite edit ${note.slug} | Find links → granite suggest-links ${note.slug}`);
}
