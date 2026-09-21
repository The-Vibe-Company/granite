# Using Jev at ingestion

Ingestion is where a vault either builds structure or accumulates debt. The measurements
below say it currently accumulates.

## The measured problem

On a real 759-note vault:

| Signal | Value |
| --- | --- |
| `source` notes that nothing cites | **64** |
| Notes with no incoming link | **105** |
| …of those, "leaves" that link out but nothing links in | **98** |
| Notes still in `draft` | **443** (58%) |

Linking happens as a *periodic* pass (gardening) rather than at *capture*, so it does not
happen for 64 notes. Connecting at capture time removes the debt at the source instead of
chasing it later.

## What to use, ranked by measured reliability

The session produced a clear ordering, and it is not the intuitive one.

### 1. Link at capture — the most reliable judgment measured

Ranking candidates inside a set is where Jev is strongest: **mean within-source AUC 0.973**
over 78 candidates across 8 notes, and 0.986/0.952 in a later A/B on the same shape.

At capture: extract entity mentions deterministically, fetch the notes the graph already
associates with those entities (`about` does exactly this), let Jev select the real
connections, and write them. One request per note.

### 2. Route the note — type, tags, entities

Use a `Choice` over a hierarchy
([hierarchical classification](https://docs.typesafe.ai/cookbooks/hierarchical_classification.md))
and read the answer's own confidence
([classification using confidence](https://docs.typesafe.ai/cookbooks/classification_using_confidence.md)):
below a threshold, report the parent level instead of guessing the leaf.

### 3. Extract facts — measured at 0.75 precision, review only

Hand-labelled on 25 then 12 proposals: **0.32 → 0.75** after scoping relations to what a
sentence states literally. That is far above the published 0.357 extraction baseline, and
still wrong about one time in four. Propose, never auto-apply.

### 4. Do NOT ask the model for dates as dates

Date roles were correct **1 time in 9** when asked "when does this start?" — the failure
was semantic, not arithmetic. The
[date extraction](https://docs.typesafe.ai/cookbooks/date_extraction_cookbook.md) pattern
is the fix: ask for the *parts* as `Choice` over enumerated options with an explicit "not
stated", then resolve and validate in code.

## The shape ingestion should take

```
capture
  -> code:  entity mentions, graph candidates, source span        (deterministic, free)
  -> Jev:   select real connections; route type/tags             (bounded selection)
  -> code:  thresholds, provenance gate, write                    (policy)
```

The note should be born connected. Today it is born an orphan and the connection is
hoped for later.

## Two rules that keep it safe

**Batch every question into one request per note.** Measured: batching 13 questions is
**12.2x cheaper and 10x faster** than 13 separate calls, with identical answers.

**Judge inside a set, never a pair in isolation.** A pair judged alone separated nothing
(AUC 0.56); the same content presented as a set separated cleanly (AUC 0.973). And do not
add already-linked neighbours to the state as reference: measured recall fell from 0.89 to
0.50 while cost doubled.

## What not to build

- **Automatic retirement or rewriting of notes.** Measured wrong on 70% of facts across
  two independent corpora, and the loss is silent.
- **Decay as an accuracy feature.** MemoryBank, the canonical citation, never measured an
  effect; Generative Agents never ablated it.
- **A graph-traversal API as the primary retrieval mode.** Graph traversal buys multi-hop
  reasoning, not basic retrieval.
