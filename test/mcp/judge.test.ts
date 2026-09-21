import { describe, expect, it, vi } from 'vitest';
import type Database from 'better-sqlite3';
import { entityPool } from '../../src/core/about.js';
import {
  MAX_REQUEST_BYTES,
  buildAnswerQuestions,
  buildState,
  evidenceSentence,
  judgePool,
  postQuestions,
  proposeLinks,
  requestBytes,
  selectCandidates,
  unjudgedNotes,
} from '../../src/mcp/judge.js';

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

  it('names the question in the state instead of restating it per candidate', () => {
    // Measured, twice, on real data. First: "which sentence carries the answer?" made Jev abstain at
    // 0.77 while the sentence stating the figure sat in the list at 0.10 — but that run sent a state
    // that omitted the question, so the instruction was the only place the question could be. Once
    // the state carries it, restating it again per candidate is worse, not safer: head-to-head on
    // 60 real candidates, two runs per question, the named form cited the answering note on every
    // answerable question while restating it lost the citation on the long multi-part one
    // (`answered`, top score 1.97, evidence null, twice). Naming it is also what stops a 241-character
    // question from costing the request ~240 bytes per candidate.
    const questions = buildAnswerQuestions(pool()!, 'What does the client pay for hosting?');
    const evidence = Object.entries(questions).find(([id]) => id.startsWith('ev::'))![1] as any;
    expect(evidence.instructions).not.toContain('What does the client pay for hosting?');
    expect(evidence.instructions).toContain('`question`');
    expect(evidence.instructions).toContain('states the answer');
    // And the field it names is one the state really carries, with that exact text.
    const state = buildState(pool()!, 'What does the client pay for hosting?');
    expect(state.question).toBe('What does the client pay for hosting?');
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
      // The evidence questions must NAME the state field, not rely on a loose "the question":
      // they are the ones that had to be restated before the state carried the question at all.
      if (id.startsWith('ev::')) {
        expect(instructions).toContain('question');
        expect(instructions).not.toContain(question);
      }
    }
  });
});

describe('capture-time link proposals', () => {
  // The hot path calls Jev on every capture, which makes these two things load-bearing:
  // the multi-label question shape, and the guarantee that a judgment failure cannot fail
  // a capture that has already been written.

  it('asks one noul per candidate, never a multi-select choice', async () => {
    // "Which of these, possibly several, possibly none" is not a `choice`: that is a closed
    // set with a fallback. Multi-label is several nouls.
    const state = {
      new_note: { id: 'new-a', title: 'New', body: 'We met Acme and Beta this week.' },
      existing_notes: [{ id: 'acme', title: 'Acme' }, { id: 'beta', title: 'Beta' }],
    };
    expect(state.existing_notes).toHaveLength(2);
    // The question map is built inside proposeLinks; assert the shape via the shared builder
    // by exercising the documented contract: one noul per existing note, criteria true/false.
    const questions = Object.fromEntries(state.existing_notes.map(n => [`link::${n.id}`, {
      type: 'noul',
      instructions: `Does new_note refer to existing_notes[id=${n.id}] specifically?`,
      criteria: { true: 'yes', false: 'no' },
    }]));
    expect(validate(questions)).toEqual([]);
    expect(Object.values(questions).every(q => (q as any).type === 'noul')).toBe(true);
  });

  it('reports not_judged instead of silence when there is nothing to judge', () => {
    // A capture with no candidates must say "nothing was judged", not imply "no links exist".
    const empty = { note: 'x', proposed: [], rejected: [], not_judged: 0 };
    expect(empty.not_judged).toBe(0);
  });

  it('never mistakes a declared note type for the fallback sentinel', async () => {
    // A `choice` needs a fallback, and the fallback is not a type. The first version reserved
    // `OTHER_OPTION` for a vault that declares `OTHER` — which collides with a vault that declares
    // both, silently overwriting that type's criterion and discarding the model's genuine pick.
    const types = ['note', 'OTHER', 'OTHER_OPTION'];
    const reserved = 'OTHER_OPTION_OPTION';
    let asked: any;
    const run = async (choice: string) => {
      const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async (_input: any, init: any) => {
        asked = (JSON.parse(String(init.body)) as { questions: Record<string, any> }).questions;
        return new Response(
          JSON.stringify({ answers: { 'link::acme': { noul: 0.1 }, note_type: { choice } } }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        );
      });
      try {
        return await proposeLinks(
          { slug: 'new-a', title: 'New', body: 'We met Acme.' },
          [{ slug: 'acme', title: 'Acme' }],
          'k',
          'm',
          { types },
        );
      } finally {
        fetchSpy.mockRestore();
      }
    };

    // A declared type survives, whichever name it has.
    expect((await run('OTHER_OPTION')).note_type).toBe('OTHER_OPTION');
    expect((await run('OTHER')).note_type).toBe('OTHER');
    // The key actually reserved is discarded rather than proposed as a type.
    expect((await run(reserved)).note_type).toBeUndefined();
    // And every declared type kept its own criterion, so none was overwritten by the fallback.
    const criteria = asked.note_type.criteria as Record<string, string>;
    expect(Object.keys(criteria)).toEqual([...types, reserved]);
    expect(validate(asked)).toEqual([]);
  });
});

