#!/usr/bin/env python3
"""Propose facts and fact conflicts with Jev, for Granite's deterministic ledger.

Design constraints, and where they come from
--------------------------------------------
Measured results say a model must never *decide* here:

* Triple extraction by a model is **low precision** - reported precision 0.357 /
  recall 0.902 on REBEL-Sub. It over-generates plausible claims. So extracted
  facts are **candidates with provenance**, never authority, and never a
  replacement for the note text.
* Automatic model-driven retirement is **unsafe**: hand-labelling one production
  run found 70% of automatically retired facts were still true, and two model
  judges could not adjudicate contradictions (Cohen's kappa 0.39). The loss is
  silent. So this script never retires or rewrites anything.
* Splitting *evidence identification* (a model) from *applying the policy* (code)
  is what produced the +10.8pp / +21pp gains. So the model here only proposes
  subject/relation/object spans; Granite's `facts` ledger applies the rule.

What that means concretely
--------------------------
* Facts are **selected from the note text**, not generated: the model returns a
  verbatim `span` copied from the source, so every claim is traceable.
* Every proposed fact carries `source` (the note slug) and `span`.
* Conflicts are **reported as candidates**, with a score, never resolved.
* Nothing is written to the vault. Output is JSON for a human or agent to accept.

Usage
-----
    python3 jev_facts.py facts <slug> [--limit N]
    python3 jev_facts.py conflicts <slug> [--limit N]
    python3 jev_facts.py judge-fact <slug>      # dedupe one candidate against the ledger

Requires TYPESAFE_API_KEY for anything that calls the model; `--help` works without.
"""

from __future__ import annotations

import argparse
import json
import os
import re
import sqlite3
import sys
from pathlib import Path
from typing import Any

sys.path.insert(0, str(Path(__file__).resolve().parent))

from jev_judge import (  # noqa: E402
    DEFAULT_MODEL,
    granite_db,
    load_note,
    post_questions,
)

# Levels describe the *action* you can take with a candidate fact, so the level is
# the decision rule. Low precision extraction means most candidates land in
# `review`, which is the honest outcome.
CONFLICT_LEVELS = [
    "Unrelated: different subject, or a different relation on the same subject.",
    "Related but compatible: they could both be true at the same time.",
    "Conflicting: they assert different values for the same subject and relation at the same time.",
]
CONFLICT_OUTCOME = {0: "unrelated", 1: "compatible", 2: "conflict"}

# Entity identity. Levels are the action, so rounding to the nearest level is the
# decision rule rather than a fitted threshold.
IDENTITY_LEVELS = [
    "Different entities: two distinct real-world things that happen to share a name.",
    "Related: one is a variant, subsidiary, alias or partial reference to the other.",
    "The same entity: both describe one and the same real-world thing.",
]
IDENTITY_OUTCOME = {0: "different", 1: "related", 2: "same"}

# Facts are extracted per candidate sentence, so the model only classifies text
# that deterministic code already selected. This keeps recall in code.
SUMMARY_CRITERIA = [
    "Not a factual assertion (opinion, question, plan, or filler).",
    "A factual assertion, but not about a specific entity and attribute.",
    "A factual assertion about a specific entity and attribute.",
]


def sentences(body: str, limit: int) -> list[dict[str, Any]]:
    """Deterministic candidate selection: split into sentences, keep the factual-looking ones.

    Recall stays here so the model never has to find anything - it only judges
    text that this function already surfaced.
    """
    # Drop YAML frontmatter first: without this, keys like `sourceNotionId:` are
    # split into "sentences" and proposed as facts.
    text = re.sub(r"\A---\n[\s\S]*?\n---\s*", " ", body)
    # Drop fenced code and markdown headings so we do not propose facts about layout.
    text = re.sub(r"```[\s\S]*?```", " ", text)
    text = re.sub(r"^#{1,6}\s.*$", " ", text, flags=re.M)
    parts = re.split(r"(?<=[.!?])\s+|\n+", text)
    out: list[dict[str, Any]] = []
    for index, raw in enumerate(parts):
        line = raw.strip().lstrip("-* ").strip()
        # Strip inline markdown so the proposed span reads as prose rather than
        # carrying bold markers and table pipes into the ledger.
        line = re.sub(r"\*\*|__|`", "", line)
        line = re.sub(r"^\|", "", line).replace(" | ", " — ").strip(" |")
        line = re.sub(r"\s{2,}", " ", line).strip()
        if len(line) < 25 or len(line) > 400:
            continue
        if not re.search(r"[A-Za-zÀ-ÿ]{3,}", line):
            continue
        out.append({"id": f"s{index:03d}", "text": line})
    return out[:limit]


