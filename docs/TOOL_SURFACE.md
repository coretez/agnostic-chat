# Tool Surface — what Shamrock offers the model, and what to add

Inventory + gap checklist, taken from the code (not from memory) on 2026-08-13.

**The governing principle, from the lab guidance we researched:** a focused tool
menu beats a large catalog — ten well-designed tools outperform fifty
overlapping ones, because the model reliably retains a small option set. The
long tail belongs in `run_command` and in skills, not in new tool schemas.
Every row below that says "skip" says it for that reason, not from laziness.

---

## 1. What ships today (15 distinct tools)

**Coding pack** — `coding-tools.js`, jailed to working dir ∪ documents dir:

- [x] `read_file` — text only; offset/limit paging
- [x] `write_file` — create/overwrite
- [x] `edit_file` — exact-string replace, optional replace_all
- [x] `list_dir` — recursive, depth-capped, skips node_modules/.git
- [x] `grep_files` — regex over contents, literal fallback
- [x] `run_command` — zsh, cwd = working dir, killed on return
- [x] `start_server` — long-running process that survives the turn
- [x] `server_logs` — read the running server's output
- [x] `stop_server`

**Documents pack** — `buildLibraryTools`, same jail machinery, library root, read-only:

- [x] `read_file` · `list_dir` · `grep_files` (no shell, no writes)

**Orchestrator** — available in every mode:

- [x] `delegate` — one isolated sub-agent, conclusion only
- [x] `assign` — parallel sub-agents + merge
- [x] `save_document` — deliverable → placement template → disk + index
- [x] `set_variable` — working-memory write (never leaves main)

**Web** — `web-tools.js`:

- [x] `web_search` · `fetch_url` (SSRF-guarded)

Framework capabilities that are deliberately NOT tools — they run without the
model asking, which is the point: the O26 check gate, O9 step-commits, O11
review, O15 doc-writer, O27 debt ledger, O30 drift scan, compaction.

---

## 2. Gaps worth closing

- [ ] **`glob` — find files by pattern.** `list_dir` + `grep_files` cannot answer
      "every `*.test.js` under src". Today the model burns turns shelling out to
      `find`. Cheapest real win on this list.
- [ ] **Multi-edit in one call.** `edit_file` does one replacement per call; a
      refactor across six sites costs six round trips and six approvals. An
      `edits: [{old,new}]` array is a small schema change to an existing tool
      (extend, don't add a sibling).
- [ ] **Images into context.** `read_file` refuses binaries, so a screenshot,
      diagram, or design comp cannot reach the model even on vision-capable
      providers. Blocks the "match this mockup" workflow entirely.
- [ ] **MCP non-text content.** See §3 — this is a correctness hole, not a
      convenience gap.
- [ ] **Background command + poll.** `start_server`/`server_logs` cover dev
      servers only. A long migration or test suite has no equivalent; it either
      blocks or hits the 300s cap.

## 3. MCP rich content — the hole

`mcp/client.js:19`:

    if (Array.isArray(result?.content))
      return result.content.filter((c) => c.type === 'text').map((c) => c.text).join('\n');

The MCP spec allows tool results to carry `text`, `image`, `audio`, and embedded
`resource` blocks. **Shamrock keeps text and silently discards the rest.** A
server returning a chart, screenshot, or rendered artifact today produces a
result that looks empty-ish to the model, with no error and no trace of what was
dropped.

`listResources()` / `readResource()` exist in the same file under the comment
"foundation for MCP Apps / widget UIs (ui:// resources)" — and are called from
**nowhere** in the codebase. The plumbing was stubbed; nothing consumes it.

- [ ] **Stop silently dropping content.** At minimum, replace dropped blocks
      with a visible marker (`[image omitted: 42kb png]`) so the glass box and
      the model both know something was there. Cheap, honest, no trust change.
- [ ] **Images through to vision models** — same path as §2's local images.
- [ ] **`ui://` resources / MCP Apps — GATE THIS BEHIND O17.** Rendering
      server-supplied HTML in the renderer would hand an external MCP server a
      scripting surface inside a window that is currently CSP-locked, sandboxed,
      and context-isolated. That is exactly the trust boundary Phase 4 hardened.
      It belongs behind an EG-3 output guardrail with a strict sanitizer and its
      own origin, or not at all. Do not ship it as a convenience feature.

## 4. Rendering — not tools, but what people mean when they ask for tools

- [ ] **Mermaid.** `renderer.js:138` captures the fence language, then line 147
      renders every block as `<pre class="codeblock">` regardless. The model can
      already WRITE mermaid (`docs/PIPELINE_PSEUDOCODE.md` has two diagrams);
      it just displays as source. Route the `mermaid` fence to a renderer in
      chat, HTML, and PDF — this is O25 (widgets), where the model authors data
      and the framework renders deterministically.
- [ ] **The rest of O25** — callout, table, chart (bar/line/donut/radar/heatmap)
      with defined markdown degradations.

## 5. Explicitly skipped

- **Notebook editing** — niche for this product.
- **A todo/task tool** — the plan IS the task list (O9/O16), and it is already
  versioned into git. Adding a second one would create two sources of truth.
- **An explicit "invoke skill" tool** — Pass 1 context-selection already loads
  what a prompt needs; an invoke tool would duplicate it.
- **A large MCP-style catalog of per-service tools** — the connected MCP servers
  already provide these, scoped per project. Baking them in would defeat the
  tool ceiling.
