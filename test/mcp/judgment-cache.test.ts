import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';
import {
  readCachedJudgments,
  readCachedRouting,
  sourceHash,
  writeCachedJudgments,
  writeCachedRouting,
} from '../../src/mcp/judgment-cache.js';

/**
 * The cache exists because the candidate distribution is heavy-tailed: `quivr` is a candidate
 * for 147 source notes, so the same pair is judged again on every capture. Two properties
 * matter more than the speed-up, and both are about not serving a stale judgment.
 */
function db(): Database.Database {
  const d = new Database(':memory:');
  d.exec('CREATE TABLE notes (slug TEXT PRIMARY KEY, tags TEXT);');
  return d;
}

describe('judgment cache', () => {
  it('round-trips a verdict', () => {
    const d = db();
    writeCachedJudgments(d, {
      sourceSlug: 'a', hash: 'h1', model: 'm',
      verdicts: [{ candidate: 'target', probability: 0.92 }],
    });
    const back = readCachedJudgments(d, { sourceSlug: 'a', hash: 'h1', model: 'm', candidates: ['target'] });
    expect(back.get('target')).toBe(0.92);
    d.close();
  });

  it('does NOT serve a verdict for a body that changed', () => {
    // A judgment is a statement about the source's wording. Serving one for text that no longer
    // exists is the silent wrongness the whole layer is built to avoid.
    const d = db();
    writeCachedJudgments(d, {
      sourceSlug: 'a', hash: sourceHash('T', 'the old wording'),
      model: 'm', verdicts: [{ candidate: 'target', probability: 0.92 }],
    });
    const changed = readCachedJudgments(d, {
      sourceSlug: 'a', hash: sourceHash('T', 'the new wording'),
      model: 'm', candidates: ['target'],
    });
    expect(changed.size).toBe(0);
    d.close();
  });

  it('does not serve a verdict from another model', () => {
    // Thresholds are tuned per model version; a verdict from another one is not comparable.
    const d = db();
    writeCachedJudgments(d, {
      sourceSlug: 'a', hash: 'h', model: 'jev-old',
      verdicts: [{ candidate: 'target', probability: 0.92 }],
    });
    expect(readCachedJudgments(d, { sourceSlug: 'a', hash: 'h', model: 'jev-new', candidates: ['target'] }).size).toBe(0);
    d.close();
  });

  it('round-trips the routing judgment under the same key', () => {
    const d = db();
    writeCachedRouting(d, {
      sourceSlug: 'a', hash: 'h', model: 'm',
      routing: { note_type: 'meeting', tags: ['client'] },
    });
    expect(readCachedRouting(d, { sourceSlug: 'a', hash: 'h', model: 'm' }))
      .toEqual({ note_type: 'meeting', tags: ['client'] });
    // and it is invalidated by a body change like everything else
    expect(readCachedRouting(d, { sourceSlug: 'a', hash: 'other', model: 'm' })).toBeUndefined();
    d.close();
  });

  it('never throws when the database cannot hold a cache', () => {
    // A read-only or locked index must lose the cache, not the capture.
    const d = db();
    d.exec('DROP TABLE notes; CREATE VIEW judgment_cache AS SELECT 1 AS x;');
    expect(() => writeCachedJudgments(d, {
      sourceSlug: 'a', hash: 'h', model: 'm', verdicts: [{ candidate: 'c', probability: 1 }],
    })).not.toThrow();
    expect(readCachedJudgments(d, { sourceSlug: 'a', hash: 'h', model: 'm', candidates: ['c'] }).size).toBe(0);
    d.close();
  });
});
