#!/usr/bin/env python3
"""Measure whether showing already-linked neighbours improves link judgments.

The question
------------
`jev_judge.py` shows the model one source note plus its candidate set. It does
**not** show which notes the source already links to. Without those, the model
cannot tell whether a candidate adds something new or merely restates a
connection the note already has — the two score almost identically.

This script runs both arms on the same source and the same candidates:

* **baseline** — note_a + candidates (what ships today)
* **with_neighbors** — the same, plus note_a's existing link targets as
  comparison points, and criteria that ask for novelty rather than mere overlap

It reports within-source AUC for each arm, pooled precision/recall, and the
breakdown on *ambiguous* candidates: ones that share title vocabulary with a note
the source already links to, which is where a missing reference class should hurt
most.

Read-only. Needs TYPESAFE_API_KEY.

Usage
-----
    python3 measure_neighbor_context.py --sources 8 --targets 5 --distractors 5
    python3 measure_neighbor_context.py --json
"""

from __future__ import annotations

import argparse
import json
import os
import random
import re
import sqlite3
import sys
from pathlib import Path
from typing import Any

sys.path.insert(0, str(Path(__file__).resolve().parent))

from jev_judge import (  # noqa: E402
    DEFAULT_MODEL,
    LEVELS,
    LINK_FALSE,
    LINK_TRUE,
    granite_db,
    load_note,
    post_questions,
)

# Contrasting criteria: the neighbour-aware arm is asked for novelty, so a
# candidate that merely repeats an existing connection should score low.
NEIGHBOR_TRUE = (
    "The candidate adds a connection the source note does not already have, AND "
    "the two notes share a specific entity, project, decision or event."
)
NEIGHBOR_FALSE = (
    "The candidate only overlaps a note the source already links to, adding "
    "nothing new, OR the overlap is a shared common word."
)


def tokens(text: str) -> set[str]:
    stop = {"the", "and", "for", "with", "from", "that", "this", "of", "a", "an"}
    return {
        w.lower()
        for w in re.findall(r"[^\W\d_][\w'-]{3,}", text or "", flags=re.UNICODE)
        if w.lower() not in stop
    }


def pick_sources(con: sqlite3.Connection, count: int, seed: int,
                 min_body: int = 700, min_links: int = 3) -> list[tuple[str, list[str]]]:
    rows = con.execute(
        """
        SELECT l.source_slug, COUNT(DISTINCT l.target_slug) AS links
        FROM links l JOIN notes n ON n.slug = l.source_slug
        WHERE l.target_slug IS NOT NULL AND length(n.body) > ?
        GROUP BY l.source_slug HAVING links >= ?
        ORDER BY links DESC
        """,
        (min_body, min_links),
    ).fetchall()
    rng = random.Random(seed)
    rng.shuffle(rows)
    out: list[tuple[str, list[str]]] = []
    for source_slug, _ in rows:
        targets = [
            s for (s,) in con.execute(
                "SELECT DISTINCT target_slug FROM links WHERE source_slug = ? AND target_slug IS NOT NULL",
                (source_slug,),
            ).fetchall()
            if s != source_slug
        ]
        if len(targets) >= min_links:
            out.append((source_slug, targets))
        if len(out) >= count:
            break
    return out


def build_state(
    source: dict[str, Any],
    candidates: list[dict[str, Any]],
    neighbors: list[dict[str, Any]],
    max_chars: int,
    with_neighbors: bool,
) -> dict[str, Any]:
    state: dict[str, Any] = {
        "note_a": {
            "title": source["title"],
            "type": source["type"],
            "text": source["body"][:max_chars],
        },
        "note_b_candidates": [
            {"id": c["slug"], "title": c["title"], "type": c["type"], "text": c["body"][:max_chars]}
            for c in candidates
        ],
    }
    if with_neighbors:
        state["already_linked_neighbours"] = [
            {"title": n["title"], "type": n["type"], "text": n["body"][:max_chars]}
            for n in neighbors
        ]
    return state


def build_questions(candidates: list[dict[str, Any]], with_neighbors: bool) -> dict[str, Any]:
    true_text = NEIGHBOR_TRUE if with_neighbors else LINK_TRUE
    false_text = NEIGHBOR_FALSE if with_neighbors else LINK_FALSE
    extra = (
        " Compare against already_linked_neighbours: if a candidate only restates "
        "what one of those already provides, do not link it."
        if with_neighbors else ""
    )
    questions: dict[str, Any] = {}
    for candidate in candidates:
        cid = candidate["slug"]
        questions[f"rel::{cid}"] = {
            "type": "score",
            "instructions": f"How related is note_b_candidates[id={cid}] to note_a? Judge only that candidate.",
            "criteria": LEVELS,
        }
        questions[f"link::{cid}"] = {
            "type": "noul",
            "instructions": (
                f"Should note_a contain a wikilink to note_b_candidates[id={cid}]?{extra}"
            ),
            "criteria": {"true": true_text, "false": false_text},
        }
    return questions


