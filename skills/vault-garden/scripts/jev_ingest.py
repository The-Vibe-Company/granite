#!/usr/bin/env python3
"""Propose the links a note should be born with, at capture time.

Why this exists
---------------
Measured on the real vault: 106 notes have no incoming link, 65 of them `source` notes,
and 99 link out while nothing links back. Linking happens as a periodic gardening pass
instead of at capture, so for those notes it never happens. The fix is to make the note
born connected.

This script is the **deterministic half** of that. It detects entity mentions in a note,
resolves them against the vault, and emits link candidates with the exact span that
justifies each one. It calls no model and writes nothing.

Reliability is why the split is here
------------------------------------
Jev is strongest at selecting inside a set (mean within-source AUC 0.973) and unreliable at
detecting from nothing. So code does the proposing — verbatim title and alias matches, which
are cheap and auditable — and a judge does the selecting, which is the judgment it is
measurably good at. `--questions` emits the request body for that judge and needs no API key.

What it deliberately does not do
--------------------------------
- No fuzzy or semantic matching. A near-miss title is a different note; proposing it is how
  a vault accumulates confidently wrong links.
- No writing. Proposals are reviewable; `granite capture`/`revise` apply them.
- No date or fact extraction. Dates measured 1/9 correct as dates; facts measured 0.75
  precision. Both are worse than this and neither belongs at the link stage.

Usage
-----
    python3 jev_ingest.py --propose <slug> [--json]   # deterministic proposals
    python3 jev_ingest.py --judge <slug>              # + Jev selects (needs the API key)
    python3 jev_ingest.py --orphans [--limit N]       # the whole vault
    python3 jev_ingest.py --questions <slug>          # the POST body, no API key needed
"""
from __future__ import annotations

import argparse
import json
import os
import re
import sqlite3
import sys
import unicodedata
from pathlib import Path
from typing import Any

sys.path.insert(0, str(Path(__file__).resolve().parent))
from jev_judge import DEFAULT_MODEL, post_questions  # noqa: E402

# Mirrors `normalizeName` in src/core/entities.ts so a mention matches the same notes the
# product would match. Kept identical on purpose: a second, subtly different normalisation
# is how two halves of a system disagree about what a name is.
def normalize_name(value: str) -> str:
    decomposed = unicodedata.normalize("NFD", value)
    stripped = "".join(ch for ch in decomposed if not unicodedata.combining(ch))
    return re.sub(r"[^a-z0-9]+", " ", stripped.lower()).strip()


def find_mentions(body: str, entities: dict[str, str], *, min_len: int = 6) -> list[dict[str, Any]]:
    """Verbatim mentions of a known entity title inside a body.

    Matching is on the raw text, case-insensitively, because a wikilink target is what a
    human would type. Longest-first matching matters: "Monka" and "Monka.care" both exist in
    a real vault, and a naive scan reports both, producing a duplicate proposal for one span.
    """
    if not body:
        return []
    lowered = body.lower()
    claimed: list[tuple[int, int]] = []
    found: list[dict[str, Any]] = []

    for title in sorted(entities, key=len, reverse=True):
        if len(title) < min_len:
            continue
        start = 0
        needle = title.lower()
        while True:
            at = lowered.find(needle, start)
            if at < 0:
                break
            end = at + len(needle)
            # Skip if a longer title already claimed this region.
            if not any(at < c_end and end > c_start for c_start, c_end in claimed):
                claimed.append((at, end))
                found.append({
                    "slug": entities[title],
                    "title": title,
                    "span": body[at:end],
                    "start": at,
                    "end": end,
                })
            start = end

    found.sort(key=lambda m: (m["start"], m["end"]))
    return found


def resolve_entities(con: sqlite3.Connection, *, exclude: str | None = None) -> dict[str, str]:
    """Map every linkable name (title and aliases) to its slug.

    Aliases are included because the vault already records them; that is the same set
    `granite entities` aligns on, so this proposes links the product can resolve.
    """
    entities: dict[str, str] = {}
    for slug, title, aliases in con.execute("SELECT slug, title, aliases FROM notes"):
        if slug == exclude:
            continue
        if title:
            entities.setdefault(title, slug)
        if aliases:
            try:
                parsed = json.loads(aliases) if isinstance(aliases, str) else aliases
            except (TypeError, ValueError):
                parsed = None
            if isinstance(parsed, list):
                for alias in parsed:
                    if isinstance(alias, str) and alias:
                        entities.setdefault(alias, slug)
    return entities


