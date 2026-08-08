# Fluency Companion — conventions

The Fluency Companion design system. A restrained, information-dense SOC/MSSP
operator UI: a warm-grey canvas, a single crimson brand accent, and a compact
type scale. These are the **real, shipped** primitives from the Companion app.

## Setup — no provider, one stylesheet

There is **no theme provider, no context wrapper, and no props-based theming**.
Every component renders semantic HTML with fixed class names; all styling —
brand tokens, fonts, component looks — comes from the design system's
`styles.css` (already bound). Just render a component and it is styled. Load
`styles.css` once at the app root.

## Styling idiom — semantic classes + CSS variables (NOT utilities, NOT props)

This DS does **not** use utility classes (no Tailwind) and does **not** style
via props. It uses **hand-written semantic CSS classes** defined in `styles.css`,
and a small set of **CSS custom properties** on `:root` for color. Style your own
layout glue with those variables and the structural classes below — never invent
a utility vocabulary.

**Color tokens** (use as `var(--token)`):

| Token | Value | Use |
|---|---|---|
| `--brand` / `--brand-strong` / `--brand-soft` | `#b3242e` / `#8f1c24` / `#f8e8eb` | primary crimson; hover; tint |
| `--ink` / `--muted` / `--micro` | `#1f2428` / `#5a5f64` / `#8a857c` | body / secondary / faint text |
| `--bg` / `--panel` / `--panel-soft` | `#f6f5f2` / `#fff` / `#faf9f6` | canvas / card / inset |
| `--line` / `--line-soft` | `#e6e2db` / `#edeae4` | borders / hairlines |
| `--blue` / `--green` | `#2f73b7` / `#2e9e5b` | data accent / positive |

**Structural classes** (in `styles.css`): `.shell` (240px sidebar + content
grid), `.sidebar`, `.card` (white panel, hairline border), `.page-head` +
`.lede` (page title block — or use the `Header` component), `.section-label`
(small uppercased divider), `.button-link` (crimson primary action), `.empty`
(muted placeholder), `.error` (red error panel).

**Fonts**: body/UI is `"Companion Sans"` (resolves to IBM Plex Sans / Inter /
system sans via `local()`); code and IDs are `"IBM Plex Mono"` (shipped).

## Where the truth lives

- **`styles.css`** — the full class vocabulary and the `:root` token block. Read
  it before styling anything custom.
- **`<Name>.d.ts`** — each component's prop contract. **`<Name>.prompt.md`** — usage.

## One idiomatic composition

```jsx
import { Header, FacetGroup, Pager } from 'fluency-companion';

function NotableEvents() {
  return (
    <div className="card" style={{ padding: 20 }}>
      <Header eyebrow="Notable events" title="Behavior review">
        Highest-risk identity behaviors for this tenant.
      </Header>
      <div className="section-label" style={{ color: 'var(--micro)' }}>Filters</div>
      <FacetGroup label="status" buckets={[{ key: 'open', doc_count: 128 }]} selected={['open']} onToggle={() => {}} />
      <Pager curPage={0} pageCount={14} rangeStart={1} rangeEnd={25} totalShown={342} onPrev={() => {}} onNext={() => {}} />
    </div>
  );
}
```

The components carry their own class names; your job is layout glue with
`.card` / `.section-label` and `var(--*)` tokens — no utility classes.

# FluencyCompanion (fluency-companion@0.0.0)

This design system is the published fluency-companion React library, bundled as a single
browser global. All 10 components are the real upstream code.

## Where things are

- `_ds_bundle.js` — the whole-DS bundle at the project root; loads every component to `window.FluencyCompanion`. First line is a `/* @ds-bundle: … */` metadata header.
- `styles.css` — the single stylesheet entry: it `@import`s the tokens, fonts, and component styles (`_ds_bundle.css`). Link this one file.
- `components/<group>/<Name>/<Name>.prompt.md` (example JSX + variants), `<Name>.d.ts` (types), `<Name>.html` (variant grid).
- `tokens/*.css` — CSS custom properties, names verbatim from upstream.
- `fonts/` — `@font-face` files + `fonts.css` (when the package ships fonts).

For a specific component, `read_file("components/<group>/<Name>/<Name>.prompt.md")`.

## Loading

Add these two lines to your page once (React must be on the page first):

```html
<link rel="stylesheet" href="styles.css">
<script src="_ds_bundle.js"></script>
```

Components are then available at `window.FluencyCompanion.*`. Mount into a dedicated child node (e.g. `<div id="ds-root">`), not the host page's own React root, so the two trees don't collide:

```jsx
const { ChartAxes } = window.FluencyCompanion;
ReactDOM.createRoot(document.getElementById('ds-root')).render(<ChartAxes />);
```

## Tokens

15 CSS custom properties from fluency-companion. Names are
preserved verbatim from upstream. They are declared inside `_ds_bundle.css` (this DS ships one compiled stylesheet rather than separate token files).

- **other** (15): `--brand`, `--brand-strong`, `--brand-soft`, …

## Components

### general
- `ChartAxes`
- `ColumnsMenu`
- `DataSourceManageLink`
- `ErrorBox`
- `FacetGroup`
- `Header`
- `JsonLine`
- `Loading`
- `Pager`
- `SlideOver`
