/**
 * The judgment layer: Granite bounds a set, Jev decides inside it.
 *
 * This is the one place in Granite that talks to a model, and it is deliberately narrow.
 * Jev (TypeSafe System One) is a classifier: it returns a `choice`, a `score` or a `noul`
 * probability over a set Granite already chose. It never decides *what* to look at, never
 * writes prose, and never runs a loop. See the Product Boundaries section of CLAUDE.md.
 *
 * **Jev is required, not optional.** `TYPESAFE_API_KEY` must be set: the MCP server and the
 * CLI both refuse to start without it, and every entry point that needs a judgment throws a
 * named error rather than degrading. Granite does less without it on purpose — a silently
 * degraded semantic layer produces answers that look right and are not.
 */
import type { EntityPool, PoolDistanceSummary } from '../core/about.js';

export const API_URL = 'https://api.typesafe.ai/v1/systemone';

/**
 * Raised whenever a required credential or judgment is missing. Named so callers and tests
 * can distinguish "Jev is not configured" from "Jev refused", which need different fixes.
 */
export class JevUnavailableError extends Error {
  readonly code = 'jev_unavailable';
  constructor(detail = 'TYPESAFE_API_KEY is not set') {
    super(
      `Jev is required and ${detail}. Set TYPESAFE_API_KEY to a TypeSafe key `
      + '(https://console.typesafe.ai). Granite does not run its semantic layer without it.',
    );
    this.name = 'JevUnavailableError';
  }
}

/**
 * Pin a versioned model. Alias names drift when TypeSafe ships a release, and a threshold
 * tuned against one version must not silently move to another.
 */
export const DEFAULT_MODEL = 'jev-1.13.0';

const TIMEOUT_MS = 60_000;

/**
 * The largest request body the API was measured to accept, in bytes.
 *
 * Measured: 100 candidates with sentences is 94-100 KB and accepted; 141 is 142 KB and
 * rejected with HTTP 400. The pool trims candidate *counts* to stay under this, but a count is
 * an inference — a corpus whose sentences sit near the 400-character cap carries ~2.4 KB per
 * candidate against the ~1.03 KB measured average, so the same count can exceed the bound.
 * This is the enforcement at the boundary the rejection actually happens at.
 */
export const MAX_REQUEST_BYTES = 130_000;

/**
 * Rough bytes a serialized entry costs, measured rather than guessed: a candidate carrying six
 * sentences and its share of the questions is ~2.05 KB, one carrying none ~0.615 KB.
 */
const BYTES_PER_CANDIDATE_WITH_SENTENCES = 2100;
const BYTES_PER_CANDIDATE_TITLES_ONLY = 640;

/**
 * The budget a pool may occupy once the caller's question is accounted for.
 *
 * The question is restated inside every `ev::` instruction, once per candidate, so its length
 * is multiplied by the pool size: measured, `granite_answer` at its own default exceeded the
 * byte ceiling for an ordinary 80-character question while a 45-character one passed. That
 * makes the ceiling a function of the question, not a constant — so the caller declares how
 * much room the question needs and the pool trims to what is left.
 */
export function poolByteBudget(question: string, ceiling = MAX_REQUEST_BYTES): number {
  // The question appears once per candidate plus once in the noul question; 60 bytes per
  // character is the measured multiplier at the pool sizes involved.
  return ceiling - question.length * 60;
}

/**
 * Trim sentences from the farthest candidates until the pool fits its byte budget.
 *
 * Refusing instead would fail on ordinary questions at the tool's own default. Sentences are the
 * thing to give up, not candidates: candidates are the recall, sentences are an excerpt, and the
 * farthest notes are both the cheapest to lose and the least likely to hold the answer.
 */
