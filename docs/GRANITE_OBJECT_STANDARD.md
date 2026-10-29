# Granite Object Standard (GOS)

> A small protocol for human-readable, agent-operable notes in Granite.

---

## 1. Design Principles

### 1.1 Markdown is truth, everything else is derived
Files on disk are the source of truth. The SQLite index, backlinks graph, and search
results are materialized views — rebuilt anytime from the files.

### 1.2 Human-readable, agent-operable
Granite stays readable in raw Markdown first. Structured JSON and MCP exposure are there to make the same vault easy for agents to inspect and modify safely.

### 1.3 Stable identity survives renames
Notes are identified by UUID (`id` in frontmatter), not by slug or title.
Slugs are human-friendly aliases. Wikilinks resolve through: slug → title → alias → id.

### 1.4 Type = Schema
Each note type defines expected fields. The type system is the schema system.
Types are constrained to ~10 max (Johnny Decimal principle: discoverable at a glance).

### 1.5 Minimal protocol beats hidden policy
The Granite core should define a small, explicit protocol: stable IDs, note types, lifecycle state, editorial state, durability, and provenance hooks. Richer agent behavior belongs in skills, templates, and team process.

---

## 2. Note Object Schema

### 2.1 Universal frontmatter (all note types)

```yaml
---
id: "uuid-v4"                    # Stable identity (survives renames)
title: "Note Title"              # Human-readable name
type: "note"                     # Schema selector
created: "2026-03-30T10:00:00Z"  # ISO 8601
modified: "2026-03-30T10:00:00Z" # ISO 8601
tags: [architecture, active]     # Flat taxonomy, lowercase
aliases: [alt-name, abbrev]      # Resolve wikilinks by alias
status: active                   # Lifecycle: inbox | active | archived
source: human                    # Provenance: human | agent | extraction
review_state: draft              # Editorial state: draft | reviewed | locked
durability: canonical            # Knowledge lifecycle: canonical | working | ephemeral
derived_from: []                 # Optional provenance chain for derived notes
---
```

**Current shared protocol fields:**
- `status` — lifecycle state, orthogonal to type: `inbox | active | archived`
- `source` — who created the note: `human | agent | extraction`
- `review_state` — editorial state: `draft | reviewed | locked`
- `durability` — whether a note is durable knowledge, working material, or situation-specific output
- `derived_from` — minimal provenance hook for syntheses and outputs

### 2.2 Type-specific schemas (defined in granite.yml)

Each note type declares expected fields and their types. Granite itself stays small; richer structured workflows are optional and can be added in `granite.yml` when needed.

```yaml
note_types:
  source:
    folder: notes/sources
    description: Imported or observed source material
    template: |
      ## Summary

      ## Key Facts

      - 

      ## Raw Content

      ## Links
    line_limit: 400

  synthesis:
    folder: notes/syntheses
    description: Compiled knowledge across multiple notes or sources
    template: |
      ## Scope

      ## Executive Summary

      ## Main Themes

      ## Open Questions

      ## Links
    line_limit: 300
```

**Field types:** `text`, `date`, `number`, `boolean`, `wikilink`, `list`, `enum`.
Type-specific fields appear in frontmatter and are indexed in SQLite for structured queries.

### 2.3 Structured relationships via frontmatter

```yaml
---
id: "abc-123"
title: "State of transformer scaling"
type: synthesis
derived_from: ["attention-is-all-you-need", "scaling-laws"]
---
```

The body still uses `[[wikilinks]]` for inline mentions, but frontmatter relationships are more structured and easier for agents to interpret consistently.

---

## 3. CLI Output Standard

### 3.1 JSON envelope

**Success:**
```json
{
  "success": true,
  "data": { ... },
  "meta": {
    "count": 5,
    "vault": "/home/user/notes"
  }
}
```

**Error:**
```json
{
  "success": false,
  "error": {
    "code": "NOTE_NOT_FOUND",
    "message": "No note with slug 'nonexistent'",
    "suggestion": "Did you mean 'decision-api-format'?"
  }
}
```

### 3.2 Field selection

```bash
granite list --json slug,title,type,tags
granite show note-slug --json title,body,backlinks
```

`granite list --json` without field names returns the default field set:
```
slug, title, type, created, modified, tags, aliases, status, source, review_state, durability, derived_from, filepath
```

