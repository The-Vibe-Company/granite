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
 * The largest request body this client will send, in bytes.
 *
 * The API's limit is a **token** limit, not a byte limit: over it the gateway answers HTTP 400 with
 * `error_type: max_tokens_exceeded`. The boundary in bytes therefore depends on the content's token
 * density, so it was measured at both densities with real requests against the live endpoint:
 *
 * - a run of one repeated character — the densest content tested — is accepted at 130,800 bytes and
 *   rejected at 131,000;
 * - ordinary prose is accepted at 133,829 bytes and rejected at 139,919.
 *
 * 128,000 therefore sits ~2 % below the measured worst-density boundary, and the trim below measures
 * the real wire body against it. Earlier values were inferred rather than measured: the original
 * ~1.03 KB-per-candidate estimate under-counted by half, and the first byte guard reused the 142 KB
 * of a payload that had been rejected, while 94-100 KB was the biggest body known to be accepted.
 */
export const MAX_REQUEST_BYTES = 128_000;

/**
 * The bytes the wire body spends on everything that is not the state or the question set: the two
 * wrapper keys, `{"state":…,"questions":…}`. The `model` field is added by the caller that knows the
 * name, so a caller-overridden `TYPESAFE_MODEL` cannot silently eat this reserve — 64 bytes is
 * generous for ~34 bytes of keys.
 */
const WIRE_OVERHEAD_BYTES = 64;

/**
 * Fit the pool inside its byte budget by measuring the body, not by estimating it.
 *
 * Three estimates here were wrong in the same way and each cost a behavioural regression: the
 * first ceiling assumed ~1.03 KB per candidate against a real ~2.05 KB; the first trim assumed
 * ~2.1 KB per candidate against a real ~1.65 KB; and the first question charge assumed the
 * question's length was the only cost, at 60 bytes per character, which under-reserved the fixed
 * ~860 bytes per candidate that its relevance question and criteria cost. That third estimate is
 * why an ordinary 80-character question was REFUSED at the tool's own default while a
 * 45-character one passed. So the caller passes a `measure` callback over the real wire body and
 * this shrinks the excerpt until that body fits.
 *
 * Shrinking is spread across **every** candidate. An earlier version stripped sentences from the
 * farthest ones, and the note that answered - measured at rank 54 of 60 - was farthest, so the
 * citation vanished while the note stayed in the pool. Position is not relevance.
 */
export function trimToByteBudget<T extends { sentences: string[] }>(
  candidates: T[],
  budget: number,
  sentencesPerNote: number,
  measure: (candidates: T[]) => number,
): T[] {
  if (candidates.length === 0 || measure(candidates) <= budget) return candidates;

  const withCount = (perCandidate: number) => candidates.map(candidate => ({
    ...candidate,
    sentences: candidate.sentences.slice(0, perCandidate),
  }));

  // The most sentences per candidate that still fits, searched from generous to minimal so a
  // short question keeps everything it asked for.
  let best = withCount(1);
  for (let perCandidate = sentencesPerNote; perCandidate >= 1; perCandidate--) {
    const attempt = withCount(perCandidate);
    if (measure(attempt) <= budget) return attempt;
    best = attempt;
  }

  // Even one sentence each is too much: shorten the excerpts rather than delete any candidate text,
  // because truncation loses a clause and deletion loses the answer.
  for (const width of [200, 120, 60]) {
    const shortened = best.map(candidate => ({
      ...candidate,
      sentences: candidate.sentences.map(sentence => sentence.slice(0, width)),
    }));
    if (measure(shortened) <= budget) return shortened;
    best = shortened;
  }

  // The caller asked for more than any request can carry. Only now do candidates go, and every
  // remaining one still carries text — a titles-only pool has nothing to shorten, which is the path
  // that reaches here. The largest prefix that fits is found by bisection, not by repeated 25% cuts:
  // a 200-note pool whose body was 593 bytes over the ceiling lost 50 notes to that step.
  let kept = best;
  if (kept.length > 1 && measure(kept) > budget) {
    // Monotone: a longer prefix is never smaller, so the first count that does not fit bounds the
    // last one that does.
    let lo = 1;
    let hi = kept.length;
    while (lo < hi) {
      const mid = Math.ceil((lo + hi) / 2);
      if (measure(kept.slice(0, mid)) <= budget) lo = mid;
      else hi = mid - 1;
    }
    kept = kept.slice(0, lo);
  }
  return kept;
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
  /**
   * What the measured request ceiling did to this pool, or nothing when it left the pool alone.
   *
   * `ranked` always lists exactly what was sent, so this is the difference between "the vault has
   * nothing more" and "the request could not carry more".
   */
  request_trim?: {
    candidates_in_pool: number;
    candidates_sent: number;
    /** True when excerpts were shortened to fit, which happens before any candidate is dropped. */
    excerpts_shortened: boolean;
  };
  reason?: string;
}