export function trimToByteBudget<T extends { sentences: string[] }>(
  candidates: T[],
  budget: number,
  sentencesPerNote: number,
): T[] {
  const costOf = (withSentences: number, titles: number) =>
    withSentences * BYTES_PER_CANDIDATE_WITH_SENTENCES + titles * BYTES_PER_CANDIDATE_TITLES_ONLY;

  if (costOf(candidates.length, 0) <= budget) return candidates;

  // First give up the sentences of the farthest candidates, keeping the nearest ones readable.
  const keepSentences = Math.max(0, Math.floor((budget - candidates.length * BYTES_PER_CANDIDATE_TITLES_ONLY)
    / BYTES_PER_CANDIDATE_WITH_SENTENCES));
  if (keepSentences < candidates.length) {
    candidates = candidates.map((candidate, index) => (index < keepSentences
      ? candidate
      : { ...candidate, sentences: [] as string[] }));
  }

  // Then, if even titles do not fit, drop the farthest candidates.
  const affordable = Math.max(1, Math.floor(budget / BYTES_PER_CANDIDATE_TITLES_ONLY));
  return candidates.length > affordable ? candidates.slice(0, affordable) : candidates;
}

export class RequestTooLargeError extends Error {
  readonly code = 'request_too_large';
  constructor(bytes: number) {
    super(
      `Refusing to send a ${Math.round(bytes / 1024)} KB request: the API rejects bodies above `
      + `roughly ${Math.round(MAX_REQUEST_BYTES / 1024)} KB with HTTP 400. Send fewer candidates, `
      + 'or fewer sentences per candidate.',
    );
    this.name = 'RequestTooLargeError';
  }
}

/**
 * Relevance is a 0-3 Score. The cut sits between measured values: an answerable question
 * scored 1.38, a control verified absent scored 0.21. Re-measured later at 1.95/0.23 and
 * 1.49/0.27 across runs; the band between them is wide, which is why the thresholds sit
 * where they do rather than being tuned tightly.
 */
export const ANSWERED_AT = 1.0;
export const ABSENT_BELOW = 0.5;

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
  status: 'ok' | 'error';
  question: string;
  anchor?: string;
  model?: string;
  verdict?: 'answered' | 'partial' | 'absent';
  top_score?: number;
  /** Reported alongside, never used as the decision — see the module note. */
  pool_has_answer?: number | null;
  ranked?: JudgeAnswer[];
  /** Notes reachable at the walked depth, before the candidate limit was applied. */
  reachable?: number;
  /** What the candidate limit left out, per hop. Absence claims must be read against it. */
  by_distance?: PoolDistanceSummary[];
  /** Real notes one hop beyond the walked depth: the other bound a verdict is drawn inside. */
  beyond_depth?: number;
  reason?: string;
}

/** The configured key, or undefined. Startup checks use this; judgments use `requireApiKey`. */
export function apiKey(): string | undefined {
  const key = process.env.TYPESAFE_API_KEY?.trim();
  return key ? key : undefined;
}

/** The configured key, or a named error. Every judgment path goes through this. */
export function requireApiKey(): string {
  const key = apiKey();
  if (!key) throw new JevUnavailableError();
  return key;
}

/**
 * Throw unless Jev is configured. Called once at MCP-server and CLI startup so a missing key
 * fails immediately and loudly, rather than at the first judgment — which, on the capture
 * path, would be after a note had already been written.
 */
export function assertJevConfigured(): void {
  if (!apiKey()) throw new JevUnavailableError();
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
  const body = JSON.stringify({ state, model: modelName, questions });
  // Checked before the call, not inferred from a candidate count upstream.
  if (Buffer.byteLength(body, 'utf8') > MAX_REQUEST_BYTES) {
    throw new RequestTooLargeError(Buffer.byteLength(body, 'utf8'));
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const response = await fetch(API_URL, {
      method: 'POST',
      headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
      body,
      signal: controller.signal,
    });
    if (!response.ok) {
      // The gateway's response body is deliberately not echoed: it is server-controlled text
      // that would surface in a tool-visible error, and there is no way to prove it can never
      // contain anything sensitive. Status and hint are enough to act on.
      const hint = response.status === 401
        ? ' — check TYPESAFE_API_KEY'
        : response.status === 429 ? ' — rate limited, retry shortly' : '';
      throw new Error(`TypeSafe rejected the request (HTTP ${response.status})${hint}.`);
    }
    return (await response.json()) as Record<string, unknown>;
  } finally {
    clearTimeout(timer);
  }
}

