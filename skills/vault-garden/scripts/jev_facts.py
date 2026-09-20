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
import unicodedata
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



MONTHS = {
    "janvier": "01", "fevrier": "02", "février": "02", "mars": "03", "avril": "04",
    "mai": "05", "juin": "06", "juillet": "07", "aout": "08", "août": "08",
    "septembre": "09", "octobre": "10", "novembre": "11", "decembre": "12", "décembre": "12",
}


def candidate_dates(text: str) -> list[str]:
    """Deterministic date candidates, so the model selects rather than generates."""
    out: list[str] = []
    for match in re.finditer(r"\b(\d{4})-(\d{2})-(\d{2})\b", text):
        out.append(match.group(0))
    for match in re.finditer(r"\b(\d{1,2})\s+([A-Za-zÀ-ÿ]+)\s+(\d{4})\b", text):
        month = MONTHS.get(match.group(2).lower())
        if month:
            out.append(f"{match.group(3)}-{month}-{int(match.group(1)):02d}")
    for match in re.finditer(r"\b([A-Za-zÀ-ÿ]+)\s+(\d{4})\b", text):
        month = MONTHS.get(match.group(1).lower())
        if month:
            out.append(f"{match.group(2)}-{month}-01")
    # De-duplicate, preserving order.
    return list(dict.fromkeys(out))[:6]


def candidate_entities(text: str, note_title: str) -> list[str]:
    """Entities the sentence could be about.

    A capitalised-word regex failed here: on real prose it produced verbs and bare
    nouns ("Fonctionne", "Flux", "Determinisme") that the model then selected as
    subjects. Capitalisation is not an entity signal in French sentence-initial
    position, so this reuses the word-window approach and lets the model choose.
    """
    tokens = re.findall(r"[\w€$%.,+-]+", text)
    spans: list[str] = []
    for size in (3, 2, 1):
        for start_index in range(0, max(0, len(tokens) - size + 1)):
            span = " ".join(tokens[start_index:start_index + size]).strip(" .,;:")
            if 2 <= len(span) <= 60:
                spans.append(span)
    if note_title:
        spans.insert(0, re.sub(r"^\[\[|\]\]$", "", note_title).strip())
    return list(dict.fromkeys(spans))[:24]


def candidate_values(text: str) -> list[str]:
    """Short spans that could be the asserted value.

    Generating this from a narrow regex (numbers, money, capitalised words) failed:
    on real prose notes it produced verbs like "Fonctionne" and single words like
    "Monka", and the model then had nothing correct to select. Coverage matters more
    than precision here, because a Choice cannot pick a value that is not offered.

    So this walks every short contiguous word window in the sentence, which is
    deterministic and always contains the right answer for a short value. The model's
    job is to select the informative one, which is the part it is actually good at.
    """
    tokens = re.findall(r"[\w€$%.,+-]+", text)
    spans: list[str] = []
    for size in (4, 3, 2, 1):
        for start in range(0, max(0, len(tokens) - size + 1)):
            span = " ".join(tokens[start:start + size]).strip(" .,;:")
            if 2 <= len(span) <= 60:
                spans.append(span)
    # Prefer longer spans when truncated: they carry more meaning.
    return list(dict.fromkeys(spans))[:24]



# A bounded relation vocabulary. Free-form relations cannot be validated and pollute
# grouping; these map onto values that are verifiable from the text.
# Unit-specific on purpose: a generic "count" made "150 questions" and "389 tasks" the
# same relation, which is wrong for grouping and would have made unrelated metrics look
# like competing values for one attribute.
METRIC_RELATIONS = {
    "ships_on": "The date something ships, launches or goes live.",
    "starts_on": "The date something starts or begins.",
    "ends_on": "The date something ends, expires or is due.",
    "question_count": "A number of questions or questionnaire items.",
    "task_count": "A number of tasks, actions or todos.",
    "actor_count": "A number of people, actors or participants.",
    "signal_count": "A number of signals, rules or clinical inputs.",
    "item_count": "A number of other items, categories or entries.",
    "price": "An amount of money, fee, budget or salary.",
    "version": "A version or release identifier.",
    "status": "Whether something is active, paused, archived, open or closed.",
}

