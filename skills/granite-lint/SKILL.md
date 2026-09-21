---
name: granite-lint
description: Health-check a Granite vault and fix structural issues. Use when the user wants to clean up the vault, find broken links, detect orphans, strengthen the knowledge graph, or run a periodic review.
user-invocable: true
argument-hint: [focus area]
allowed-tools: Bash
---

You are a vault maintainer for a Granite vault.

Your job: find and fix structural problems, strengthen the knowledge graph, and surface what the vault needs next. This is the **lint** phase of the knowledge loop.

## Process

### 1. Run Doctor

```bash
granite doctor --json
```

Fix what you can immediately:
- **Broken wikilinks** — find the correct slug and update the link
- **Missing frontmatter** — add required fields
- **Line limit violations** — split oversized notes or flag for user review

### 2. Find Orphans

List all notes and check for backlinks:

```bash
granite list --json slug,title,type,status
```

For each note (prioritize `note` and `synthesis` types):

```bash
granite backlinks <slug> --json
```

Orphans (zero backlinks) need attention:
- If they should be linked from other notes, add wikilinks
- If they're isolated ideas, run `suggest-links` to find connections
- If they're stale, propose archiving

### 3. Check Inbox

```bash
granite list --status inbox --json slug,title,type,created
```

Inbox notes older than a few days are rotting. For each:
- Refine into a durable note, or
- Merge into an existing note, or
- Archive if no longer relevant

### 4. Strengthen Connections

For notes with few links:

```bash
granite suggest-links <slug> --json
granite recommend <slug> --json
```

Apply what makes sense:
- Add wikilinks for unlinked mentions
- Apply recommended tags
- Create follow-up notes if recommend suggests them

When lexical matching finds nothing for a note that clearly belongs somewhere,
the graph and the semantic layer can help. Lint diagnoses, so route the fix to the
MCP tools rather than duplicating the logic here:

```
granite_about(slug)        # what the vault already knows, through the links
granite_pool(anchor)       # the bounded candidate set worth judging
granite_answer(question, anchor)   # judge a question inside that set
```

`granite_about` and `granite_pool` are deterministic and need no key. Every tool that
judges is backed by Jev, which Granite requires: without a TypeSafe key the server and
the CLI refuse to start rather than return answers they cannot stand behind.

Link-worthiness is a different question from near-duplicate detection in step 2. Do
not use those tools to decide that two notes are the same note: a synthesis and the
entity note it compiles are a good link and a bad merge at once.

### 5. Detect Compilation Opportunities

Look for clusters of 3+ related `note` or `source` type notes that lack a unifying `synthesis`:

```bash
granite list --type note --json slug,title,tags
granite list --type source --json slug,title,tags
granite list --type synthesis --json slug,title
```

If you see a cluster that should be compiled, suggest `/granite-compile <topic>`.

### 6. Report

Present a structured health report:

```
## Vault Health Report

### Fixed
- <what you fixed>

### Needs Attention
- <issues that need user decision>

### Orphans
- <notes with no connections>

### Inbox Status
- <inbox notes and their age>

### Compilation Opportunities
- <clusters that could become syntheses>

### Stats
- Total notes: X
- By type: Y notes, Z sources, W syntheses, V outputs
- Orphans: N
- Inbox items: M
```

## Rules

- **Fix before flagging** — if you can fix it (broken link, missing tag), do it. Only flag issues that need human judgment.
- **Don't delete** — archive instead. `granite edit <slug> --status archived`
- **Don't edit locked notes** — flag them for the user.
- **Explain why** — for each suggestion, say what it improves (graph density, discoverability, compilation readiness).
- **End with next action** — always tell the user the single most valuable thing to do next (usually `/granite-capture` or `/granite-compile`).
