#!/usr/bin/env python3
"""Answer a question from the vault: the graph narrows, Jev selects, code decides.

Why this shape
--------------
Measured on a real vault, the shipped lexical search finds the note that answers a
question only 13% of the time when the question is asked in a different language than
the note was written in — and it failed even on words the two languages share (43 notes
contained "migration"; the right one was not in the top ten).

The link graph does not have that problem. So:

1. **Code** narrows using the graph: an entity, its neighbours, and the notes those link
   to. Deterministic, free, language-independent. 761 notes become a few dozen.
2. **Jev** answers three questions about the pool in ONE request per note:
   - `has_answer` (Noul) — does the corpus address the question at all?
   - `relevance` (Score) — how directly does this note answer it?
   - `evidence` (Choice) — which of the note's own sentences carries the answer?
3. **Code** applies thresholds and reports absence when `has_answer` is low.

The question matters. Asking "is this related?" ranked two generic explainers above the
note containing the figure. Asking "does this answer the question, and which sentence
proves it?" is a different, narrower judgment.

Usage
-----
    python3 jev_ask.py "<question>" [--about <entity-slug>] [--limit N] [--json]

Read-only. Nothing is written to the vault.
"""
from __future__ import annotations

import argparse, json, os, re, sqlite3, sys
from pathlib import Path
from typing import Any

sys.path.insert(0, str(Path(__file__).resolve().parent))
from jev_judge import DEFAULT_MODEL, granite_db, post_questions  # noqa: E402

# Cut points for the absence judgment. Measured absent answers read low, but the
# boundary is wording-dependent, so it is reported and tunable rather than hidden.
FOUND = 0.7
ABSENT = 0.35

RELEVANCE_LEVELS = [
    "Does not address the question.",
    "Mentions the topic but does not answer the question.",
    "Partially answers it, or answers only part of it.",
    "Directly and specifically answers the question.",
]


def sentences(body: str, limit: int) -> list[dict[str, str]]:
    """Candidate sentences, chosen deterministically so recall stays in code."""
    text = re.sub(r"\A---\n[\s\S]*?\n---\s*", " ", body)
    text = re.sub(r"```[\s\S]*?```", " ", text)
    parts = re.split(r"(?<=[.!?])\s+|\n+", text)
    out = []
    for raw in parts:
        line = raw.strip().lstrip("-*| ").strip()
        line = re.sub(r"\*\*|__|`", "", line)
        line = re.sub(r"\s{2,}", " ", line).strip()
        if 30 <= len(line) <= 400:
            out.append(line)
    return out[:limit]


def neighbours(con: sqlite3.Connection, slug: str, depth: int = 2) -> list[tuple[str, int]]:
    """The graph pool as (slug, hops), nearest first.

    Truncating this pool matters more than its size. A first version sorted it
    alphabetically and kept the first twelve; the note that answered the question was
    one hop away but arrived later in the alphabet, so a correct answer was reported
    absent. Distance is the signal that matters, so it is returned with each candidate.
    """
    seen: dict[str, int] = {}
    frontier = {slug}
    for hop in range(1, depth + 1):
        nxt: set[str] = set()
        for s in frontier:
            for (t,) in con.execute(
                "SELECT target_slug FROM links WHERE source_slug=? AND target_slug IS NOT NULL", (s,)):
                nxt.add(t)
            for (t,) in con.execute("SELECT source_slug FROM links WHERE target_slug=?", (s,)):
                nxt.add(t)
        nxt -= set(seen) | {slug}
        for t in nxt:
            seen[t] = hop
        frontier = nxt
    return sorted(seen.items(), key=lambda kv: (kv[1], kv[0]))


