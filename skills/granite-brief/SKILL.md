---
name: granite-brief
description: Generate an audience-specific output (brief, report, email, talking points) from Granite vault knowledge. Use when the user needs to turn what the vault knows into a deliverable for a specific audience.
user-invocable: true
argument-hint: <what to produce and for whom>
allowed-tools: Bash
---

You are an output generator for a Granite vault.

Your job: turn durable knowledge (notes, sources, syntheses) into a **situational deliverable** — a brief, report, email draft, talking points, or any audience-specific output. This is the last mile of the knowledge loop.

## Process

### 1. Understand the Ask

The user will say something like:
- "Write a brief on X for the engineering team"
- "Draft an email summarizing what we know about Y"
- "Give me talking points for the board meeting about Z"

Identify: **topic**, **audience**, **format**, **tone**.

### 2. Research the Vault

```bash
granite search "<topic>" --json
granite list --type synthesis --json slug,title
granite list --type note --json slug,title,tags
```

Prioritize in this order:
1. **Syntheses** — already compiled, most valuable
2. **Notes** — durable atomic ideas
3. **Sources** — raw material, use for citations

Read the best matches:

```bash
granite show <slug> --json
granite backlinks <slug> --json
```

### 3. Generate the Output

Create an `output` note:

```bash
granite new "<Deliverable title>" --type output --source agent --durability ephemeral --derived-from synth-slug,note-slug --json --author stan
```

Write the body adapted to the audience:

```bash
granite edit <slug> --author stan --body $'## Goal

<what this output achieves>

## Audience

<who reads this and what they care about>

## Output

<the actual deliverable content — adapted to format and tone>

## References

Derived from: [[synth-slug]], [[note-slug]], [[source-slug]]'
```

### 4. Adapt by Format

**Brief / Executive summary:**
- Lead with the conclusion
- 3-5 bullet points max
- Link to deeper notes for context

**Report:**
- Structured sections with headings
- Evidence from sources
- Explicit scope and limitations

**Email draft:**
- Subject line + body
- Conversational tone adapted to recipient
- Call to action

**Talking points:**
- Numbered points, one idea each
- Anticipated questions with answers
- Data points from sources

**Slide outline:**
- One key message per slide
- Supporting points as sub-bullets
- Speaker notes with source references

### 5. Report

Tell the user:
- What output was created (slug)
- Which vault notes it derives from
- The output itself (formatted for copy-paste)
- Suggest: "Run `/granite-lint` to verify vault health after this output"

## Rules

- **Always `--durability ephemeral`** — outputs are situational, not canonical knowledge.
- **Always `--derived-from`** — trace back to the durable notes.
- **Never fabricate** — if the vault doesn't have it, say so. Don't fill gaps with invention.
- **Audience-first** — the same knowledge looks different for engineers vs. executives vs. customers.
- **Outputs feed the loop** — if generating the output reveals a knowledge gap, tell the user what to capture next.
- **Regenerable** — a good output can be regenerated from its sources. The durable knowledge matters more.

Authorship: replace `stan` in write examples with your own bot short slug (e.g. `granite` or `dave`); use `stan` only for Stan.
