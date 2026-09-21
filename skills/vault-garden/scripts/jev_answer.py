#!/usr/bin/env python3
"""Answer a question from a Granite pool: the graph narrows, Jev selects, code decides.

Input comes from `granite pool <anchor> --json`, so the candidate set is chosen by
deterministic code inside Granite rather than re-derived here. That separation matters:
a first version walked the graph in Python and ordered the pool by lexical overlap with
the question, which reintroduced the exact failure this exists to fix — the note holding
the answer was one hop away and shared no vocabulary with the English question, so it was
pushed out and the answer was reported absent.

Why the shape is what it is
--------------------------
Measured on a real vault, `granite search` finds the note that answers a question only
**13% of the time** when the question is asked in a different language than the note was
written in. The graph is language-independent, so it supplies recall and the model
supplies the selection -- which is the judgment it is measurably good at (mean
within-source AUC 0.973 across 78 candidates).

The absence verdict is read from the RANKING, not from an absolute question. An absolute
"does the pool contain an answer?" Noul gave a false negative on the case whose answer was
in the pool at rank 3 (it read 0.25 while the answering note scored 1.38). Measured
separation: 1.38 when an answer exists, 0.21 when it does not.

Usage
-----
    granite pool monka-care --limit 30 --json | python3 jev_answer.py "<question>"

Read-only. Nothing is written to the vault.
"""
from __future__ import annotations

import argparse, json, os, re, sys
from pathlib import Path
from typing import Any

sys.path.insert(0, str(Path(__file__).resolve().parent))
from jev_judge import DEFAULT_MODEL, post_questions  # noqa: E402

# Relevance is a 0-3 Score. The cut sits between the two measured values: an answerable
# question scored 1.38, a control verified absent scored 0.21.
ANSWERED_AT = 1.0
ABSENT_BELOW = 0.5

RELEVANCE_LEVELS = [
    "Does not address the question.",
    "Mentions the topic but does not answer the question.",
    "Partially answers it, or answers only part of it.",
    "Directly and specifically answers the question.",
]


def build_questions(candidates: list[dict[str, Any]]) -> dict[str, Any]:
    questions: dict[str, Any] = {
        # Kept as context, never as the decision: absolute judgments were unreliable.
        "pool_has_answer": {
            "type": "noul",
            "instructions": (
                "Does any candidate_note state the answer to the question? Answer yes only "
                "if a note states it, not merely discusses the topic."
            ),
            "criteria": {
                "true": "At least one note states or directly implies the answer.",
                "false": "No note states the answer.",
            },
        },
    }
    for candidate in candidates:
        cid = candidate["slug"]
        questions[f"rel::{cid}"] = {
            "type": "score",
            "instructions": (
                f"How directly does candidate_notes[id={cid}] answer the question? Judge "
                "only that note. A note that merely discusses the topic is not an answer."
            ),
            "criteria": RELEVANCE_LEVELS,
        }
        sentences = candidate.get("sentences") or []
        if sentences:
            questions[f"ev::{cid}"] = {
                "type": "choice",
                "instructions": (
                    f"Which sentence of candidate_notes[id={cid}] carries the answer? "
                    "Choose none if that note does not answer the question."
                ),
                "criteria": {f"s{i}": None for i in range(len(sentences))}
                | {"none": "No sentence answers it."},
            }
    return questions


def evidence_sentence(picked: Any, sentences: list[str]) -> str | None:
    """Resolve the sentence the model cited, or ``None`` when it cited nothing usable.

    Only ``s<digits>`` names a sentence; the criteria the model is given are ``s0..sN``
    plus ``none``. A loose ``startswith("s")`` accepted two wrong shapes: ``"sentence2"``
    (``int()`` raised and the whole answer lost its evidence) and ``"s-1"`` (which resolved
    to the *last* sentence, presenting a real quote the model never cited). An
    unrecognised token is no evidence, which is the honest reading.
    """
    match = re.fullmatch(r"s(\d+)", picked) if isinstance(picked, str) else None
    if match is None:
        return None
    index = int(match.group(1))
    return sentences[index] if index < len(sentences) else None


