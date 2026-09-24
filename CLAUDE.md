# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What is Granite?

Granite (`granite` CLI) is a local-first markdown memory system for humans and agents. Notes are plain markdown files with YAML frontmatter, organized by configurable note types. The default model is knowledge-first: `note`, `source`, `synthesis`, and `output`. Configuration lives in `granite.yml` at the vault root. A SQLite index (`.granite/index.db`) provides full-text search and wikilink resolution.

## Product Boundaries

- Granite must remain a deterministic markdown knowledge engine.
- Never add embedded LLM features, prompt execution inside Granite, embeddings, vector search, autonomous agent loops, or an internal scheduler.
- All intelligence lives in the external client or agent. Granite only exposes markdown storage, index/graph operations, and deterministic workflow rules.
- Keep the CLI and MCP surfaces small, explicit, and MECE. Avoid overlapping commands/tools that solve the same layer of the workflow in slightly different ways.
- Before adding a new CLI command, MCP tool, or prompt:
  - First check whether the behavior can be expressed by composing existing primitives.
  - Prefer improving tool descriptions, prompts, and deterministic planning logic over adding another endpoint.
  - If a new endpoint is necessary, it must have one clear role in the workflow and no ambiguous overlap with existing endpoints.

### The one permitted model: Jev

**Jev (TypeSafe System One) is the single exception**, and it is an exception of
kind, not of degree: it is a *classifier*, not a generative model. It returns a
`choice`, a `score` or a `noul` probability over a bounded set — typed values code
branches on. It never writes prose, never plans, and never runs a loop.

- **`src/core/` stays pure.** No network call, no API key, no model reference. The
  graph walk, sentence selection and thresholds are deterministic and must remain
  testable without a key.
- **`src/mcp/` may call Jev**, so Granite can bound a candidate set deterministically
  and then *delegate the semantic judgment* instead of asking the calling agent to
  orchestrate it. This respects the rule above rather than breaking it: intelligence
  still lives outside Granite, it is only Granite that is allowed to invoke it.
- **Required, and it fails loudly.** `TYPESAFE_API_KEY` must be set: the MCP server and
  the CLI refuse to start without it, and a judgment without one throws a named
  `JevUnavailableError` rather than returning a verdict. Granite does less without it on
  purpose — a silently degraded semantic layer produces answers that look right and are
  not.
- **Capture is judged.** Every created note is judged at capture, because linking as a
  periodic pass never happens for the notes that need it. Jev proposes links and never
  writes them: the measured precision does not support writing. The write stays
  synchronous and a failed judgment never fails a capture.
- **The boundary that does not move:** no embeddings, no vector store, no generative
  text, no autonomous loop, no scheduler, no telemetry. Jev answers questions about a
  set Granite chose; it never chooses what to look at.

Anything else that would think on Granite's behalf is still out of bounds, and the
answer to "can this be deterministic?" is still yes by default.

#### Measured constraints on that one model call

These were paid for in API calls and hand-labelling. They are the reason the judge layer
looks the way it does, so they belong with the rule rather than in a skill that can move.

- **Rank inside a set; never judge a pair in isolation.** A pair judged alone separated
  nothing (AUC 0.56); the same content presented as a set separated cleanly (AUC 0.973).
- **Batch one request per set.** Measured 12.2x cheaper and 10x faster than one call per
  item, with identical answers.
- **Do not pass already-linked neighbours as extra state.** Recall fell 0.89 → 0.50 while
  the cost doubled.
- **Derive absence from the ranking, never from an absolute question.** An absolute "does
  this pool hold an answer?" Noul returned 0.25 on a pool whose answer sat at rank 3 — a
  false negative, the worst failure a second brain can produce. Report it as context; do not
  gate on it. `ANSWERED_AT` / `ABSENT_BELOW` sit between the measured values.
- **Name the question in the state when asking which sentence answers it.** A state *without* the
  question made Jev abstain at 0.77 while the sentence holding the figure sat in the list at 0.10.
  Once the state carries it, restating it inside every `ev::` instruction is worse, not safer:
  head-to-head on 60 real candidates, two runs per question, the named form cited the answering
  note on every answerable question while restating it lost the citation on the long multi-part
  one (`answered`, evidence null, twice). Naming it also stops a long question from costing the
  request ~1 byte per character per candidate.
