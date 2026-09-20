#!/usr/bin/env python3
"""Measure and calibrate the Jev link judgment on labelled data from your vault.

What this measures
------------------
The shipped judgment (`jev_judge.py`) shows the model **one source note plus its
candidate set in a single request** and asks for a relation Score per candidate.
This harness reproduces exactly that shape, so its numbers describe the code you
actually run.

Ground truth is built from your graph:

* **Positive** — a candidate that the source note already links to. The link
  exists in `links`, so a human or agent decided it was worth having.
* **Negative** — an unrelated note sampled from the vault and injected into the
  candidate set. It is not a link target, and it shares no deliberate
  relationship with the source.

Positives and negatives are compared **within the same source and the same
request**, which removes every confound except the judgment itself. Pooled
precision/recall across sources follows, with a threshold sweep you can use to
set `LINK_THRESHOLD` / `REVIEW_THRESHOLD` in `jev_judge.py`.

A finding worth keeping
-----------------------
An earlier version of this harness judged each pair **in isolation** (one pair
per request) and found AUC ~0.56, i.e. no separation. Re-presented as a set, the
same model separates the classes with AUC 0.94-1.00. A pair judged alone carries
no reference class, so an absolute judgement ("is this a duplicate?") is not
asked that way anywhere in this codebase. If you extend this integration, keep
the set-based shape.

Read-only: never writes to the vault.

Usage
-----
    python3 calibrate_thresholds.py --sources 6 --targets 5 --distractors 5
    python3 calibrate_thresholds.py --sources 12 --json
"""

from __future__ import annotations

import argparse
import json
import os
import random
import sqlite3
import sys
from pathlib import Path
from typing import Any

sys.path.insert(0, str(Path(__file__).resolve().parent))

from jev_judge import (  # noqa: E402
    DEFAULT_MODEL,
    LINK_FALSE,
    LINK_THRESHOLD,
    LINK_TRUE,
    REVIEW_THRESHOLD,
    build_questions,
    granite_db,
    load_note,
    post_questions,
)


def pick_sources(
    con: sqlite3.Connection, count: int, seed: int, min_body: int = 800, min_links: int = 3
) -> list[tuple[str, list[str]]]:
    """Sources with a substantial body and several real link targets."""
    rows = con.execute(
        """
        SELECT l.source_slug, COUNT(DISTINCT l.target_slug) AS links
        FROM links l
        JOIN notes n ON n.slug = l.source_slug
        WHERE l.target_slug IS NOT NULL AND length(n.body) > ?
        GROUP BY l.source_slug
        HAVING links >= ?
        ORDER BY links DESC
        """,
        (min_body, min_links),
    ).fetchall()
    rng = random.Random(seed)
    rng.shuffle(rows)
    picked: list[tuple[str, list[str]]] = []
    for source_slug, _links in rows:
        targets = [
            slug
            for (slug,) in con.execute(
                "SELECT DISTINCT target_slug FROM links WHERE source_slug = ? AND target_slug IS NOT NULL",
                (source_slug,),
            ).fetchall()
            if slug != source_slug
        ]
        if len(targets) >= min_links:
            picked.append((source_slug, targets))
        if len(picked) >= count:
            break
    return picked


def build_candidate_set(
    con: sqlite3.Connection,
    source: dict[str, Any],
    targets: list[str],
    targets_per_source: int,
    distractors: int,
    seed: int,
    min_body: int = 400,
) -> list[dict[str, Any]]:
    rng = random.Random(seed)
    chosen_targets = rng.sample(targets, min(targets_per_source, len(targets)))
    linked = set(chosen_targets)

    pool = [
        slug
        for (slug,) in con.execute(
            "SELECT slug FROM notes WHERE length(body) > ?", (min_body,)
        ).fetchall()
        if slug != source["slug"] and slug not in linked
    ]
    chosen_distractors = rng.sample(pool, min(distractors, len(pool)))

    candidates: list[dict[str, Any]] = []
    for slug in chosen_targets:
        note = load_note(con, slug)
        note["truth"] = "linked"
        candidates.append(note)
    for slug in chosen_distractors:
        note = load_note(con, slug)
        note["truth"] = "distractor"
        candidates.append(note)
    rng.shuffle(candidates)
    return candidates