def main(argv: list[str]) -> int:
    ap = argparse.ArgumentParser(description="Answer a question from the vault's graph.")
    ap.add_argument("question")
    ap.add_argument("--about", help="start from this entity's graph instead of the whole vault")
    ap.add_argument("--limit", type=int, default=12, help="notes to judge")
    ap.add_argument("--depth", type=int, default=2)
    ap.add_argument("--sentences", type=int, default=6)
    ap.add_argument("--model", default=os.environ.get("TYPESAFE_MODEL", DEFAULT_MODEL))
    ap.add_argument("--vault", default=os.environ.get("GRANITE_VAULT"))
    ap.add_argument("--json", action="store_true")
    args = ap.parse_args(argv)

    key = os.environ.get("TYPESAFE_API_KEY")
    if not key:
        print(json.dumps({"status": "unavailable", "reason": "missing TYPESAFE_API_KEY"}, indent=2))
        return 0

    vault = Path(args.vault).expanduser() if args.vault else Path.home() / ".granite"
    con = sqlite3.connect(f"file:{granite_db(vault)}?mode=ro", uri=True)

    if args.about:
        row = con.execute("SELECT title FROM notes WHERE slug=?", (args.about,)).fetchone()
        if not row:
            print(json.dumps({"status": "error", "reason": f"no note {args.about}"}, indent=2))
            return 1
        pool = [s for s, _ in neighbours(con, args.about, args.depth)] + [args.about]
    else:
        # No anchor: fall back to the whole vault, which is why --about matters for cost.
        pool = [r[0] for r in con.execute("SELECT slug FROM notes WHERE length(body)>800")]

    # Order by graph distance only. Ranking by lexical overlap with the question would
    # reintroduce the exact failure this layer exists to fix: the note that answered the
    # first test question was one hop away and shared no vocabulary with the English
    # question, so a lexical pre-rank pushed it out of the pool and the answer was
    # reported absent. The graph is the language-independent signal; use that.

    docs: list[dict[str, Any]] = []
    for slug in pool[: args.limit]:
        r = con.execute("SELECT title,type,body FROM notes WHERE slug=?", (slug,)).fetchone()
        if not r:
            continue
        docs.append({"slug": slug, "title": r[0], "type": r[1],
                     "sentences": sentences(r[2] or "", args.sentences)})
    con.close()

    if not docs:
        print(json.dumps({"status": "ok", "answer": "absent", "reason": "no candidates"},
                         indent=2, sort_keys=True))
        return 0

    questions: dict[str, Any] = {
        # Absence is asked once, over the whole pool, not per note.
        "pool_has_answer": {
            "type": "noul",
            "instructions": (
                "Does any candidate_note answer the question? Answer yes only if at least "
                "one note states the answer, not merely discusses the topic."
            ),
            "criteria": {
                "true": "At least one candidate note states or directly implies the answer.",
                "false": "No candidate note states the answer; at most they discuss the topic.",
            },
        },
    }
    for d in docs:
        sid = d["slug"]
        questions[f"rel::{sid}"] = {
            "type": "score",
            "instructions": (
                f"How directly does candidate_notes[id={sid}] answer the question? "
                "Judge only that note."
            ),
            "criteria": RELEVANCE_LEVELS,
        }
        if d["sentences"]:
            questions[f"ev::{sid}"] = {
                "type": "choice",
                "instructions": (
                    f"Which sentence of candidate_notes[id={sid}] carries the answer? "
                    "Choose none if that note does not answer the question."
                ),
                "criteria": {f"s{i}": None for i in range(len(d["sentences"]))} | {"none": "No sentence answers it."},
            }

    response = post_questions(key, args.model, {
        "question": args.question,
        "candidate_notes": [{"id": d["slug"], "title": d["title"], "type": d["type"],
                             "sentences": {f"s{i}": s for i, s in enumerate(d["sentences"])}}
                            for d in docs],
    }, questions)
    answers = response.get("answers", {})
    pool_has = float(answers.get("pool_has_answer", {}).get("noul", 0.0))

    ranked = []
    for d in docs:
        sid = d["slug"]
        score = float(answers.get(f"rel::{sid}", {}).get("score", 0.0))
        picked = answers.get(f"ev::{sid}", {}).get("choice")
        evidence = None
        if picked and picked != "none" and picked.startswith("s"):
            idx = int(picked[1:])
            if idx < len(d["sentences"]):
                evidence = d["sentences"][idx]
        ranked.append({"slug": sid, "title": d["title"], "type": d["type"],
                       "score": round(score, 2), "evidence": evidence})
    ranked.sort(key=lambda r: -r["score"])

    if pool_has >= FOUND:
        verdict = "answered"
    elif pool_has < ABSENT:
        verdict = "absent"
    else:
        verdict = "partial"

    out = {
        "status": "ok",
        "question": args.question,
        "model": response.get("model", args.model),
        "usage": response.get("usage", {}),
        "anchor": args.about,
        "pool_size": len(docs),
        "answer_verdict": verdict,
        "pool_has_answer": round(pool_has, 3),
        "thresholds": {"found": FOUND, "absent": ABSENT},
        "results": ranked,
    }
    if args.json:
        print(json.dumps(out, indent=2, sort_keys=True))
        return 0

    print(f'Q: {args.question}')
    print(f'   {verdict.upper()}  (pool_has_answer={pool_has:.2f}, '
          f'pool={len(docs)} notes, {response.get("usage", {}).get("input_tokens", "?")} tokens)')
    if verdict == "absent":
        print('   No candidate states the answer. Reporting absence rather than the')
        print('   least-bad match is the point: a search always returns something.')
    for r in ranked[:5]:
        if r["score"] < 1.0:
            continue
        print(f'   [{r["score"]:.2f}] {r["title"][:64]}')
        if r["evidence"]:
            print(f'          “{r["evidence"][:120]}”')
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