def document_frequency(con: sqlite3.Connection, entities: dict[str, str]) -> dict[str, int]:
    """How many notes each entity's name appears in, counting bodies as well as titles.

    This is the cheapest available signal for "is this word an entity or just vocabulary".
    Measured on the real vault: `granite` appears in 347 of 761 notes while 565 titles
    appear in one or two. A mention of a name that is everywhere is not evidence of a
    connection, and a judge shown nothing but the string cannot tell the difference — which
    is exactly how a vault fills up with links to whatever word is most common.

    Bodies matter: a first version counted titles only, which reported 1 for both a
    distinctive client name and a word that saturates the vault, making the signal useless.
    """
    texts: list[str] = []
    for text, body in con.execute("SELECT title, body FROM notes"):
        texts.append(((text or "") + "\n" + (body or "")).lower())
    freq: dict[str, int] = {}
    for name in entities:
        needle = name.lower()
        freq[name] = sum(1 for text in texts if needle in text)
    return freq


def linked_targets(con: sqlite3.Connection, slug: str) -> set[str]:
    return {
        row[0] for row in con.execute(
            "SELECT target_slug FROM links WHERE source_slug = ? AND target_slug IS NOT NULL",
            (slug,),
        )
    }


def propose(con: sqlite3.Connection, slug: str,
            entities: dict[str, str] | None = None,
            freq: dict[str, int] | None = None) -> dict[str, Any] | None:
    row = con.execute("SELECT title, type, body FROM notes WHERE slug = ?", (slug,)).fetchone()
    if row is None:
        return None
    title, note_type, body = row[0], row[1], row[2] or ""

    # Both are vault-wide, so `propose_many` passes them in rather than recomputing them
    # per note: the first version rescanned every body once per orphan, which is 106 full
    # scans to answer one question.
    if entities is None:
        entities = resolve_entities(con, exclude=slug)
    else:
        entities = {k: v for k, v in entities.items() if v != slug}
    mentions = find_mentions(body, entities)
    already = linked_targets(con, slug)
    if freq is None:
        freq = document_frequency(con, entities)

    proposals: list[dict[str, Any]] = []
    for mention in mentions:
        target = mention["slug"]
        if target in already:
            continue
        proposals.append({
            "target": target,
            "target_title": mention["title"],
            "matched_text": mention["span"],
            "offset": mention["start"],
            # How many notes this name appears in. Low means distinctive, so the mention is
            # evidence; high means the word is part of the vocabulary and the mention is not.
            "name_frequency": freq.get(mention["title"], 0),
            # The sentence around the mention is what a judge decides on, and what a human
            # reads to accept or reject. Without it the proposal is an assertion.
            "context": _sentence_at(body, mention["start"], mention["end"]),
        })

    # One proposal per target, at its first mention.
    deduped: dict[str, dict[str, Any]] = {}
    for proposal in proposals:
        deduped.setdefault(proposal["target"], proposal)

    # Most distinctive first: the candidates a judge can actually decide on come before the
    # ones that merely share a common word with the note.
    ordered = sorted(deduped.values(), key=lambda p: (p["name_frequency"], p["offset"]))

    return {
        "slug": slug,
        "title": title,
        "type": note_type,
        "already_linked": sorted(already),
        "candidates": ordered,
    }


def _sentence_at(body: str, start: int, end: int, *, window: int = 240) -> str:
    left = max(0, start - window)
    right = min(len(body), end + window)
    chunk = body[left:right]
    # Trim to sentence-ish boundaries around the mention.
    before = chunk[: start - left]
    after = chunk[start - left :]
    cut = max(before.rfind(". "), before.rfind("\n"))
    if cut >= 0:
        before = before[cut + 1 :]
    stop = min([i for i in (after.find(". "), after.find("\n")) if i >= 0], default=len(after))
    return re.sub(r"\s+", " ", (before + after[: stop + 1])).strip()


