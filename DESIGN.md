# NAI Blue Design System

This file is the visual contract for `src/styles/globals.css`, `tailwind.config.js`,
the shared primitives in `src/components/ui`, and every workspace surface. Add a
token here before introducing a new visual value in source. Android platform
behavior remains owned by `src/platform/*`; this contract only defines how those
capabilities are presented.

## 1. Atmosphere / Signature

**Cobalt Editorial Instrument** is a matte ink-blue image-production workspace. Boundaries
disappear into three deliberate tones (`background -> canvas -> card`) so prompts
and generated images remain the visual priority. One restrained cobalt marks
selection, focus, and the next meaningful action. Borders are reserved for form
fields, focus treatment, and data-row dividers; decorative cards, glow, blur, and
gradient chrome are absent. The Guided welcome surface is the sole exception: it
may use one low-opacity cobalt ambient gradient behind content. Text, controls,
cards, and every Advanced surface remain flat. `DESIGN_VARIANCE = 3`,
`MOTION_INTENSITY = 2`, and `VISUAL_DENSITY = 6`.

## 2. Color

### Shared workspaces, September 2026

The asset workbench palette is the shared semantic palette in `globals.css`,
including portalled dialogs and direct entry into every category. Route changes
must never switch palettes. The existing theme store remains authoritative.
The central folder title and adjacent next action form one visual focus; navigation
and settings have lower contrast. Settings open on demand to preserve image space.
Background lightness is restrained in both themes, with enough blue chroma to avoid
a gray haze. The gallery uses an opaque canvas beneath lighter cards, retaining
clear surface separation without blur or decorative shadows. Native controls use
the matching `color-scheme`. All color declarations consume OKLCH channel tokens.

| Semantic tokens | Light channels | Dark channels |
| --- | --- | --- |
| background | `0.945 0.014 265` | `0.225 0.037 265` |
| canvas | `0.915 0.021 265` | `0.195 0.032 265` |
| card, popover | `0.975 0.007 265` | `0.270 0.044 265` |
| foreground, card-foreground, popover-foreground | `0.255 0.045 265` | `0.950 0.008 265` |
| primary, ring | `0.505 0.195 264` | `0.700 0.155 264` |
| primary-foreground | `0.985 0.004 265` | `0.170 0.038 265` |
| secondary, muted | `0.895 0.025 265` | `0.300 0.045 265` |
| secondary-foreground | `0.330 0.045 265` | `0.915 0.014 265` |
| muted-foreground | `0.475 0.035 265` | `0.750 0.030 265` |
| accent | `0.875 0.050 265` | `0.315 0.077 264` |
| accent-foreground | `0.345 0.130 264` | `0.895 0.050 264` |
| border | `0.820 0.025 265` | `0.380 0.041 265` |
| input | `0.735 0.035 265` | `0.475 0.047 265` |

Shared category type: title `36px/1.2` desktop and `30px/1.2` mobile; section
heading `22px/1.4`; navigation, controls and descriptions `16px/1.5`; quiet
metadata `14px/1.5`. Controls have at least a 44px target. A 248px folder rail
docks from 1024px; below that width a labelled folder button opens the same tree.
Main content uses a shared 32px inset (16px mobile). Grid cards have at least
208px width, 16px gaps, 4px corners, and uncropped 4:5 preview space. Mobile uses
one column below 480px. No extra bright badges, decorative gradients, or shadowed
card stacks. The primary button is the only filled accent action in a work area.

All CSS values are OKLCH channels consumed as `oklch(var(--token) / alpha)`.
`--brand-core: 0.316 0.1719 263.65` is the requested anchor. Interactive primary
tokens move lighter in dark mode so text, icons, and focus states remain legible.

Status colors (`success`, `warning`, `destructive`, `info`), scrim, charts and
Guided welcome ambient tokens retain their definitions in `globals.css`.
`--radius-control = 4px`; docked panels have no radius. The category shell uses
16px body/control text and 14px metadata; user-selected prompt text sizes remain
owned by the prompt editor.

Charts use `--chart-1` through `--chart-5`; their OKLCH values are defined in
`globals.css`. No raw hex, named Tailwind hue, or feature-specific accent may be
introduced in edited components. Functional image overlays may use the scrim
token with alpha.

## 3. Typography

- Sans stack: `Pretendard Variable`, `Pretendard`, `Noto Sans KR`,
  `Apple SD Gothic Neo`, `Malgun Gothic`, `system-ui`, `sans-serif`. Pretendard is
  deliberate for mixed Korean, English, and numeric production data; Inter and
  Roboto are not defaults.
