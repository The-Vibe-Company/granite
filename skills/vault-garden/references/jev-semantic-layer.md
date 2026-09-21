# Optional semantic judgments with Jev

Granite stays deterministic and offline by default. This reference describes an
**opt-in** semantic layer that asks Jev — a classifier, not a language model — for
typed judgments, while Granite keeps owning recall, thresholds and every decision to
write. With no key, nothing here runs and Granite behaves exactly as before.

Use it when lexical signals are not enough — connecting orphans, spotting
duplicates, or deciding whether two notes are really the same entity. Skip it
for anything the graph already answers.

## Commands

```bash
python3 scripts/jev_judge.py candidates <slug>     # deterministic, no key needed
python3 scripts/jev_judge.py judge <slug>          # rank link candidates for one note
python3 scripts/jev_judge.py duplicates            # rank likely duplicate pairs, for merging
python3 scripts/jev_judge.py judge-adjudications   # score the pairs a human already ruled on
python3 scripts/jev_judge.py calibrate             # report what your own decisions imply
python3 scripts/calibrate_thresholds.py            # link thresholds, measured on your graph
python3 scripts/measure_neighbor_context.py        # regression test for a rejected idea
```

`link` and `merge` are different questions with different commands. Read the two
sections on that below before using either.

## Why it started as a companion layer, and what changed

This layer began outside Granite, for two concrete reasons that are still worth
knowing:

- `granite search` and `granite recommend` run on the hot path (every note
  write, every search). A network call there would force the whole synchronous
  note-creation chain to become async.
- The product rule then read "no embedded LLM, anywhere".

**The rule has since been amended, narrowly.** Jev is permitted — not as an LLM
but as a *classifier*: it returns a choice, a score or a probability over a set
Granite chose, never prose, never a plan, never a loop. It may be called from
`src/mcp/`; `src/core/` stays free of network calls and API keys. See
[CLAUDE.md](../../../CLAUDE.md) for the exact boundary.

The hot-path objection above is **unchanged and load-bearing**: Jev must never
move into note creation or indexing, because that turns a synchronous local
write into a network round trip. The scripts here still follow the same shape as
the optional `ferrules` PDF extractor — resolve an external tool, degrade
clearly when it is missing.

## Setup

```bash
export TYPESAFE_API_KEY=...        # never commit this
```

Nothing else changes. Without the key the helper reports `status: unavailable`
and exits 0, so a gardener falls back to the deterministic path.

## Usage

Both commands print one JSON object.

```bash
# Deterministic candidates only — no network, no key needed.
python3 scripts/jev_judge.py candidates <slug> --limit 12

# Ask Jev to judge the candidates. Cached; repeat runs make no request.
python3 scripts/jev_judge.py judge <slug> --limit 12

# Measure and calibrate the thresholds against your own graph.
python3 scripts/calibrate_thresholds.py --sources 8 --targets 5 --distractors 5
```

`calibrate_thresholds.py` is read-only and prints per-source AUC, a threshold
sweep, and the raw candidate scores so a run can be inspected rather than
trusted as a summary number. It needs `TYPESAFE_API_KEY`; without the key it
reports `status: unavailable` and exits 0.

`judge` returns, per candidate:

| Field | Meaning |
| --- | --- |
| `verdict` | `link`, `review` or `skip` — derived from `link_probability` and the thresholds |
| `link_probability` | Noul: probability this link is worth adding (0–1, absolute) |
| `relation_score` | Score: 0–3 over the levels below, plus `relation_confidence` |
| `model` | The versioned model that actually answered, logged for reproducibility |

The two questions per candidate are deliberately different primitives:

- A **Score** orders candidates. Its four levels describe the *action* you can
  take with the pair — unrelated, same domain, related, directly connected.
- A **Noul** decides whether to link at all. This is not redundant: a Score
  always returns something, so without the Noul a vault containing no real
  connection would still get its top candidate proposed.

## Thresholds live in code, and they were measured

`LINK_THRESHOLD = 0.25` and `REVIEW_THRESHOLD = 0.15`. These are not guesses:
`scripts/calibrate_thresholds.py` builds ground truth from your own graph and
measures where the cut points should sit.

Jev's Noul answer for this question occupies a **compressed range** — roughly
0.05–0.80 across a sample of 78 candidates from 8 source notes, not the full 0–1
interval. A "cautious" high cut point therefore destroys recall silently:

| Noul threshold | precision | recall | unrelated candidates passed |
| --- | --- | --- | --- |
| 0.15 | 0.83 | 1.00 | 8 |
| 0.25 | 0.88 | 0.97 | 5 |
| 0.35 | 0.91 | 0.84 | 3 |
| **0.60** (initial guess) | 0.95 | **0.55** | 1 |

Missing a real connection is the failure this layer exists to fix, so the default
sits at 0.25. Re-measure on your own vault before trusting it.

## Judge a candidate set, never a pair in isolation

This is the most important implementation constraint, and it was learned the hard
way while building this layer.

Judging **one pair per request** ("are these two notes duplicates?") produces
scores that do not separate signal from noise at all — measured AUC 0.56, with
positives and negatives both clustered near 0.36. A pair presented alone carries
no reference class, so the model has nothing to calibrate against.

Presenting **one source note together with its candidate set in a single
request** — what `jev_judge.py` does — separates the classes cleanly:

