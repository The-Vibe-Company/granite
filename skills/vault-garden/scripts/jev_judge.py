#!/usr/bin/env python3
"""Optional semantic judgments for Granite, powered by TypeSafe (Jev).

Granite itself stays deterministic and offline. This script is the only piece
that talks to a hosted model, and it lives in a companion skill on purpose:
Granite's product boundary is markdown storage, index/graph operations and
deterministic workflow rules — never prompt execution or an embedded LLM.

Design rules
------------
* **Opt-in, fail-closed.** Without ``TYPESAFE_API_KEY`` the script emits a
  neutral ``status: unavailable`` payload instead of failing, exactly like
  Granite's optional ``ferrules`` extractor. Nothing else changes.
* **Granite recalls, Jev judges.** Candidates come from the vault index; the
  model only assigns a typed judgment to things that are already on the list.
  One bounded request per note, so cost and latency are predictable.
* **Thresholds in code, never invented.** The verdict uses cut points you can
  see and tune; calibrated numbers come back to you so they can be checked on
  your own adjudications instead of trusted blindly.
* **Cache in derived state.** Judgments are keyed by model + content hash and
  stored under ``<vault>/.granite/``, which Granite treats as reproducible
  derived state. Delete it any time; markdown stays the source of truth.
* **Secrets stay in the environment.** The API key is never written to disk.

Usage
-----
    granite-links-judge candidates <slug> [--limit N] [--max-chars N]
    granite-links-judge judge <slug> [--limit N] [--max-chars N] [--no-cache]

Both subcommands print a single JSON object on stdout.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
import sqlite3
import sys
import urllib.error
import urllib.request
from pathlib import Path
from typing import Any

API_URL = "https://api.typesafe.ai/v1/systemone"
# Pin a versioned model: alias names drift when TypeSafe ships a release, and a
# threshold tuned against one version should not silently move to another.
DEFAULT_MODEL = "jev-1.13.0"
DEFAULT_LIMIT = 12
DEFAULT_MAX_CHARS = 900
TIMEOUT_SECONDS = 60

# One Score question orders the candidates; one Noul decides whether to link at
# all. The Noul matters because a Score always returns something — without it a
# vault with no real connection would still get its top candidate proposed.
LEVELS = [
    "Unrelated: different subjects, no shared entity, concept, project or event.",
    "Same broad domain but distinct topics; reading one would not lead to the other.",
    "Related: they share a specific entity, concept, project or event, but neither derives from the other.",
    "Directly connected: the candidate is a source, decision or follow-up the note should link to.",
]

LINK_TRUE = (
    "The two notes share a specific entity, project, concept or event, and a "
    "reader of the source note would benefit from traversing to the candidate."
)
LINK_FALSE = "The overlap is generic, incidental, or only a shared common word."

# `garden-adjudications.json` records pairs a human decided must stay **separate**.
# That is a statement about merging, not about linking: a synthesis and the entity
# note it compiles are a good link and a bad merge at once. Judging those labels
# with the link question above scores them 0.73-0.96, i.e. it calls every
# human-separated pair link-worthy, because it is answering a different question.
#
# The merge question below is the one those labels actually answer. Its levels are
# the three things you can do with a pair, so the decision rule is the rounding,
# not a fitted threshold.
MERGE_LEVELS = [
    "Different notes: different subjects, or the same subject at a different level of abstraction.",
    "Near-duplicates: a reader would be unsure which to use, but each carries something the other does not.",
    "The same thing: they should be merged into one note.",
]
MERGE_OUTCOME = {0: "separate", 1: "review", 2: "merge"}

# Verdict cut points, measured rather than guessed. Jev's Noul for this question
# occupies a compressed range (roughly 0.05-0.80 on a sample across 78 candidates
# and 8 source notes), not the full 0-1 interval, so a "high" cut point silently
# destroys recall: a 0.60 threshold scored precision 0.95 but recall 0.55.
#
# Measured on one vault with the harness in this directory (mean within-source
# AUC 0.973 for the relation Score):
#   0.25 -> precision 0.88  recall 0.97  (5 unrelated candidates passed)
#   0.35 -> precision 0.91  recall 0.84  (3 passed)
#   0.60 -> precision 0.95  recall 0.55  (1 passed)
# Tolerance for a wrong link is real, but a missed connection is the failure this
# layer exists to fix, so 0.25 is the default and 0.15 keeps uncertain pairs
# visible for review instead of discarding them.
#
# Re-run `calibrate_thresholds.py` on your own vault before trusting these.
LINK_THRESHOLD = 0.25
REVIEW_THRESHOLD = 0.15


def granite_db(vault: Path) -> Path:
    """Locate the SQLite index Granite derives from the markdown."""
    candidates = [
        vault / ".granite" / "index.db",
        vault / "index.db",
    ]
    for path in candidates:
        if path.is_file():
            return path
    raise SystemExit(
        f"error: no Granite index found under {vault}. "
        "Run `granite doctor` or any granite command to build it, or set GRANITE_VAULT."
    )


def load_note(con: sqlite3.Connection, slug: str) -> dict[str, Any]:
    row = con.execute(
        "SELECT slug, title, type, body, aliases, filepath FROM notes WHERE slug = ?",
        (slug,),
    ).fetchone()
    if row is None:
        raise SystemExit(f"error: no note with slug {slug!r} in the index")
    slug_, title, ntype, body, aliases, filepath = row
    try:
        alias_list = json.loads(aliases or "[]")
    except json.JSONDecodeError:
        alias_list = []
    return {
        "slug": slug_,
        "title": title,
        "type": ntype,
        "body": body or "",
        "aliases": alias_list,
        "filepath": filepath,
    }


def shortlist(
    con: sqlite3.Connection,
    note: dict[str, Any],
    limit: int,
) -> list[dict[str, Any]]:
    """Deterministic recall: title tokens plus FTS, excluding notes already linked.

    Recall stays in Granite's layer. A semantic judge can only ever reorder what
    this returns, so widening recall here is what makes a judgment useful.
    """
    stop = {
        "the", "and", "for", "with", "from", "that", "this", "into", "about",
        "note", "notes", "source", "summary", "details", "links", "les", "des",
        "une", "pour", "dans", "avec", "sur", "par", "pas", "est", "que", "qui",
    }

    def tokens(text: str) -> set[str]:
        words = re.findall(r"[^\W\d_][\w'-]{3,}", text, flags=re.UNICODE)
        return {w.lower() for w in words if w.lower() not in stop}

    linked: set[str] = set()
    for target in re.findall(r"\[\[([^\]|]+)", note["body"]):
        linked.add(target.strip().lower())
        linked.add(re.sub(r"[^a-z0-9]+", "-", target.strip().lower()).strip("-"))

    title_tokens = tokens(note["title"])
    scored: list[tuple[int, dict[str, Any]]] = []
    rows = con.execute(
        "SELECT slug, title, type, body FROM notes WHERE slug != ?", (note["slug"],)
    ).fetchall()
    # A candidate whose title is exactly this note's title is a duplicate record,
    # not a link target: linking them would create a false merge signal, and the
    # judgment would be about two copies of the same thing.
    own_title = re.sub(r"[^a-z0-9]+", " ", (note["title"] or "").lower()).strip()
    for slug, title, ntype, body in rows:
        if slug in linked or (title or "").lower() in linked:
            continue
        normalized = re.sub(r"[^a-z0-9]+", " ", (title or "").lower()).strip()
        if normalized and normalized == own_title:
            continue
        overlap = len(title_tokens & tokens(title or ""))
        if overlap:
            scored.append((overlap, {"slug": slug, "title": title, "type": ntype, "body": body or ""}))
    scored.sort(key=lambda pair: (-pair[0], pair[1]["title"]))
    picked = [item for _, item in scored[:limit]]

    if len(picked) < limit:
        seen = {item["slug"] for item in picked}
        words = re.findall(r"[^\W\d_][\w'-]{4,}", note["body"], flags=re.UNICODE)
        unique = list(dict.fromkeys(w.lower() for w in words))[:14]
        if unique:
            fts = " OR ".join(f'"{w}"' for w in unique)
            try:
                for (slug,) in con.execute(
                    "SELECT n.slug FROM notes_fts JOIN notes n ON n.rowid = notes_fts.rowid "
                    "WHERE notes_fts MATCH ? ORDER BY rank LIMIT ?",
                    (fts, limit * 3),
                ).fetchall():
                    if slug == note["slug"] or slug in seen:
                        continue
                    picked.append(load_note(con, slug))
                    seen.add(slug)
                    if len(picked) >= limit:
                        break
            except sqlite3.Error:
                pass
    return picked[:limit]


def content_hash(note: dict[str, Any], candidates: list[dict[str, Any]], model: str, max_chars: int) -> str:
    h = hashlib.sha256()
    h.update(model.encode())
    h.update(str(max_chars).encode())
    h.update(note["slug"].encode())
    h.update(note["body"][:max_chars].encode("utf-8", "replace"))
    for candidate in candidates:
        h.update(candidate["slug"].encode())
        h.update(candidate["body"][:max_chars].encode("utf-8", "replace"))
    return h.hexdigest()


def cache_path(vault: Path) -> Path:
    return vault / ".granite" / "jev-judgments.json"


def read_cache(vault: Path) -> dict[str, Any]:
    path = cache_path(vault)
    if not path.is_file():
        return {}
    try:
        return json.loads(path.read_text("utf-8"))
    except json.JSONDecodeError:
        return {}


def write_cache(vault: Path, cache: dict[str, Any]) -> None:
    path = cache_path(vault)
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(".json.tmp")
    tmp.write_text(json.dumps(cache, indent=2, sort_keys=True), "utf-8")
    tmp.replace(path)


def build_questions(candidates: list[dict[str, Any]]) -> dict[str, Any]:
    questions: dict[str, Any] = {}
    for candidate in candidates:
        cid = candidate["slug"]
        questions[f"rel::{cid}"] = {
            "type": "score",
            "instructions": (
                f"How related is note_b_candidates[id={cid}] to note_a? "
                "Judge only that one candidate."
            ),
            "criteria": LEVELS,
        }
        questions[f"link::{cid}"] = {
            "type": "noul",
            "instructions": (
                f"Should note_a contain a wikilink to note_b_candidates[id={cid}]? "
                "Answer for that candidate only."
            ),
            "criteria": {"true": LINK_TRUE, "false": LINK_FALSE},
        }
    return questions


def post_questions(
    api_key: str,
    model: str,
    state: Any,
    questions: dict[str, Any],
) -> dict[str, Any]:
    """Send one batched System One request and return the decoded response.

    Reusable so callers that build a different state shape (for example the
    calibration harness, which judges labelled note pairs) do not re-implement
    transport, auth or error handling.
    """
    payload = {"state": state, "model": model, "questions": questions}
    request = urllib.request.Request(
        API_URL,
        data=json.dumps(payload).encode("utf-8"),
        headers={
            "Authorization": f"Bearer {api_key}",
            "Content-Type": "application/json",
        },
    )
    try:
        with urllib.request.urlopen(request, timeout=TIMEOUT_SECONDS) as response:
            return json.loads(response.read().decode("utf-8"))
    except urllib.error.HTTPError as exc:
        detail = exc.read().decode("utf-8", "replace")[:400]
        hint = ""
        if exc.code == 401:
            hint = " (check TYPESAFE_API_KEY)"
        elif exc.code == 429:
            hint = " (rate limited; retry shortly)"
        raise SystemExit(f"error: TypeSafe returned HTTP {exc.code}{hint}: {detail}") from exc
    except urllib.error.URLError as exc:
        raise SystemExit(f"error: could not reach TypeSafe: {exc.reason}") from exc


def call_jev(
    api_key: str,
    model: str,
    note: dict[str, Any],
    candidates: list[dict[str, Any]],
    max_chars: int,
) -> dict[str, Any]:
    state = {
        "note_a": {
            "title": note["title"],
            "type": note["type"],
            "text": note["body"][:max_chars],
        },
        "note_b_candidates": [
            {
                "id": candidate["slug"],
                "title": candidate["title"],
                "type": candidate["type"],
                "text": candidate["body"][:max_chars],
            }
            for candidate in candidates
        ],
    }
    return post_questions(api_key, model, state, build_questions(candidates))


def verdict_for(noul: float) -> str:
    if noul >= LINK_THRESHOLD:
        return "link"
    if noul >= REVIEW_THRESHOLD:
        return "review"
    return "skip"


def unavailable(reason: str, note: dict[str, Any], candidates: list[dict[str, Any]]) -> dict[str, Any]:
    """Fail-closed payload: the caller should fall back to its deterministic path."""
    return {
        "status": "unavailable",
        "reason": reason,
        "note": note["slug"],
        "candidates": [c["slug"] for c in candidates],
        "hint": (
            "Set TYPESAFE_API_KEY to enable semantic judgments, or continue with "
            "granite suggest-links / granite recommend, which need no model."
        ),
    }


def merge_verdict(score: float) -> tuple[int, str]:
    """Round the merge Score to its nearest level — the level *is* the decision."""
    level = min(int(score + 0.5), len(MERGE_LEVELS) - 1)
    return level, MERGE_OUTCOME[level]


def read_adjudications(vault: Path) -> list[dict[str, Any]]:
    """Human decisions about pairs from Granite's garden-adjudications.json.

    A `downrank` entry means a person decided two notes should stay separate, so
    it is a labelled **negative for merging**. These are the only human labels the
    vault carries, which makes them the natural calibration set for the merge
    question — and *not* for link-worthiness.
    """
    path = vault / "garden-adjudications.json"
    if not path.is_file():
        return []
    try:
        store = json.loads(path.read_text("utf-8"))
    except json.JSONDecodeError:
        return []
    out: list[dict[str, Any]] = []
    for entry in (store.get("entries") or {}).values():
        if entry.get("decision") != "downrank":
            continue
        slugs = entry.get("target_slugs") or []
        if len(slugs) != 2:
            continue
        out.append({
            "slugs": slugs,
            "reason_code": entry.get("reason_code", ""),
            "rationale": entry.get("rationale", ""),
            "recorded_at": entry.get("recorded_at", ""),
        })
    return out


def calibrated_thresholds(vault: Path) -> dict[str, Any]:
    """Report what the human decisions imply, for the question they answer.

    The adjudications are merge labels (pairs that must stay separate). They
    cannot bound the *link* threshold — a link between two near-duplicates is
    perfectly reasonable. So this reports merge agreement, and says so plainly
    rather than deriving a link threshold from mismatched labels.
    """
    ledger = read_cache(vault).get("adjudications", {})
    items = [item for item in ledger.values() if isinstance(item, dict)]
    if not items:
        return {
            "available": False,
            "labelled_pairs": 0,
            "hint": (
                "Run `judge-adjudications` first: it scores every pair a human "
                "already ruled on and stores the result in derived state."
            ),
        }

    merges = [i for i in items if i.get("merge_verdict") == "merge"]
    review = [i for i in items if i.get("merge_verdict") == "review"]
    separate = [i for i in items if i.get("merge_verdict") == "separate"]
    confidences = [float(i.get("merge_confidence", 0.0)) for i in items]
    lowest_merge_confidence = min(
        (float(i.get("merge_confidence", 0.0)) for i in merges), default=None
    )

    return {
        "available": True,
        "question": "merge",
        "labelled_pairs": len(items),
        "verdicts": {"separate": len(separate), "review": len(review), "merge": len(merges)},
        # Every label is a pair a human kept apart, so any "merge" verdict is a
        # disagreement between the classifier and the recorded decision.
        "agreement_rate": round(1 - len(merges) / len(items), 3),
        "disagreements": len(merges),
        "mean_confidence": round(sum(confidences) / len(confidences), 3) if confidences else None,
        "lowest_merge_confidence": lowest_merge_confidence,
        "note": (
            "These are merge labels. Do not use them to set LINK_THRESHOLD: two "
            "near-duplicate notes are a bad merge and a good link at the same "
            "time. Use calibrate_thresholds.py for the link question."
        ),
    }


def bounded_limit(value: str) -> int:
    """Candidate count: at least 1, and never beyond the model's option ceiling."""
    try:
        parsed = int(value)
    except ValueError as exc:
        raise argparse.ArgumentTypeError(f"expected an integer, got {value!r}") from exc
    if not 1 <= parsed <= 255:
        raise argparse.ArgumentTypeError(f"must be between 1 and 255, got {parsed}")
    return parsed