def build_extraction_questions(candidates: list[dict[str, Any]]) -> dict[str, Any]:
    questions: dict[str, Any] = {}
    for candidate in candidates:
        cid = candidate["id"]
        questions[f"is_fact::{cid}"] = {
            "type": "score",
            "instructions": (
                f"Does candidate_sentences[id={cid}] assert something about the world "
                "that should still be checkable later? Judge only that sentence."
            ),
            "criteria": SUMMARY_CRITERIA,
        }
        # Separated on purpose. The first version of this gate scored meta-statements
        # highly and proposed "This document is the canonical engine spec" and
        # "Reçu le 2026-04-16 via Mael Yang" as world facts, which would pollute the
        # ledger with corpus bookkeeping that frontmatter already holds.
        questions[f"is_world_claim::{cid}"] = {
            "type": "noul",
            "instructions": (
                f"Does candidate_sentences[id={cid}] assert a fact about the world, rather "
                "than about the document itself, its provenance, or a link?"
            ),
            "criteria": {
                "true": (
                    "It states something about an entity, project, product, person, "
                    "organisation, contract or event — a claim that stays checkable."
                ),
                "false": (
                    "It describes the document (its title, version, purpose, structure, "
                    "layout), how or when the document was received, who sent it, or it is "
                    "only a URL or a table row label."
                ),
            },
        }
        # Extraction is a *selection* from the given text, so ask for the parts by
        # name and keep the original span verbatim for traceability.
        questions[f"subject::{cid}"] = {
            "type": "choice",
            "instructions": (
                f"If candidate_sentences[id={cid}] is a factual assertion, which entity "
                "is it about? Answer with the option whose description matches the text."
            ),
            "criteria": {
                "named_entity": "The sentence is about a specific named entity (person, company, product, project, place).",
                "no_specific_entity": "There is no single specific named entity it is about.",
            },
        }
        questions[f"relation::{cid}"] = {
            "type": "choice",
            "instructions": (
                f"What attribute of the subject does candidate_sentences[id={cid}] assert? "
                "Choose the closest of these."
            ),
            "criteria": {
                "hosting_or_infrastructure": "Where something is hosted, deployed or run.",
                "status": "Whether something is active, paused, archived, open or closed.",
                "ownership_or_role": "Who owns, leads, employs or is responsible for something.",
                "money": "A price, budget, amount, fee or salary.",
                "scope_or_contract": "What a contract, engagement or project covers.",
                "date_or_deadline": "When something happened or is due.",
                "capability_or_technology": "What something can do or what it uses.",
                "other_attribute": "Some other attribute of the subject.",
            },
        }
        questions[f"value::{cid}"] = {
            "type": "choice",
            "instructions": (
                f"For candidate_sentences[id={cid}], is the asserted value expressible as a "
                "short verbatim phrase copied from the sentence?"
            ),
            "criteria": {
                "explicit": "Yes - a short value phrase appears verbatim in the sentence.",
                "implied_only": "No - the value would have to be inferred rather than copied.",
            },
        }
        questions[f"when::{cid}"] = {
            "type": "choice",
            "instructions": (
                f"Does candidate_sentences[id={cid}] state, verbatim, when the assertion "
                "became true?"
            ),
            "criteria": {
                "explicit_date": "Yes - a date or dated phrase is stated in the sentence.",
                "no_date": "No date is stated.",
            },
        }
    return questions


