# Granite

<p align="center">
  <a href="https://www.npmjs.com/package/granite-mem"><img src="https://img.shields.io/npm/v/granite-mem?color=111111" alt="npm version"></a>
  <a href="https://www.npmjs.com/package/granite-mem"><img src="https://img.shields.io/npm/dm/granite-mem?color=111111" alt="npm downloads"></a>
  <a href="https://github.com/The-Vibe-Company/Granite/actions/workflows/ci.yml"><img src="https://img.shields.io/github/actions/workflow/status/The-Vibe-Company/Granite/ci.yml?branch=main&label=tests&color=111111" alt="CI status"></a>
  <a href="LICENSE"><img src="https://img.shields.io/github/license/The-Vibe-Company/Granite?color=111111" alt="MIT license"></a>
  <a href="https://github.com/The-Vibe-Company/Granite/stargazers"><img src="https://img.shields.io/github/stars/The-Vibe-Company/Granite?style=social" alt="GitHub stars"></a>
</p>

> **The personal OS your agent runs on.**
> Give your agent a memory it can't hallucinate: plain markdown + SQLite full-text search + a typed contract it already knows how to operate. No LLM inside. Your agent brings the intelligence; Granite holds the ground truth.

<p align="center">
  <img src="docs/screenshots/granite-graph.png" alt="Granite constellation graph" width="720">
</p>

<p align="center">
  <code>npm install -g granite-mem</code>
</p>

---