def parse_args(argv: list[str]) -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description=(
            "Optional Jev judgments for Granite links. Granite stays deterministic; "
            "this script is the opt-in layer that adds a calibrated semantic judgment."
        ),
        epilog=(
            "commands: candidates (deterministic, no key), judge (score one note's "
            "candidates), duplicates (rank likely duplicate pairs for merging), "
            "judge-adjudications (score the pairs a human already ruled on), "
            "calibrate (report what your own decisions imply)."
        ),
    )
    parser.add_argument(
        "command",
        choices=["candidates", "judge", "duplicates", "calibrate", "judge-adjudications"],
    )
    parser.add_argument("slug", nargs="?", help="required for candidates and judge")
    parser.add_argument("--limit", type=bounded_limit, default=DEFAULT_LIMIT, metavar="1-255")
    parser.add_argument("--max-chars", type=int, default=DEFAULT_MAX_CHARS)
    parser.add_argument("--model", default=os.environ.get("TYPESAFE_MODEL", DEFAULT_MODEL))
    parser.add_argument("--no-cache", action="store_true")
    parser.add_argument("--vault", default=os.environ.get("GRANITE_VAULT"))
    return parser.parse_args(argv)


def judge_adjudications(api_key: str, args: argparse.Namespace, vault: Path) -> int:
    """Score every pair a human already ruled on, and record it in derived state.

    This is the feedback half of the loop: it turns decisions the vault already
    contains into a labelled set, so `calibrate` can read a real measurement
    instead of a guess.
    """
    pairs = read_adjudications(vault)
    if not pairs:
        print(json.dumps({
            "status": "empty",
            "reason": "no downrank adjudications in garden-adjudications.json",
            "hint": (
                "Adjudicate garden opportunities first (granite_adjudicate_garden_opportunity "
                "or the plan-garden flow). Those decisions are the calibration labels."
            ),
        }, indent=2, sort_keys=True))
        return 0

    con = sqlite3.connect(f"file:{granite_db(vault)}?mode=ro", uri=True)
    notes: list[tuple[dict[str, Any], dict[str, Any], dict[str, Any]]] = []
    try:
        for pair in pairs:
            try:
                a = load_note(con, pair["slugs"][0])
                b = load_note(con, pair["slugs"][1])
            except SystemExit:
                continue  # a note referenced by an old adjudication is gone
            notes.append((a, b, pair))
    finally:
        con.close()

    if not notes:
        print(json.dumps({"status": "empty", "reason": "adjudicated notes no longer exist"}, indent=2))
        return 0

    usage: dict[str, int] = {}
    models: set[str] = set()
    scored: list[dict[str, Any]] = []
    for index, (a, b, pair) in enumerate(notes):
        state = {
            "note_a": {"title": a["title"], "type": a["type"], "text": a["body"][:args.max_chars]},
            "note_b": {"title": b["title"], "type": b["type"], "text": b["body"][:args.max_chars]},
        }
        questions = {
            "link": {
                "type": "noul",
                "instructions": "note_a should contain a wikilink to note_b.",
                "criteria": {"true": LINK_TRUE, "false": LINK_FALSE},
            },
            # The question these labels actually answer.
            "merge": {
                "type": "score",
                "instructions": (
                    "How do note_a and note_b relate as records in a knowledge base — "
                    "are they the same thing?"
                ),
                "criteria": MERGE_LEVELS,
            },
        }
        response = post_questions(api_key, args.model, state, questions)
        models.add(response.get("model", args.model))
        for key, value in (response.get("usage") or {}).items():
            usage[key] = usage.get(key, 0) + int(value or 0)
        answers = response.get("answers", {})
        noul = float(answers.get("link", {}).get("noul", 0.0))
        merge = answers.get("merge", {})
        level, verdict = merge_verdict(float(merge.get("score", 0.0)))
        scored.append({
            "key": f"{a['slug']}+{b['slug']}",
            "noul": round(noul, 4),
            "merge_level": level,
            "merge_verdict": verdict,
            "merge_confidence": round(float(merge.get("confidence", 0.0)), 4),
            "human_decision": "separate",
            "reason_code": pair["reason_code"],
            "recorded_at": pair["recorded_at"],
        })

    cache = read_cache(vault)
    cache["adjudications"] = {item["key"]: item for item in scored}
    try:
        write_cache(vault, cache)
    except OSError:
        pass

    above = [item for item in scored if item["noul"] >= LINK_THRESHOLD]
    print(json.dumps({
        "status": "ok",
        "model": ",".join(sorted(models)),
        "usage": usage,
        "labelled_pairs": len(scored),
        "above_current_threshold": len(above),
        "pairs": scored,
        "thresholds": calibrated_thresholds(vault),
    }, indent=2, sort_keys=True))
    return 0