# Structured, verifiable tokens. Each is checkable against the sentence, which is what
# makes a strict write-gate safe: our runs showed these extract cleanly while
# interpretive claims produced values like "standalone ou avec un".
ABSOLUTE_DATE_RE = r"\b\d{4}-\d{2}-\d{2}\b"
MONTH_NAMES = "janvier|fevrier|février|mars|avril|mai|juin|juillet|aout|août|septembre|octobre|novembre|decembre|décembre"
WRITTEN_DATE_RE = rf"\b\d{{1,2}}\s+(?:{MONTH_NAMES})\s+\d{{4}}\b"
MONTH_YEAR_RE = rf"\b(?:{MONTH_NAMES})\s+\d{{4}}\b"
MONEY_RE = r"\b\d[\d\s.,]*\s?(?:k€|€|\$|kEUR|EUR)\b"
COUNT_RE = r"\b\d[\d\s.,]*\s?(?:Q\b|r[eè]gles?|t[aâ]ches?|acteurs?|items?|questions?|signaux?|cat[eé]gories?|%)\b"
VERSION_RE = r"\bv?\d+\.\d+(?:\.\d+)?\b"


def note_aspect_labels(body: str, limit: int = 12) -> list[str]:
    """Short leading labels the note itself uses for its counts.

    Real notes label what they count ("Questionnaire initial — 150 Q", "126 questions
    socle ...", "Règles d'activation — 319"). Those labels are the disambiguation we
    need, so they are read from the text rather than invented.

    A first version kept every line containing a digit, which produced lead-ins like
    "En France" and "Flux utilisateur en" and table fragments; the model then answered
    "unclear" to all of them. Only genuine `label — number` and `label N unit` shapes
    are kept, and section numbering is stripped.
    """
    labels: list[str] = []
    skip_prefixes = (
        "un ", "une ", "le ", "la ", "les ", "en ", "il ", "elle ", "ce ", "cet ",
        "chaque ", "tous ", "toutes ", "pour ", "dans ", "avec ", "sur ",
    )
    for raw in body.splitlines():
        line = re.sub(r"\*\*|__|`", "", raw).strip().lstrip("-*# ").strip()
        if len(line) < 6 or not re.search(r"\d", line):
            continue
        if line.startswith("|"):
            continue
        label = None
        match = re.match(r"^([^—:–|]{3,48})[—:–]\s*\d", line)
        if match:
            label = match.group(1)
        else:
            match = re.match(
                r"^([A-Za-zÀ-ÿ][^—:–|]{2,48}?)\s+\d[\d\s.,]*\s?"
                r"(?:Q\b|r[eè]gles?|t[aâ]ches?|acteurs?|items?|questions?|signaux?|cat[eé]gories?|%)",
                line,
            )
            if match:
                label = match.group(1)
        if not label:
            continue
        # Drop a leading section number: "4.1 Règles d'activation" -> "Règles d'activation".
        label = re.sub(r"^\d+(?:\.\d+)*\s*", "", label).strip(" .,;:-")
        if len(label) < 3 or len(label) > 48:
            continue
        if label.lower().startswith(skip_prefixes):
            continue
        labels.append(re.sub(r"\s+", " ", label))
    return list(dict.fromkeys(labels))[:limit]


def metric_candidates(sentence: str) -> list[dict[str, str]]:
    """Structured values in a sentence, each with the token class that found it."""
    found: list[tuple[int, dict[str, str]]] = []
    for match in re.finditer(ABSOLUTE_DATE_RE, sentence):
        found.append((match.start(), {"kind": "date", "value": match.group(0)}))
    for match in re.finditer(WRITTEN_DATE_RE, sentence):
        found.append((match.start(), {"kind": "date", "value": match.group(0)}))
    for match in re.finditer(MONTH_YEAR_RE, sentence):
        found.append((match.start(), {"kind": "date", "value": match.group(0)}))
    for match in re.finditer(MONEY_RE, sentence):
        found.append((match.start(), {"kind": "money", "value": re.sub(r"\s+", " ", match.group(0)).strip()}))
    for match in re.finditer(COUNT_RE, sentence):
        found.append((match.start(), {"kind": "count", "value": re.sub(r"\s+", " ", match.group(0)).strip()}))
    for match in re.finditer(VERSION_RE, sentence):
        found.append((match.start(), {"kind": "version", "value": match.group(0)}))
    found.sort(key=lambda pair: pair[0])
    seen: set[str] = set()
    out: list[dict[str, str]] = []
    for _pos, item in found:
        if item["value"] in seen:
            continue
        seen.add(item["value"])
        out.append(item)
    return out[:8]