- **Measure the request body; never model it.** The API's ceiling is a token limit, so the byte
  boundary moves with the content: a run of one character is rejected at 131,000 bytes while prose
  passes at 133,829. Budgeting from an estimate has cost three regressions, one of which refused an
  ordinary 80-character question. The pool is trimmed against the serialized body it will actually
  send, and every candidate keeps an excerpt — position in the pool is not relevance, and the note
  that answered sat at rank 54 of 60.
- **Do not ask for dates as dates** (correct 1 time in 9) and **do not auto-apply extracted
  facts** (0.75 precision, and the failure is silent). Propose; let a policy or a human decide.
- **Do not build**: note decay or forgetting (the canonical citation never measured an
  effect), or automatic retirement (wrong on 70% of facts across two independent corpora).

Preferred workflow layers:
- orient
- research
- inspect
- plan
- mutate

## Commands

```bash
npm run build        # Build with tsup + copy web assets to dist/
npm run dev          # Run CLI directly via tsx (no build needed)
npm run test         # Run all tests (vitest)
npm run test:watch   # Run tests in watch mode
npm run lint         # Type-check with tsc --noEmit

# Run a single test file
npx vitest run test/core/note.test.ts

# Run the CLI during development
npx tsx src/index.ts <command>
```

## Architecture

- **`src/index.ts`** — CLI entrypoint using Commander. Registers all subcommands (`init`, `new`, `add`, `list`, `edit`, `open`, `search`, `backlinks`, `suggest-links`, `types`, `doctor`, `serve`, `deploy`).
- **`src/core/`** — Pure business logic, no CLI concerns:
  - `types.ts` — All shared interfaces (`Note`, `GraniteConfig`, `WikiLink`, `SearchResult`, etc.)
  - `config.ts` — Loads/writes `granite.yml`, holds default config
  - `vault.ts` — Vault root discovery (walks up looking for `granite.yml`), path helpers
  - `note.ts` — CRUD for notes (create, read, list, find by slug)
  - `index-db.ts` — SQLite index with FTS5 for full-text search and a `links` table for wikilink graph
  - `frontmatter.ts` — Parse/serialize YAML frontmatter via `gray-matter`
  - `wikilinks.ts` — Parse `[[wikilinks]]` from note bodies and resolve them to slugs
  - `slugify.ts` — Title-to-slug conversion
  - `search.ts`, `backlinks.ts`, `suggest.ts`, `doctor.ts` — Query/validation logic
- **`src/commands/`** — Thin CLI wrappers that call into `src/core/`
- **`src/core/deploy/`** — `granite deploy`: one-command serverless Granite on Fly.io Sprites. `sprites-client.ts` is the only file that knows Sprites API shapes; `deploy.ts` orchestrates against the injected `SpritesClient` interface. The sprite is the source of truth for instances (marker file `/home/sprite/.granite-deploy/deploy.json`, kept outside the vault because it holds the MCP token; sprite names prefixed `granite`/`granite-<instance>`). The optional Sprites API credential is user-scoped local config at `~/.granite/config/sprites.json`, not instance state, and is excluded from sync manifests.
- **`src/web/`** — Hono-based local web UI served by `granite serve`

## Key Patterns

- **Vault detection**: `findVaultRoot()` walks up from CWD looking for `granite.yml`. Most commands call `requireVaultRoot()` which throws if not found.
- **Index rebuild**: `ensureIndex()` rebuilds the entire SQLite index on every command when `config.index.auto_rebuild` is true. The index is derived state — the markdown files are the source of truth.
- **Slug formats**: Granite uses title-based slugs with collision counters by default. Custom note types may still opt into alternate slug formats in `granite.yml`.
- **Note files**: Each note is `<folder>/<slug>.md` with YAML frontmatter (id, title, type, created, modified, tags, aliases).
- **Document parsing kill switch**: `GRANITE_DISABLE_DOCUMENT_PARSING=1` (set automatically on cloud deployments) hides the `granite_extract_document`/`granite_import_document` MCP tools and disables `granite extract`/`granite import`. Check with `isDocumentParsingDisabled()` from `src/core/extract-document.ts`.

## Testing

Tests live in `test/core/` mirroring `src/core/`. A fixture vault at `test-vault/` provides test data. Tests use vitest with globals enabled (no need to import `describe`/`it`/`expect`).
