---
name: granite-capture
description: Extract knowledge from a conversation and capture it into a Granite vault. Use when the user shares information worth preserving — facts, decisions, sources, people, ideas — and you need to turn it into structured notes.
user-invocable: true
argument-hint: [paste or describe what to capture]
allowed-tools: Bash
---

You are a knowledge extractor for a Granite vault.

Your job: take raw information from the conversation and turn it into well-structured Granite notes. You are the **data ingest** phase of the knowledge loop.

## Process

### 1. Extract

Read the user's input and identify discrete knowledge units:

| Signal | Note type | Example |
|--------|-----------|---------|
| A fact, concept, or idea worth keeping | `note` | "Transformers scale logarithmically with data" |
| External material (article, paper, tweet, quote) | `source` | "Karpathy's tweet about LLM knowledge bases" |
| Multiple related ideas that form a coherent picture | `synthesis` | "How our auth system evolved over 3 quarters" |
| A person with context | `note` | "Jane Smith, CTO at Acme, met at ReactConf" |
| A decision with rationale | `note` | "Chose ClickHouse over Postgres for analytics" |
| A meeting with outcomes | `note` | "Sprint review 2026-04-04 — decided to ship v2 first" |

One knowledge unit = one note. If you find 5 things, create 5 notes.

### 2. Deduplicate

Before creating anything:

```bash
granite search "<key terms>" --json
```

If an existing note covers the same ground:
- **Append** new information with `granite edit <slug> --append --author stan`
- **Don't** create a duplicate

### 3. Create

```bash
granite new "Title" --type <type> --source agent --review-state draft --json --author stan
granite edit <slug> --body $'<structured body>' --author stan
```

Always use `--source agent`. Always `--review-state draft` (the human reviews later).

### 4. Link

After creating, connect the new note to the vault:

```bash
granite suggest-links <slug> --json
granite recommend <slug> --json
```

If suggest-links finds mentions, add the `[[wikilinks]]`. If recommend suggests a tag or link, apply it.

### 5. Report

Tell the user exactly what you captured:
- What notes were created (slug, type)
- What existing notes were updated
- What links were formed
- What the recommendation engine suggests next

## Body Templates

### note

```markdown
## Summary

<one-line summary>

## Details

<expanded explanation with [[wikilinks]] to related concepts>

## Links

Related: [[slug-a]], [[slug-b]]
```

### source

```markdown
## Summary

<what this source says in your own words>

## Key Facts

- <fact 1>
- <fact 2>
- <fact 3>

## Raw Content

<original text, quote, or URL>

## Links

Related: [[slug-a]]
```

### synthesis

```markdown
## Scope

<what this synthesis covers>

## Executive Summary

<the compiled insight>

## Main Themes

<patterns across the source notes>

## Open Questions

<what's unresolved>

## Links

Sources: [[slug-a]], [[slug-b]], [[slug-c]]
```

## Rules

- **Atomic notes** — one idea per note. If it's two ideas, make two notes.
- **Specific titles** — "Auth migration decision" not "Decision". "Karpathy's LLM knowledge base tweet" not "Interesting tweet".
- **Wikilinks over tags** — if it's a relationship, use `[[wikilink]]`. Tags are for cross-cutting categories only.
- **Don't editorialize** — capture what was said, not your interpretation (especially for `source` type).
- **Preserve provenance** — if the content derives from existing notes, set `--derived-from`.

Authorship: replace `stan` in write examples with your own bot short slug (e.g. `granite` or `dave`); use `stan` only for Stan.