def build_extraction_questions(candidates: list[dict[str, Any]], note_title: str = "") -> dict[str, Any]:
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
        entity_options = {e: None for e in candidate_entities(candidate["text"], note_title)}
        questions[f"subject::{cid}"] = {
            "type": "choice",
            "instructions": (
                f"Which candidate_entities entry is the entity that candidate_sentences[id={cid}] "
                "asserts something about? If none is a specific entity, choose no_specific_entity."
            ),
            "criteria": {**entity_options, "no_specific_entity": "No single specific named entity."},
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
        value_options = {v: None for v in candidate_values(candidate["text"])}
        if value_options:
            questions[f"object::{cid}"] = {
                "type": "choice",
                "instructions": (
                    f"Which candidate_values entry is the value that candidate_sentences[id={cid}] "
                    "asserts about its subject? Choose the one stated by the sentence."
                ),
                "criteria": value_options,
            }
        date_options = {d: None for d in candidate_dates(candidate["text"])}
        if date_options:
            questions[f"valid_from::{cid}"] = {
                "type": "choice",
                "instructions": (
                    f"Which candidate_dates entry is the date on which candidate_sentences[id={cid}] "
                    "became true? If none is stated, choose no_date_stated."
                ),
                "criteria": {**date_options, "no_date_stated": "The sentence states no date."},
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
        build_extraction_questions(candidates, note["title"]),
    )
    answers = response.get("answers", {})

    proposed: list[dict[str, Any]] = []
    rejected: list[dict[str, Any]] = []
    for candidate in candidates:
        cid = candidate["id"]
        is_fact = answers.get(f"is_fact::{cid}", {})
        score = float(is_fact.get("score", 0.0))
        subject_kind = answers.get(f"subject::{cid}", {}).get("choice")
        subject_name = None if subject_kind == "no_specific_entity" else subject_kind
        value_kind = answers.get(f"value::{cid}", {}).get("choice")
        entry = {
            "span": candidate["text"],
            "source": note["slug"],
            "is_fact_score": round(score, 2),
            "subject_kind": subject_kind,
            "relation_kind": answers.get(f"relation::{cid}", {}).get("choice"),
            "value_kind": value_kind,
            "date_kind": answers.get(f"when::{cid}", {}).get("choice"),
            "world_claim": round(float(answers.get(f"is_world_claim::{cid}", {}).get("noul", 0.0)), 2),
            "object": answers.get(f"object::{cid}", {}).get("choice"),
            "valid_from": answers.get(f"valid_from::{cid}", {}).get("choice"),
        }
        # Only surface candidates the model actually scored as assertions, and only
        # when the value can be copied verbatim. An inferred value is exactly the
        # low-precision case the extraction numbers warn about.
        is_world_claim = float(answers.get(f"is_world_claim::{cid}", {}).get("noul", 0.0))
        object_value = answers.get(f"object::{cid}", {}).get("choice")
        stated_date = answers.get(f"valid_from::{cid}", {}).get("choice")
        # Every accepted proposal must be complete enough to write: a subject, a
        # bounded relation, a value that is verbatim in the sentence, and a date. A
        # missing date defaults to the extraction date and says so, rather than being
        # silently invented.
        if (score >= args.min_score and subject_name
                and value_kind == "explicit" and is_world_claim >= args.min_world_claim
                and object_value and object_value in candidate["text"]):
            entry["subject"] = subject_name
            entry["relation"] = answers.get(f"relation::{cid}", {}).get("choice")
            entry["object"] = object_value
            if stated_date and stated_date != "no_date_stated":
                entry["valid_from"] = stated_date
                entry["date_basis"] = "stated in the sentence"
            else:
                entry["valid_from"] = args.today
                entry["date_basis"] = f"not stated; defaults to the extraction date {args.today}"
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
                    else "not a specific assertion" if not r["subject_kind"] or r["subject_kind"] == "no_specific_entity"
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


def month_to_iso(value: str) -> str | None:
    """Normalise a written date to ISO, deterministically."""
    text = value.strip().lower()
    match = re.match(r"^(\d{4})-(\d{2})-(\d{2})$", text)
    if match:
        return text
    match = re.match(rf"^(\d{{1,2}})\s+({MONTH_NAMES})\s+(\d{{4}})$", text)
    if match:
        month = MONTHS.get(match.group(2))
        if month:
            return f"{match.group(3)}-{month}-{int(match.group(1)):02d}"
    match = re.match(rf"^({MONTH_NAMES})\s+(\d{{4}})$", text)
    if match:
        month = MONTHS.get(match.group(1))
        if month:
            return f"{match.group(2)}-{month}-01"
    return None


def slugify_aspect(value: Any) -> str:
    """Turn an aspect label into a relation-name fragment.

    Uses unicodedata rather than the str.normalize method: this helper runs inside a
    generated __pycache__ import chain, and the explicit call removes any ambiguity
    about which object is being normalised.
    """
    if not isinstance(value, str):
        return ""
    folded = "".join(
        c for c in unicodedata.normalize("NFD", value) if not unicodedata.combining(c)
    )
    return re.sub(r"[^a-zA-Z0-9]+", "_", folded).strip("_").lower()[:32]


def metrics(api_key: str, args: argparse.Namespace, vault: Path) -> int:
    """Extract only structured, verifiable claims.

    The broad `facts` command proposes anything that reads like an assertion, and our
    runs showed why that is unreliable: subjects came out as verbs and values as
    sentence fragments. This command narrows to tokens that can be *checked* - dates,
    counts, money, versions - where the value is verifiable against the sentence and a
    strict write gate is therefore safe to trust.

    The subject is the note's own entity, resolved deterministically from its title
    rather than asked of the model, because a free choice of subject produced
    "Fonctionne" and "Flux" on real prose.
    """
    con = sqlite3.connect(f"file:{granite_db(vault)}?mode=ro", uri=True)
    try:
        note = load_note(con, args.slug)
    finally:
        con.close()

    subject = re.sub(r"^\[\[|\]\]$", "", note["title"]).split("—")[0].split("(")[0].strip()
    if not subject:
        print(json.dumps({"status": "error", "reason": "note has no usable title as subject"}, indent=2))
        return 0

    # Only sentences that actually carry a structured token can yield a metric.
    sentences_with_metrics: list[dict[str, Any]] = []
    for candidate in sentences(note["body"], args.candidates * 4):
        found = metric_candidates(candidate["text"])
        if found:
            sentences_with_metrics.append({**candidate, "metrics": found})
    sentences_with_metrics = sentences_with_metrics[: args.candidates]

    if not sentences_with_metrics:
        print(json.dumps({
            "status": "ok", "note": note["slug"], "subject": subject, "proposed": 0,
            "note_detail": "no sentence carries a structured value",
        }, indent=2))
        return 0

    aspects = note_aspect_labels(note["body"])
    questions: dict[str, Any] = {}
    for candidate in sentences_with_metrics:
        cid = candidate["id"]
        options = {m["value"]: None for m in candidate["metrics"]}
        questions[f"metric::{cid}"] = {
            "type": "choice",
            "instructions": (
                f"Which candidate_metrics entry is a value that candidate_sentences[id={cid}] "
                "asserts as a fact? Choose no_metric if none is asserted."
            ),
            "criteria": {**options, "no_metric": "None of these is asserted as a fact."},
        }
        questions[f"relation::{cid}"] = {
            "type": "choice",
            "instructions": (
                f"Which relation does candidate_sentences[id={cid}] assert for the metric it "
                "states? Choose the closest."
            ),
            "criteria": {**METRIC_RELATIONS, "other": "None of these fits."},
        }
        aspect_options = {a: None for a in aspects}
        questions[f"aspect::{cid}"] = {
            "type": "choice",
            "instructions": (
                f"Which candidate_aspects entry names what candidate_sentences[id={cid}] "
                "counts or measures? Choose the closest."
            ),
            "criteria": {**aspect_options, "unclear_aspect": "None of these names it."},
        }
        questions[f"world::{cid}"] = {
            "type": "noul",
            "instructions": (
                f"Does candidate_sentences[id={cid}] assert a fact about the world rather than "
                "about the document itself or its provenance?"
            ),
            "criteria": {"true": "A claim about an entity or project.",
                         "false": "About the document, its version history, or who sent it."},
        }

    response = post_questions(
        api_key, args.model,
        {"note": {"title": note["title"], "type": note["type"]},
         "note_subject": subject,
         "candidate_sentences": [
             {"id": c["id"], "text": c["text"]}
             for c in sentences_with_metrics
         ],
         "candidate_aspects": aspects,
         "candidate_metrics": [
             {"sentence_id": c["id"], "values": [m["value"] for m in c["metrics"]]}
             for c in sentences_with_metrics
         ]},
        questions,
    )
    answers = response.get("answers", {})

    proposals: list[dict[str, Any]] = []
    dropped: list[dict[str, Any]] = []
    for candidate in sentences_with_metrics:
        cid = candidate["id"]
        value = answers.get(f"metric::{cid}", {}).get("choice")
        relation = answers.get(f"relation::{cid}", {}).get("choice")
        world = float(answers.get(f"world::{cid}", {}).get("noul", 0.0))
        entry = {
            "source": note["slug"], "span": candidate["text"], "subject": subject,
            "relation": relation, "object": value, "world_claim": round(world, 2),
        }
        aspect = answers.get(f"aspect::{cid}", {}).get("choice")
        # A counted metric gets a relation naming what is counted, so six different
        # counts for one subject become six relations rather than six competing values.
        # The name comes from the note's own labels, so it is grounded rather than
        # invented; if none fits, the proposal is dropped instead of guessed at.
        if relation in {"question_count", "task_count", "actor_count", "signal_count", "item_count"}:
            if not aspect or aspect == "unclear_aspect":
                relation = None
            else:
                slug = slugify_aspect(aspect)
                relation = f"{relation}__{slug}" if slug else None
        # The entry was built before the aspect was resolved, so write the final
        # relation back onto it. Without this the aspect never reached the output.
        entry["relation"] = relation
        if not value or value == "no_metric" or not relation or relation == "other" or world < args.min_world_claim:
            entry["why"] = (
                "model asserts no metric" if not value or value == "no_metric"
                else "what is counted could not be named" if not relation
                else "no bounded relation fits" if relation == "other"
                else "not a world claim"
            )
            dropped.append(entry)
            continue
        # Resolve the date deterministically. A date metric becomes valid_from; any
        # other metric keeps the default unless the sentence states a separate date.
        stated = None
        for item in candidate["metrics"]:
            if item["kind"] == "date":
                stated = month_to_iso(item["value"])
                if stated:
                    break
        if relation in {"ships_on", "starts_on", "ends_on"} and value:
            stated = month_to_iso(value) or stated
        entry["valid_from"] = stated or args.today
        entry["date_basis"] = "stated in the sentence" if stated else f"not stated; defaults to {args.today}"
        proposals.append(entry)

    # One entry per (relation, object): the same value stated twice is one fact.
    deduped: list[dict[str, Any]] = []
    seen_triples: set[tuple[str, str]] = set()
    for proposal in proposals:
        key = (str(proposal["relation"]), str(proposal["object"]))
        if key in seen_triples:
            continue
        seen_triples.add(key)
        deduped.append(proposal)
    proposals = deduped

    print(json.dumps({
        "status": "ok",
        "note": note["slug"],
        "subject": subject,
        "model": response.get("model", args.model),
        "usage": response.get("usage", {}),
        "sentences_with_metrics": len(sentences_with_metrics),
        "proposed": len(proposals),
        "facts": proposals,
        "dropped": dropped,
        "note_detail": (
            "Structured metrics only. Every value is verifiable against its sentence, and "
            "the subject is the note's own entity, resolved in code."
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
    parser.add_argument("command", choices=["facts", "metrics", "conflicts", "align"])
    parser.add_argument("slug", nargs="?", help="required for facts and conflicts")
    parser.add_argument("--limit", type=int, default=8, help="notes to compare against (conflicts)")
    parser.add_argument("--candidates", type=int, default=40, help="sentences to consider (facts)")
    # Measured on a real vault: assertion scores occupy a compressed range
    # (roughly 0.0-2.0, not 0-3), so a "high" gate rejects everything. Real
    # assertions landed at 1.7-2.0 while action items and plans landed at 0.03-0.10,
    # so the useful cut is near the middle, not the top. Re-measure per corpus.
    parser.add_argument("--today", default=__import__("datetime").date.today().isoformat(),
                        help="date used when a sentence states none")
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
    if args.command == "metrics":
        return metrics(api_key, args, vault)
    if args.command == "align":
        return align(api_key, args, vault)
    return conflicts(api_key, args, vault)


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
