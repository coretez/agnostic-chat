# Shamrock — Design Specification

> Status: living document · Last updated 2026-08-01
> Source of truth for the UI is the interactive prototype in
> `Interactive design system demo/Shamrock - Direction B.dc.html`
> (**Direction B**, the committed visual language — a dark terminal/developer
> aesthetic). `Shamrock.dc.html` (**Direction A**, Apple-native) is the same
> information architecture in an alternate skin, retained as a possible future
> appearance toggle (see §9). The two differ only in visual language, not IA.

---

## 1. Product

Shamrock is an **LLM-agnostic, project-centric desktop app** for coding,
document management, and process work. It is built in Electron but must feel
indistinguishable from a native macOS (AppKit) application.

### The problem it solves
Tools like Claude Code and ChatGPT are **chat-centric**: every conversation is
an isolated island, and any artifact it produces (files, notes, docs) is
stranded inside that one chat. There is no shared, durable place for a project's
knowledge, and skills/keys leak across unrelated work.

### The inversion
The **project is the durable container.** Chats, documents, skills, and
credentials all belong to a project. In particular:

- **Documents are a project-scoped knowledge base the assistant retrieves from**
  — never attachments stapled to a single chat.
- **Skills are enabled per project**, so an unrelated project's skills never
  pollute the model's decisions.
- **Credentials are project-scoped or global**, encrypted at rest.
- **Continuity is first-class**: a project maintains an auto-updated index,
  handoff notes, and task state, so a *new* chat starts warm.

---

## 2. Principles

1. **Local-first.** All data lives on the user's Mac. Nothing syncs by default.
2. **Project-centric.** Navigation starts from a project, not a document list.
3. **LLM-agnostic.** Hosted (Claude, GPT) and on-device (Ollama/Llama) models
   are peers; the active model is switchable at any moment.
4. **Retrieval-first.** Answers are grounded in project documents, and the app
   *shows its sources* and relevance.
5. **Secure by construction.** Secrets never touch the renderer; LLM/provider
   logic lives only in the main process (this is the "prompt protection"
   backbone).
6. **Continuity over ephemerality.** The project remembers state across chats.

---

## 3. Architecture (implemented)

Electron with a hard main/renderer boundary.

```
┌──────────────── Renderer (chat UI) ────────────────┐
│ contextIsolation: true · nodeIntegration: false     │
│ sandbox: true · strict CSP · no Node, no DB, no keys │
│                     window.api  (typed)             │
└───────────────────────┬─────────────────────────────┘
                        │ ipcRenderer.invoke (preload bridge)
┌───────────────────────┴─────────────────────────────┐
│ Main process (trusted)                               │
│  ipc.js → db/repo.js → node:sqlite (DatabaseSync)    │
│  secrets.js → Electron safeStorage (macOS Keychain)  │
│  provider routing (planned) — keys decrypted HERE     │
└──────────────────────────────────────────────────────┘
```

- **DB:** SQLite via the built-in `node:sqlite` (Electron 43 / Node 24) — zero
  native deps. File at `app.getPath('userData')/agnostic-chat.db`, WAL mode.
  Migrations via `PRAGMA user_version` (`SCHEMA_VERSION`).
- **Secrets:** `safeStorage.encryptString` → ciphertext BLOB in DB. Plaintext is
  only ever recovered in the main process via `credentials.reveal()`, which is
  deliberately **not** exposed over IPC/preload.
- **Files:** see §5 — documents will live as real files under a per-project
  folder, with the DB as the index over them.

### Canonical data location
`app.getPath('userData')` (macOS: `~/Library/Application Support/Shamrock/`).
Layout:
```
<userData>/
  agnostic-chat.db            # index + metadata + encrypted secrets
  projects/<project-slug>/
    docs/                     # documents as real files (portable, tool-readable)
    index/                    # vector/embedding store for retrieval
```
> The prototype shows abbreviated paths like `~/Library/AgnosticChat/…`; the
> canonical location above is what ships (Electron `userData`).

---

## 4. Information architecture

Persistent window chrome frames a main area that switches between **five pages**;
**modals** and the **command palette** overlay any page.