def extract(api_key: str, args: argparse.Namespace, vault: Path) -> int:
    con = sqlite3.connect(f"file:{granite_db(vault)}?mode=ro", uri=True)
    try:
        note = load_note(con, args.slug)
    finally:
        con.close()

    candidates = sentences(note["body"], args.candidates)
    if not candidates:
        print(json.dumps({"status": "ok", "note": note["slug"], "proposed": 0,
                          "note_detail": "no candidate sentences found"}, indent=2))
        return 0

    response = post_questions(
        api_key, args.model,
        {"note": {"title": note["title"], "type": note["type"]},
         "candidate_sentences": candidates},
        build_extraction_questions(candidates),
    )
    answers = response.get("answers", {})

    proposed: list[dict[str, Any]] = []
    rejected: list[dict[str, Any]] = []
    for candidate in candidates:
        cid = candidate["id"]
        is_fact = answers.get(f"is_fact::{cid}", {})
        score = float(is_fact.get("score", 0.0))
        subject = answers.get(f"subject::{cid}", {}).get("choice")
        value_kind = answers.get(f"value::{cid}", {}).get("choice")
        entry = {
            "span": candidate["text"],
            "source": note["slug"],
            "is_fact_score": round(score, 2),
            "subject_kind": subject,
            "relation_kind": answers.get(f"relation::{cid}", {}).get("choice"),
            "value_kind": value_kind,
            "date_kind": answers.get(f"when::{cid}", {}).get("choice"),
            "world_claim": round(float(answers.get(f"is_world_claim::{cid}", {}).get("noul", 0.0)), 2),
        }
        # Only surface candidates the model actually scored as assertions, and only
        # when the value can be copied verbatim. An inferred value is exactly the
        # low-precision case the extraction numbers warn about.
        is_world_claim = float(answers.get(f"is_world_claim::{cid}", {}).get("noul", 0.0))
        if (score >= args.min_score and subject == "named_entity"
                and value_kind == "explicit" and is_world_claim >= args.min_world_claim):
            proposed.append(entry)
        else:
            rejected.append(entry)

    print(json.dumps({
        "status": "ok",
        "note": note["slug"],
        "model": response.get("model", args.model),
        "usage": response.get("usage", {}),
        "candidate_sentences": len(candidates),
        "proposed": len(proposed),
        "rejected": len(rejected),
        "facts": proposed,
        "rejected_detail": [
            {"span": r["span"][:110], "score": r["is_fact_score"],
             "why": "meta/provenance, not a world claim" if r.get("world_claim", 1.0) < args.min_world_claim
                    else "not a specific assertion" if r["subject_kind"] != "named_entity"
                    else "value not verbatim" if r["value_kind"] != "explicit"
                    else "below score threshold"}
            for r in rejected
        ],
        "note_detail": (
            "Proposals only. Nothing was written. Extraction precision for this task is "
            "measured at ~0.36, so review before creating fact notes. Every proposal "
            "carries the verbatim span and its source note."
        ),
    }, indent=2, sort_keys=True))
    return 0


def conflicts(api_key: str, args: argparse.Namespace, vault: Path) -> int:
    con = sqlite3.connect(f"file:{granite_db(vault)}?mode=ro", uri=True)
    try:
        note = load_note(con, args.slug)
        rows = con.execute(
            "SELECT slug, title, body FROM notes WHERE slug != ? AND length(body) > 200",
            (note["slug"],),
        ).fetchall()
    finally:
        con.close()

    if not rows:
        print(json.dumps({"status": "ok", "note": note["slug"], "candidates": 0}, indent=2))
        return 0

    # Structural scoping first, exactly as the evidence requires: only compare
    # against notes that share a distinctive token with this one. Unbounded
    # candidate generation is what produced a 70% false-retirement rate elsewhere.
    def tokens(text: str) -> set[str]:
        return {
            w.lower()
            for w in re.findall(r"[^\W\d_][\w'-]{4,}", text or "", flags=re.UNICODE)
        }

    own = tokens(note["title"]) | tokens(note["body"][:4000])
    scoped = []
    for slug, title, body in rows:
        shared = own & (tokens(title) | tokens(body[:2000]))
        if shared:
            scoped.append((len(shared), slug, title, body))
    scoped.sort(key=lambda item: -item[0])
    scoped = scoped[: args.limit]

    if not scoped:
        print(json.dumps({"status": "ok", "note": note["slug"], "candidates": 0,
                          "note_detail": "no note shares vocabulary with this one"}, indent=2))
        return 0

    questions: dict[str, Any] = {}
    for _shared, slug, _title, _body in scoped:
        questions[f"rel::{slug}"] = {
            "type": "score",
            "instructions": (
                f"How do note_a and note_b_candidates[id={slug}] relate? Do they assert "
                "different values for the same subject and attribute at the same time?"
            ),
            "criteria": CONFLICT_LEVELS,
        }

    response = post_questions(
        api_key, args.model,
        {"note_a": {"title": note["title"], "type": note["type"], "text": note["body"][: args.max_chars]},
         "note_b_candidates": [
             {"id": slug, "title": title, "text": body[: args.max_chars]}
             for _shared, slug, title, body in scoped
         ]},
        questions,
    )
    answers = response.get("answers", {})

    results = []
    for shared, slug, title, _body in scoped:
        score = float(answers.get(f"rel::{slug}", {}).get("score", 0.0))
        level = min(int(score + 0.5), len(CONFLICT_LEVELS) - 1)
        results.append({
            "slug": slug, "title": title,
            "verdict": CONFLICT_OUTCOME[level],
            "score": round(score, 2),
            "shared_terms": shared,
        })
    results.sort(key=lambda r: (-r["score"], r["slug"]))

    print(json.dumps({
        "status": "ok",
        "note": note["slug"],
        "model": response.get("model", args.model),
        "usage": response.get("usage", {}),
        "scoped_candidates": len(scoped),
        "summary": {v: sum(1 for r in results if r["verdict"] == v)
                    for v in ("conflict", "compatible", "unrelated")},
        "results": results,
        "note_detail": (
            "Conflicts are candidates for review. Nothing was changed. Granite's ledger "
            "surfaces conflicts and never resolves them, because automatic resolution was "
            "measured to retire true facts 70% of the time."
        ),
    }, indent=2, sort_keys=True))
    return 0


