# Generated-Document Management Strategy

## The problem

Agentic tools dump generated files into an opaque, session-scoped folder (OpenAI's
ephemeral file storage is the canonical anti-pattern). Results are then hard to
find, not tied to the project, and junk up the host system. We already have the
right primitives to do better: a **project working directory** on disk and a
**`documents` table** that treats documents as project-owned (not chat-owned).

## Principle (from the research)

**A persistent, human-and-agent-shared project workspace — not a session folder.**
Outputs live in a findable place, are organized by stage, and are indexed with
provenance. This is the pattern every serious source converges on (Fastio's shared
workspace, Claude Code's Artifacts + Files grid, the `.aiwg/`/AGENTS.md convention,
stage folders `drafts/` → `output/`).

## Reference model: Claude Code Artifacts — adopt the UX, fix the storage

Claude Code's Artifacts is the closest, most-polished reference: files saved into the
project, a searchable **Files** grid, a per-file menu (Open / Provenance / Versions /
Star / Rename / Download / Delete), and **auto-versioning on same-name resave**. We
adopt that management UX wholesale.

BUT its one weakness is *exactly the problem we're solving*: Claude Code stores
artifacts *"in the app's data folder"* — opaque, hard to find, which is why it needs a
Download button and a Files grid to compensate. **Our improvement: same UX, but the
files live in a real, user-visible, configurable folder (Documents by default).** So:
- **"Reveal in Finder" is the primary action** (the file is already somewhere real);
  Download/Export-elsewhere is secondary.
- Drop session-scoped menu items (`Open beside session`, `View in context`) — ours are
  project-scoped, which is cleaner.
- **Versions map to real files cleanly**: keep the live file as `report.html`, move
  prior versions into a `.versions/` subfolder, full history in the DB index — rather
  than littering `report.v1.html`, `report.v2.html` beside it.

## Design

### 1. A defined, USER-CONFIGURABLE output location per project (findable, not hidden)
Configurability is a first-class requirement, not just a default:
- **Per-project output dir**, settable in OVERVIEW (folder picker + Reveal),
  re-pointable anywhere (repo subfolder, shared drive, iCloud, …).
- **Global default base** (a setting) so new projects inherit the user's preferred
  root — default `~/Documents/Agnostic Chat/`.
- Effective default per project: `<global base>/<Project Name>/`.
Each project gets an **output directory**, distinct from `working_dir`:
- Default: `~/Documents/Agnostic Chat/<Project Name>/` — in the user's Documents,
  trivially findable, never junking a code repo.
- If the project's `working_dir` is set and the user prefers in-repo docs, they can
  point the output dir at `<working_dir>/documents/`.
- Configurable in OVERVIEW, right next to the working directory, with a Reveal button.

### 2. A conventional structure inside it (stage-based)
```
<output_dir>/
  documents/     # finished deliverables (reports, docs)
    2026-08/     # dated (or by-topic) subfolders — organized, not a flat junk drawer
  drafts/        # work-in-progress / intermediate outputs
  .agnostic/     # app metadata (kept out of the way; DB remains source of truth)
```

### 3. The `documents` table = the searchable index (rich metadata + provenance)
Every generated file is registered with structured, queryable metadata:
- **Common columns**: `doc_type` (monthly-report | investigation | compliance-assessment
  | …), `title`, on-disk `path`, `mime_type`, **`source`/provenance** (which chat /
  skill / agent produced it), `version`, `created_at`/`updated_at`, `project_id`.
- **`properties_json`** for the per-type variable fields: **tenant/company**,
  **period/date**, `case_id`, `framework`, `tags`, … — so the same index answers
  "all monthly reports for tenant expo" or "everything from August".

Same-name resave → new version (prior file moved to `.versions/`, full history in the
index).

### 3a. AI decides the *meaning*, a policy decides the *path*
The model that just generated the report knows the tenant/type/period, so it supplies
**semantic metadata** — it does NOT freely choose folders/filenames (that breeds
`expo report.html` / `Expo_Monthly.html` inconsistency). Split of responsibility:
- **AI (at save time)** → calls `save_document({ type, title, properties:{tenant, period, …}, content, format })`.
- **App (deterministic, user-configurable placement policy)** → maps that metadata to a
  path via a **template**, e.g. `documents/{type}/{tenant}/{title}-{period}.{ext}`. The
  template is user-editable (configurability applies to naming, not just the root).
- **Fallback**: if the model omits metadata, a lightweight classification pass (reusing
  the forced-tool selector pattern) infers `type`/`tenant`/`period` from the prompt.

Result: every monthly report for every tenant lands in the same predictable place with
the same naming, the index is richly queryable, and the user controls the scheme.

### 4. Skills & tools *suggest and use* the output dir
- When a skill/tool produces a deliverable it saves to the output dir (or a
  skill-declared subfolder), **registers it in the index**, opens it in the existing
  **artifact panel**, and surfaces the **exact path + a Reveal-in-Finder link** —
  never a silent session folder.
- A skill's frontmatter can declare a suggested output subfolder (e.g. a monthly-
  report skill → `documents/reports/`), so related outputs cluster.
- Export-type tools (the evaluator flagged these) stream the package to the output
  dir and return only a one-line "saved to …" + link, instead of inlining 500 tokens.

### 5. A "DOCUMENTS" library tab (replace the placeholder)
The DOCUMENTS tab becomes the Files grid: searchable list of the project's documents
with Open (artifact panel), Reveal in Finder, **Provenance** (which chat/skill made
it), **Versions**, Rename, Download/Export, Delete. Mirrors Claude Code's Files view.

### 6. A built-in "document-manager" skill
A first-class skill that manages the library: organize/rename to a consistent scheme,
dedupe, find ("where's the NIST report from last week"), summarize the library,
apply retention (archive old drafts). It knows the output structure and the index, so
document housekeeping is itself an agent capability — which is what the user asked for.

## How the pieces connect
`working_dir` (code) + **output_dir** (deliverables) + `documents` index (metadata +
provenance) + artifact panel (view) + DOCUMENTS tab (library) + document-manager skill
(housekeeping). Generated docs are always: **saved somewhere findable, indexed,
traceable to what made them, versioned, and manageable** — the opposite of a junk
session folder.

## Decisions (2026-08-03)
1. **Default output location: `~/Documents/Agnostic Chat/<Project Name>/`** — per
   project, in the user's Documents (findable, never junks a repo). Per-project
   configurable (can be re-pointed, e.g. into a repo), settable in OVERVIEW.
2. **Organization: by topic/skill** — `documents/reports/`, `documents/investigations/`,
   `documents/compliance/`, etc. A skill declares its output subfolder (frontmatter);
   ad-hoc/general output falls to `documents/`. The DB index still provides
   search/filter across everything.
3. **Build order**:
   - **Phase 1 — Plumbing**: `output_dir` (schema + default resolver), a main-process
     file-write capability (save to `<output_dir>/documents/<topic>/`, versioned),
     `documents` index columns (`path`, `source`/provenance, `version`, `mime`), and
     an `artifacts.save` IPC skills/tools call (save → register → open in artifact
     panel → return path + Reveal). Expose a `save_document` tool to the model.
   - **Phase 2 — DOCUMENTS library tab**: searchable grid + Open / Reveal / Provenance
     / Versions / Rename / Delete.
   - **Phase 3 — document-manager skill**: organize, dedupe, find, retention.