**Jump to:** [The 60-second setup](#the-60-second-setup) · [Install it yourself](#or-install-it-yourself) · [How it works](#how-it-works) · [Why not Obsidian, Notion, or a vector store?](#why-not-obsidian-notion-or-a-vector-store) · [See it](#see-it) · [Types are contracts](#types-are-contracts-not-folders) · [The MCP server](#wired-for-agents-the-mcp-server) · [What Granite will never do](#what-granite-will-never-do) · [Beyond one machine](#beyond-one-machine) · [The full CLI](#the-full-cli) · [FAQ](#faq) · [Philosophy](#philosophy)

## The 60-second setup

Paste this into **Claude Code**, **Cursor**, or any MCP-capable agent:

````
Install Granite as my personal OS.

1. `npm install -g granite-mem`
2. `granite init --template founder-os`  (vault at ~/.granite)
3. `claude mcp add granite -- granite mcp --vault ~/.granite`
4. Restart yourself so the MCP server loads.
5. Call `granite_wakeup`, then propose three notes you would write
   first based on what you know about me so far. Capture them as
   drafts with --source agent.
````

Sixty seconds later: a live vault, an agent that knows how to operate it, and its first three notes on disk in `~/.granite/notes/`. No system prompt. No config. No cloud.

That's the thesis of this project. No agent handy? Granite is a complete tool on its own:

## Or install it yourself

```bash
npm install -g granite-mem
granite init                        # note / source / synthesis / output
granite new "Ideas worth stealing"
granite search "steal"
granite serve                       # web UI + constellation graph
```

Add `--template founder-os` to `init` when you want a full personal OS from the start: `person`, `organization`, `meeting`, and `learning` on top of the four defaults — eight types already wired with hooks, indexed fields, and lifecycles, in [150 lines of pure YAML](templates/founder-os.yml).

Everything Granite writes is a plain `.md` file with YAML frontmatter. Close the laptop, `git init` the vault, open the folder in any editor — it's just files.

## How it works

Granite is a **deterministic substrate** for knowledge: markdown files as the source of truth, a SQLite index as derived state, and one fixed loop imposed on top. The intelligence is not in Granite — it's in whatever agent (or human) operates it.

```
              ┌──────────────────────────────────────────┐
              │        your agent  ·  the brains         │
              └────────────────────┬─────────────────────┘
                                   │  MCP · CLI · web UI
              ┌────────────────────▼─────────────────────┐
              │                 GRANITE                  │
              │                                          │
              │   capture ─▶ compile ─▶ query ─▶ output  │
              │      ▲                             │     │
              │      └──────────── lint ◀──────────┘     │
              │                                          │
              │   .md files     SQLite FTS5   wikilinks  │
              │   (truth)       (derived)     (graph)    │
              └──────────────────────────────────────────┘
```

- **Markdown is truth.** Every note is `<folder>/<slug>.md` with YAML frontmatter. Nothing you can't read in `cat`.
- **The index is disposable.** Full-text search, backlinks, and typed queries live in `.granite/index.db` — rebuilt from the files at any time.
- **Wikilinks are the graph.** `[[a-note]]` in any body resolves slug → title → alias, and the backlink graph falls out for free.

> Karpathy asked for *"an incredible new product instead of a hacky collection of scripts"* for [LLM knowledge bases](https://x.com/karpathy/status/2039805659525644595).
>
> This is our answer.

## Why not Obsidian, Notion, or a vector store?

Granite doesn't compete with your note app. It competes with the pile of scripts you were about to write.

|                                                | **Granite** | Obsidian  | Notion    | Vector memory | Plain files |
| ---------------------------------------------- | :---------: | :-------: | :-------: | :-----------: | :---------: |
| Plain markdown on disk                         | ✅          | ✅        | ❌        | ❌            | ✅          |
| Typed schemas with hooks & lifecycles          | ✅          | plugins   | databases | ❌            | ❌          |
| Agent-native MCP workflow                      | ✅          | community | limited   | ✅            | ❌          |
| Deterministic retrieval (no embeddings)        | ✅          | ✅        | ❌        | ❌            | `grep`      |
| Structured queries over indexed fields         | ✅          | plugins   | ✅        | ❌            | ❌          |
| Provenance on every note                       | ✅          | ❌        | ❌        | partial       | ❌          |
| Offline, no account, no telemetry              | ✅          | ✅        | ❌        | ❌            | ✅          |
| Git-friendly                                   | ✅          | ✅        | ❌        | ❌            | ✅          |

Obsidian is a great editor for humans. Vector memory is a great cache for agents. Granite is the shared substrate both can operate.

## See it

<table>
  <tr>
    <td width="50%">
      <img src="docs/screenshots/granite-graph.png" alt="Granite constellation graph">
      <br>
      <sub><b>Constellation graph.</b> Browse the vault as communities, hubs, and links.</sub>
    </td>
    <td width="50%">
      <img src="docs/screenshots/granite-search.png" alt="Granite command palette search">
      <br>
      <sub><b>Command palette.</b> Search the vault and jump straight into the graph context.</sub>
    </td>
  </tr>
  <tr>
    <td width="50%">
      <img src="docs/screenshots/granite-preview.png" alt="Granite note preview">
      <br>
      <sub><b>Graph-aware reading.</b> Preview notes without losing the surrounding context.</sub>
    </td>
    <td width="50%">
      <img src="docs/screenshots/granite-note.png" alt="Granite reader view">
      <br>
      <sub><b>Floating reader.</b> Open a note without leaving the constellation.</sub>
    </td>
  </tr>
</table>

## Types are contracts, not folders

This is what makes an agent feel native rather than bolted-on. Every note type in `granite.yml` is an executable contract:

```yaml
note_types:
  meeting:
    folder: notes/meetings
    fields:
      date:         { type: date,     required: true }
      organization: { type: wikilink, target_types: [organization] }
      attendees:    { type: wikilink, target_types: [person] }
    on_create:
      - { action: set_default,       field: date, value: "${today}" }
      - { action: resolve_wikilinks, fields: [organization, attendees], auto_stub: true }
    indexed_fields: [date, organization]
```

- `set_default` — fills `${today}` automatically
- `resolve_wikilinks + auto_stub` — turns `organization: Acme Corp` into the slug `acme-corp`, creating the org note if missing (with a globally-unique slug so nothing gets silently overwritten)
- `indexed_fields` — makes `granite_query { type: meeting, where: { date: { gte: "2026-01-01" } } }` fast and deterministic
- `lifecycle` — declare states and stale-days transitions, and `granite doctor` surfaces drift before it rots

On top of its type, **every note carries five protocol fields**, so humans and agents share ground truth:

| Field          | Values                                | Purpose                              |
|----------------|---------------------------------------|--------------------------------------|
| `status`       | `inbox` · `active` · `archived`       | operational state                    |
| `source`       | `human` · `agent` · `extraction`      | who wrote it                         |
| `review_state` | `draft` · `reviewed` · `locked`       | editorial state                      |
| `durability`   | `canonical` · `working` · `ephemeral` | keep / may drift / throwaway         |
| `derived_from` | `[slug, …]`                           | provenance for syntheses and outputs |

Your agent reads these before writing and sets them as it works. You inherit a fully auditable trail. Add a type when your life grows a new shape — the core stays small. For the formal protocol, see [docs/GRANITE_OBJECT_STANDARD.md](docs/GRANITE_OBJECT_STANDARD.md).

## Wired for agents: the MCP server

> "A thin MCP server exposes capabilities. A strong MCP server shapes behavior."

One line connects any MCP-capable agent to your vault:

```bash
claude mcp add granite -- granite mcp --vault ~/.granite
```

The surface is intention-first — fourteen tools organized around the workflow, not around files:

| Intent     | Tools                                                                                                          |
|------------|----------------------------------------------------------------------------------------------------------------|
| **Orient** | `granite_wakeup` · `granite_research_topic` · `granite_resolve`                                                  |
| **Read**   | `granite_query` · `granite_compile_context` · `granite_understand_note` · `granite_extract_document`             |
| **Write**  | `granite_capture_knowledge` · `granite_import_document` · `granite_revise_note` · `granite_dispose_note`         |
| **Garden** | `granite_plan_garden` · `granite_adjudicate_garden_opportunity` · `granite_list_garden_adjudications`            |

Plus three prompts for the higher-level workflows (`granite_refine_note`, `granite_process_inbox`, `granite_compile_topic`), and resources for raw note and type-contract access. Start the server with `--role read` when an agent should inspect without mutating. An HTTP transport with bearer-token auth is available for remote setups — see [docs/DEPLOY.md](docs/DEPLOY.md).

The point is not to give an agent a file browser. The point is to give it a workflow it can follow.

## What Granite will never do

Granite will **never**:

- run a generated word, plan a step, or loop on its own
- compute embeddings or ship a vector store
- run background agents or a scheduler
- phone home — no telemetry, no account, no cloud dependency of its own
- add overlapping CLI/MCP endpoints that blur the loop

This is why your agent can be trusted with write access. The vault is a deterministic substrate. The intelligence is yours (or Claude's, or GPT's, or whoever you pay this quarter).

**One exception, and it is not a language model.** Granite's MCP layer calls
[Jev](https://typesafe.ai), TypeSafe's System One classifier, so it can bound a candidate
set deterministically and then *delegate the judgment* of which candidate answers a
question — instead of leaving that assembly work to your agent. Jev returns a choice, a
score, or a probability over a set Granite chose; it never writes prose, never plans, and
never decides what to look at.

**Jev is required.** `TYPESAFE_API_KEY` must be set or Granite refuses to start, because a
semantic layer that silently degrades produces answers that look right and are not. Every
capture is judged too, and the proposals it returns are yours to apply — Jev never writes a
link.

## Beyond one machine

**Cloud, if you want it.** One command deploys a personal serverless Granite on [Fly.io Sprites](https://sprites.dev): wakes on request in 100–500 ms, sleeps when idle, costs cents per month at rest. You own the sprite — there is no Granite cloud, no central admin, no relay.

```bash
granite deploy login --token <sprites-token>   # or export SPRITES_TOKEN=…
granite deploy                                 # prints an MCP URL + bearer token

claude mcp add --transport http granite https://<your-sprite>.sprites.app/mcp \
  --header "Authorization: Bearer <token>"
```

Multiple named instances, bulk upgrades, token rotation, and self-hosting the HTTP MCP server (a generic `Dockerfile` is included) are covered in [docs/DEPLOY.md](docs/DEPLOY.md).

**Sync, without a relay.** Direct machine-to-machine over LAN, Tailscale, or a private DNS name — with per-device read/write tokens:

```bash
granite sync access grant ipad --role read     # on the serving machine
granite sync serve --host 0.0.0.0 --port 8765

granite sync remote add macbook http://100.x.y.z:8765 --token <read-token>
granite sync watch macbook --direction pull --interval 30
```

Conflict policies, push/pull details, and access management live in [docs/SYNC.md](docs/SYNC.md).

## The full CLI

<details>
<summary><b>Every command, one line each</b></summary>

| Layer      | Command                    | What it does                                                    |
|------------|----------------------------|------------------------------------------------------------------|
| setup      | `granite init`             | create a vault (optionally from a `--template`)                  |
| setup      | `granite status`           | vault health and what to do next                                 |
| capture    | `granite new <title>`      | create a typed note                                              |
| capture    | `granite add [text]`       | quick raw capture (arg or stdin) into the inbox                  |
| capture    | `granite attach <file>`    | attach an image/video/PDF and get markdown to embed              |
| capture    | `granite extract <file>`   | raw text from PDF/DOCX/XLSX/PPTX without importing               |
| capture    | `granite import <file> --content <text>` | attach a document and create a linked source note |
| query      | `granite list`             | browse notes by type, status, source, date                       |
| query      | `granite show <slug>`      | read a full note                                                 |
| query      | `granite search <query>`   | full-text search across the vault                                |
| query      | `granite open <slug>`      | open a note in `$EDITOR`                                         |
| query      | `granite wakeup`           | compact vault snapshot for loading agent context                 |
| compile    | `granite edit <slug>`      | update fields, body, tags, protocol state                        |
| compile    | `granite backlinks <slug>` | inbound links to a note                                          |
| compile    | `granite suggest-links <slug>` | unlinked mentions worth linking                              |
| compile    | `granite recommend <slug>` | what to link, tag, or write next                                 |
| lint       | `granite doctor`           | broken links, missing fields, stale notes, line violations       |
| lint       | `granite types`            | show note types and the flow between them                        |
| serve      | `granite serve`            | local web UI with the constellation graph (port 4321)            |
| serve      | `granite mcp`              | MCP server (stdio or HTTP; `--role read\|write`)                 |
| serve      | `granite daemon start`     | MCP + web UI as one background process                           |
| cloud      | `granite deploy …`         | serverless instances on Fly.io Sprites ([docs](docs/DEPLOY.md))  |
| sync       | `granite sync …`           | direct multi-device sync ([docs](docs/SYNC.md))                  |

Run `granite --help` for every flag.

</details>

## FAQ

<details>
<summary><b>Is this an Obsidian replacement?</b></summary>

No. Your vault is plain markdown with `[[wikilinks]]` — Obsidian opens it just fine. Granite adds the typed contracts, the deterministic index, and the MCP surface on top of files any editor can read.

</details>

<details>
<summary><b>Where's the AI?</b></summary>

In your agent. Granite is deliberately deterministic — that's precisely why an agent can be trusted with write access to it.

</details>

<details>
<summary><b>No embeddings — how does search work?</b></summary>

SQLite FTS5 for full text, typed queries over indexed fields, and the wikilink graph for structure. Deterministic, explainable, and rebuildable from the files.

</details>

<details>
<summary><b>Can I use it without an agent?</b></summary>

Yes. The full CLI and the web UI work standalone. The MCP server is one door among three.

</details>

<details>
<summary><b>What happens to my data if Granite disappears?</b></summary>

Nothing. It's a folder of markdown files. The index is derived and disposable; `git init` the vault and you have versioning and backup for free.

</details>

<details>
<summary><b>Does anything phone home?</b></summary>

No. No telemetry, no account, no network calls — unless you explicitly deploy to your own sprite, sync to your own machines, or run `granite serve` with cloud credentials configured (use `--no-cloud` to stay fully offline). Granite makes one outbound call on your behalf: the Jev judgment, from the MCP layer, which requires a `TYPESAFE_API_KEY` you set yourself. Without it Granite refuses to start rather than degrade.

</details>

## Philosophy

- local-first beats cloud dependence for personal memory
- plain markdown beats proprietary formats
- **types as active contracts** beat types as folders
- tools for humans should also be legible to agents
- protocol belongs in the core; **agent policy belongs outside it**
- a personal OS is a thing you own — not a thing you rent

## Status & contributing

Granite is pre-1.0 and moving fast — see [CHANGELOG.md](CHANGELOG.md) for release history. The product boundary stays fixed: Granite stores and indexes local knowledge; agents bring the intelligence.

Issues and focused PRs are welcome. For local development, read [CLAUDE.md](CLAUDE.md). The key product rule is simple: no embedded LLM, no vector store, no autonomous scheduler inside Granite — the single permitted model is Jev, a classifier Granite requires for its semantic layer.

---

<p align="center">
  <sub>Ship your agent a home. Then give it the keys.</sub>
</p>
