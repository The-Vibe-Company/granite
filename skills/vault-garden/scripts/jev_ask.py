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
2. **Jev** answers questions about the pool in ONE request per note:
   - `relevance` (Score) — how directly does this note answer it?
   - `evidence` (Choice) — which of the note's own sentences carries the answer?
3. **Code** decides: absence is derived from the RANKING (the best relevance score), not
   from a separate absolute question. An absolute "does the pool have an answer?" Noul was
   tried and gave a false negative on a case whose answer sat in the pool at rank 3.

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
from jev_answer import evidence_sentence  # noqa: E402

# The absence verdict is derived from the RANKING, not from an absolute question.
#
# An absolute "does the pool contain an answer?" Noul was tried first and gave a false
# negative on a case whose answer was in the pool at rank 3: it read 0.25 while the
# note that answered scored 1.38 in the ranking. The pattern held across the session -
# Jev ranks well *within* a set and is unreliable at absolute judgments - so the signal
# is the best relevance score.
#
# Measured on a real vault (relevance runs 0 to 3):
#   answerable question, answer in the pool   -> top score 1.38
#   unanswerable control, verified absent      -> top score 0.21
# A 6.6x separation, so the cut sits between them.
ANSWERED_AT = 1.0
ABSENT_BELOW = 0.5

RELEVANCE_LEVELS = [
    "Does not address the question.",
    "Mentions the topic but does not answer the question.",
    "Partially answers it, or answers only part of it.",
    "Directly and specifically answers the question.",
]


def sentences(body: str, limit: int) -> list[str]:
    """Candidate sentences, chosen deterministically so recall stays in code.

    This mirrors `candidateSentences` in `src/core/about.ts`, which is the canonical
    implementation; the product emits its candidates to JSON and `jev_answer.py` consumes
    them, so no Python copy is shipped. Keep the two in step: this prototype used to keep
    headings while the shipped extractor dropped them, so the set it judged was not the set
    the product produces and the calibration in this file described an unreproducible run.

    There is deliberately **no frontmatter strip**. An earlier version carried one, on the
    assumption that this reads raw note files. It reads the index database, whose `body`
    column is already post-frontmatter — verified across all 761 notes, none begins with a
    delimiter — so the strip could only ever fire on a real body that opens with a
    horizontal rule, deleting the content between the rules. That is the same mistake
    `src/core/about.ts` documents at length, and the fix is the same: do not have the strip.

    JavaScript and Python do not agree on every character, so this is not a byte-for-byte
    port. Four mechanisms differ, none of them exercised by the product or by the calibration
    corpus (audited: no body in the vault contains any of the code points below):

    1. The 30..400 window counts UTF-16 units in JS and code points here, so a run of astral
       characters can fall inside one window and outside the other.
    2. Whitespace classes differ: U+FEFF and U+0085 are whitespace to Python and not to JS,
       while U+001C-001F are whitespace to JS and not to Python. That changes both `strip`
       and the `(?<=[.!?])\\s+` split.
    3. JS `.` and `$` treat `\\r`, U+2028 and U+2029 as line terminators; Python's do not.
       The heading pattern above is therefore anchored differently, so a heading followed by
       a lone `\\r` is dropped here and kept there (a plain-ASCII trigger, unlike the rest).
    4. A list marker interleaved with whitespace around a tab (`-\\t- item`) is stripped by JS
       and only partly stripped here.

    `test_jev_ask.py` checks this copy against the sentences the shipped CLI actually emits,
    so real drift fails there instead of quietly changing what gets judged.
    """
    if limit <= 0:
        return []
    text = re.sub(r"```[\s\S]*?```", " ", body)
    text = re.sub(r"^#{1,6}\s.*$", " ", text, flags=re.M)
    out: list[str] = []
    for raw in re.split(r"(?<=[.!?])\s+|\n+", text):
        line = re.sub(r"\*\*|__|`", "", raw)
        line = re.sub(r"\s{2,}", " ", line)
        line = line.strip().lstrip("-*| ").strip()
        if 30 <= len(line) <= 400:
            out.append(line)
            if len(out) >= limit:
                break
    return out


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
        # The anchor goes FIRST: appended last it was truncated away by --limit, so the
        # note the caller anchored on was never judged.
        pool = [args.about] + [s for s, _ in neighbours(con, args.about, args.depth)]
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
        # Same strict parse as the shipped consumer: only `s<digits>` names a sentence.
        # A loose `startswith("s")` mapped "s-1" onto the last sentence and raised on
        # "sentence2", which presents a quote the model never cited.
        evidence = evidence_sentence(picked, d["sentences"])
        ranked.append({"slug": sid, "title": d["title"], "type": d["type"],
                       "score": round(score, 2), "evidence": evidence})
    ranked.sort(key=lambda r: -r["score"])

    # The ranking decides; the pool-level Noul is reported alongside as context.
    top_score = ranked[0]["score"] if ranked else 0.0
    if top_score >= ANSWERED_AT:
        verdict = "answered"
    elif top_score < ABSENT_BELOW:
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
        "top_relevance": round(top_score, 3),
        "pool_has_answer": round(pool_has, 3),
        "thresholds": {"answered_at": ANSWERED_AT, "absent_below": ABSENT_BELOW},
        "results": ranked,
    }
    if args.json:
        print(json.dumps(out, indent=2, sort_keys=True))
        return 0

    print(f'Q: {args.question}')
    print(f'   {verdict.upper()}  (top relevance {top_score:.2f}, '
          f'pool_has_answer {pool_has:.2f}, pool={len(docs)} notes, '
          f'{response.get("usage", {}).get("input_tokens", "?")} tokens)')
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