def build_questions(note: dict[str, Any]) -> dict[str, Any]:
    """One `noul` per candidate — the documented way to ask a multi-label question.

    One request per note, all candidates inside it: batching measured 12.2x cheaper and 10x
    faster than one call per item, with identical answers. Judging a candidate alone also
    measured near chance (AUC 0.56), so the set is the unit.

    Two request-shape rules are load-bearing here, both from the Jev cookbook's linter:

    - The type is `choice`/`score`/`noul`. There is no `choices`, and asking for one returns
      HTTP 400 — which is how this was found, after it had already shipped past tests that
      checked the shape rather than the contract.
    - A multi-label question is **several `noul`s, not one multi-select `choice`**. A
      `choice` is a closed set with a fallback, so it is the wrong instrument for "which of
      these, possibly several, possibly none".

    Instructions are phrased as questions because TypeSafe's docs recommend it, and the
    semantics asked for is the one measured to work: does this candidate *answer/connect*,
    not merely is it related.
    """
    return {
        "candidate_notes": [
            {
                "id": note["slug"],
                "title": note["title"],
                "candidates": {
                    f"c{i}": {"target": c["target_title"], "context": c["context"]}
                    for i, c in enumerate(note["candidates"])
                },
            }
        ],
        "questions": {
            f"link::{note['slug']}::{i}": {
                "type": "noul",
                "instructions": (
                    f"Does the note's own wording refer to {c['target_title']} "
                    f"specifically, rather than merely sharing a word with it?"
                ),
                "criteria": {
                    "true": f"The note means {c['target_title']} itself.",
                    "false": (
                        "The name is absent, or names a different organization, person or "
                        "version; a shared word is not a reference."
                    ),
                },
            }
            for i, c in enumerate(note["candidates"])
        } or {
            f"link::{note['slug']}": {
                "type": "noul",
                "instructions": "Does the note refer to any other note in the vault?",
                "criteria": {
                    "true": "It names one explicitly.",
                    "false": "It names none.",
                },
            }
        },
    }


def request_body(note: dict[str, Any], model: str) -> dict[str, Any]:
    """The full request, ready to POST. `--questions` emits this and nothing else."""
    state = build_questions(note)
    return {"model": model, "state": state, "questions": state["questions"]}


def orphan_slugs(con: sqlite3.Connection, limit: int | None) -> list[str]:
    rows = con.execute(
        "SELECT n.slug FROM notes n "
        "LEFT JOIN links l ON l.target_slug = n.slug "
        "WHERE l.target_slug IS NULL ORDER BY n.slug"
    ).fetchall()
    slugs = [r[0] for r in rows]
    return slugs[:limit] if limit else slugs


DEFAULT_MAX_FREQUENCY = 5


def propose_many(con: sqlite3.Connection, slugs: list[str], *,
                 max_frequency: int | None = DEFAULT_MAX_FREQUENCY) -> list[dict[str, Any]]:
    """Propose for many notes, computing the vault-wide caches once.

    Measured on the real vault, the raw signal is mostly noise: of 77 mentions found across
    63 orphan notes, 72 point at a name that appears in more than 20 other notes, and 47 at
    one that appears in more than 100. Only 5 are distinctive (4-20) or unique (<=3) — and
    those 5 are the good ones, e.g. a source note linking the author's own follow-up project,
    a meeting referencing a named client contact. So `max_frequency` is a default, because
    "every note that contains the word Granite" is not a link set.
    """
    entities = resolve_entities(con)
    freq = document_frequency(con, entities)
    out: list[dict[str, Any]] = []
    for slug in slugs:
        note = propose(con, slug, entities, freq)
        if not note:
            continue
        if max_frequency is not None:
            note["candidates"] = [c for c in note["candidates"]
                                  if c["name_frequency"] <= max_frequency]
        out.append(note)
    return out


LINK_THRESHOLD = 0.5


def judge(con: sqlite3.Connection, note: dict[str, Any], api_key: str,
          model: str, *, threshold: float = LINK_THRESHOLD) -> dict[str, Any]:
    """Ask Jev which of the proposed candidates the note really refers to.

    One request for the whole note, one `noul` per candidate. `noul` returns a probability,
    not a boolean: measured against controls, a certain yes reads 0.99 and a certain no 0.01,
    so the threshold sits at 0.5 and the raw probability is kept in the output rather than
    rounded away — the difference between 0.37 and 0.97 is the part a human should see.
    """
    body = request_body(note, model)
    response = post_questions(api_key, model, body["state"], body["questions"])
    answers = response.get("answers", {})

    kept: list[dict[str, Any]] = []
    rejected: list[dict[str, Any]] = []
    for i, candidate in enumerate(note["candidates"]):
        probability = answers.get(f"link::{note['slug']}::{i}", {}).get("noul")
        judged = {**candidate, "link_probability": probability}
        if probability is not None and probability >= threshold:
            kept.append(judged)
        else:
            rejected.append(judged)

    return {
        "slug": note["slug"],
        "title": note["title"],
        "type": note["type"],
        "model": response.get("model", model),
        "threshold": threshold,
        "confirmed": kept,
        "rejected": rejected,
    }