def duplicate_candidates(con: sqlite3.Connection, limit: int) -> list[tuple[dict[str, Any], dict[str, Any]]]:
    """Deterministic recall for likely duplicate pairs.

    Mirrors the cheap half of Granite's own duplicate heuristic — normalised title
    overlap plus shared tags — then hands the pairs to the model. Recall stays in
    code; the model only judges the pairs this surfaces.
    """
    rows = con.execute("SELECT slug, title, tags FROM notes").fetchall()

    def norm_title(text: str) -> set[str]:
        return {
            w for w in re.findall(r"[^\W\d_][\w'-]{3,}", (text or "").lower(), flags=re.UNICODE)
            if w not in {"the", "and", "for", "with", "from", "note", "notes"}
        }

    def tag_set(raw: str | None) -> set[str]:
        try:
            value = json.loads(raw or "[]")
        except json.JSONDecodeError:
            return set()
        return {str(t).lower() for t in value} if isinstance(value, list) else set()

    prepared = [
        {"slug": slug, "title": title, "tags": tag_set(tags), "tokens": norm_title(title)}
        for slug, title, tags in rows
    ]
    scored: list[tuple[float, str, str]] = []
    for i in range(len(prepared)):
        a = prepared[i]
        if not a["tokens"]:
            continue
        for j in range(i + 1, len(prepared)):
            b = prepared[j]
            if not b["tokens"]:
                continue
            union = a["tokens"] | b["tokens"]
            overlap = len(a["tokens"] & b["tokens"]) / len(union) if union else 0.0
            shared_tags = len(a["tags"] & b["tags"])
            if overlap >= 0.6 or (overlap >= 0.4 and shared_tags >= 2):
                scored.append((overlap + 0.05 * shared_tags, a["slug"], b["slug"]))
    scored.sort(key=lambda item: -item[0])
    out: list[tuple[dict[str, Any], dict[str, Any]]] = []
    for _score, slug_a, slug_b in scored[:limit]:
        try:
            out.append((load_note(con, slug_a), load_note(con, slug_b)))
        except SystemExit:
            continue
    return out


