# Facts, validity, and what Jev is allowed to do

Granite ships a **deterministic fact ledger**. This document explains why it is
deterministic, what the optional Jev layer may propose, and the measurements that
forced those boundaries.

## The problem

A second brain accumulates contradictions. A note from January says the project
runs on one host; a note from June says it moved. Both are retrieved, both look
equally relevant to a search, and an agent has to pick.

This is measured as the central failure of agent memory, and it is **not a
retrieval problem**:

| Finding | Number | Source |
| --- | --- | --- |
| New evidence actually retrieved | 77.5% of the time | [STALE](https://arxiv.org/abs/2605.06527) |
| New evidence ranked **top-1** | **5.2%** of the time | STALE |
| Failures *despite* the contradicting evidence being in context | 56–99% | STALE |
| Best frontier model overall | 55.2% | STALE |
| Memory frameworks on the same benchmark | 5–8% (Zep 6.0, mem0 8.3, A-mem 5.1) | STALE |
| Automatic fact retirement that was **wrong** | **70%** (28/40, Wilson CI 54.6–81.9%) | [silent fact loss](https://github.com/alexsh88/synapse/blob/main/docs/FINDING-silent-fact-loss.md) |
| Agreement between two model judges on contradictions | Cohen's κ 0.39, then 0.35 | same |

The last two rows are why Granite never lets a model retire a fact. The loss is
silent: the write reports success and the fact stops appearing.

## What Granite owns

### 1. Validity intervals

A fact is any note carrying `subject`, `relation`, `object` and `valid_from`
(plus optional `valid_to`, `confidence`, `source_note`). **No new note type and no
config change are needed** — facts are detected by the fields they declare, so
adopting the ledger is not a migration.

```yaml
---
title: Monka runs on Scaleway
subject: Monka
relation: hosting
object: Scaleway
valid_from: 2026-06-01
source_note: "[[monka-care-migration-scaleway-et-infogerance]]"
---
```

### 2. The recency rule, in code

`compareRecency` decides which fact is current, in a fixed order: an open interval
beats a closed one, then a later `valid_from`, then higher `confidence`, then
slug. The result is **stable regardless of input order**.

Deliberately absent: any similarity threshold. Cosine similarity distinguishes a
contradicted fact from a duplicated one at **AUROC 0.59 — near chance** — because
a contradiction is often *more* similar to the original than a paraphrase is
([MemStrata](https://arxiv.org/abs/2606.26511)). Ordering by declared validity is
the reliable signal.

### 3. Retirement closes an interval; it never deletes

Superseded facts keep their note and their history. `granite facts --superseded`
shows what was displaced and by what, so a retirement can be audited and reversed.

### 4. Contradictions are surfaced, never resolved

Two open facts asserting different objects for the same subject and relation are
**reported in the ledger output**. Granite does not pick a winner, because the
measured error rate for automatic resolution (70% wrong) plus inter-judge
disagreement (κ 0.39) makes silent resolution worse than the problem it solves.

This matters more than it looks: models fail premise-resistance **99.0% of the
time even when the contradicting evidence is in context**. Making conflict visible
in the result set is a different thing from making it discoverable on request.

### 5. Candidate generation is scoped structurally

The 70%-wrong retirement run traced back to unbounded candidate generation — every
edge in a group became a contradiction candidate. Granite's conflict comparison
only ever considers notes that share vocabulary with the subject, and groups the
ledger by normalised subject + relation.

## What Jev is allowed to do

`skills/vault-garden/scripts/jev_facts.py` proposes, and only proposes.

```bash
python3 jev_facts.py facts <slug>        # propose candidate facts from a note
python3 jev_facts.py conflicts <slug>    # propose conflicting notes
```

Guardrails, each answering a measured failure:

- **Every proposal carries a verbatim span copied from the note, plus its source
  slug.** A model triple is a candidate, and a wrong one is traceable to the text
  that produced it.
- **Nothing is written.** Output is JSON for a human or agent to accept.
- **Values must be explicitly present**, not inferred. Inference is where
  extraction precision collapses.
- **Conflicts are candidates, not verdicts.** The ledger would not act on them
  anyway; this just ranks which pairs are worth a look.
- **Recall stays in code.** The script splits the note into candidate sentences
  deterministically; the model only classifies text already selected.

### Why extraction is a hint layer, not authority

Measured triple-extraction precision is **0.357 with recall 0.902**
([GraphJudge](https://arxiv.org/abs/2411.17388)) — models over-generate plausible
claims. Mem0's write-time extraction discards so much of the source that it scores
**28.0 on RULER-QA against 53.5 for the base model**
([MemoryAgentBench](https://arxiv.org/abs/2507.05257)). So:

- the **note text stays the primary object**; extracted facts are an index over it;
- extracted facts are **never** used to retire or rewrite a note;
- the ledger's validity rule works on declared fields, so it is useful with or
  without the model.

## Calibration: scores are compressed

The extraction Score occupies roughly **0.0–2.0, not 0–3**. On a real note, genuine
assertions scored 1.7–2.0 while action items and plans scored 0.03–0.10. A gate at
2.0 therefore rejected **everything**; the default is now 1.4.

This is the third time the same trap appeared in this codebase (the link Noul had
it too). **Always print the score distribution before choosing a threshold** —
`granite facts` and the `--json` flags exist so a threshold can be justified from
data rather than intuition.

## Current state and limits

- **The ledger is tested** (11 unit tests: recency, tie-breaking, order
  independence, interval boundaries, contradiction reporting).
- **The Jev extraction layer is a working prototype, not a calibrated
  classifier.** Real-run behaviour is measured (6 proposals from 25 sentences on a
  dense meeting note, with accurate relation buckets), but its precision has *not*
  been validated against human labels. Treat proposals as a review queue.
- **Adoption is zero-config but also manual.** Nothing extracts facts in the
  background; an agent or person has to run the extraction and create the notes.
  Automating that is the obvious next step, and it should be done with a write-gate
  that refuses a fact with no source, since write-gate validation is a documented
  blind spot in every memory architecture surveyed.