def align(api_key: str, args: argparse.Namespace, vault: Path) -> int:
    """Judge entity-identity candidates that code detects but cannot decide.

    Deterministic detection (identical folded titles, shared aliases) is Granite's
    job. This answers only the part code cannot: are these the *same thing*? It
    reports; it never merges or rewrites anything.
    """
    con = sqlite3.connect(f"file:{granite_db(vault)}?mode=ro", uri=True)
    try:
        rows = con.execute("SELECT slug, title, type, aliases FROM notes").fetchall()
    finally:
        con.close()

    def clean_title(value: str) -> str:
        # Some notes store a wikilink as the title ("[[Agence France-Presse (AFP)]]").
        # Strip the brackets so the name compared is the name a reader sees.
        text = (value or "").strip()
        text = re.sub(r"^\[\[", "", text)
        text = re.sub(r"\]\]$", "", text)
        return text.split("|")[-1].strip()

    def norm(value: str) -> str:
        return re.sub(r"[^a-z0-9]+", " ", clean_title(value).lower()).strip()

    entities = []
    for slug, title, ntype, aliases in rows:
        try:
            alias_list = json.loads(aliases or "[]")
        except json.JSONDecodeError:
            alias_list = []
        entities.append({"slug": slug, "title": clean_title(title), "type": ntype,
                         "aliases": [clean_title(str(a)) for a in alias_list]})

    # The same deterministic candidate signals Granite uses, so the two agree.
    by_title: dict[str, list[dict[str, Any]]] = {}
    by_alias: dict[str, list[dict[str, Any]]] = {}
    for entity in entities:
        key = norm(entity["title"])
        if key:
            by_title.setdefault(key, []).append(entity)
        own = set()
        for alias in [entity["title"], *entity["aliases"]]:
            alias_key = norm(alias)
            if not alias_key or alias_key in own:
                continue
            own.add(alias_key)
            by_alias.setdefault(alias_key, []).append(entity)

    pairs: list[dict[str, Any]] = []
    seen: set[str] = set()
    for key, bucket in list(by_title.items()) + list(by_alias.items()):
        distinct = list({e["slug"]: e for e in bucket}.values())
        for i in range(len(distinct)):
            for j in range(i + 1, len(distinct)):
                pair_key = "\u0000".join(sorted([distinct[i]["slug"], distinct[j]["slug"]]))
                if pair_key in seen:
                    continue
                seen.add(pair_key)
                pairs.append({"a": distinct[i], "b": distinct[j], "matched_on": key})

    # Only cross-type cases need a model. Same-type identical titles are true
    # duplicates for a human to merge; same-type shared aliases are safe to alias
    # mechanically. Granite's planAlignment draws the same line.
    to_judge = [p for p in pairs if p["a"]["type"] != p["b"]["type"]][: args.limit]

    if not to_judge:
        print(json.dumps({
            "status": "ok",
            "deterministic_candidates": len(pairs),
            "judged": 0,
            "note_detail": "no cross-type candidates need a judgement",
        }, indent=2, sort_keys=True))
        return 0

    questions: dict[str, Any] = {}
    for index, _pair in enumerate(to_judge):
        questions[f"id::{index}"] = {
            "type": "score",
            "instructions": (
                "Do entity_a and entity_b describe the same real-world thing? They may "
                f"have different record types. Judge only candidate_pairs[index={index}]."
            ),
            "criteria": IDENTITY_LEVELS,
        }

    response = post_questions(
        api_key, args.model,
        {"candidate_pairs": [
            {"index": index,
             "entity_a": {"name": p["a"]["title"], "type": p["a"]["type"]},
             "entity_b": {"name": p["b"]["title"], "type": p["b"]["type"]}}
            for index, p in enumerate(to_judge)
        ]},
        questions,
    )
    answers = response.get("answers", {})

    results = []
    for index, pair in enumerate(to_judge):
        answer = answers.get(f"id::{index}", {})
        score = float(answer.get("score", 0.0))
        level = min(int(score + 0.5), len(IDENTITY_LEVELS) - 1)
        results.append({
            "verdict": IDENTITY_OUTCOME[level],
            "score": round(score, 2),
            "matched_on": pair["matched_on"],
            "a": {"slug": pair["a"]["slug"], "title": pair["a"]["title"], "type": pair["a"]["type"]},
            "b": {"slug": pair["b"]["slug"], "title": pair["b"]["title"], "type": pair["b"]["type"]},
        })
    results.sort(key=lambda r: (-r["score"], r["a"]["slug"]))

    print(json.dumps({
        "status": "ok",
        "model": response.get("model", args.model),
        "usage": response.get("usage", {}),
        "deterministic_candidates": len(pairs),
        "judged": len(to_judge),
        "results": results,
        "note_detail": (
            "Advisory only. Nothing merged, nothing rewritten. Folding records across "
            "types is a modelling decision, so this reports and stops."
        ),
    }, indent=2, sort_keys=True))
    return 0


