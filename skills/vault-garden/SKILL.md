---
name: vault-garden
description: "Actively maintain and grow the Granite vault — review drafts, connect orphans, enrich weak notes, promote good notes, and keep the knowledge graph healthy. Use when the user wants to garden the vault, maintain notes, clean up, review drafts, connect orphans, strengthen the graph, or says 'garden', 'maintain the vault', 'clean up granite', 'review my notes', 'tidy up'. Different from granite-lint (which diagnoses); this skill fixes, enriches, and grows."
user-invocable: true
argument-hint: [focus: drafts | orphans | enrich | all]
allowed-tools:
  - Bash
  - Read
  - Write
  - Grep
  - Glob
  - ToolSearch
  - Agent
---

# Vault Garden

You are the gardener of a Granite vault. Your job is not to diagnose (that's `/granite-lint`) — it's to do the actual work: review drafts, connect orphans, enrich thin notes, and grow the graph.

Think of it like tending a garden: pull weeds, water what's growing, plant connections between things that should be linked.

## How to garden

### 1. Assess the vault

```bash
granite status
granite doctor --json
```

From this, build a work list. Prioritize:
1. **Drafts** — notes the agent wrote that haven't been reviewed
2. **Orphans** — notes with zero backlinks (disconnected from the graph)
3. **Thin notes** — notes with less than 3 outgoing wikilinks
4. **Stale inbox** — fleeting notes older than 3 days that should be promoted or archived

### 2. Review drafts

For each draft note, read it in full:

```bash
granite show <slug>
```

Then decide:
- **Promote to reviewed** if the content is accurate and well-structured
- **Edit and promote** if it needs minor fixes (typos, missing links, weak summary)
- **Archive** if it's stale, duplicate, or no longer relevant

To promote:
```bash
granite edit <slug> --review-state reviewed
```

To enrich before promoting:
```bash
granite edit <slug> --append $'<additional content or links>'
```

When reviewing, look for:
- Is the summary clear and self-contained?
- Are there `[[wikilinks]]` to related notes?
- Are tags appropriate (not too many, not too few — 3-6 is ideal)?
- For sources: is the provenance (URL, author, date) complete?
- For syntheses: does `derived_from` list the actual source notes?

### 3. Connect orphans

For each orphan note:

```bash
granite suggest-links <slug> --json
granite recommend <slug> --json
```

- Add wikilinks that `suggest-links` finds (unlinked mentions in other notes)
- Apply recommended tags
- If the orphan logically belongs as a source for an existing synthesis, add `derived_from`
- If no connections make sense, the note might be too vague — enrich its body first, then try again

`granite suggest-links` only matches notes named literally in the text. When that
finds nothing but the note clearly belongs somewhere, ask for semantic
judgments — this is optional and only runs if `TYPESAFE_API_KEY` is set:

```bash
python3 scripts/jev_judge.py candidates <slug> --limit 12
python3 scripts/jev_judge.py judge <slug> --limit 12
```

Act on `verdict: link`; treat `verdict: review` as a candidate to inspect
yourself and `skip` as noise. See
[references/jev-semantic-layer.md](references/jev-semantic-layer.md) for the
thresholds, cost model and calibration workflow. If the helper reports
`status: unavailable`, no key is configured — continue with the deterministic
commands above and do not treat it as a failure.

### 3b. Merge near-duplicates

Linking and merging are different questions: a synthesis and the entity note it
compiles are a **good link and a bad merge** at the same time. Never use the link
judgment above to decide that two notes are the same note.

To get a ranked queue of likely duplicates:

```bash
python3 scripts/jev_judge.py duplicates --limit 20
```

`verdict: merge` means the pair should become one note; `review` means a human
should look. Treat this as a queue, not an automatic merge: the merge classifier
has no positive labels to validate against, so its confidence is not calibrated.
Merge the useful parts first, then archive:

```bash
granite edit <slug> --status archived
```

### 4. Enrich thin notes

Notes with fewer than 3 outgoing wikilinks are under-connected. For each:

1. Read the note body
2. Search the vault for related concepts: `granite search "<key terms from the note>"`
3. Add `[[wikilinks]]` where concepts overlap
4. If the note references external material that isn't captured, suggest creating a source note

The goal isn't maximum links — it's meaningful links. Don't force connections that aren't there.

### 5. Spot synthesis opportunities

While gardening, notice when 3+ notes cluster around a theme but no synthesis exists. Flag these to the user:

> "I noticed 4 notes about X marketing strategy but no synthesis pulling them together. Want me to run `/granite-compile` on this cluster?"

### 6. Archive dead weight

Notes that are:
- Duplicates of other notes (merge the useful parts first)
- Test/demo data that leaked in
- Ephemeral notes older than 2 weeks with no connections

Archive, don't delete:
```bash
granite edit <slug> --status archived
```

## Reporting

After gardening, give a brief summary:

```markdown
## Garden Report

**Reviewed:** X drafts → Y promoted, Z archived
**Connected:** X orphans → Y now linked
**Enriched:** X notes with new wikilinks
**Archived:** X dead notes

**Vault health:** X notes, Y reviewed, Z orphans remaining
**Next garden:** <what to focus on next time>
```

## Principles

- **Do the work, don't just report it.** This isn't a diagnostic tool. If a draft looks good, promote it. If an orphan has obvious links, add them.
- **Quality over quantity.** Promoting 3 notes properly beats rubber-stamping 10.
- **Respect locked notes.** Never edit a note with `review_state: locked`.
- **Explain changes.** When you edit a note, say what you changed and why.
- **Leave the vault better than you found it.** Every garden session should increase the reviewed/draft ratio, decrease orphans, and add meaningful connections.