def judge_duplicates(api_key: str, args: argparse.Namespace, vault: Path) -> int:
    """Score likely duplicate pairs so a human (or agent) gets a ranked queue."""
    con = sqlite3.connect(f"file:{granite_db(vault)}?mode=ro", uri=True)
    try:
        pairs = duplicate_candidates(con, max(1, args.limit))
    finally:
        con.close()

    if not pairs:
        print(json.dumps({
            "status": "ok",
            "candidates": 0,
            "results": [],
            "note": "No title-overlap candidate pairs found; nothing to judge.",
        }, indent=2, sort_keys=True))
        return 0

    usage: dict[str, int] = {}
    models: set[str] = set()
    results: list[dict[str, Any]] = []
    for a, b in pairs:
        state = {
            "note_a": {"title": a["title"], "type": a["type"], "text": a["body"][:args.max_chars]},
            "note_b": {"title": b["title"], "type": b["type"], "text": b["body"][:args.max_chars]},
        }
        response = post_questions(api_key, args.model, state, {
            "merge": {
                "type": "score",
                "instructions": (
                    "How do note_a and note_b relate as records in a knowledge base — "
                    "are they the same thing?"
                ),
                "criteria": MERGE_LEVELS,
            },
        })
        models.add(response.get("model", args.model))
        for key, value in (response.get("usage") or {}).items():
            usage[key] = usage.get(key, 0) + int(value or 0)
        merge = response.get("answers", {}).get("merge", {})
        level, verdict = merge_verdict(float(merge.get("score", 0.0)))
        results.append({
            "a": a["slug"], "b": b["slug"],
            "a_title": a["title"], "b_title": b["title"],
            "verdict": verdict, "level": level,
            "confidence": round(float(merge.get("confidence", 0.0)), 4),
        })

    order = {"merge": 0, "review": 1, "separate": 2}
    results.sort(key=lambda r: (order[r["verdict"]], -r["confidence"]))
    counts = {v: sum(1 for r in results if r["verdict"] == v) for v in ("merge", "review", "separate")}
    print(json.dumps({
        "status": "ok",
        "model": ",".join(sorted(models)),
        "usage": usage,
        "candidates": len(pairs),
        "summary": counts,
        "results": results,
        "note": (
            "A 'merge' verdict means the pair should become one note; it says "
            "nothing about whether they should link to each other."
        ),
    }, indent=2, sort_keys=True))
    return 0