def auc(positives: list[float], negatives: list[float]) -> float:
    if not positives or not negatives:
        return 0.0
    wins = sum(1 for p in positives for n in negatives if p > n)
    ties = sum(1 for p in positives for n in negatives if p == n)
    return (wins + 0.5 * ties) / (len(positives) * len(negatives))


def precision_recall(rows: list[dict[str, Any]], key: str, threshold: float) -> dict[str, float]:
    pos = [r for r in rows if r["truth"] == "linked"]
    neg = [r for r in rows if r["truth"] == "distractor"]
    tp = sum(1 for r in pos if r[key] >= threshold)
    fp = sum(1 for r in neg if r[key] >= threshold)
    precision = tp / (tp + fp) if (tp + fp) else 0.0
    recall = tp / len(pos) if pos else 0.0
    return {"precision": round(precision, 3), "recall": round(recall, 3),
            "tp": tp, "fp": fp, "n_pos": len(pos), "n_neg": len(neg)}


def main(argv: list[str]) -> int:
    parser = argparse.ArgumentParser(description="A/B test neighbour context in link judgments.")
    parser.add_argument("--sources", type=int, default=8)
    parser.add_argument("--targets", type=int, default=5)
    parser.add_argument("--distractors", type=int, default=5)
    parser.add_argument("--max-chars", type=int, default=700)
    parser.add_argument("--seed", type=int, default=11)
    parser.add_argument("--threshold", type=float, default=0.25, help="Noul threshold to compare at")
    parser.add_argument("--model", default=os.environ.get("TYPESAFE_MODEL", DEFAULT_MODEL))
    parser.add_argument("--vault", default=os.environ.get("GRANITE_VAULT"))
    parser.add_argument("--json", action="store_true")
    args = parser.parse_args(argv)

    api_key = os.environ.get("TYPESAFE_API_KEY")
    if not api_key:
        print(json.dumps({"status": "unavailable", "reason": "missing TYPESAFE_API_KEY"}, indent=2))
        return 0

    vault = Path(args.vault).expanduser() if args.vault else Path.home() / ".granite"
    con = sqlite3.connect(f"file:{granite_db(vault)}?mode=ro", uri=True)
    usage = {"input_tokens": 0, "output_tokens": 0}
    models: set[str] = set()
    per_source: list[dict[str, Any]] = []
    baseline_rows: list[dict[str, Any]] = []
    neighbor_rows: list[dict[str, Any]] = []

    try:
        sources = pick_sources(con, args.sources, args.seed)
        for index, (source_slug, all_targets) in enumerate(sources):
            source = load_note(con, source_slug)
            rng = random.Random(args.seed + index)
            chosen_targets = rng.sample(all_targets, min(args.targets, len(all_targets)))
            linked = set(chosen_targets)
            pool = [
                s for (s,) in con.execute(
                    "SELECT slug FROM notes WHERE length(body) > 400", ()
                ).fetchall()
                if s != source_slug and s not in linked
            ]
            distractors = rng.sample(pool, min(args.distractors, len(pool)))

            candidates: list[dict[str, Any]] = []
            for slug in chosen_targets:
                note = load_note(con, slug)
                note["truth"] = "linked"
                candidates.append(note)
            for slug in distractors:
                note = load_note(con, slug)
                note["truth"] = "distractor"
                candidates.append(note)
            rng.shuffle(candidates)

            # Neighbours: everything the source links to, not only the sampled ones.
            neighbors = [load_note(con, s) for s in all_targets[:8] if s != source_slug]
            neighbor_tokens = set()
            for n in neighbors:
                neighbor_tokens |= tokens(n["title"])

            # A candidate is "ambiguous" when it echoes a neighbour's vocabulary,
            # i.e. the case a missing reference class should get wrong.
            for c in candidates:
                c["ambiguous"] = bool(tokens(c["title"]) & neighbor_tokens)

            for arm, with_neighbors in (("baseline", False), ("with_neighbors", True)):
                response = post_questions(
                    api_key, args.model,
                    build_state(source, candidates, neighbors, args.max_chars, with_neighbors),
                    build_questions(candidates, with_neighbors),
                )
                answers = response.get("answers", {})
                models.add(response.get("model", args.model))
                for key, value in (response.get("usage") or {}).items():
                    usage[key] = usage.get(key, 0) + int(value or 0)
                scored = []
                for candidate in candidates:
                    cid = candidate["slug"]
                    scored.append({
                        "slug": cid,
                        "truth": candidate["truth"],
                        "ambiguous": candidate["ambiguous"],
                        "score": float(answers.get(f"rel::{cid}", {}).get("score", 0.0)),
                        "noul": float(answers.get(f"link::{cid}", {}).get("noul", 0.0)),
                    })
                if arm == "baseline":
                    baseline_rows.extend(scored)
                else:
                    neighbor_rows.extend(scored)

            pos = [r["noul"] for r in baseline_rows[-len(candidates):] if r["truth"] == "linked"]
            neg = [r["noul"] for r in baseline_rows[-len(candidates):] if r["truth"] == "distractor"]
            npos = [r["noul"] for r in neighbor_rows[-len(candidates):] if r["truth"] == "linked"]
            nneg = [r["noul"] for r in neighbor_rows[-len(candidates):] if r["truth"] == "distractor"]
            per_source.append({
                "source": source_slug,
                "title": source["title"],
                "neighbours": len(neighbors),
                "ambiguous_candidates": sum(1 for c in candidates if c["ambiguous"]),
                "baseline_auc": round(auc(pos, neg), 3),
                "with_neighbors_auc": round(auc(npos, nneg), 3),
            })
    finally:
        con.close()

    def arm_summary(rows: list[dict[str, Any]]) -> dict[str, Any]:
        pos = [r["noul"] for r in rows if r["truth"] == "linked"]
        neg = [r["noul"] for r in rows if r["truth"] == "distractor"]
        amb = [r["noul"] for r in rows if r["ambiguous"] and r["truth"] == "distractor"]
        summary = {
            "auc_noul": round(auc(pos, neg), 3),
            "at_threshold": precision_recall(rows, "noul", args.threshold),
        }
        if amb:
            summary["ambiguous_distractors"] = len(amb)
            summary["ambiguous_median_noul"] = round(sorted(amb)[len(amb) // 2], 3)
        return summary

    base_aucs = [s["baseline_auc"] for s in per_source]
    nb_aucs = [s["with_neighbors_auc"] for s in per_source]
    wins = sum(1 for b, n in zip(base_aucs, nb_aucs) if n > b)
    losses = sum(1 for b, n in zip(base_aucs, nb_aucs) if n < b)

    report = {
        "status": "ok",
        "model": ",".join(sorted(models)),
        "usage": usage,
        "sources": len(per_source),
        "threshold": args.threshold,
        "baseline": arm_summary(baseline_rows),
        "with_neighbors": arm_summary(neighbor_rows),
        "mean_auc": {
            "baseline": round(sum(base_aucs) / len(base_aucs), 3) if base_aucs else None,
            "with_neighbors": round(sum(nb_aucs) / len(nb_aucs), 3) if nb_aucs else None,
        },
        "per_source": per_source,
        "sources_improved": wins,
        "sources_worsened": losses,
        "ambiguous_candidate_count": sum(1 for r in baseline_rows if r["ambiguous"]),
    }

    if args.json:
        print(json.dumps(report, indent=2, sort_keys=True))
        return 0

    print(f"model: {report['model']}   tokens: {usage}")
    print(f"sources: {len(per_source)}   candidates/arm: {len(baseline_rows)}")
    print(f"ambiguous candidates (echo an existing neighbour's vocabulary): "
          f"{report['ambiguous_candidate_count']}")
    print()
    for arm in ("baseline", "with_neighbors"):
        s = report[arm]
        print(f"{arm}:")
        print(f"  AUC (Noul)          {s['auc_noul']}")
        at = s["at_threshold"]
        print(f"  @{args.threshold:.2f}  precision {at['precision']:.2f}  recall {at['recall']:.2f} "
              f"({at['fp']} unrelated passed / {at['n_neg']})")
        if "ambiguous_median_noul" in s:
            print(f"  ambiguous distractors: {s['ambiguous_distractors']} "
                  f"median noul {s['ambiguous_median_noul']}")
    print()
    print(f"mean within-source AUC: baseline {report['mean_auc']['baseline']} -> "
          f"with_neighbors {report['mean_auc']['with_neighbors']}")
    print(f"per source: improved {report['sources_improved']}, worsened {report['sources_worsened']}, "
          f"tied {len(per_source) - report['sources_improved'] - report['sources_worsened']}")
    for s in per_source:
        delta = s["with_neighbors_auc"] - s["baseline_auc"]
        arrow = "improved" if delta > 0 else ("worse" if delta < 0 else "same")
        print(f"  {s['title'][:40]:42s} {s['baseline_auc']:.2f} -> {s['with_neighbors_auc']:.2f}  "
              f"({arrow})  neighbours={s['neighbours']}")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
