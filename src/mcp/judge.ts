/**
 * The judgment layer: Granite bounds a set, Jev decides inside it.
 *
 * This is the one place in Granite that talks to a model, and it is deliberately narrow.
 * Jev (TypeSafe System One) is a classifier: it returns a `choice`, a `score` or a `noul`
 * probability over a set Granite already chose. It never decides *what* to look at, never
 * writes prose, and never runs a loop. See the Product Boundaries section of CLAUDE.md.
 *
 * It is opt-in and fails closed. Without `TYPESAFE_API_KEY` every function here reports
 * itself unavailable and the rest of Granite is unaffected.
 */
import type { EntityPool } from '../core/about.js';

export const API_URL = 'https://api.typesafe.ai/v1/systemone';

/**
 * Pin a versioned model. Alias names drift when TypeSafe ships a release, and a threshold
 * tuned against one version must not silently move to another.
 */
export const DEFAULT_MODEL = 'jev-1.13.0';

const TIMEOUT_MS = 60_000;

/**
 * Relevance is a 0-3 Score. The cut sits between measured values: an answerable question
 * scored 1.38, a control verified absent scored 0.21. Re-measured later at 1.95/0.23 and
 * 1.49/0.27 across runs; the band between them is wide, which is why the thresholds sit
 * where they do rather than being tuned tightly.
 */
export const ANSWERED_AT = 1.0;
export const ABSENT_BELOW = 0.5;

/** Above this `noul` probability a proposed link is kept. Controls read 0.99/0.01. */
export const LINK_THRESHOLD = 0.5;

const RELEVANCE_LEVELS = [
  'Does not address the question.',
  'Mentions the topic but does not answer the question.',
  'Partially answers it, or answers only part of it.',
  'Directly and specifically answers the question.',
];

export interface JudgeAnswer {
  slug: string;
  title: string;
  type: string;
  distance: number;
  /** 0-3 relevance score from Jev. */
  score: number;
  /** The sentence Jev cited, or null when it cited none. */
  evidence: string | null;
}

export interface AnswerVerdict {
  status: 'ok' | 'unavailable' | 'error';
  question: string;
  anchor?: string;
  model?: string;
  verdict?: 'answered' | 'partial' | 'absent';
  top_score?: number;
  /** Reported alongside, never used as the decision — see the module note. */
  pool_has_answer?: number | null;
  ranked?: JudgeAnswer[];
  reason?: string;
}

export function apiKey(): string | undefined {
  const key = process.env.TYPESAFE_API_KEY?.trim();
  return key ? key : undefined;
}

export function model(): string {
  return process.env.TYPESAFE_MODEL?.trim() || DEFAULT_MODEL;
}

/**
 * Send one batched System One request.
 *
 * Every question for a set goes in a single call: measured 12.2x cheaper and 10x faster
 * than one call per item, with identical answers. Questions are evaluated independently,
 * so adding them barely changes latency.
 */
export async function postQuestions(
  key: string,
  modelName: string,
  state: unknown,
  questions: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const response = await fetch(API_URL, {
      method: 'POST',
      headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ state, model: modelName, questions }),
      signal: controller.signal,
    });
    if (!response.ok) {
      const detail = (await response.text().catch(() => '')).slice(0, 300);
      const hint = response.status === 401
        ? ' (check TYPESAFE_API_KEY)'
        : response.status === 429 ? ' (rate limited; retry shortly)' : '';
      throw new Error(`TypeSafe returned HTTP ${response.status}${hint}: ${detail}`);
    }
    return (await response.json()) as Record<string, unknown>;
  } finally {
    clearTimeout(timer);
  }
}

/** The pool as the state Jev reads: one entry per candidate, sentences keyed `s0..sN`. */
function poolState(pool: EntityPool) {
  return {
    candidate_notes: pool.candidates.map(candidate => ({
      id: candidate.slug,
      title: candidate.title,
      type: candidate.type,
      sentences: Object.fromEntries(
        candidate.sentences.map((sentence, index) => [`s${index}`, sentence]),
      ),
    })),
  };
}

/**
 * Ask which candidate answers the question, and which of its sentences carries it.
 *
 * The question is "does this answer the question?", never "is this related?" — the two
 * ranked differently on real data, and the broader one put generic explainers above the
 * note holding the figure.
 */