- Mono stack: `JetBrains Mono`, `D2Coding`, `Consolas`, `monospace`, reserved for
  seeds, balances, paths, dimensions, and job timing.
- Category page title: mobile `30px / 700 / 1.2`; desktop `36px / 700 / 1.2`.
- Guided display: `clamp(32px, 4vw, 56px) / 700 / 1.08`, `-0.035em` tracking.
- Guided question: mobile `26–30px`; desktop `30–36px`; at most `32ch`.
- Category section title: `22px / 600 / 1.4`.
- Category control/body: `16px / 450 / 1.5`.
- Label: `12px / 550 / 1.35`.
- Metadata: `11px / 500 / 1.35`; never use below `11px`.
- Prompt text: user-configurable `12–24px`; shell default `14px / 400 / 1.5`.
- Letter spacing is normal. Uppercase tracking is reserved for machine metadata,
  not headings.

## 4. Spacing and Responsive Structure

The base unit is `4px`, with the main layout rhythm aligned to an `8px` grid.
Allowed rhythm tokens are `4, 8, 12, 16, 20, 24, 32, 40, 44, 48, 64px`; `1px`
is allowed only for borders. Tailwind equivalents are `1, 2, 3, 4, 5, 6, 8,
10, 11, 12, 16`, backed by `--space-1` through `--space-12` where defined.

- `--touch-target = 44px`; every coarse-pointer action uses at least this hit box.
- Shell inset: `8px` at 390, `12px` from 640, plus Android
  `env(safe-area-inset-*)` at the outer shell and fixed overlays.
- Shell gap: `8px` mobile, `12px` desktop.
- Guided content max: `72rem`; question max: `45rem`; review max: `57.5rem`.
- Guided activity rail: `22rem`, docked only from an `80rem` shell width;
  otherwise it becomes a Sheet so the question surface never clips.
- Control padding: `8px 12px`; dense icon controls keep a 44px hit box and a
  `16–20px` icon.
- Panel padding: `20px` standard, `24px` dialog/desktop settings. Dense `12px`
  padding is reserved for repeated data rows, not shell-level panels.
- Section rhythm: `32px` between major regions. Related controls may use `8px`
  or `12px` internal gaps.
- Below `640px`: two primary destinations, labelled Tools menu and theme toggle.
  Prompt and History remain named menu actions. No horizontal navigation scroll.
- `640–1535px`: center workspace remains primary; Prompt opens as a non-modal,
  horizontally resizable panel without a scrim, while History remains a sheet.
- `1536px+`: Prompt is a persistent left rail on Main and Scene. History opens on demand in a sheet.
- Scene grids render one column below `640px`, at most two below `1024px`, and
  honor the stored column preference on desktop.
- Fixed overlays never cover system bars. Text, toolbars, and pages must not
  create horizontal page scrolling at 390, 768, or 1280px.

## 5. Components and Information Architecture

- **Workspace shell:** every category shares the workbench header: Create images,
  Job history, Tools and theme. Tools lists named specialist destinations and
  marks the active route. Prompt and History remain directly available on
  desktop authoring screens and in the labelled Tools menu at compact widths.
  Prompt docks only for Main/Scene at 1536px; utility categories do not mount
  unrelated authoring/history rails. The header spans the whole viewport.
- **Category rhythm:** title, one short next-step description, then the task.
  Use 32px horizontal insets (16px mobile), 24px heading separation, and flat
  canvas/card tones. `workspace.css` owns this shared geometry; page classes
  are explicit so image canvases and user-sized prompt editors stay independent.