def main(argv: list[str]) -> int:
    parser = argparse.ArgumentParser(
        description=(
            "Propose facts and fact conflicts for Granite's deterministic ledger. "
            "Proposals only: this never writes to the vault."
        ),
    )
    parser.add_argument("command", choices=["facts", "conflicts", "align"])
    parser.add_argument("slug", nargs="?", help="required for facts and conflicts")
    parser.add_argument("--limit", type=int, default=8, help="notes to compare against (conflicts)")
    parser.add_argument("--candidates", type=int, default=40, help="sentences to consider (facts)")
    # Measured on a real vault: assertion scores occupy a compressed range
    # (roughly 0.0-2.0, not 0-3), so a "high" gate rejects everything. Real
    # assertions landed at 1.7-2.0 while action items and plans landed at 0.03-0.10,
    # so the useful cut is near the middle, not the top. Re-measure per corpus.
    parser.add_argument("--min-world-claim", type=float, default=0.5,
                        help="minimum probability that the sentence is a world claim, not document bookkeeping")
    parser.add_argument("--min-score", type=float, default=1.4,
                        help="minimum assertion score; scores are compressed, see docs")
    parser.add_argument("--max-chars", type=int, default=900)
    parser.add_argument("--model", default=os.environ.get("TYPESAFE_MODEL", DEFAULT_MODEL))
    parser.add_argument("--vault", default=os.environ.get("GRANITE_VAULT"))
    args = parser.parse_args(argv)

    vault = Path(args.vault).expanduser() if args.vault else Path.home() / ".granite"
    if not vault.is_dir():
        raise SystemExit(f"error: vault directory not found: {vault}")

    api_key = os.environ.get("TYPESAFE_API_KEY")
    if not api_key:
        print(json.dumps({
            "status": "unavailable",
            "reason": "missing TYPESAFE_API_KEY",
            "hint": (
                "Fact proposals need the model. The ledger itself needs no key: use "
                "`granite facts` for current state, retirements and contradictions."
            ),
        }, indent=2, sort_keys=True))
        return 0

    if args.command == "facts":
        return extract(api_key, args, vault)
    if args.command == "align":
        return align(api_key, args, vault)
    return conflicts(api_key, args, vault)


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
