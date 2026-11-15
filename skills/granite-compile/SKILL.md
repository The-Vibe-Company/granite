---
name: granite-compile
description: Synthesize scattered Granite notes into compiled knowledge. Use when the user wants to connect ideas, build a synthesis from multiple notes, or compile what the vault knows about a topic.
user-invocable: true
argument-hint: <topic to compile>
allowed-tools: Bash
---

You are a knowledge compiler for a Granite vault.

Your job: take scattered notes and sources and compile them into a **synthesis** — durable knowledge that is more valuable than any individual note. This is the most important operation in the knowledge loop.

## Process

### 1. Research the Topic

```bash
granite search "<topic>" --json
granite list --type source --json slug,title,tags
granite list --type note --json slug,title,tags
```

Read each relevant note:

```bash
granite show <slug> --json
granite backlinks <slug> --json
```

Build a mental map of what the vault knows. Look for:
- **Clusters** — notes that reference each other
- **Tensions** — notes that disagree or present different angles
- **Gaps** — things referenced but not yet captured
- **Patterns** — recurring themes across sources

### 2. Check for Existing Synthesis

```bash
granite search "<topic>" --json
granite list --type synthesis --json slug,title
```

If a synthesis already exists on this topic:
- Read it, then **update** it with new connections
- Don't create a duplicate synthesis

### 3. Compile

Create the synthesis:

```bash
granite new "<Topic> synthesis" --type synthesis --source agent --review-state draft --derived-from slug-a,slug-b,slug-c --json --author stan
```

Write a body that:
- **Connects** — draws explicit links between ideas from different notes
- **Elevates** — says something the individual notes don't say alone
- **Links back** — uses `[[wikilinks]]` to every source note
- **Scopes** — states clearly what it covers and what it doesn't

```bash
granite edit <slug> --author stan --body $'## Scope

<what this synthesis covers and doesn'\''t>

## Executive Summary

<the compiled insight — what you know NOW that no single note says>

## Main Themes

### <Theme 1>

<pattern observed across [[source-a]], [[note-b]], [[note-c]]>

### <Theme 2>

<another pattern or tension>

## Open Questions

- <what'\''s missing or unresolved>
- <what the next capture or research should target>

## Links

Sources: [[slug-a]], [[slug-b]], [[slug-c]]
See also: [[related-synthesis]]'
```

### 4. Strengthen the Graph

After creating the synthesis:

```bash
granite suggest-links <slug> --json
granite recommend <slug> --json
```

Apply suggested links. Check if source notes should link back to the synthesis.

### 5. Report

Tell the user:
- What synthesis was created (slug, scope)
- Which notes it compiles (with count)
- Key insight that emerged from compilation
- Open questions and suggested next captures
- What `granite recommend` suggests as next step

## What Makes a Good Synthesis

A synthesis is **not** a summary. It's compiled knowledge:

| Bad synthesis | Good synthesis |
|---------------|----------------|
| Lists what each note says | Connects ideas across notes to reveal patterns |
| Repeats information | Adds insight the notes don't contain individually |
| Has no wikilinks | Links every claim back to its source note |
| No scope statement | Clear boundary on what it covers |
| No open questions | Identifies what's missing for the next iteration |

## Rules

- **Always set `derived_from`** — list every note slug the synthesis draws from.
- **Scope explicitly** — a synthesis without scope is just a long note.
- **One synthesis per topic** — update the existing one rather than creating overlapping syntheses.
- **Link bidirectionally** — the synthesis links to sources, and sources should link back.
- **Surface tensions** — if notes disagree, say so. Don't flatten nuance.
- **Open questions drive the loop** — a good synthesis tells you what to capture next.

Authorship: replace `stan` in write examples with your own bot short slug (e.g. `granite` or `dave`); use `stan` only for Stan.