def score_source(
    api_key: str, model: str, source: dict[str, Any], candidates: list[dict[str, Any]],
    max_chars: int,
) -> tuple[list[dict[str, Any]], dict[str, Any], str]:
    """One request per source — the shipped shape."""
    state = {
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
    response = post_questions(api_key, model, state, build_questions(candidates))
    answers = response.get("answers", {})
    scored = []
    for candidate in candidates:
        cid = candidate["slug"]
        scored.append({
            **candidate,
            "score": float(answers.get(f"rel::{cid}", {}).get("score", 0.0)),
            "confidence": float(answers.get(f"rel::{cid}", {}).get("confidence", 0.0)),
            "noul": float(answers.get(f"link::{cid}", {}).get("noul", 0.0)),
        })
    return scored, response.get("usage") or {}, response.get("model", model)


def auc(positives: list[float], negatives: list[float]) -> float:
    if not positives or not negatives:
        return 0.0
    wins = sum(1 for p in positives for n in negatives if p > n)
    ties = sum(1 for p in positives for n in negatives if p == n)
    return (wins + 0.5 * ties) / (len(positives) * len(negatives))


def sweep(rows: list[dict[str, Any]], key: str, thresholds: list[float]) -> list[dict[str, Any]]:
    positives = [r for r in rows if r["truth"] == "linked"]
    negatives = [r for r in rows if r["truth"] == "distractor"]
    out = []
    for threshold in thresholds:
        tp = sum(1 for r in positives if r[key] >= threshold)
        fp = sum(1 for r in negatives if r[key] >= threshold)
        precision = tp / (tp + fp) if (tp + fp) else 0.0
        recall = tp / len(positives) if positives else 0.0
        f1 = 2 * precision * recall / (precision + recall) if (precision + recall) else 0.0
        out.append({
            "threshold": round(threshold, 2),
            "precision": round(precision, 3),
            "recall": round(recall, 3),
            "f1": round(f1, 3),
            "false_positives": fp,
        })
    return out


def main(argv: list[str]) -> int:
    parser = argparse.ArgumentParser(description="Measure the Jev link judgment against your graph.")
    parser.add_argument("--sources", type=int, default=6)
    parser.add_argument("--targets", type=int, default=5, help="real link targets per source")
    parser.add_argument("--distractors", type=int, default=5, help="random notes per source")
    parser.add_argument("--max-chars", type=int, default=900)
    parser.add_argument("--seed", type=int, default=11)
    parser.add_argument("--model", default=os.environ.get("TYPESAFE_MODEL", DEFAULT_MODEL))
    parser.add_argument("--vault", default=os.environ.get("GRANITE_VAULT"))
    parser.add_argument("--json", action="store_true")
    return run(argv, parser)


def run(argv: list[str], parser: argparse.ArgumentParser) -> int:
    args = parser.parse_args(argv)
    api_key = os.environ.get("TYPESAFE_API_KEY")
    if not api_key:
        print(json.dumps({
            "status": "unavailable",
            "reason": "missing TYPESAFE_API_KEY",
            "hint": "This harness measures a hosted model, so it needs the API.",
        }, indent=2))
        return 0

    vault = Path(args.vault).expanduser() if args.vault else Path.home() / ".granite"
    con = sqlite3.connect(f"file:{granite_db(vault)}?mode=ro", uri=True)
    try:
        sources = pick_sources(con, args.sources, args.seed)
        if not sources:
            print(json.dumps({"status": "empty", "reason": "no source notes with enough links"}, indent=2))
            return 0
        per_source = []
        all_rows: list[dict[str, Any]] = []
        usage = {"input_tokens": 0, "output_tokens": 0}
        models: set[str] = set()
        for index, (source_slug, targets) in enumerate(sources):
            source = load_note(con, source_slug)
            candidates = build_candidate_set(
                con, source, targets, args.targets, args.distractors, args.seed + index
            )
            scored, used, model = score_source(api_key, args.model, source, candidates, args.max_chars)
            models.add(model)
            for key, value in used.items():
                usage[key] = usage.get(key, 0) + int(value or 0)
            pos = [r["score"] for r in scored if r["truth"] == "linked"]
            neg = [r["score"] for r in scored if r["truth"] == "distractor"]
            per_source.append({
                "source": source_slug,
                "title": source["title"],
                "positives": sorted(round(p, 2) for p in pos),
                "distractors": sorted(round(p, 2) for p in neg),
                "auc": round(auc(pos, neg), 3),
                "positives_median": round(sorted(pos)[len(pos) // 2], 2) if pos else None,
                "distractors_median": round(sorted(neg)[len(neg) // 2], 2) if neg else None,
            })
            all_rows.extend(scored)
    finally:
        con.close()

    thresholds = [round(0.25 + 0.25 * i, 2) for i in range(12)]
    score_sweep = sweep(all_rows, "score", thresholds)
    noul_sweep = sweep(all_rows, "noul", [round(0.05 + 0.05 * i, 2) for i in range(19)])

    aucs = [s["auc"] for s in per_source]
    mean_auc = sum(aucs) / len(aucs) if aucs else 0.0
    best = max(score_sweep, key=lambda r: (r["f1"], r["precision"]))

    report = {
        "status": "ok",
        "model": ",".join(sorted(models)),
        "usage": usage,
        "candidate_scores": len(all_rows),
        "positives": sum(1 for r in all_rows if r["truth"] == "linked"),
        "distractors": sum(1 for r in all_rows if r["truth"] == "distractor"),
        "mean_within_source_auc": round(mean_auc, 3),
        "per_source": per_source,
        "relation_score_best": best,
        "relation_score_sweep": score_sweep,
        "noul_sweep": noul_sweep,
        "current_defaults": {"link": LINK_THRESHOLD, "review": REVIEW_THRESHOLD},
    }

    if args.json:
        print(json.dumps(report, indent=2, sort_keys=True))
        return 0

    print(f"model: {report['model']}   tokens: {usage}")
    print(f"scored {len(all_rows)} candidates across {len(per_source)} sources "
          f"({report['positives']} linked / {report['distractors']} unrelated)")
    print(f"\nwithin-source AUC: mean {mean_auc:.3f}   per source {aucs}")
    for row in per_source:
        print(f"  {row['title'][:44]:46s} linked~{row['positives_median']}  "
              f"unrelated~{row['distractors_median']}  auc={row['auc']:.2f}")
    print(f"\nrelation Score separates: linked {min(r['positives_median'] or 0 for r in per_source)}"
          f"-{max(r['positives_median'] or 0 for r in per_source)} median vs "
          f"unrelated {min(r['distractors_median'] or 0 for r in per_source)}"
          f"-{max(r['distractors_median'] or 0 for r in per_source)} median")
    print("\nrelation Score sweep (threshold -> precision / recall / fp):")
    for row in score_sweep:
        print(f"  {row['threshold']:.2f}  p={row['precision']:.2f} r={row['recall']:.2f} "
              f"fp={row['false_positives']:2d}  {'#' * int(row['precision'] * 20)}")
    print(f"\nbest relation-score threshold: {best['threshold']:.2f} "
          f"(precision {best['precision']:.2f}, recall {best['recall']:.2f}, f1 {best['f1']:.2f})")
    print("Note: `jev_judge` decides with the Noul, not this Score. Use the Score to rank, "
          "and read the Noul sweep in --json to set LINK_THRESHOLD.")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