export function buildAnswerQuestions(pool: EntityPool, questionText: string): Record<string, unknown> {
  const questions: Record<string, unknown> = {
    // Reported as context, never used as the decision. An absolute "does the pool hold an
    // answer?" was measured giving a false negative on a pool whose answer sat at rank 3
    // (0.25 against a 0.35 cut), so the verdict comes from the ranking instead.
    pool_has_answer: {
      type: 'noul',
      instructions:
        'Does any candidate_note state the answer to the question? Answer yes only if a '
        + 'note states it, not merely discusses the topic.',
      criteria: {
        true: 'At least one note states or directly implies the answer.',
        false: 'No note states the answer.',
      },
    },
  };

  for (const candidate of pool.candidates) {
    const id = candidate.slug;
    questions[`rel::${id}`] = {
      type: 'score',
      instructions:
        `How directly does candidate_notes[id=${id}] answer the question? Judge only that `
        + 'note. A note that merely discusses the topic is not an answer.',
      criteria: RELEVANCE_LEVELS,
    };
    if (candidate.sentences.length > 0) {
      questions[`ev::${id}`] = {
        type: 'choice',
        // The question is restated in full rather than referred to as "the answer". Measured
        // on a real note: "which sentence carries the answer?" returned `none` at 0.77 while
        // the sentence stating the figure sat in the list at 0.10; stating the question and
        // asking which sentence contains its answer moved that sentence to 0.96. The model
        // could always do it — the instruction was what made it abstain.
        instructions:
          `The question is: ${questionText}. Which single sentence of candidate_notes[id=${id}] `
          + 'contains the answer to that question? Choose the sentence that states it, or none '
          + 'if no sentence does.',
        criteria: {
          ...Object.fromEntries(candidate.sentences.map((_, index) => [`s${index}`, 'A sentence of this note.'])),
          none: 'No sentence states the answer.',
        },
      };
    }
  }
  return questions;
}

/** Resolve the sentence Jev cited, or null when it cited nothing usable. */
export function evidenceSentence(picked: unknown, sentences: string[]): string | null {
  // Only `s<digits>` names a sentence. A loose prefix match accepted "sentence2" (which
  // raised) and "s-1" (which resolved to the last sentence, presenting a quote the model
  // never cited).
  if (typeof picked !== 'string') return null;
  const match = /^s(\d+)$/.exec(picked);
  if (!match) return null;
  const index = Number.parseInt(match[1], 10);
  return index < sentences.length ? sentences[index] : null;
}

/**
 * Judge a pool against a question and return a verdict.
 *
 * The verdict is derived from the **ranking**, and the absence signal is the top score.
 * `pool_has_answer` travels with the result because it is useful context for a human, but
 * it is deliberately not the gate: it was measured wrong on a case the ranking got right.
 */
export async function judgePool(
  pool: EntityPool,
  question: string,
  key: string,
  modelName: string,
): Promise<AnswerVerdict> {
  const state = poolState(pool);
  const answers = (await postQuestions(key, modelName, state, buildAnswerQuestions(pool, question)))
    .answers as Record<string, Record<string, unknown>> | undefined ?? {};

  const ranked: JudgeAnswer[] = pool.candidates.map(candidate => {
    const id = candidate.slug;
    const score = Number(answers[`rel::${id}`]?.score ?? 0);
    const picked = answers[`ev::${id}`]?.choice;
    return {
      slug: id,
      title: candidate.title,
      type: candidate.type,
      distance: candidate.distance,
      score: Math.round(score * 100) / 100,
      evidence: evidenceSentence(picked, candidate.sentences),
    };
  });
  ranked.sort((a, b) => b.score - a.score);

  const topScore = ranked.length > 0 ? ranked[0].score : 0;
  const poolHasAnswer = answers.pool_has_answer?.noul;

  return {
    status: 'ok',
    question,
    anchor: pool.anchor,
    model: modelName,
    verdict: topScore >= ANSWERED_AT ? 'answered' : topScore < ABSENT_BELOW ? 'absent' : 'partial',
    top_score: topScore,
    pool_has_answer: typeof poolHasAnswer === 'number' ? Math.round(poolHasAnswer * 100) / 100 : null,
    ranked,
  };
}
