---
name: granite
description: Work safely in a Granite vault using the `granite` CLI. Use when the user wants to capture, search, read, update, or navigate knowledge in a local-first markdown memory system.
user-invocable: true
argument-hint: [query or action]
allowed-tools: Bash
---

You are operating a Granite vault — a local-first knowledge compiler inspired by Karpathy's vision of LLM-operated knowledge bases.

The core loop is: **capture → compile → query → output → lint**.

This skill covers **query and CRUD** — the foundation. Use the specialized skills for the other phases:
- `/granite-capture` — extract and capture knowledge from conversations
- `/granite-compile` — synthesize scattered notes into compiled knowledge
- `/granite-brief` — generate audience-specific outputs from the vault
- `/granite-lint` — health-check and strengthen the vault

## Safety Rules

1. **Read before write.** Always search before creating. Never create a duplicate.
2. **`--source agent`** on every create and edit you perform.
3. **Respect `locked`** — if `review_state: locked`, create a derived note instead of editing.
4. **Provenance** — set `--derived-from` on every `synthesis` and `output` note.
5. **Smallest useful change** — append or link when that's clearly better than creating.

## Note Types

| Type | Purpose | Durability |
|------|---------|------------|
| `note` | Atomic durable idea | canonical |
| `source` | Imported/observed material | canonical |
| `synthesis` | Compiled knowledge across notes | canonical |
| `output` | Audience-specific deliverable | ephemeral |

Natural flow: `source → note → synthesis → output`

## CLI Quick Reference

### Search & Read

```bash
granite search "<query>" --json
granite list --json slug,title,type,status
granite list --type source --since 2026-04-01 --json slug,title
granite show <slug> --json
granite backlinks <slug> --json
granite suggest-links <slug> --json
granite recommend <slug> --json
```

### Create

```bash
granite new "Title" --type note --source agent --json --author stan
granite new "Title" --type source --source agent --durability canonical --json --author stan
granite new "Title" --type synthesis --source agent --derived-from slug-a,slug-b --json --author stan
granite new "Title" --type output --source agent --durability ephemeral --derived-from slug-a --json --author stan
granite add "Quick thought" --source agent --json --author stan
```

### Update

```bash
granite edit <slug> --append $'New content' --author stan
granite edit <slug> --body $'Full replacement' --author stan
granite edit <slug> --tag "tag1,tag2" --author stan
granite edit <slug> --status archived --author stan
granite edit <slug> --review-state reviewed --author stan
granite edit <slug> --derived-from note-a,note-b --author stan
```

### Inspect

```bash
granite types
granite doctor
```

## When the User Asks "What Do We Know About X?"

```bash
granite search "X" --json
granite show <best-slug> --json
granite backlinks <best-slug> --json
```

Synthesize from retrieved notes. Never invent provenance not in the vault.

## Anti-patterns

- Creating without searching first
- Editing a `locked` note without explicit permission
- `output` without `derived_from`
- Replacing wikilinks with tags
- Overwriting a human note when a derived note would be safer

Authorship: replace `stan` in write examples with your own bot short slug (e.g. `granite` or `dave`); use `stan` only for Stan.
