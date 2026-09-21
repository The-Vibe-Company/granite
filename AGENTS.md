# AGENTS.md

For repository architecture, product boundaries, commands, and test workflow, see [CLAUDE.md](CLAUDE.md).

Codex-specific notes:

- No operational differences from the Claude workflow.
- This repo is TypeScript + Node ESM. Keep CLI wrappers thin and put business logic in `src/core/`.
- Preserve the product boundary: Granite is deterministic local markdown infrastructure, not an embedded LLM, vector store, scheduler, or autonomous agent. The single permitted model is **Jev** — a classifier, called from `src/mcp/` only, opt-in and failing closed. See [CLAUDE.md](CLAUDE.md).
