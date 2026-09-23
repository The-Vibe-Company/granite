# AGENTS.md

For repository architecture, product boundaries, commands, and test workflow, see [CLAUDE.md](CLAUDE.md).

Codex-specific notes:

- No operational differences from the Claude workflow.
- This repo is TypeScript + Node ESM. Keep CLI wrappers thin and put business logic in `src/core/`.
- Preserve the product boundary: Granite is deterministic local markdown infrastructure, not an embedded LLM, vector store, scheduler, or autonomous agent. The single permitted model is **Jev** — a classifier, called from `src/mcp/` only, and **required**: Granite refuses to start without `TYPESAFE_API_KEY`. See [CLAUDE.md](CLAUDE.md).

## Plan PR workflow

Use the repository's [plan-pr](.agents/skills/plan-pr/SKILL.md) to prepare an implementation
plan for approval, then [ship-pr-dev](.agents/skills/ship-pr-dev/SKILL.md) for delivery.
All dependencies are bundled in `.agents/skills/`; Claude Code uses relative links in
`.claude/skills/`. Prefer these copies over global skills. See the
[shared workflow guide](.agents/skills/plan-pr-bundle.md) for usage and prerequisites.