/** The pool as the state Jev reads: the question, then one entry per candidate. */
export function buildState(pool: EntityPool, question: string) {
  // The question is restated inside every `ev::` instruction, so its length multiplies against
  // the pool size. Trimming here — rather than refusing upstream — is what keeps an ordinary
  // 80-character question working at the tool's own default pool size.
  const trimmed = trimToByteBudget(pool.candidates, poolByteBudget(question), 6);
  return {
    // The question MUST be in the state. Every `rel::` question says "the question" without
    // restating it, and questions are evaluated independently, so a state without it asks
    // Jev to score relevance to nothing. The ranking, `top_score` and the verdict all come
    // from those scores, and the thresholds were calibrated with the question present.
    question,
    candidate_notes: trimmed.map(candidate => ({
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
  // Must be the same trim `buildState` applies, or a question is asked about a candidate whose
  // sentences the state no longer carries.
  const candidates = trimToByteBudget(pool.candidates, poolByteBudget(questionText), 6);
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

  for (const candidate of candidates) {
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
  const state = buildState(pool, question);
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

  if (ranked.length === 0) {
    // No candidates is a fact about the anchor, not about the vault: saying "absent" alone
    // would present a disconnected note as "the vault does not know this".
    return {
      status: 'ok',
      question,
      anchor: pool.anchor,
      model: modelName,
      verdict: 'absent',
      top_score: 0,
      pool_has_answer: null,
      ranked: [],
      reachable: pool.reachable,
      by_distance: pool.by_distance,
      beyond_depth: pool.beyond_depth,
      reason: `the pool is empty: no note is reachable from "${pool.anchor}" at the walked depth`,
    };
  }

  return {
    status: 'ok',
    question,
    anchor: pool.anchor,
    model: modelName,
    verdict: topScore >= ANSWERED_AT ? 'answered' : topScore < ABSENT_BELOW ? 'absent' : 'partial',
    top_score: topScore,
    pool_has_answer: typeof poolHasAnswer === 'number' ? Math.round(poolHasAnswer * 100) / 100 : null,
    ranked,
    // A verdict is only as trustworthy as the set it was drawn from. Reporting what the
    // limit dropped is what separates "the vault does not say" from "I did not look".
    reachable: pool.reachable,
    by_distance: pool.by_distance,
    beyond_depth: pool.beyond_depth,
  };
}

/** Above this `noul` probability a capture-time link is proposed. Controls read 0.99/0.01. */
export const LINK_THRESHOLD = 0.5;

/** The `choice` fallback sentinel. A vault type with this name gets a distinct option key. */
const OTHER_TYPE = 'OTHER';

export interface LinkProposal {
  target: string;
  target_title: string;
  /** `noul` probability that the note's own wording refers to this target. */
  link_probability: number;
}

export interface LinkProposalResult {
  note: string;
  proposed: LinkProposal[];
  rejected: LinkProposal[];
  /** Candidates the limit left unjudged, so a caller does not read silence as "no link". */
  not_judged: number;
  /**
   * The type Jev would give this note, from the vault's declared types plus a fallback.
   *
   * Measured cost of asking: **+7 ms average** across five notes, inside run-to-run noise.
   * Measured caveat: adding questions shifted 1 of 14 link decisions across the threshold, so
   * these extras are not perfectly free in effect even when they are free in time.
   */
  note_type?: string;
  /** Tags Jev judged applicable, from the tags the vault already uses. */
  tags?: string[];
}

/**
 * Which of these notes does the new note actually refer to?
 *
 * Called at capture, because linking as a periodic pass means it never happens for the notes
 * that need it: measured on a real vault, 106 notes had no incoming link and 65 of them were
 * source notes. Judging at capture is where the connection is still obvious.
 *
 * Multi-label is **several `noul`s, not one multi-select `choice`**: a `choice` is a closed
 * set with a fallback, and "which of these, possibly several, possibly none" is not that
 * question. One request per note, all candidates inside it.
 *
 * This proposes and never writes. The measured precision does not support writing: on the
 * same shape, 47 of 77 proposals pointed at a word that appears in 348 of 761 notes, and a
 * judge that was right about three of four links was confidently wrong about the fourth.
 */
export async function proposeLinks(
  note: { slug: string; title: string; body: string },
  candidates: Array<{ slug: string; title: string }>,
  key: string,
  modelName: string,
  /** The vault's declared note types and its existing tag vocabulary, for routing. */
  vocabulary: { types?: string[]; tags?: string[] } = {},
): Promise<LinkProposalResult> {
  const types = vocabulary.types ?? [];
  const tagVocabulary = vocabulary.tags ?? [];
  if (candidates.length === 0) {
    return { note: note.slug, proposed: [], rejected: [], not_judged: 0 };
  }

  const state = {
    new_note: { id: note.slug, title: note.title, body: note.body.slice(0, 4000) },
    existing_notes: candidates.map(candidate => ({
      id: candidate.slug,
      title: candidate.title,
    })),
  };

  const questions: Record<string, unknown> = {};
  for (const candidate of candidates) {
    questions[`link::${candidate.slug}`] = {
      type: 'noul',
      instructions:
        `Does new_note refer to existing_notes[id=${candidate.slug}] specifically, rather `
        + 'than merely sharing a word with it?',
      criteria: {
        true: `The new note means ${candidate.title} itself.`,
        false:
          'The name is absent, or names a different organization, person or version; a shared '
          + 'word is not a reference.',
      },
    };
  }

  // Routing, asked in the same request. Their docs say questions are evaluated in parallel
  // and that adding them barely changes latency, and this measures it as +7 ms on our data.
  // `OTHER` is the fallback a `choice` needs: without one the model still picks from the
  // closed set on input that fits nothing, which is how a note gets routed to a type it is not.
  if (types.length > 0) {
    // The fallback key must not collide with a declared type. Spreading it last meant a vault
    // that legitimately declares a type named like the sentinel lost that type's criterion.
    const fallbackKey = types.includes(OTHER_TYPE) ? `${OTHER_TYPE}_OPTION` : OTHER_TYPE;
    questions.note_type = {
      type: 'choice',
      instructions: 'Which single type best describes new_note?',
      criteria: {
        ...Object.fromEntries(types.map(t => [t, `A ${t} note.`])),
        [fallbackKey]: 'None of the declared types fits.',
      },
    };
  }
  // Tags are multi-label, so this is several `noul`s and not one `choice`: a `choice` is a
  // closed set with a fallback, which can express "one of these" but not "any of these,
  // possibly several". The earlier single-`choice` version could only ever return one tag.
  for (const tag of tagVocabulary) {
    questions[`tag::${tag}`] = {
      type: 'noul',
      instructions: `Does the existing tag "${tag}" apply to new_note?`,
      criteria: { true: `The ${tag} tag applies.`, false: `It does not apply.` },
    };
  }

  const answers = (await postQuestions(key, modelName, state, questions))
    .answers as Record<string, { noul?: number; choice?: string; confidence?: number }> | undefined ?? {};

  const proposed: LinkProposal[] = [];
  const rejected: LinkProposal[] = [];
  for (const candidate of candidates) {
    const probability = answers[`link::${candidate.slug}`]?.noul;
    const entry: LinkProposal = {
      target: candidate.slug,
      target_title: candidate.title,
      link_probability: typeof probability === 'number' ? Math.round(probability * 100) / 100 : 0,
    };
    if (typeof probability === 'number' && probability >= LINK_THRESHOLD) proposed.push(entry);
    else rejected.push(entry);
  }
  proposed.sort((a, b) => b.link_probability - a.link_probability);

  const rawType = answers.note_type?.choice;
  // The fallback sentinel is not a note type, and returning it verbatim proposed `OTHER` as one.
  // Both the plain sentinel and the de-collided variant are fallbacks, not types. Filtering
  // only `OTHER` let `OTHER_OPTION` be proposed as a note type in a vault that declares OTHER.
  const isFallbackType = typeof rawType === 'string'
    && (rawType === OTHER_TYPE || rawType === `${OTHER_TYPE}_OPTION`);
  const noteType = typeof rawType === 'string' && !isFallbackType ? rawType : undefined;
  const pickedTags = tagVocabulary.filter(tag => (answers[`tag::${tag}`]?.noul ?? 0) >= LINK_THRESHOLD);

  return {
    note: note.slug,
    proposed,
    rejected,
    not_judged: 0,
    note_type: noteType,
    tags: pickedTags.length > 0 ? pickedTags : undefined,
  };
}
