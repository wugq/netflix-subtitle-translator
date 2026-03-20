# Project Reference

- **Code style:** [`docs/CODE_STYLE.md`](docs/CODE_STYLE.md) — comments, file organisation
- **Architecture:** [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) — execution contexts, class map, data flow, SPA navigation
- **Design decisions:** [`docs/DECISIONS.md`](docs/DECISIONS.md) — known gotchas, non-obvious constraints, historical bug fixes

Read these before making changes to understand current design intent.

**When writing code:**
- Follow the patterns and constraints in the docs above
- If a change introduces a new class, modifies a data flow, or resolves a non-obvious bug, update the relevant doc as part of the same change

**When bumping a version:**
- Run `git log` from the last version commit to HEAD and use it as the basis for the changelog entry — do not rely on memory or conversation history
- Review all docs and update any sections that no longer reflect the current code
- All of the above must be done before the version commit is made

# Architecture Philosophy

The three execution contexts (injected page script / content script / background service worker) are **platform-imposed** by the browser extension model — not an architecture choice. Don't treat boundaries between them as clean-arch layer violations.

Clean architecture is a longer-term goal, deferred until we have a clearer picture of how to test browser extensions properly. For now, keep code well-structured within each context and avoid unnecessary coupling across contexts.

# Knowledge Persistence

**Prefer `CLAUDE.md` and `docs/` over local memory files.** Architecture decisions, design rules, and gotchas belong in this repo so they are versioned and available on any machine.

Only use local memory (outside the repo) for information that is genuinely personal or environment-specific and must not go into git.
