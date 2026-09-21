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
    python3 jev_ingest.py --propose <slug> [--json]
    python3 jev_ingest.py --orphans [--limit N]
    python3 jev_ingest.py --questions <slug>       # judge request body, no API key needed
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
    """The judge request body, in the same shape the retrieval path uses.

    One request per note, all candidates inside it: batching measured 12.2x cheaper and 10x
    faster than one call per item, with identical answers. Judging a candidate alone also
    measured near chance (AUC 0.56), so the set is the unit.
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
            f"link::{note['slug']}": {
                "type": "choices",
                "instructions": (
                    "Which of these candidates does the note really refer to? Select only "
                    "those the note's own words connect to. A shared word is not a "
                    "connection; a different company, person or version with a similar name "
                    "is not a connection."
                ),
                "criteria": {
                    **{f"c{i}": c["target_title"] for i, c in enumerate(note["candidates"])},
                    "none": "None of them.",
                },
                "multiple": True,
            }
        },
    }


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


def main(argv: list[str]) -> int:
    parser = argparse.ArgumentParser(description="Propose the links a note should be born with.")
    parser.add_argument("--propose", metavar="SLUG")
    parser.add_argument("--orphans", action="store_true")
    parser.add_argument("--questions", metavar="SLUG")
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
            payload = build_questions(note) if args.questions else note
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
