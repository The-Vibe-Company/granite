import { describe, expect, it } from 'vitest';
import type Database from 'better-sqlite3';
import { entityPool } from '../../src/core/about.js';
import { buildAnswerQuestions, buildState, evidenceSentence } from '../../src/mcp/judge.js';

/**
 * The judge layer is the one place Granite calls a model, so its contract has two halves
 * worth pinning without a network: the sentence parser, and the shape of the request.
 *
 * The request shape is not cosmetic. `"type": "choices"` does not exist and returns HTTP
 * 400; a `choice` whose criteria use `{"options": [...]}` is *accepted* and read as a single
 * option; and a `noul` whose criteria use `yes`/`no` is accepted with the criteria silently
 * ignored. All three were hit for real while building this.
 */

const TYPES = ['choice', 'score', 'noul'];
const FALLBACK_WORDS = ['OTHER', 'UNCLEAR', 'UNKNOWN', 'NONE', 'OUT_OF_SCOPE'];

function validate(questions: Record<string, any>): string[] {
  const errors: string[] = [];
  for (const [id, question] of Object.entries(questions)) {
    const where = `questions.${id}`;
    if (!TYPES.includes(question.type)) {
      errors.push(`${where}: unknown type ${question.type}`);
      continue;
    }
    if (!question.instructions?.trim()) errors.push(`${where}: no instructions`);
    const criteria = question.criteria;
    if (question.type === 'choice') {
      if (typeof criteria !== 'object' || criteria === null) errors.push(`${where}: criteria must be a map`);
      else if (Object.keys(criteria).length === 1 && 'options' in criteria) errors.push(`${where}: {"options": ...} is read as one option`);
      else if (Object.keys(criteria).length < 2) errors.push(`${where}: needs at least 2 options`);
      else if (!Object.keys(criteria).some(k => FALLBACK_WORDS.some(w => k.toUpperCase().includes(w)))) {
        errors.push(`${where}: no fallback option`);
      }
    }
    if (question.type === 'score') {
      if (!Array.isArray(criteria) || criteria.length < 2) errors.push(`${where}: score needs 2-10 ordered levels`);
    }
    if (question.type === 'noul' && criteria) {
      if (!Object.keys(criteria).every(k => k === 'true' || k === 'false')) {
        errors.push(`${where}: noul criteria keys must be true/false`);
      }
    }
  }
  return errors;
}

function pool(): ReturnType<typeof entityPool> {
  const d = new (require('better-sqlite3'))(':memory:') as Database.Database;
  d.exec(`
    CREATE TABLE notes (slug TEXT PRIMARY KEY, title TEXT, type TEXT, status TEXT, body TEXT);
    CREATE TABLE links (source_slug TEXT, target_slug TEXT, target_raw TEXT, context TEXT);
  `);
  const note = d.prepare('INSERT INTO notes VALUES (?,?,?,?,?)');
  note.run('acme', 'Acme', 'organization', 'active', 'Acme is the client and pays for hosting.');
  note.run('meeting-a', 'Kickoff', 'meeting', 'active',
    'Kickoff with Acme. The proposal states 1 975 EUR per month for managed hosting over three years.');
  const link = d.prepare('INSERT INTO links VALUES (?,?,?,?)');
  link.run('meeting-a', 'acme', 'Acme', 'Kickoff with [[Acme]]');
  const built = entityPool(d, 'acme', { sentences: 6 })!;
  d.close();
  return built;
}

describe('evidenceSentence', () => {
  const SENTENCES = ['first sentence here', 'second sentence here', 'third sentence here'];

  it('resolves a valid index', () => {
    expect(evidenceSentence('s0', SENTENCES)).toBe('first sentence here');
    expect(evidenceSentence('s2', SENTENCES)).toBe('third sentence here');
  });

  it('treats none and out-of-range as no evidence', () => {
    expect(evidenceSentence('none', SENTENCES)).toBeNull();
    expect(evidenceSentence('s-1', SENTENCES)).toBeNull();
    expect(evidenceSentence('s99', SENTENCES)).toBeNull();
  });

  it('rejects anything that is not an index', () => {
    for (const picked of ['sentence2', 's', 's1x', '', null, undefined, 3, ['s0'], { choice: 's0' }]) {
      expect(evidenceSentence(picked, SENTENCES)).toBeNull();
    }
  });

  it('never resolves against an empty sentence list', () => {
    expect(evidenceSentence('s0', [])).toBeNull();
  });
});

describe('buildAnswerQuestions', () => {
  it('passes the API request-shape rules', () => {
    expect(validate(buildAnswerQuestions(pool()!, 'What does the client pay?'))).toEqual([]);
  });

  it('restates the question instead of referring to "the answer"', () => {
    // Measured: "which sentence carries the answer?" made Jev abstain at 0.77 while the
    // sentence stating the figure sat in the list at 0.10. Stating the question moved it to
    // 0.96, so the wording is behaviour, not style.
    const questions = buildAnswerQuestions(pool()!, 'What does the client pay for hosting?');
    const evidence = Object.entries(questions).find(([id]) => id.startsWith('ev::'))![1] as any;
    expect(evidence.instructions).toContain('What does the client pay for hosting?');
    expect(evidence.instructions).toContain('contains the answer');
  });

  it('gives every choice question a fallback option', () => {
    const questions = buildAnswerQuestions(pool()!, 'What does the client pay?');
    for (const [id, question] of Object.entries(questions)) {
      if ((question as any).type !== 'choice') continue;
      expect(Object.keys((question as any).criteria), id).toContain('none');
    }
  });

  it('asks one score question per candidate and one evidence question per non-empty note', () => {
    const questions = buildAnswerQuestions(pool()!, 'What does the client pay?');
    const ids = Object.keys(questions);
    expect(ids.filter(id => id.startsWith('rel::'))).toHaveLength(1);
    expect(ids.filter(id => id.startsWith('ev::'))).toHaveLength(1);
  });

  it('keeps the absolute pool question as context rather than as the decision', () => {
    const questions = buildAnswerQuestions(pool()!, 'What does the client pay?');
    expect((questions.pool_has_answer as any).type).toBe('noul');
  });
});

describe('the state sent to Jev', () => {
  // The regression this pins is the worst kind: every question still validated, the verdict
  // still came back, and it was scored against nothing. `poolState` sent only the candidates
  // while `rel::` and `pool_has_answer` refer to "the question", and questions are evaluated
  // independently — so the ranking had no antecedent and the thresholds were calibrated with
  // one present.
  it('includes the question alongside the candidates', () => {
    const built = pool()!;
    const state = buildState(built, 'What does the client pay for managed hosting?');
    expect(state.question).toBe('What does the client pay for managed hosting?');
    expect(Array.isArray(state.candidate_notes)).toBe(true);
    expect(state.candidate_notes.length).toBeGreaterThan(0);
  });

  it('sends every question with its antecedent restated or resolvable', () => {
    const built = pool()!;
    const question = 'What does the client pay for managed hosting?';
    const questions = buildAnswerQuestions(built, question);
    const state = buildState(built, question);
    for (const [id, value] of Object.entries(questions)) {
      const instructions = (value as { instructions: string }).instructions;
      // Either the question is in the instruction text, or it is in the state the
      // instruction points at. One of the two must hold for every question.
      const restated = instructions.includes(question);
      const resolvable = typeof state.question === 'string' && state.question.length > 0;
      expect(restated || resolvable, `${id} has no antecedent`).toBe(true);
    }
  });
});