```
Title bar:  ●●●  {Project}      [model ▾] [⌘K] [theme]
├─ Sidebar (220px) ── Projects ▸ list (+),  Chats ▸ list (+),  footer: Local · path
└─ Main
   ├─ Page toolbar (44px): segmented [Chat · Overview · Documents · Skills · Settings] + context note
   └─ Page body → one of:
        Chat · Overview · Documents · Skills · Settings
Overlays: New Project · New Document · Add API Key · New Skill · Delete confirm · Command Palette (⌘K)
```

Navigation is a **segmented control** in the page toolbar (plus the sidebar for
project/chat selection, and ⌘K to jump anywhere).

---

## 5. Data model

### Implemented tables (`src/main/db/schema.sql`)
`projects · chats · messages · documents · chat_documents · skills ·
project_skills · credentials · settings` — project-centric, portable to Postgres.

### Planned additions (driven by this design)
| Need | Change |
|---|---|
| Docs as real files | Write document bodies to `projects/<slug>/docs/`; keep `documents.path`, `mime_type`, `source` as the index. |
| Retrieval + "Sources" | Add embeddings via **`sqlite-vec`** (in-DB vectors); store chunk→document mapping + relevance scores surfaced in the Sources popover. |
| Tasks (Overview) | `tasks(id, project_id, title, status[todo\|in_progress\|done], updated_at)`. |
| Project Index / Handoff | `project_notes(project_id, kind[index\|handoff], body, updated_at)` — auto-maintained by the assistant. |
| Inbox | `inbox_items(id, project_id, filename, size, path, status[pending\|added])`. |
| Model per chat | Already on `chats.model`; default from project setting `default_model`. |

---

## 6. Pages