- **Progressive disclosure:** initial views expose the frequent next action;
  labelled disclosures contain execution policies, capability summaries and
  comparison statistics. Active progress, errors, cancellation and consent stay
  visible. Empty Queue links to the workbench; empty Style Lab links to artist
  preparation. Mobile Style Lab uses a labelled selector for all eight sections.
  Reference: [NN/g, Progressive Disclosure](https://www.nngroup.com/articles/progressive-disclosure/),
  consulted 2026-09-09. Local browser checks verify layout and navigation, not
  real-user usability or native Provider/storage operation.
- **Buttons:** control radius `4px`. Primary is a flat `--primary` fill; hover
  changes tone, active uses a slight opacity/transform response, focus uses a
  2px `--ring`, and disabled retains its footprint at 45% opacity. No gradient.
- **Checkbox choices:** use a 24px control with a 2px visible unchecked boundary.
  Permission, consent and selection rows have a 56px minimum height, 12px gap
  between control and copy, and 8px between repeated permission rows. The whole
  label is clickable; adjacent actions remain outside it. Titles use 16px,
  short scope descriptions 14px. Existing larger Guided rows keep their spacing.
  `choices.css` owns the shared row styling, including portalled dialogs. Native
  checkboxes retain input semantics and use system appearance in forced colors.
  Never shorten away permission scope, data destinations, costs or destructive
  conditions. Separate execution mode, edit permissions and upload permissions;
  show two columns only when the form itself is at least 880px wide.
- **Inputs/selects/textareas:** `4px` radius, input border, canvas/card surface,
  44px touch height on coarse pointers, blue focus ring, readable disabled state.
- **Panels:** page, panel, section, and repeated settings-group radius is `0`.
  Popovers and dialogs may use up to `8px`; repeated rows use dividers or tonal
  fills, not cards inside cards.
- **Sheets:** full viewport width below `640px`, bounded to `420px` for Prompt and
  `400px` for History above it. Close target is 44px, title/header reserves its
  space, and content respects top/bottom safe areas.
- **MainMode:** current result/canvas owns the view. Prompt, model, resolution,
  seed, and token state stay in the authoring surface. One bottom action rail owns
  generate/cancel at every width; the Prompt surface never duplicates that CTA.
- **SceneMode:** title and critical create/edit controls stay visible. Import,
  rotation, queue, export, and sharing remain reachable in grouped overflow
  menus on compact widths. The preset/view row wraps without horizontal scroll.
- **Settings:** desktop uses a sticky section rail and broad content column.
  Mobile uses one section select at the top; every section remains reachable.
- **History:** empty/loading/error states occupy the panel without ornamental
  rings. Sheet view uses a two-column thumbnail grid when space allows; docked
  view may use one column. Thumbnail cells rest without borders or shadows;
  image actions appear as a tonal overlay on hover or keyboard focus.
- **Prompt command surface:** Base, Additional, Detail, and Negative remain
  directly reachable as slots in one editor. Only the selected slot exposes its
  textarea. Import actions and prompt tools each use one disclosure; Character,
  image reference, and detailed settings form the quiet three-action rail below.
  Four equal collapsible cards are prohibited.
- **Startup rescue:** database-unavailable startup renders one bounded alert panel
  without workspace navigation or generation/edit/save entry points. Retry,
  diagnostic export, backup guidance, and safe exit remain direct native-button
  actions with 44px touch targets and visible keyboard focus.
- **Icons:** Lucide only except existing product logos. Every icon-only action has
  an accessible name and tooltip where hover exists.
- **Guided shell:** one question owns the reading order. Choice rows use a 1px
  separator, `88–112px` height, one monochrome icon, one short description, and
  one arrow. They are rows, not a grid of ornamental cards. Low-risk reversible
  answers may advance after `250–350ms`; model, credential, cost, storage,
  metadata, public-access, overwrite, and destructive choices require an
  explicit Continue action. Branching paths show `Step n · label` until the
  active path length is stable. Review uses a definition list and hairlines at
  up to `57.5rem`, not nested cards.

### Composition workspace contract

- **Composition action rail:** Generate/cancel is the only unconditional filled
  action and Main places it below the canvas. Settings summary, estimated cost,
  image count, and the CTA stay in a single non-wrapping grid; narrower widths
  collapse settings to one button instead of creating a second row. Module Stack
  and actual generation values appear only when backing data exists.
  Generate/cancel is never placed in an overflow menu.
- **Module Stack row anatomy:** Each fixed-height row has enable state, an
  unabridged accessible module name, visible kind/summary, validation state,
  edit entry, and ordering affordances. The visual name may truncate to protect
  the canvas, but its `title`/accessible name preserves long Korean, English, and
  Japanese values. Reordering always supports `Alt+Arrow` and explicit up/down
  actions; drag may supplement but never replace those controls.
- **Inspector and sheet behavior:** The Context Inspector shows selection identity,
  recipe context, typed controls, override diff, validation, and conflict status.
  Pages may use a right rail when width permits; Main and Scene use the explicit
  Inspector sheet because the persistent Prompt rail owns the desktop authoring
  space. Main Inspector is a second-level sheet opened by selecting a module;
  another workflow may expose a direct trigger only when it has inspector context.
  Sheets trap focus, close with Escape, restore focus to the launch control, use
  44px close targets, and apply all four `env(safe-area-inset-*)` values.
- **Resolved Plan:** When a plan, issue, or external conflict exists, Resolved Plan
  is one action away on desktop and one dock tap away on mobile. Its dedicated
  surface groups positive/negative prompts, prompt
  slots, characters and positions, winning parameter sources, output policy,
  warnings/errors, random trace, provenance, and plan hash. Dense sections may
  collapse; blocking errors and repair actions remain first in reading order.
- **Conflict severity:** Warnings use `--warning` and preserve generation when the
  domain says they are non-blocking. Errors and stale/external revision conflicts
  use `--destructive`, `role="alert"`, and block unsafe commits or generation.
  Color never carries severity alone; every state includes an icon and text.
- **Long text:** Module names, recipe names, paths, prompt text, hashes, and error
  messages must stay inside `min-width: 0` regions. Human text wraps; machine IDs
  and paths use `break-all`. Truncation is allowed only when the full value remains
  available through an accessible name, adjacent detail, or `title`. The contract
  holds at 200% text zoom without page-level horizontal scrolling.
- **Virtualization:** Module collections use a measured viewport, fixed row
  anatomy, bounded overscan, and an end-exclusive visible range once lists can
  grow into the hundreds. Filtering or external edits clamp stale scroll ranges.
  Virtual rows preserve list/listbox semantics, stable IDs, keyboard focus, and
  total scroll height for at least 500 modules.
- **Mobile command dock:** Below `768px`, the canvas or Scene grid remains primary
  above a fixed safe-area-aware dock. Generate/Cancel is always direct; Modules,
  Inspector, and Resolved Plan occupy buttons only when the owning workflow
  supplies an applicable action. Every icon has an accessible name. The dock never
  copies generation rules, never hides the active Cancel action, and the workspace
  reserves its height plus `env(safe-area-inset-bottom)` so content is not covered.

## 6. Motion

- Fast feedback: `120ms`; standard state transition: `180ms`; overlays: `240ms`.
- Easing: `cubic-bezier(0.2, 0, 0, 1)` for entrances and standard ease-out for
  color changes.
- Animate only `transform`, `opacity`, or `filter`. Width progress is the sole
  functional exception because it communicates streamed generation progress.
- Navigation may use one shared Framer Motion indicator with low bounce and
  `180–240ms` duration.
- `prefers-reduced-motion: reduce` removes transforms, animated scrolling, pulse,
  ping, and spinners beyond the minimum state indication.
- `--welcome-ambient` is allowed only behind the Guided welcome route. It uses
  pseudo-elements animated through `transform` and `opacity`: the main plane
  moves over `16–22s`, while the secondary light breathes over `8–12s`.
  Background-position animation, blur, glow, gradient text, and gradients inside
  cards or controls remain prohibited. Reduced motion freezes both layers.

## 7. Depth

Depth is tonal-first and borders are exceptional.

- Region separation uses only `--background`, `--canvas`, and `--card`.
- A 1px border is allowed on input, textarea, select, table-row dividers, and
  focus-ring offsets. Panels, cards, grid cells, and buttons do not use borders.
- One shadow token, `--shadow-overlay`, is allowed only on popovers, dialogs,
  sheets, and functional drag overlays. Panels, thumbnails, and buttons have no
  shadow.
- Hover and active states change tone with `--accent` instead of drawing an edge.
- No glow, glassmorphism, persistent backdrop blur, or decorative shadow ladder.

## Do / Do Not

- Do keep blue to active, focus, link, progress, and primary-action semantics.
- Do separate regions and actions through tone, typography, and whitespace.
- Do preserve Android gates, safe areas, storage adapters, and every command.
- Do not use panel borders, cards inside cards, thumbnail shadows, decorative
  pills, persistent glassmorphism, four or more peer collapsibles, oversized
  empty-state art, or hidden functionality.
- Do not solve responsive failures with page-level horizontal scrolling.

## 8. Platform capability and data-scale contract

- Desktop and Android consume the same Composition document. Platform-only actions are represented by a capability adapter; shared UI does not infer support from viewport width.
- An unsupported capability stays visible with a capability badge, a concrete reason, and a safe alternative workflow. Disabled controls must not silently fall back to a different output path or operation.
- Asset Module Studio exposes external profile watching, local tagger sidecar, and R2 deploy capabilities on the canonical v2 surface as well as compatibility tools.
- Repairable resolved-plan issues keep their `actionId` and stable entity reference. The repair action opens the canonical repository editor before generation.
- Module lists window 500 rows, character layout editors window 200 rows, and Scene grids window 1,000 items using deterministic overscanned ranges. A 20,000-character prompt remains complete and wraps inside its intentional editor/plan scroll region.
- Virtualized rows retain keyboard focus styling, accessible names, 44px coarse-pointer controls, and explicit Up/Down controls as the non-drag ordering path.