def main(argv: list[str]) -> int:
    parser = argparse.ArgumentParser(description="Propose the links a note should be born with.")
    parser.add_argument("--propose", metavar="SLUG")
    parser.add_argument("--orphans", action="store_true")
    parser.add_argument("--questions", metavar="SLUG",
                        help="emit the full POST body for this note's candidates")
    parser.add_argument("--model", default=os.environ.get("TYPESAFE_MODEL", DEFAULT_MODEL))
    parser.add_argument("--judge", metavar="SLUG",
                        help="ask Jev which candidates are real (needs TYPESAFE_API_KEY)")
    parser.add_argument("--threshold", type=float, default=LINK_THRESHOLD,
                        help=f"noul probability above which a link is kept (default {LINK_THRESHOLD})")
    parser.add_argument("--limit", type=int)
    parser.add_argument(
        "--max-frequency", type=int, default=DEFAULT_MAX_FREQUENCY,
        help=f"drop mentions of a name that appears in more than N notes "
             f"(default {DEFAULT_MAX_FREQUENCY}; 0 disables the filter)",
    )
    parser.add_argument("--json", action="store_true")
    args = parser.parse_args(argv)
    max_frequency = args.max_frequency or None

    vault = Path(os.environ.get("GRANITE_VAULT", Path.home() / ".granite"))
    db = vault / ".granite" / "index.db"
    if not db.exists():
        db = vault / "index.db"
    if not db.exists():
        print(json.dumps({"status": "error", "reason": f"no index database under {vault}"}))
        return 1

    con = sqlite3.connect(f"file:{db}?mode=ro", uri=True)
    try:
        if args.judge:
            api_key = os.environ.get("TYPESAFE_API_KEY")
            if not api_key:
                print(json.dumps({"status": "unavailable",
                                  "reason": "missing TYPESAFE_API_KEY"}))
                return 0
            entities = resolve_entities(con, exclude=args.judge)
            note = propose(con, args.judge, entities, document_frequency(con, entities))
            if note is None:
                print(json.dumps({"status": "error", "reason": f"no note {args.judge}"}))
                return 1
            if max_frequency is not None:
                note["candidates"] = [c for c in note["candidates"]
                                      if c["name_frequency"] <= max_frequency]
            print(json.dumps(judge(con, note, api_key, args.model, threshold=args.threshold),
                             indent=2, ensure_ascii=False))
            return 0

        if args.propose or args.questions:
            slug = args.propose or args.questions
            entities = resolve_entities(con, exclude=slug)
            note = propose(con, slug, entities, document_frequency(con, entities))
            if note is None:
                print(json.dumps({"status": "error", "reason": f"no note {slug}"}))
                return 1
            if max_frequency is not None:
                note["candidates"] = [c for c in note["candidates"]
                                      if c["name_frequency"] <= max_frequency]
            payload = request_body(note, args.model) if args.questions else note
            print(json.dumps(payload, indent=2, ensure_ascii=False))
            return 0

        if args.orphans:
            slugs = orphan_slugs(con, args.limit)
            notes = propose_many(con, slugs, max_frequency=max_frequency)
            result = [
                {
                    "slug": note["slug"],
                    "type": note["type"],
                    "proposed": [c["target"] for c in note["candidates"]],
                }
                for note in notes if note["candidates"]
            ]
            if args.json:
                print(json.dumps({
                    "orphans": len(slugs),
                    "max_frequency": max_frequency,
                    "with_proposals": result,
                }, indent=2, ensure_ascii=False))
            else:
                scope = ("any frequency" if max_frequency is None
                         else f"a name in <= {max_frequency} notes")
                print(f"{len(result)} of {len(slugs)} orphans mention {scope} verbatim")
                for row in result[:20]:
                    print(f"  {row['slug'][:44]:44s} {row['type']:10s} -> {', '.join(row['proposed'][:3])}")
            return 0

        parser.print_help()
        return 0
    finally:
        con.close()


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