| | linked targets (median) | unrelated notes (median) | within-source AUC |
| --- | --- | --- | --- |
| MediaGen — 1ère réunion partenaires | 2.72 | 0.30 | 0.98 |
| Vercel Sandbox FUSE remote storage | 2.18 | 0.27 | 1.00 |
| Monka — avenant n°2 TVC | 2.82 | 0.80 | 1.00 |
| Kima Ventures | 2.93 | 0.70 | 1.00 |
| Granite Codex macOS app concept | 2.53 | 1.46 | 0.92 |

Mean within-source AUC **0.973** over 78 candidates. The relation Score alone
reaches precision 0.90 / recall 0.95 at a threshold of 1.75 on its 0–3 scale.

If you extend this integration, keep the set-based shape. Do not add a
pair-in-isolation endpoint for absolute judgments.

## Do not conflate "should link" with "should merge"

A synthesis and the entity note it compiles are a **good link** and a **bad
merge** simultaneously. Scoring a link judgment against merge labels measures
nothing, because the same pair is positive under one framing and negative under
the other.

That mistake produced a first calibration run whose "negatives" (human
adjudications that two notes should stay separate) scored *higher* than its
positives. The model was right; the labels answered a different question.

The same trap appears in the shipped code if you are not careful. Scoring the
eight human-separated pairs in a real vault with the **link** question gives
0.55–0.95 — i.e. it calls every pair a person explicitly kept apart
link-worthy. That is not a model failure; a link between two near-duplicates is
perfectly reasonable. It is the wrong question for those labels.

### The merge classifier

`judge-adjudications` and `duplicates` therefore ask the merge question, whose
three levels are the three things you can do with a pair — keep separate, send
for review, merge. The level *is* the decision rule, so there is no fitted
threshold.

Measured against the eight human adjudications in a real vault: **8/8 agreement**
(no pair was called a merge), at confidence 0.79–1.00.

| Verdict | Meaning | Action |
| --- | --- | --- |
| `separate` | clearly different notes | leave alone |
| `review` | near-duplicate, a human should look | queue it |
| `merge` | the same thing | merge into one note |

`duplicates` supplies the recall half deterministically (normalised title
overlap plus shared tags) and hands only those pairs to the model. On the same
vault it correctly flagged the three exact-title duplicate pairs as `merge`.

Caveat to respect: the merge classifier has **no positive merge labels**
available — Granite records separations, not merges. Agreement is therefore
measured only on negatives, which is a weak check. Confidence values are not
calibrated for the `merge` verdict, and `merge` scores came back with *lower*
confidence than `separate` ones, so do not read confidence as certainty here.
Treat `duplicates` as a ranked queue for human review, not an automatic merger.

## Rejected: showing already-linked neighbours

A natural idea is to include the source note's existing link targets in the
request, so the model can tell whether a candidate adds something new or merely
restates a connection already present. It was implemented and measured, and it
**does not work** — it is worse:

| | AUC (Noul) | precision | recall | tokens |
| --- | --- | --- | --- | --- |
| baseline (no neighbours) | **0.986** | 0.94 | **0.89** | 47k |
| with neighbours | 0.952 | 0.90 | **0.50** | 96k |

Recall collapses from 0.89 to 0.50 and the cost doubles. A causal follow-up
separated the two candidate explanations: the *criteria* wording is not the
problem (novelty criteria without neighbours score AUC 0.967 / recall 0.94), so
the **neighbour state itself** causes the regression. With neighbours present and
an instruction not to repeat them, the model becomes over-conservative and
suppresses genuine links too.

`measure_neighbor_context.py` keeps this measurement runnable, so the idea can be
re-tested against a future model instead of being re-implemented from intuition.

## Cost and caching

The state is re-sent on every request, so one batched call over N candidates
costs roughly one state plus N questions, instead of N full states. Batching all
questions into a single request is what keeps this cheap and fast.

Measured on a real vault: 8 candidates over ~5,200 input tokens, about one
second. Judgments are cached in `<vault>/.granite/jev-judgments.json`, keyed by
model plus a hash of the note and candidate text, so unchanged pairs are never
recomputed and an edited note is automatically re-judged.

The cache lives under `.granite/`, Granite's derived-state directory. Markdown
stays the source of truth; deleting the cache is always safe.

## Handling uncertainty

- Prefer `verdict: link` for automatic action; send `review` to a human.
- Do not carry a threshold tuned on a Noul over to a Choice question about the
  same pair — the numbers are not the same scale.
- The thresholds are calibrated for the **relation + Noul** pair of questions in
  this script. Changing the instructions or criteria invalidates them; re-run
  `calibrate_thresholds.py` after any wording change.
- The model reads content literally and does not count reliably. Do counting,
  date arithmetic and exact lookups in code, then let the model judge meaning.
- A shortlist is a ceiling: the model can only reorder what Granite retrieved.
  If recall missed the right note, no judgment can recover it — improve the
  shortlist instead.
- The measured operating point leaves roughly one unrelated candidate in twenty
  above the threshold. On a vault where a wrong link is expensive, raise
  `LINK_THRESHOLD` and accept lower recall.

## Limitations

- Requires `TYPESAFE_API_KEY`; the key is read from the environment and never
  written to disk.
- The helper reads Granite's SQLite index directly and needs the `notes_fts`
  table that Granite builds. Run any `granite` command first if the index is
  missing.
- Candidate generation for the improved `granite suggest-links` (whole-word
  matching, already-linked aliases excluded) lives in Granite itself and is not
  yet in released builds; the helper's own `candidates` command works today.