### 3.3 Exit codes

| Code | Meaning |
|------|---------|
| 0 | Success |
| 1 | General error |
| 2 | Usage/argument error |

---

## 4. Agent Interaction Standard

### 4.1 The ECDA loop (Extract → Compare → Decide → Act)

Every agent interaction with the vault follows this pattern:

```
┌─────────┐    ┌─────────┐    ┌─────────┐    ┌─────────┐
│ EXTRACT │───▶│ COMPARE │───▶│ DECIDE  │───▶│  ACT    │
│ facts   │    │ search  │    │ ADD?    │    │ create/ │
│ from    │    │ vault   │    │ UPDATE? │    │ update/ │
│ context │    │ for     │    │ NOOP?   │    │ link    │
│         │    │ matches │    │         │    │         │
└─────────┘    └─────────┘    └─────────┘    └─────────┘
```

**Step 1 — Extract:** Identify atomic facts, entities, and relationships from conversation.

**Step 2 — Compare:** Search the vault for existing notes about the same entities.
```bash
granite search "transformer scaling" --json
granite list --type synthesis --json slug,title,review_state
```

**Step 3 — Decide:**
- If no match → `ADD` (create new note)
- If match and new info → `UPDATE` (append or edit existing)
- If match and no new info → `NOOP` (skip)

**Step 4 — Act:**
```bash
granite new "State of transformer scaling" -t synthesis --review-state reviewed --derived-from attention-is-all-you-need,scaling-laws --json
granite edit state-of-transformer-scaling --append $'\n## Links\n\n- [[scaling-laws]]'
```

### 4.3 MCP resource/tool mapping

If Granite exposes an MCP server, the split is:

**Resources (raw reads, application-controlled):**
- `granite://notes/{slug}` — read the source markdown for a note
- `granite://vault/types` — read the note-type contract for the vault
- `granite://assets/{filename}` — read an imported asset as text or a base64 blob

**Public tools (intent-first, model-controlled):**
- `granite_wakeup()` — load the compressed map of the vault
- `granite_vault_types()` — read the same full type contract as `granite://vault/types`
- `granite_read_resource(uri)` — read any resource, including concrete note and asset template URIs; returns embedded MCP resources with identical content
- `granite_research_topic(query, limit?)` — discover relevant notes for a topic
- `granite_capture_knowledge(...)` — capture new knowledge into the vault
- `granite_understand_note(slug)` — inspect a note in graph context
- `granite_revise_note(slug, changes...)` — make targeted revisions
- `granite_dispose_note(slug, mode?)` — archive by default, delete intentionally

**Workflow prompts (agent-facing methodology):**
- `granite_refine_note(slug)` — turn a draft into a durable note
- `granite_compile_topic(topic)` — compile related notes into a synthesis
- `granite_process_inbox()` — triage and refine inbox notes
- `granite_garden_vault()` — review and strengthen the graph

---

## 5. Knowledge Patterns

### 5.1 Hub notes (Maps of Content)

For major topics, create durable notes that are mostly links:

```yaml
---
title: "Knowledge Map: Infrastructure"
type: note
tags: [hub, area/infrastructure]
---

## Sources
- [[attention-is-all-you-need]] — Foundational transformer paper
- [[scaling-laws]] — Reference on scaling behavior

## Durable Notes
- [[transformer-architectures]]
- [[training-compute-tradeoffs]]

## Syntheses
- [[state-of-transformer-scaling]]
- [[attention-variants-overview]]
```

### 5.2 The promotion flow

```
note (canonical) ──compile──▶ synthesis (canonical)
synthesis (canonical) ──render──▶ output (ephemeral)
```

This is the main distinction Granite now supports in the core:
- durable knowledge
- working material
- situational output

---

## 6. Implementation Priorities for Granite

### Implemented
- Shared frontmatter protocol: `status`, `source`, `review_state`, `durability`, `derived_from`
- Default note types for `source`, `synthesis`, and `output`
- CLI support for editing the shared protocol fields
- MCP exposure of the same protocol fields
- `doctor` warnings for invalid lifecycle/editorial metadata and missing provenance on `synthesis` / `output`

### Intentionally out of core
- Confidence scoring
- Mandatory “agent trace” sections
- Model-specific prompts or planner behavior
- Rich agent policy embedded in Granite
