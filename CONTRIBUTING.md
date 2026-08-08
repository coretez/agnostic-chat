# Contributing to Shamrock

Issues, discussion, and pull requests are welcome.

## Developer Certificate of Origin

Every commit must be signed off. Add `-s` to your commit:

```bash
git commit -s -m "your message"
```

That appends a `Signed-off-by:` line, which certifies you wrote the patch or
otherwise have the right to submit it under this project's license — the
[Developer Certificate of Origin 1.1](DCO), reproduced in full in this repo.

CI checks every commit in a pull request. To fix commits you already made:

```bash
git rebase --signoff origin/main
```

Why this matters here: Shamrock is offered under the FSL with a commercial
licensing path. The sign-off is what keeps the copyright chain clean enough for
the project to keep offering commercial licenses. Contributions retain your
copyright; the sign-off grants the project the rights it needs to distribute
your work under the terms in [LICENSE](LICENSE).

## Before you open a PR

```bash
npx electron scripts/smoke.js   # must end with ALL SMOKE TESTS PASSED
```

New behavior needs coverage in `scripts/smoke.js`. The suite runs headless
against a throwaway database and needs no API keys or network.

## Ground rules the codebase follows

- **No runtime dependencies.** The zero-dependency posture is deliberate —
  it keeps the licensing clean and the install auditable. Propose a dependency
  in an issue before a PR that adds one.
- **Every loop is bounded**, and every failure lands somewhere safer:
  planner failure falls back to the flat loop, budget exhaustion forces a
  wrap-up, a stuck step re-plans then escalates, STOP always saves work.
- **The glass box stays glass.** Anything that changes what reaches the model
  must emit a process event so it stays visible in the INTERNALS tab.
- **Secrets never leave the main process.** The preload bridge exposes a typed
  channel list; nothing decrypts into the renderer.

## Architecture

Start with `docs/PIPELINE_PSEUDOCODE.md` for how a turn flows end to end, then
`docs/HARNESS_OBJECTIVES.md` for what the coding harness is required to do and
why (objectives O1–O15; commits and design elements cite these IDs).

## Name and mark

The code license does not cover the Shamrock name or clover mark — see
[TRADEMARK.md](TRADEMARK.md). Forks are welcome and need their own identity.