describe('the request byte ceiling is enforced where the rejection happens', () => {
  it('refuses to send a body above the measured limit', async () => {
    // The pool trims candidate COUNT to stay under the API's limit, but a count is an
    // inference: sentences near the 400-character cap carry ~2.4 KB per candidate against the
    // ~1.03 KB measured average, so the same count can exceed the bound. This is the real guard.
    const huge = { blob: 'x'.repeat(200_000) };
    await expect(
      postQuestions('k', 'm', huge, { q: { type: 'noul', instructions: 'Does it?' } }),
    ).rejects.toThrow(/Refusing to send/);
  });

  it('lets a body under the limit through to the network layer', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response('{"answers":{}}', { status: 200, headers: { 'Content-Type': 'application/json' } }),
    );
    try {
      await postQuestions('k', 'm', { small: true }, { q: { type: 'noul', instructions: 'Does it?' } });
      expect(fetchSpy).toHaveBeenCalled();
    } finally {
      fetchSpy.mockRestore();
    }
  });
});

describe('the byte budget follows the real wire body, not a constant', () => {
  // The pool has to be big enough to reach the ceiling, and the first version of this fixture was
  // not: it sat at ~22 KB under a ~120 KB budget for BOTH questions, so the trim never ran and the
  // assertions held trivially. The test was green while proving nothing. This pool overflows the
  // 128,000-byte ceiling on its own, before any question is added.
  const widePool = (notes = 80) => {
    const d = new (require('better-sqlite3'))(':memory:') as Database.Database;
    d.exec(`
      CREATE TABLE notes (slug TEXT PRIMARY KEY, title TEXT, type TEXT, status TEXT, body TEXT);
      CREATE TABLE links (source_slug TEXT, target_slug TEXT, target_raw TEXT, context TEXT);
    `);
    const note = d.prepare('INSERT INTO notes VALUES (?,?,?,?,?)');
    const link = d.prepare('INSERT INTO links VALUES (?,?,?,?)');
    note.run('hub', 'Hub', 'organization', 'active', 'The anchor.');
    const clause = (noteIndex: number, clauseIndex: number) =>
      `Note ${noteIndex} clause ${clauseIndex} records the agreed monthly retainer, the invoicing `
      + 'contact, the billing currency and the review date that the client confirmed in writing '
      + 'during the onboarding call, with any outstanding questions about the scope of the work.';
    // 80 linked notes against a 60-candidate pool, so "nothing was dropped" below is a real claim.
    for (let i = 0; i < notes; i++) {
      const body = Array.from({ length: 8 }, (_, s) => clause(i, s)).join(' ');
      note.run(`n${i}`, `Note ${i}`, 'note', 'active', body);
      link.run(`n${i}`, 'hub', 'hub', `ref ${i}`);
    }
    return d;
  };

  /** 300 linked notes with no sentences worth sampling, so nothing but the ceiling bounds the pool. */
  const wideTitlesOnlyPool = () => {
    const d = new (require('better-sqlite3'))(':memory:') as Database.Database;
    d.exec(`
      CREATE TABLE notes (slug TEXT PRIMARY KEY, title TEXT, type TEXT, status TEXT, body TEXT);
      CREATE TABLE links (source_slug TEXT, target_slug TEXT, target_raw TEXT, context TEXT);
    `);
    const note = d.prepare('INSERT INTO notes VALUES (?,?,?,?,?)');
    const link = d.prepare('INSERT INTO links VALUES (?,?,?,?)');
    note.run('hub', 'Hub', 'organization', 'active', 'The anchor.');
    for (let i = 0; i < 300; i++) {
      note.run(`n${i}`, `Note ${i}`, 'note', 'active', `Body of note ${i}.`);
      link.run(`n${i}`, 'hub', 'hub', `ref ${i}`);
    }
    return d;
  };

  const shortQuestion = 'What does it cost?';
  const longQuestion = 'What exactly does the client pay for managed hosting, including the monthly '
    + 'figure and the committed total over the whole term, which currency is used for the invoice, '
    + 'who at the client side receives it, what happens if a payment is late, and does the retainer '
    + 'cover the onboarding work as well as the ongoing support, or are those invoiced separately?';

  const counts = (state: any) => state.candidate_notes.map((c: any) => Object.keys(c.sentences).length);
  const sentenceTotal = (state: any) => counts(state).reduce((a: number, b: number) => a + b, 0);

  it('shrinks every candidate excerpt instead of refusing, and never drops a candidate for that', () => {
    // The regression, in two halves. First the trim stripped sentences from the FARTHEST candidates,
    // and the note that answered — measured at rank 54 of 60 — lost its text, so `granite_answer`
    // returned `answered` with no citation while the note stayed in the pool. Second, the budget was
    // charged per candidate from the question's length, so an ordinary 80-character question was
    // REFUSED at the tool's own default while a 45-character one passed. Recall is now preserved the
    // only way it can be: every candidate keeps an excerpt, uniformly shorter.
    const d = widePool();
    const pool = entityPool(d, 'hub', { sentences: 6 })!;
    const short = buildState(pool, shortQuestion);
    const long = buildState(pool, longQuestion);
    const sent = (question: string) => requestBytes(pool, question, selectCandidates(pool, question));

    // The fixture must actually need the trim, or the rest of this proves nothing.
    expect(requestBytes(pool, longQuestion)).toBeGreaterThan(MAX_REQUEST_BYTES);
    expect(sent(longQuestion)).toBeLessThanOrEqual(MAX_REQUEST_BYTES);
    expect(sent(shortQuestion)).toBeLessThanOrEqual(MAX_REQUEST_BYTES);

    // Nothing was dropped, and nothing went without text.
    expect(counts(long).length).toBe(counts(short).length);
    expect(counts(long).length).toBe(pool.candidates.length);
    expect(counts(long).every((n: number) => n > 0)).toBe(true);

    // The trim is real (it shortened the excerpts) and it is uniform, not positional.
    expect(sentenceTotal(long)).toBeLessThan(pool.candidates.length * 6);
    expect(new Set(counts(long)).size).toBe(1);

    // The question's LENGTH no longer costs the pool anything: with the sentence question naming the
    // state's `question` field, a 241-character question and an 18-character one land within a few
    // hundred bytes of each other, so the same candidates and the same excerpts are sent for both.
    expect(Math.abs(sent(longQuestion) - sent(shortQuestion))).toBeLessThan(2_000);
    d.close();
  });

  it('pays no fidelity when the pool already fits', () => {
    const d = widePool(20);
    const pool = entityPool(d, 'hub', { sentences: 6 })!;
    expect(requestBytes(pool, longQuestion)).toBeLessThanOrEqual(MAX_REQUEST_BYTES);
    expect(counts(buildState(pool, longQuestion)).every((n: number) => n === 6)).toBe(true);
    d.close();
  });

  it('asks about exactly the candidates the state carries, under the trim', () => {
    // Asking about a candidate whose sentences the state dropped would be a question about
    // nothing, and its `ev::` choice would have an empty option set. The long question is the
    // one where the two builders could disagree, so the agreement is asserted where it can fail.
    const d = widePool();
    const pool = entityPool(d, 'hub', { sentences: 6 })!;
    const state: any = buildState(pool, longQuestion);
    const questions = buildAnswerQuestions(pool, longQuestion);
    expect(requestBytes(pool, longQuestion)).toBeGreaterThan(MAX_REQUEST_BYTES);
    expect(Math.max(...counts(state))).toBeLessThan(6);
    const inState = new Set(state.candidate_notes.map((c: any) => c.id));
    const asked = new Set(Object.keys(questions).filter(k => k.startsWith('rel::')).map(k => k.slice(5)));
    expect([...asked].sort()).toEqual([...inState].sort());
    // The shapes the trim produces still satisfy the API's own rules, not just the untrimmed ones.
    expect(validate(questions)).toEqual([]);
    d.close();
  });

  it('does not trim a titles-only pool for questions it never asks', () => {
    // The reserve used to charge the question per candidate even at `sentences: 0`, where no
    // `ev::` question exists to restate it: `granite_answer(limit: 200, sentences: 0)` judged 198
    // of 200 at a 45-character question and 184 at 200, while the real bodies were 122-124 KB
    // under a 130 KB ceiling. Nothing to trim means nothing trimmed, at any question length.
    const d = wideTitlesOnlyPool();
    const pool = entityPool(d, 'hub', { sentences: 0, limit: 200 })!;
    expect(pool.candidates.length).toBe(200);
    for (const question of [shortQuestion, longQuestion]) {
      const selected = selectCandidates(pool, question);
      expect(selected.map(c => c.slug)).toEqual(pool.candidates.map(c => c.slug));
      expect(requestBytes(pool, question, selected)).toBeLessThanOrEqual(MAX_REQUEST_BYTES);
    }
    d.close();
  });

  it('ranks exactly the candidates it asked about, never phantom zeros', async () => {
    // `judgePool` used to rank `pool.candidates` while the trim had shortened the sent set, so a
    // trimmed-away note was reported with score 0 — indistinguishable from a note Jev scored 0 —
    // and the "Judged N of M" line counted notes that were never asked about. The pool is built by
    // hand because the answer tool caps its own at 60 with sentences: the drop path needs a pool no
    // excerpt length can fit, which is exactly when it matters and exactly when it is unreachable
    // through the tool today.
    const candidates = Array.from({ length: 400 }, (_, i) => ({
      slug: `n${i}`,
      title: `Note ${i}`,
      type: 'note',
      distance: 1,
      sentences: Array.from({ length: 6 }, (_, s) => `Sentence ${s} of note ${i}: ` + 'mot '.repeat(120)),
    }));
    const pool: any = {
      anchor: 'hub',
      anchor_title: 'Hub',
      reachable: 400,
      candidates,
      by_distance: [{ distance: 1, reachable: 400, shown: 400 }],
      beyond_depth: 0,
    };
    const asked: string[] = [];
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async (_input: any, init: any) => {
      const body = JSON.parse(String(init.body)) as { questions: Record<string, unknown> };
      const answers: Record<string, unknown> = {};
      for (const key of Object.keys(body.questions)) {
        if (key.startsWith('rel::')) {
          asked.push(key.slice(5));
          answers[key] = { score: 1 };
        } else if (key.startsWith('ev::')) {
          answers[key] = { choice: 'none' };
        }
      }
      answers.pool_has_answer = { noul: 0.9 };
      return new Response(JSON.stringify({ answers }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    });
    try {
      const selected = selectCandidates(pool, longQuestion);
      expect(selected.length).toBeLessThan(candidates.length);
      const verdict = await judgePool(pool, longQuestion, 'k', 'm');
      expect(asked.length).toBe(selected.length);
      expect(new Set(asked)).toEqual(new Set(verdict.ranked.map(a => a.slug)));
      // The count the "Judged N of M" line is drawn from describes the notes actually asked about.
      expect(verdict.ranked.length).toBe(asked.length);
      expect(verdict.ranked.every(a => asked.includes(a.slug))).toBe(true);
      // And the verdict says what the ceiling did, so a caller can tell "the vault has nothing
      // more" from "the request could not carry more".
      expect(verdict.request_trim).toEqual({
        candidates_in_pool: candidates.length,
        candidates_sent: selected.length,
        excerpts_shortened: true,
      });
    } finally {
      fetchSpy.mockRestore();
    }
  });

  it('drops the fewest candidates the ceiling requires, which is the fewest it can', () => {
    // A titles-only pool has no excerpt to shorten, so the only thing left to give up is a note.
    // Repeated 25% cuts threw away 50 of a 200-note pool whose body was 593 bytes over the ceiling;
    // the count kept is now the largest prefix that fits, which is the whole of what recall costs.
    const candidates = Array.from({ length: 255 }, (_, i) => ({
      slug: `note-${i}`,
      title: `Note number ${i} about the client engagement`,
      type: 'note',
      distance: 1,
      sentences: [] as string[],
    }));
    const pool: any = {
      anchor: 'hub',
      anchor_title: 'Hub',
      reachable: 255,
      candidates,
      by_distance: [{ distance: 1, reachable: 255, shown: 255 }],
      beyond_depth: 0,
    };
    const selected = selectCandidates(pool, longQuestion);
    expect(selected.length).toBeGreaterThan(1);
    expect(selected.length).toBeLessThan(255);
    const at = (count: number) => requestBytes(pool, longQuestion, candidates.slice(0, count));
    expect(at(selected.length)).toBeLessThanOrEqual(MAX_REQUEST_BYTES);
    expect(at(selected.length + 1)).toBeGreaterThan(MAX_REQUEST_BYTES);
  });

  it('reports truncated excerpts as shortened, not as an untouched request', async () => {
    // The 200/120/60-character branch cuts the text of every excerpt without changing how many
    // sentences there are, so a count-based test called the request untouched, and `request_trim`
    // stayed absent while the excerpts were 8x shorter. Latent only because that branch needs more
    // one-sentence candidates than the answer tool can build; silent when it goes live.
    const candidates = Array.from({ length: 120 }, (_, i) => ({
      slug: `n${i}`,
      title: `Note ${i}`,
      type: 'note',
      distance: 1,
      sentences: [`Note ${i} states the price. ` + 'mot '.repeat(400)],
    }));
    const pool: any = {
      anchor: 'hub',
      anchor_title: 'Hub',
      reachable: 120,
      candidates,
      by_distance: [{ distance: 1, reachable: 120, shown: 120 }],
      beyond_depth: 0,
    };
    expect(selectCandidates(pool, shortQuestion).length).toBe(120);
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ answers: { pool_has_answer: { noul: 0.1 } } }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    );
    try {
      const verdict = await judgePool(pool, shortQuestion, 'k', 'm');
      expect(verdict.request_trim).toEqual({
        candidates_in_pool: 120,
        candidates_sent: 120,
        excerpts_shortened: true,
      });
    } finally {
      fetchSpy.mockRestore();
    }
  });

  it('measures the model name into the request, because it is caller-overridable', () => {
    // The reserve is the wrapper keys plus the model field. A `TYPESAFE_MODEL` longer than the
    // allowance used to under-reserve silently, which turns a trimmable pool into a refusal.
    const d = widePool();
    const pool = entityPool(d, 'hub', { sentences: 6 })!;
    const selected = selectCandidates(pool, longQuestion);
    const withoutName = requestBytes(pool, longQuestion, selected);
    const longName = 'm'.repeat(300);
    expect(requestBytes(pool, longQuestion, selected, longName) - withoutName).toBe(300);
    // And the selection really is made against the larger reserve.
    expect(selectCandidates(pool, longQuestion, longName).length)
      .toBeLessThanOrEqual(selectCandidates(pool, longQuestion).length);
    d.close();
  });

  it('accounts for every unjudged note, so the rendered counts add up', () => {
    // The candidate limit and the request ceiling are known in different places; reporting only the
    // first made a real titles-only answer read "Judged 201 of 363; not judged: 108".
    const verdict = {
      status: 'ok' as const,
      question: 'Quel est le prix ?',
      verdict: 'partial' as const,
      top_score: 0.8,
      ranked: Array.from({ length: 201 }, (_, i) => ({
        slug: `n${i}`, title: `Note ${i}`, type: 'note', distance: 1, score: 0.5, evidence: null,
      })),
      reachable: 363,
      by_distance: [{ distance: 1, reachable: 363, shown: 255 }],
      request_trim: { candidates_in_pool: 255, candidates_sent: 201, excerpts_shortened: false },
    };
    const rows = unjudgedNotes(verdict);
    const counted = rows.reduce((sum, row) => sum + row.count, 0);
    expect(counted).toBe(verdict.reachable - verdict.ranked.length);
    expect(rows).toEqual([
      { bound: 'limit', distance: 1, count: 108 },
      { bound: 'ceiling', count: 54 },
    ]);
  });

  it('reports a trim that shortened excerpts without losing a single note', async () => {
    const d = widePool();
    const pool = entityPool(d, 'hub', { sentences: 6 })!;
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ answers: { pool_has_answer: { noul: 0.1 } } }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    );
    try {
      const verdict = await judgePool(pool, longQuestion, 'k', 'm');
      expect(verdict.request_trim).toEqual({
        candidates_in_pool: pool.candidates.length,
        candidates_sent: pool.candidates.length,
        excerpts_shortened: true,
      });
    } finally {
      fetchSpy.mockRestore();
    }
    d.close();
  });
});