/**
 * Every note a verdict did not judge, with the bound that left it out.
 *
 * Two different bounds drop notes and they are known in different places: the candidate limit shows
 * up in `by_distance`, which describes the POOL, and the request ceiling in `request_trim`, which
 * describes what was SENT. Rendering only the first made a real titles-only answer read "Judged 201
 * of 363; not judged: 108" — 201 + 108 = 309. Both together always add up to `reachable - judged`.
 */
export function unjudgedNotes(
  verdict: AnswerVerdict,
): Array<{ bound: 'limit' | 'ceiling'; distance?: number; count: number }> {
  const rows: Array<{ bound: 'limit' | 'ceiling'; distance?: number; count: number }> = [];
  for (const band of verdict.by_distance ?? []) {
    if (band.shown < band.reachable) {
      rows.push({ bound: 'limit', distance: band.distance, count: band.reachable - band.shown });
    }
  }
  const trim = verdict.request_trim;
  const dropped = (trim?.candidates_in_pool ?? 0) - (trim?.candidates_sent ?? 0);
  if (dropped > 0) rows.push({ bound: 'ceiling', count: dropped });
  return rows;
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

/** The one shape both the state and the question set are built from. */
function assembleState(pool: EntityPool, question: string, candidates = pool.candidates) {
  return {
    question,
    candidate_notes: candidates.map(candidate => ({
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
 * The bytes this candidate set will actually put on the wire: the state AND the question set.
 *
 * The question set is not a rounding error. Measured at 60 candidates carrying six sentences each
 * it is 46,395 B — 773 B per candidate of relevance question, criteria and evidence options — and
 * 78,517 B at 200 titles-only candidates, 393 B each. It does not depend on the question's length
 * at all, because the question lives once in the state and every `ev::` question names that field.
 * That was not always true: with the question restated inside every `ev::` instruction, the same 60
 * candidates cost 54,315 B at a 45-character question and 61,695 B at 200, so a budget that charged
 * only `question.length * 60` under-reserved by ~50 KB and refused an ordinary question at the
 * tool's own default. Measuring the body instead of modelling it is what closed that.
 *
 * `state` and `questions` are assembled from the SAME candidate list passed in, so what is
 * measured here is what gets sent.
 */
export function requestBytes(
  pool: EntityPool,
  question: string,
  candidates = pool.candidates,
  modelName = '',
): number {
  const body = { state: assembleState(pool, question, candidates), questions: questionsFor(pool, candidates) };
  // The model name is measured, not allowed for: it is caller-overridable, and a name long enough
  // would otherwise turn the reserve into an under-reserve and make `postQuestions` refuse a body
  // this selector approved.
  return Buffer.byteLength(JSON.stringify(body), 'utf8')
    + WIRE_OVERHEAD_BYTES + Buffer.byteLength(modelName, 'utf8');
}

/** The most sentences any candidate in this pool carries — what the caller asked for, as built. */
function sentencesPerNote(candidates: EntityPool['candidates']): number {
  return candidates.reduce((most, candidate) => Math.max(most, candidate.sentences.length), 0);
}

/**
 * The candidate set every builder uses: the whole pool when the real wire body fits, a uniformly
 * shorter one when it does not.
 *
 * Exported because it is the deterministic half of the answer path — `judgePool` ranks exactly
 * this set, so the ranking, the "judged N of M" count and the questions asked all describe the
 * same notes rather than three different ones.
 */
export function selectCandidates(
  pool: EntityPool,
  question: string,
  modelName = '',
): EntityPool['candidates'] {
  return trimToByteBudget(
    pool.candidates,
    MAX_REQUEST_BYTES,
    sentencesPerNote(pool.candidates),
    // Measured on the real wire body, state plus question set. Measuring a reduced shape let two
    // callers settle on different sets — one test caught them disagreeing by a single candidate —
    // and measuring the state alone reserved nothing for the ~770 bytes per candidate the
    // relevance and evidence questions cost.
    candidates => requestBytes(pool, question, candidates, modelName),
  );
}

/** The pool as the state Jev reads: the question, then one entry per candidate. */
export function buildState(pool: EntityPool, question: string) {
  // Trimming here — rather than refusing upstream — is what keeps the tool working at its own
  // default pool size: a 60-candidate pool of ordinary notes is already over the ceiling.
  // The state carries the question. It MUST: every `rel::` question says "the question" without
  // restating it, and questions are evaluated independently, so a state without it asks Jev to
  // score relevance to nothing. The ranking, `top_score` and the verdict all come from those
  // scores, and the thresholds were calibrated with the question present.
  return assembleState(pool, question, selectCandidates(pool, question));
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
  return questionsFor(pool, selectCandidates(pool, questionText));
}

/**
 * The question set for one specific candidate list.
 *
 * It takes no question text on purpose: every question here refers to the state's `question`
 * field, which is assembled from the same call, so a long question costs the request nothing.
 */
function questionsFor(pool: EntityPool, candidates: EntityPool['candidates']): Record<string, unknown> {
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
        // The question is named, not restated. Restating it was measured to be necessary once —
        // "which sentence carries the answer?" returned `none` at 0.77 while the sentence stating
        // the figure sat in the list at 0.10 — but that measurement was taken while the state
        // itself omitted the question, so the instruction was the only place it could exist.
        // Head-to-head on the real vault at 60 candidates, two runs per question: the named form
        // cites the answering note on all four answerable questions, while restating the question
        // lost the citation on the long multi-part one (`answered`, top score 1.97, evidence null,
        // twice). Both forms gave identical verdicts, identical top notes and the same refusal on
        // the unanswerable control. Naming it also stops the question's length multiplying against
        // the pool, which is what made an ordinary question overflow the request ceiling.
        instructions:
          `Which single sentence of candidate_notes[id=${id}] states the answer to the question in `
          + "the state's `question` field? Choose the sentence that states it, or none if no "
          + 'sentence does.',
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
  // One selection, used three times: the state that is sent, the questions that are asked, and
  // the ranking that comes back. Ranking `pool.candidates` instead reported every candidate the
  // trim had removed as scored 0 — indistinguishable from a note Jev scored 0 — and inflated the
  // "Judged N of M" count: measured 2 such phantoms at a 45-character question and 16 at 200 on
  // the titles-only path, where the trim was removing notes the real body had room for.
  const candidates = selectCandidates(pool, question, modelName);
  const state = assembleState(pool, question, candidates);
  const answers = (await postQuestions(key, modelName, state, questionsFor(pool, candidates)))
    .answers as Record<string, Record<string, unknown>> | undefined ?? {};

  const ranked: JudgeAnswer[] = candidates.map(candidate => {
    const id = candidate.slug;
    const score = Number(answers[`rel::${id}`]?.score ?? 0);
    const picked = answers[`ev::${id}`]?.choice;
    return {
      slug: id,
      title: candidate.title,
      type: candidate.type,
      distance: candidate.distance,
      score: Math.round(score * 100) / 100,
      // Resolved against the sentences that were actually sent, not the untrimmed ones: an index
      // is only meaningful in the option list Jev was given.
      evidence: evidenceSentence(picked, candidate.sentences),
    };
  });
  ranked.sort((a, b) => b.score - a.score);

  const topScore = ranked.length > 0 ? ranked[0].score : 0;
  const poolHasAnswer = answers.pool_has_answer?.noul;
  // Compared by content, not by count: the width branch (200/120/60-character excerpts) shortens a
  // sentence without changing how many there are, and a count-only test called that an untouched
  // request. Measured on synthetic one-sentence pools, where that branch is the one that runs.
  const before = new Map(pool.candidates.map(candidate => [candidate.slug, candidate.sentences]));
  const excerptsShortened = candidates.some((candidate) => {
    const original = before.get(candidate.slug);
    return original === undefined
      || original.length !== candidate.sentences.length
      || candidate.sentences.some((sentence, index) => sentence !== original[index]);
  });
  const requestTrim = candidates.length !== pool.candidates.length || excerptsShortened
    ? {
      candidates_in_pool: pool.candidates.length,
      candidates_sent: candidates.length,
      excerpts_shortened: excerptsShortened,
    }
    : undefined;

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
    request_trim: requestTrim,
  };
}

/** Above this `noul` probability a capture-time link is proposed. Controls read 0.99/0.01. */
export const LINK_THRESHOLD = 0.5;

/** The `choice` fallback sentinel. A vault type with this name gets a distinct option key. */
const OTHER_TYPE = 'OTHER';

/**
 * A fallback option key that no declared type can be.
 *
 * The obvious one-step de-collision (`OTHER` is taken, so use `OTHER_OPTION`) still collides with
 * a vault that declares both — and that collision is not cosmetic: the fallback is spread last, so
 * the declared type loses its criterion, and the answer filter drops the model's genuine pick.
 * Suffixing until the key is free terminates because the declared set is finite.
 */
function fallbackTypeKey(types: string[]): string {
  let key = OTHER_TYPE;
  while (types.includes(key)) key = `${key}_OPTION`;
  return key;
}

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
    // The fallback key must not collide with a declared type — and a vault may declare any name,
    // `OTHER` and `OTHER_OPTION` included. Spreading it last meant a vault that legitimately
    // declares a type named like the sentinel lost that type's criterion, and filtering the answer
    // by name meant losing its judgment too. So the key is chosen against the declared set.
    questions.note_type = {
      type: 'choice',
      instructions: 'Which single type best describes new_note?',
      criteria: {
        ...Object.fromEntries(types.map(t => [t, `A ${t} note.`])),
        [fallbackTypeKey(types)]: 'None of the declared types fits.',
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
  // It is identified as the key this call actually reserved, not by name: a vault that declares
  // `OTHER` or `OTHER_OPTION` as a real type must not have that judgment thrown away.
  const isFallbackType = typeof rawType === 'string' && rawType === fallbackTypeKey(types);
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