def main(argv: list[str]) -> int:
    args = parse_args(argv)
    vault = Path(args.vault).expanduser() if args.vault else Path.home() / ".granite"
    if not vault.is_dir():
        raise SystemExit(f"error: vault directory not found: {vault}")

    # `calibrate` reads only derived state, so it needs neither a key nor a slug.
    if args.command == "calibrate":
        print(json.dumps({
            "status": "ok",
            "note": "thresholds are code constants; this reports what your labels imply",
            **calibrated_thresholds(vault),
        }, indent=2, sort_keys=True))
        return 0

    api_key = os.environ.get("TYPESAFE_API_KEY")

    if args.command == "judge-adjudications":
        if not api_key:
            print(json.dumps({
                "status": "unavailable",
                "reason": "missing TYPESAFE_API_KEY",
                "hint": "Scoring adjudicated pairs needs the API.",
            }, indent=2, sort_keys=True))
            return 0
        return judge_adjudications(api_key, args, vault)

    if args.command == "duplicates":
        if not api_key:
            print(json.dumps({
                "status": "unavailable",
                "reason": "missing TYPESAFE_API_KEY",
                "hint": "Duplicate ranking needs the API; the recall half is deterministic.",
            }, indent=2, sort_keys=True))
            return 0
        return judge_duplicates(api_key, args, vault)

    if not args.slug:
        raise SystemExit(f"error: the '{args.command}' command needs a note slug")

    con = sqlite3.connect(f"file:{granite_db(vault)}?mode=ro", uri=True)
    try:
        note = load_note(con, args.slug)
        candidates = shortlist(con, note, max(1, args.limit))
    finally:
        con.close()

    if args.command == "candidates":
        print(json.dumps({
            "status": "ok",
            "note": note["slug"],
            "count": len(candidates),
            "candidates": [
                {"slug": c["slug"], "title": c["title"], "type": c["type"]}
                for c in candidates
            ],
        }, indent=2, sort_keys=True))
        return 0

    if not api_key:
        print(json.dumps(unavailable("missing TYPESAFE_API_KEY", note, candidates), indent=2, sort_keys=True))
        return 0

    if not candidates:
        print(json.dumps({
            "status": "ok",
            "note": note["slug"],
            "model": args.model,
            "judgments": [],
            "summary": {"link": 0, "review": 0, "skip": 0},
            "cached": True,
        }, indent=2, sort_keys=True))
        return 0

    digest = content_hash(note, candidates, args.model, args.max_chars)
    cache = {} if args.no_cache else read_cache(vault)
    entry = cache.get(digest)
    from_cache = entry is not None

    if entry is None:
        response = call_jev(api_key, args.model, note, candidates, args.max_chars)
        answers = response.get("answers", {})
        judgments = []
        for candidate in candidates:
            cid = candidate["slug"]
            score = answers.get(f"rel::{cid}", {})
            link = answers.get(f"link::{cid}", {})
            noul = float(link.get("noul", 0.0))
            judgments.append({
                "slug": cid,
                "title": candidate["title"],
                "type": candidate["type"],
                "verdict": verdict_for(noul),
                "link_probability": round(noul, 4),
                "relation_score": round(float(score.get("score", 0.0)), 4),
                "relation_confidence": round(float(score.get("confidence", 0.0)), 4),
            })
        judgments.sort(key=lambda j: (-j["link_probability"], -j["relation_score"]))
        entry = {
            "model": response.get("model", args.model),
            "usage": response.get("usage", {}),
            "note_hash": digest,
            "judgments": judgments,
        }
        cache[digest] = entry
        try:
            write_cache(vault, cache)
        except OSError:
            pass  # a read-only vault must not break the judgment

    judgments = entry["judgments"]
    print(json.dumps({
        "status": "ok",
        "note": note["slug"],
        # The versioned id that actually answered, so results stay reproducible.
        "model": entry.get("model", args.model),
        "usage": entry.get("usage", {}),
        "thresholds": {"link": LINK_THRESHOLD, "review": REVIEW_THRESHOLD},
        "judgments": judgments,
        "summary": {
            verdict: sum(1 for j in judgments if j["verdict"] == verdict)
            for verdict in ("link", "review", "skip")
        },
        "cached": from_cache,
    }, indent=2, sort_keys=True))
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