### 6.1 Chat (default)
- **Center:** message thread. User bubbles right (accent), assistant bubbles
  left (`--bub`). A centered pill shows retrieval context ("Today · retrieving
  from 6 project documents").
- **Sources:** assistant replies that used documents show a **`Sources (n)`**
  chip beneath the bubble + model/latency (`Claude Opus 4.5 · 4.2s`). Clicking
  opens a popover listing retrieved documents, each with a **relevance meter**
  (three bars + score like `0.94`) and a one-line "why", deep-linking to the
  document in the Documents page.
- **Composer:** rounded field, `+` (new document), a scope line
  ("6 documents in scope · 3 skills enabled"), **Send**. `⌘↩` sends.
- **Right panel (240px): DOCUMENTS** for the project — compact list (title +
  `source · type`), `+` to add, footer reminder that docs belong to the project.

### 6.2 Overview (continuity home)
Header: project name + description + stats (**Chats · Documents · Last active**).
2×2 cards:
- **Project Index** — auto-maintained: Goal / Contains / State / Open questions.
- **Handoff · Recent activity** — timeline of what happened, per chat + model;
  "Start chat from here" action.
- **Tasks** — checklist with `done / in progress / to do` states + counts.
- **Inbox** — drag-drop zone; **full state** lists items to triage (name, size,
  Add) "auto-related to this project"; **empty state** = "Drop files here".

### 6.3 Documents (library + reader)
Three columns:
- **Library (272px):** search field + `+`; list of docs (`type · source · date`),
  selectable.
- **Reader:** title bar with **Edit** and **Reveal in Finder**; renders
  markdown/code/diff (diff shows red/green lines).
- **Details (224px):** `Type · Source · Created · Updated`, the **on-disk path**
  (monospace), and **Referenced by** — the chats that created/retrieved it, each
  deep-linking back to the chat.

### 6.4 Skills (per-project scoping)
Intro line: "Enabled skills apply to **{Project}** only." Two groups:
- **Project-authored** — badge `This project`.
- **Global library** — badge `Global`.
Each row: name + description + a toggle. `+ New Skill` opens the modal.

### 6.5 Settings / Keys
- **API Keys** — badge "🔒 Encrypted at rest in Keychain". Table: provider ·
  label · masked key (`sk-ant-••••4f2a`) · scope (`Global` / `This project`) ·
  date. Note: "Secrets are write-only… never read back." `+ Add API Key`.
- **General** — Default model (per project) · Appearance (Light/Dark/System) ·
  Data location (+ Change…).
- **Danger zone** — Delete project (destructive, opens confirm modal).

---

## 7. Modals & overlays

| Modal | Key fields / behavior |
|---|---|
| **New Project** | Name (autofocus) + optional Description → Create. |
| **New Document** | Title + Type; drag-drop / paste; "Indexed for retrieval on save." |
| **Add API Key** | Provider + Label + Secret (masked, write-only) + Scope toggle; Keychain reassurance. |
| **New Skill** | Name + Import…; Description; Definition (YAML/markdown); "Enable for {Project}". |
| **Delete confirm** | Warns with counts; irreversible; red confirm. |
| **Command Palette (⌘K)** | Fuzzy jump: PAGES · DOCUMENTS · ACTIONS (New Project ⌘N, Add API Key, toggle theme). `esc` closes. |

All modals: dimmed backdrop (`rgba(0,0,0,0.28)` + 2px blur), card with
`--sheet` shadow, `ac-sheet`/`ac-fade` entrance, footer action bar on `--panel`.

---

## 8. Visual design system — Direction A palette (alternate skin)

> This section documents the **Direction A** (Apple-native) palette, retained as
> the alternate skin. The **shipped Direction B tokens are in §9** and live in
> `src/renderer/tokens.css` (switched by `data-b-theme="light"`; dark is default).

### Color
| Token | Light | Dark | Use |
|---|---|---|---|
| `--accent` | `#0a84ff` | `#0a84ff` | primary actions, selection, links |
| `--ink` / `--ink2` / `--ink3` | `#1d1d1f` / `#6e6e73` / `#9a9aa0` | `#f5f5f7` / `#a1a1a6` / `#77777c` | text primary / secondary / tertiary |
| `--win` `--content` `--card` `--panel` `--side` | white-ish | `#1c1c1e`–`#242426` | surfaces (window, page, cards, rails, sidebar) |
| `--bub` | `#f0f0f3` | `#2c2c2e` | assistant bubble |
| `--field` | `#ffffff` | `#1a1a1c` | inputs |
| `--line` / `--line2` | `rgba(0,0,0,.09/.05)` | `rgba(255,255,255,.10/.055)` | dividers |
| `--hov` / `--sel` | `rgba(0,0,0,.045/.075)` | `rgba(255,255,255,.06/.10)` | hover / selected |
| status | green `#30d158`, red `#ff453a` | same | online, encrypted / danger |

Semantic tint chips: accent `rgba(10,132,255,.12)`, green `rgba(48,209,88,.13)`.

### Type
System font stack; monospace `'SF Mono', ui-monospace, monospace` for code,
paths, keys. Scale (px): **26** page/overview title · **22** page section title ·
**19** doc H2 / stat number · **15** modal & palette title · **13.5** chat body ·
**13** list/body · **12.5** secondary · **12** labels/buttons · **11.5** meta ·
**11** micro hints · **10** uppercase group headers.
Weights: 600 (titles/labels), 500 (medium/rows), 400 (body). Negative tracking
(−0.2…−0.4px) on large titles; +0.35/+0.5px on uppercase micro-labels.

### Shape, elevation, motion, layout
- **Radii:** window 12 · cards/modals 12–14 · buttons/fields 6–7 · pills 11/20 ·
  toggle track 11.
- **Shadows:** `--shadow` `0 1px 2px rgba(0,0,0,.05/.30)`; `--sheet`
  `0 24px 70px …` for modals/popovers.
- **Motion:** `ac-sheet` 120–160ms `cubic-bezier(.2,.8,.3,1)`; `ac-fade`
  100–120ms. Keep everything ≤160ms.
- **Backdrop wall:** subtle radial gradient behind the window.
- **Fixed metrics:** title bar 40px · page toolbar 44px · sidebar 220px · chat
  docs panel 240px · docs library 272px · docs details 224px · reference frame
  1320×856.

---

## 9. Direction B — committed visual language (terminal / developer)

Dark-first, monospace-accented, brand-red. This is what the app ships.

**Signatures:** brand-red square logo + uppercase mono project name and page slug
in the chrome (`▪ INGEXT PIPELINE / chat`); lowercase model ids
(`claude-opus-4.5`); 1px borders with sharp 4–6px radii; author-label chat turns
(`YOU` / `OPUS` in the left gutter) instead of bubbles; left-bar selection
indicators; a right rail with **DOCS / PLAN / SCOPE** tabs (PLAN = the agent's
live step plan; SCOPE = enabled skills + connected MCP servers).

**Tokens** (`src/renderer/tokens.css`, `data-b-theme="light"` opt-in; dark default):
| Token | Dark | Light |
|---|---|---|
| `--brand` / `--brand-deep` / `--brand-soft` | `#e04452` / `#b3242e` / `rgba(224,68,82,.14)` | `#b3242e` / `#8f1c24` / `#f8e8eb` |
| `--content` `--side` `--chrome` `--panel`/`--card` `--raise` | `#1a1b1e` `#161719` `#141517` `#1e1f23` `#25262b` | `#faf9f6` `#efede8` `#f2f0ec` `#f4f2ee`/`#fff` `#fff` |
| `--ink` / `--ink2` / `--ink3` | `#eceef1` / `#9ba1a9` / `#6b7178` | `#1f2428` / `#5a5f64` / `#8a857c` |
| `--line` / `--hov` / `--sel` | `#26282c` / `#232529` / `#2a2c31` | `#e0dcd4` / `#eeece6` / `#e6e3db` |
| `--green` / `--blue` | `#3ec97a` / `#5b9bd8` | `#2e9e5b` / `#2f73b7` |

**Type:** UI accents/labels/meta in `--mono` (IBM Plex Mono in the prototype;
currently falls back to the system mono stack because the app is CSP-locked/offline
— bundle IBM Plex Mono `woff2` locally under `font-src 'self'` to match exactly).
Body copy stays in the system sans stack.

**Metrics:** title bar 38 · tab bar 34 · sidebar 208 · right rail 276.

> Direction A (§8) remains a clean token-swap away should a lighter Apple-native
> skin ever be wanted — same markup, different `tokens.css`.

---

## 9b. Model connections (implemented 2026-08-01)

App-global model providers, managed on a dedicated **Models** screen (reachable
via the titlebar `MODELS` chip, the model dropdown's "Manage connections…", and
the command palette).

- **Providers at launch:** OpenAI, Claude (Anthropic), Qwen (DashScope), Kimi
  (Moonshot), Gemini (Google). Definitions in `src/main/providers/registry.js`
  (label, wire `style`, default `baseUrl` (user-editable), key hint, fallback
  models).
- **Connectors (main process only):** `openai-compat.js` handles OpenAI, Qwen,
  Kimi, Gemini (all OpenAI-compatible `/chat/completions` + `/models`, Bearer);
  `anthropic.js` handles Claude (`x-api-key` + `anthropic-version`,
  `/v1/messages` with top-level `system`, `/v1/models`). `index.js` dispatches by
  type and provides `testConnection()` (live `/models`, falling back to a 1-token
  chat ping).
- **Model lists are fetched live** from each provider; `registry` fallbacks only
  seed the picker before a successful fetch. Model ids churn, so nothing is
  hardcoded as truth.
- **Storage:** `providers` table (schema v2). API key encrypted via `safeStorage`
  (ciphertext BLOB); `reveal()` is main-only and never exposed over IPC. Repo:
  `repo.providers.*`. IPC: `providers:{registry,list,add,update,remove,test}`.
- **Chat routing:** `chat:send` resolves the selected connection, decrypts
  the key in main, and calls the connector with the full message history.
  The renderer blocks send (with a setup notice) when no model or working
  directory is set, so `chat:send` itself now requires a provider.
- **Switcher:** the title-bar model dropdown is built dynamically from enabled
  connections' models, grouped by provider.

## 10. Interaction & keyboard
`⌘K` command palette · `⌘N` new project · `⌘↩` send message · `Esc` closes any
overlay/popover. Model switcher and theme toggle live in the title bar and are
always available.

## 11. Key states to support
First-run (no projects → hero + New Project) · empty vs full Inbox · retrieval
on/off · model-specific chat rows · light/dark for all pages.

---

## 12. Implementation status → gap

| Area | Built | Gap to design |
|---|---|---|
| Security boundary | ✅ main/preload/renderer, CSP, sandbox | — |
| DB + repo (9 tables) | ✅ | + tasks, project_notes, inbox_items |
| Encrypted credentials | ✅ set/list/remove + keychain | Add-Key modal UI; masked display |
| Renderer shell | ✅ Direction B: chrome, sidebar, tab nav, Chat page, DOCS/PLAN/SCOPE rail, palette, light/dark | Full Overview/Documents pages, modals, live PLAN/SCOPE data |
| Documents | ⚠️ create/list (DB only) | Files-on-disk, reader/editor, details, referenced-by |
| Retrieval / Sources | ❌ | `sqlite-vec` embeddings + Sources popover |
| Overview / continuity | ❌ | Index, Handoff, Tasks, Inbox |
| Skills UI | ❌ (backend scoping ✅) | Skills page + New Skill modal |
| Model connections | ✅ OpenAI/Claude/Qwen/Kimi/Gemini connectors, Models screen, encrypted keys, test, live model fetch | Streaming; per-project key scoping; usage/cost |
| LLM routing | ✅ chat:send routes to selected connection (history sent); requires model + working dir, else a setup notice | Streaming tokens; system prompt from project/skills |

---

## 13. Build roadmap (proposed)

1. **App shell + design tokens** — window chrome, sidebar, segmented nav,
   light/dark via `tokens.css`; port the working Chat page into it.
2. **Real LLM routing + Add-Key modal** — decrypt key in main, call provider,
   stream reply; wire the model switcher.
3. **Documents on disk + reader/editor** — write files, reader page, details +
   referenced-by.
4. **Retrieval (`sqlite-vec`) + Sources popover** — embed on save, retrieve into
   context, render sources with scores.
5. **Overview (continuity)** — Index/Handoff/Tasks/Inbox, auto-maintained.
6. **Skills page + Command Palette** — per-project toggles; ⌘K navigation.

## 14. Routines (O33) — interface design

There is no surface for this today: nine pages, four chat rails, nothing that
mentions a schedule. The backend design was written first, so this section
exists to keep the UI from being retrofitted onto it.

**The governing idea: capture happens where the work happened.** A routine is
not authored from a blank form — it is a plan that already ran and worked.
Asking someone to re-describe in a builder what they just watched succeed is
how these features end up unused.

### 14.1 Capture — the PLAN rail
The right rail already narrates the live plan. When a turn completes
successfully, its plan header gains **SAVE AS ROUTINE**. That is the entire
capture affordance, and it sits three inches from the steps that just ran.

Clicking opens a small sheet, pre-filled from the turn rather than empty:
- **Name** — defaulted from the goal ("Expo monthly security report")
- **Runs** — a plain-language schedule (`monthly on the 1st at 01:00`), not a
  cron string; cron is the storage format, never the input
- **Bindings** — the period-like values the plan used, each with what they
  should become on the next run: `period 2026-07 → previous month`. This is the
  one genuinely new concept, so it gets the most explanation and a worked
  example of the next three fire dates.
- **On failure** — notify / notify and disable

Nothing is inferred. O8's lesson applies directly: durability is a decision the
user makes, never one the system guesses.

### 14.2 ROUTINES — a top-level page
Routines are first-class objects with history, like documents and skills, and
history needs room a card cannot give. Sits after AGENTS in the tab bar.

Each row: name · what it produces · schedule in words · **next fire** · last
outcome as a status dot (ran / failed / skipped / disabled) · an enable toggle.
Selecting a row opens a detail pane with the captured plan **read-only** (the
same step list the PLAN rail draws, so it is recognisably the thing that ran),
the bindings with their next resolved values, and the run history.

Run history is the part that earns the page: one line per fire — when, outcome,
duration, the document produced (deep-linked into DOCUMENTS), or the reason it
did not run. `skipped` states its cause in words: *"Fluency Expo was
unauthorized — no document was produced."* A routine that quietly stops
producing is the worst failure mode, so a gap in the series is drawn as a gap,
not as an absence of rows.

### 14.3 Where failure surfaces
A 01:00 failure must be visible at 09:00 without hunting:
- the **ROUTINES tab label** carries a count badge when any routine is in a
  failed state
- **OVERVIEW** gains one line in the project header — next fire, or the failure
  if there is one
- the outcome is written to the O27 debt ledger like any other finding

No modal, no notification centre popup. The badge persists until the run
succeeds or the routine is disabled — failures should not be dismissible by
acknowledgement, only by resolution.

### 14.4 What this deliberately does not have
No visual schedule builder, no calendar grid, no dependency graph between
routines, no per-step editing of a captured plan. Editing a captured plan in a
GUI recreates the planner badly; if the plan is wrong, run the turn again and
capture the better one — the capture is cheap, which is the whole point.

## 15. Document library — retrieval strategy

Today the library defaults to a recency list with single-tag pivots
(`state.libraryView`, `state.libraryTag`). That is fine for "what did I just
make" and answers nothing else. Recency is the one ordering guaranteed to
decay: the document you need at month-end is the one from *last* month, and by
definition it has been pushed down by everything since.

**Start from the questions, not the layout.** A user of this library asks:
*what is the latest Expo monthly report* · *did August actually run* ·
*everything for Expo* · *what did we produce this quarter* · *where is that
thing about the Falcon sensors* · *what needs my attention*. A recency list
answers only the first, and only for a few days.

### 15.1 Facets, not a filter
What ships is a *filter* — one `facet:slug` at a time. Faceted navigation is
multi-dimensional and combinable, and each value carries a **count reflecting
the current result set**, so the interface shows the shape of the library
before you commit to a click and never offers a path to zero results. NN/g puts
task completion 25–50% faster with facets than keyword search alone, and the
facets must be domain-specific to earn that: here **tenant · period · type ·
status · topic**, which is exactly the vocabulary O31's librarian already
assigns. The data exists; the navigation does not.

Text search sits alongside, not instead: faceted search is text over the
unstructured part and facets over the structured part. Neither alone is enough.

### 15.2 Series are first-class objects
A monthly report is not a document, it is the August member of a series. This
is the largest retrieval gap and the one the current design cannot express at
all. A series row shows its members as a **period strip** — one cell per period,
filled where a document exists and **empty where it does not**. A missing month
is drawn as a gap.

This matters more once routines (O33) run unattended: the failure mode of a
scheduled report is not a loud error, it is a month that quietly never appears.
The library is where that becomes visible, and a gap in a strip is noticed in a
way an absent row never is. Requires O23's period-as-identity split — until
periods are identities rather than versions, a series cannot be enumerated.

### 15.3 Saved views are library objects
A view someone returns to weekly ("Expo monthlies", "unreviewed this quarter")
should be a thing in the library, not a filter state to reconstruct each time.
Treating a saved query as a first-class library object is a well-worn document-
management pattern, and it is what turns facets from a search tool into
navigation. Saved views appear beside documents in the sidebar; the default
landing view is itself one, so it can be changed rather than hard-coded.

### 15.4 The default view answers, it does not list
Landing on the library should show, in order: **series with their period
strips** (including gaps), **anything needing attention** (a failed routine, an
unreviewed deliverable, a superseded document still referenced), and only then
recent items. Recency drops to a section — it is a genuine answer to one
question, not the organising principle.

### 15.4b Two libraries, one at a time
The DOCUMENTS page holds two collections that answer different questions:
**PROJECT DOCUMENTATION** — the canonical set the planner itself reads
(OBJECTIVES, DESIGN, DEBT, CODING RULES) — and **GENERATED & UPLOADED**, what
this project has produced or been given. They are never consulted together:
one is the standing contract, the other is output. Stacking them charged the
reader a scroll past four fixed rows to reach the list that actually changes,
and put the facet rail — which only ever applies to the second — alongside the
first, where it means nothing. They are therefore **tabs**, each carrying its
count so the shape of both is legible without switching. Canonical opens first:
it is the smaller, fixed set, and it is what a reader arriving cold needs to
orient. The chosen tab survives a re-render, so a document saved mid-session
does not throw the reader back to the default.

### 15.5 Two view modes, chosen by content
List for browsing; **timeline** for periodic content, where the x-axis is the
period and the eye reads coverage and gaps directly. Time-oriented and
content-oriented views over the same set is standard in document management,
and a periodic series is the case that most rewards it. No thumbnail grid —
these are reports, not images, and a wall of identical page-one previews
carries no information.

### 15.5b Two different times, and only one of them is a facet
The first cut showed a Period facet listing `2026-Q3 · 2026-Q2 · 2026-Q1 ·
2025`, which conflated two unrelated things:

- **What the document is ABOUT** — the July report covers July. This is
  intrinsic, comes from the save contract, and is *already drawn better by the
  series strip*, one cell per period, in the series' own cadence. It does not
  need to be a facet at all; the strip shows coverage and gaps, which a list of
  quarter buckets cannot.
- **When it was PRODUCED** — this is what browsing actually wants, and people
  do not ask for it in quarters. They ask for **last 7 days · last 30 · last
  90 · this year · older**. Calendar quarters are a *reporting* convention
  borrowed into navigation, where they fit badly: "2026-Q2" requires knowing
  today's date to be useful, "last 30 days" does not.

So: the strip owns *about*, a relative-window facet owns *made*. A quarterly
artifact still shows quarters — in its own strip, because that is its cadence,
not because the library imposes quarters on everything.

### 15.6 No status facet — it implies a process that does not exist
The first cut showed `reviewed / unreviewed / superseded`. Nothing sets those,
and more importantly nothing *could* without inventing a review workflow this
product does not have and has not asked for. A facet that describes a process
nobody performs is worse than no facet: it invites the user to filter by a
state that never changes.

What remains real is **attention**, and it is derived from facts rather than a
taxonomy — a routine that did not run, a document whose figures carry no as-of
time. Those come from the run record and from provenance (O21), both of which
are actual signals, not labels somebody was supposed to maintain.
`superseded` is likewise derivable if it is ever wanted — a newer version or
period exists — and should be computed, never stored as a status.

### 15.7 Where the metadata comes from — the user mostly does not type it
Facets are worthless if someone has to hand-tag 42 documents, so the honest
answer to "how does `kind: monthly-report` get set" is **three sources, and the
user is the last of them**:

1. **The skill's save contract — the bulk, and zero user input.** A skill
   declares its output shape once, in frontmatter, and every run fills it:
   `expo-monthly-report` carries `type: monthly-report`,
   `properties: {tenant: expo, period: "{YYYY-MM}"}`. The July run produced
   `{"tenant":"expo","period":"2026-07"}` from exactly that. Whoever writes the
   skill sets the metadata for every document it will ever produce.
2. **The librarian (O31) fills the gaps** — a dropped-in PDF or an ad-hoc save
   has no contract, so it gets tagged on save under deterministic validation
   (known facets, slug dedupe, existing spellings win).
3. **The user corrects** — in the reader, on a document that is wrong. Not
   built (O31 lists it as an extension) and it is genuinely needed: today a
   mis-tag is permanent. Correction is the workflow, authoring is not.

**Typed `kind:monthly-report` is an accelerator, not the entry path.** The
search box should parse `key:value` into the same facet state a click produces,
because people who know the vocabulary type faster than they click — but
nobody should have to learn a query language to browse, and the rail must
always be able to answer the question on its own.

**The gap this exposes: `properties` is free-form.** The tool schema invites
drift in its own description — *"tenant/company, period/date… whatever
applies"* — so two skills will name the same concept `tenant` and `customer`,
and the facet rail will show both as separate dimensions. Values should stay
open (any tenant name), but **keys need a controlled vocabulary**: `tenant`,
`period`, `case_id`, `framework`, with unknown keys kept on the document and
excluded from the facet rail until promoted. Same shape as the O8 durable-key
allowlist, and for the same reason — an open key space fills with synonyms.

### 15.8 What this does not do
No folder tree in the UI. Placement (O23) organises the *disk* so files are
portable and greppable; the interface navigates by facet, and a tree in both
places means two organisations to keep in sync and a user asking which one is
authoritative. No manual tagging as the primary path — the librarian tags on
save; hand-editing is a correction, not the workflow.

## 16. Open decisions
- Model roster/versions to display (prototype shows Opus/Sonnet **4.5**, GPT-4o,
  Local Llama 3.3; align to whatever we actually call at runtime).
- Provider set at launch (Anthropic + OpenAI + Ollama shown).
- Direction A only, or ship the B skin as a toggle later.