def main(argv: list[str]) -> int:
    ap = argparse.ArgumentParser(description="Answer a question from a Granite pool.")
    ap.add_argument("question")
    ap.add_argument("--pool", help="pool JSON file (default: stdin)")
    ap.add_argument("--top", type=int, default=5, help="results to show")
    ap.add_argument("--model", default=os.environ.get("TYPESAFE_MODEL", DEFAULT_MODEL))
    ap.add_argument("--json", action="store_true")
    args = ap.parse_args(argv)

    key = os.environ.get("TYPESAFE_API_KEY")
    if not key:
        print(json.dumps({"status": "unavailable", "reason": "missing TYPESAFE_API_KEY"}, indent=2))
        return 0

    raw = Path(args.pool).read_text() if args.pool else sys.stdin.read()
    if not raw.strip():
        print(json.dumps({
            "status": "empty",
            "hint": "pipe a pool in: granite pool <anchor> --json | python3 jev_answer.py \"<question>\"",
        }, indent=2))
        return 0
    # A failed `granite pool` call returns {"success": false, "error": ...}. Reading it as
    # an empty pool reported "absent", so "the command broke" looked identical to "the
    # vault has no answer" -- the two must never be confusable. Every malformed shape is
    # checked before anything is read from it, including a top-level scalar or list, which
    # previously escaped as an AttributeError traceback with no structured verdict.
    def fail(reason: str) -> int:
        print(json.dumps({"status": "error", "answer_verdict": None, "reason": reason},
                         indent=2, sort_keys=True))
        return 1

    try:
        payload = json.loads(raw)
    except json.JSONDecodeError as exc:
        return fail(f"pool input is not JSON: {exc.msg}")

    if not isinstance(payload, dict):
        return fail(f"expected a JSON object from `granite pool --json`, got {type(payload).__name__}")
    if payload.get("success") is False:
        return fail(payload.get("error") or "granite pool reported failure")

    pool = payload.get("data", payload)
    if not isinstance(pool, dict) or not isinstance(pool.get("candidates"), list):
        return fail("unrecognised pool payload; expected the output of `granite pool --json`")
    candidates = pool["candidates"]
    if not candidates:
        print(json.dumps({
            "status": "ok", "answer_verdict": "absent", "top_relevance": 0.0,
            "reason": "the pool is empty: nothing is reachable from this anchor",
            "anchor": pool.get("anchor"),
        }, indent=2, sort_keys=True))
        return 0

    response = post_questions(key, args.model, {
        "question": args.question,
        "candidate_notes": [
            {"id": c["slug"], "title": c["title"], "type": c["type"],
             "sentences": {f"s{i}": s for i, s in enumerate(c.get("sentences") or [])}}
            for c in candidates
        ],
    }, build_questions(candidates))
    answers = response.get("answers", {})

    ranked = []
    for candidate in candidates:
        cid = candidate["slug"]
        score = float(answers.get(f"rel::{cid}", {}).get("score", 0.0))
        sentences = candidate.get("sentences") or []
        picked = answers.get(f"ev::{cid}", {}).get("choice")
        evidence = evidence_sentence(picked, sentences)
        ranked.append({
            "slug": cid, "title": candidate["title"], "type": candidate["type"],
            "distance": candidate.get("distance"),
            "score": round(score, 2), "evidence": evidence,
        })
    ranked.sort(key=lambda r: -r["score"])

    top_score = ranked[0]["score"]
    if top_score >= ANSWERED_AT:
        verdict = "answered"
    elif top_score < ABSENT_BELOW:
        verdict = "absent"
    else:
        verdict = "partial"

    out = {
        "status": "ok",
        "question": args.question,
        "anchor": pool.get("anchor"),
        "model": response.get("model", args.model),
        "usage": response.get("usage", {}),
        "pool_size": len(candidates),
        "answer_verdict": verdict,
        "top_relevance": round(top_score, 3),
        "pool_has_answer": round(float(answers.get("pool_has_answer", {}).get("noul", 0.0)), 3),
        "thresholds": {"answered_at": ANSWERED_AT, "absent_below": ABSENT_BELOW},
        "results": ranked,
    }
    if args.json:
        print(json.dumps(out, indent=2, sort_keys=True))
        return 0

    print(f'Q: {args.question}')
    print(f'   {verdict.upper()}  (top relevance {top_score:.2f}, pool {len(candidates)} notes, '
          f'{response.get("usage", {}).get("input_tokens", "?")} tokens)')
    if verdict == "absent":
        print('   Nothing in this pool states the answer. Reporting absence beats returning')
        print('   the least-bad match, which is what a search always does.')
    for row in ranked[: args.top]:
        if row["score"] < ABSENT_BELOW:
            continue
        print(f'   [{row["score"]:.2f}] {row["title"][:64]}')
        if row["evidence"]:
            print(f'          "{row["evidence"][:120]}"')
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
