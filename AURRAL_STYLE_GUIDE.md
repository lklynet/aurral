## Aurral UI Style Guide

### Design principles

- **Minimal and focused**: The interface is mostly black, white, and grayscale. Visual hierarchy comes from layout, typography, and subtle opacity changes instead of decoration.
- **Content first**: Artwork, titles, and metadata should always be the most visually prominent elements on screen.
- **Clarity and calm**: Avoid noisy visuals (no gradients, borders, or shadows). Use large tap targets, consistent spacing, and simple layouts.
- **Consistent motion**: Use small, purposeful transitions (opacity, background-color, and scale) and keep them fast.
- **Device ready**: Design for a full-bleed black app background with black gutters, working cleanly on desktop and touch devices.

### Foundations

#### Color system

All colors must be referenced through CSS custom properties (defined in `frontend/src/index.css`), never hard-coded in components.

- **Background**
  - **`--aurral-black` `#000000`**: App background and gutters. Use on `body`, `app-shell`, and mobile nav background.
- **Surfaces**
  - **`--aurral-surface` `#121212`**: Primary content surface (e.g. `app-main`, primary cards, large panels).
  - **`--aurral-surface-mid` `#212121`**: Elevated content and emphasis surfaces (hero strips, sticky action bars, nested panels, rails, modals, menus).
  - **`--aurral-overlay` `#000000`**: Overlays behind full-screen elements (e.g. page-level backdrops).
  - **`--aurral-overlay-hover` `#212121`**: Legacy hover color for overlay items (avoid in new work; prefer `--aurral-gray`).
- **Text**
  - **`--aurral-white` `#ffffff`**: Primary text on dark backgrounds.
  - **`--aurral-gray-light` `#b3b3b3`**: Secondary text, metadata, helper copy, and icons.
  - **`--aurral-gray` `#535353`**: Tertiary text, de-emphasis, and neutral surfaces.
- **Brand and status**
  - **`--aurral-green` `#84cc16`**: Brand color. Use extremely sparingly:
    - Primary “play” or “confirm” actions.
    - Positive status indicators and progress.
    - Rare accent text (e.g. artist eyebrow text).
  - **`--aurral-danger` `#f87171`**: Destructive actions and error text.
  - **`--aurral-warning` `#c8b491`**: Warning or incomplete status.
  - **`--aurral-focus` `rgba(132, 204, 22, 0.42)`**: Focus ring / outline color.

#### Tag color system

Artist and genre tags are colored using a fixed palette and a deterministic mapping so the same tag always receives the same color:

```js
const TAG_COLORS = [
  "#845336",
  "#57553c",
  "#a17e3e",
  "#43454f",
  "#604848",
  "#5c6652",
  "#a18b62",
  "#8c4f4a",
  "#898471",
  "#c8b491",
  "#65788f",
  "#755e4a",
  "#718062",
  "#bc9d66",
];
```

- **Usage**
  - Tag backgrounds (e.g. `artist-tag`, artist “About” chips) use `getTagColor(tagName)` from the utilities, which indexes into `TAG_COLORS`.
  - Tag text remains white for contrast.
  - Avoid using `--aurral-green` for general tag coloring.

#### Typography

- **Font family**: `--font-sans: "DM Sans", ui-sans-serif, system-ui, sans-serif;`
- **Base text**
  - Body copy: 0.875rem–1rem.
  - Secondary/meta text (`artist-meta-line`, `artist-count`, `artist-subtext`): 0.75rem with `--aurral-gray-light`.
- **Headings**
  - Page titles (e.g. `artist-hero__title`): clamp between 3rem and 6rem, heavy weight (900).
  - Section titles (`artist-section-title`): ~1.5rem, 800 weight.
  - Large section titles (`artist-section-title--large`): ~1.875rem, 900 weight.
- **Numbers**
  - Use tabular numerals for durations and counts (`font-variant-numeric: tabular-nums`) as in `artist-track-duration`.

#### Radius rules

Use the radius tokens consistently:

- **`--aurral-radius` (20px)**: Default radius for all surfaces and containers:
  - Cards, panels, app main shell, hero cards, about cards, rails, modals, large media cells.
- **`--aurral-radius-sm` (15px)**: Compact containers and controls that are list items or chips:
  - Tabs, segmented controls, list rows, small menus, tag pills.
- **`--aurral-radius-round` (9999px)**: All action items (buttons) and circular elements:
  - Primary and secondary buttons, icon buttons, segmented pills, scrollbar thumbs, nav pills, round “play” buttons, status dots, rating badges.

**Rule:** If it is a clickable action (button, pill, icon button, segmented control), use `--aurral-radius-round`. If it is a surface (card, panel, rail, modal, hero) use `--aurral-radius`. Use `--aurral-radius-sm` only for nested list items or small menu items.

#### Spacing & layout

- **Global**
  - `body` and `app-shell` sit on `--aurral-black` with no gradients.
  - `app-content` has 0.5rem outer padding; `app-main-wrap` centers content up to 1600px, with `--aurral-radius` and `--aurral-surface` background.
  - `app-main` handles vertical scrolling with hidden scrollbars on desktop.
- **Gutters and padding**
  - Primary page padding in `app-main`: 1rem on small screens, 2–2.5rem on larger breakpoints.
  - Artist sections (`artist-section`) are spaced by 2.5rem vertically.
  - Grids (`artist-release-grid`, `artist-albums-grid`) use consistent gaps: ~1.25rem between columns and ~0.75–1.25rem between rows.
- **Responsive**
  - Mobile: 2-column grids, stacked sections, mobile nav pinned to bottom over black background.
  - Small desktop: 3-column album grids.
  - Large desktop: 6-column album grids, multi-column layouts for pick panels and preview/video layouts.

### Visual constraints

- **No gradients**: Backgrounds are always solid colors. Overlays use solid rgba blacks (e.g. hero washes, modals backdrops).
- **No borders**: Do not introduce borders for separation or emphasis. Use spacing, background changes, and typography instead.
  - Existing one-off borders (e.g. outlines around selected items) are considered legacy and should be migrated to borderless patterns over time.
- **No shadows**: Avoid `box-shadow` for elevation. Use:
  - Darker/lighter surface tokens (`--aurral-surface` vs `--aurral-surface-mid`).
  - Slight opacity changes on hover.
- **Minimal color usage**
  - Pages should read as almost monochrome; reserve `--aurral-green` for the main action and key status indicators only.

### Interaction & states

#### Buttons and actions

- **Shape**
  - All buttons and primary action controls use `--aurral-radius-round`.
  - Circular buttons (`artist-round-button`, icon-only actions) should be square in size with `clip-path: circle(...)` where needed.
- **Primary actions**
  - Background: `--aurral-green`.
  - Text: black.
  - Use for the highest-priority action only (e.g. main play, main confirm).
- **Neutral / secondary actions**
  - Background: `--aurral-gray` or `--aurral-surface-mid`.
  - Text: white.
  - Used for library actions (“In Library”, “Refresh”) and icon buttons.
- **Destructive actions**
  - Use `--aurral-danger` for text or icons; backgrounds remain neutral dark surfaces.
- **Hover / active**
  - Change background color and text color (e.g. to `--aurral-gray-light` on dark background).
  - Optional small scale down on press (`transform: scale(0.95)`), no shadows.
- **Disabled**
  - Lower opacity (~0.5) and remove hover/active changes.

#### Focus

- Use `--aurral-focus` for focus outlines or rings.
- Focus styles should be clearly visible on all actionable components (buttons, inputs, links, menu items).
- Do not rely solely on color changes for focus; maintain a visible ring or outline where appropriate.

#### Loading, empty, and error

- **Loading**
  - Use `Loader` icon with `animate-spin` and sizes defined in `artist-spinner` / `artist-spinner--large`.
  - Center loading states within panels using `artist-loading`.
- **Error**
  - Use `artist-error-panel` with `--aurral-surface-mid` background and `--aurral-danger` for important error text.
- **Empty**
  - Use `artist-empty-panel` / `artist-empty-message` with subtle gray copy; keep layout consistent with populated state.

### Component patterns

#### Hero & meta

- **Artist hero (`artist-hero`)**
  - Full-width strip at top of artist pages.
  - Background: cover image if available, otherwise `--aurral-surface-mid`, with a black wash overlay.
  - Title (`artist-hero__title`) is the largest text on the page.
  - Meta line (`artist-meta-line`) collects type, location, lifespan, release count, and library state.
- **Artist tags**
  - `artist-tag-list` and `artist-tag` use colored backgrounds from `getTagColor(tagName)` and white text.
  - Tags are interactive chips when used for navigation; otherwise they are static labels.

#### Tabs, segmented controls, and filters

- **Tabs (`artist-tab`)**
  - Small pill-shaped buttons with `--aurral-radius-sm`.
  - Default background: `--aurral-gray`; active: `--aurral-gray-light` with black text.
- **Segmented controls (`artist-segmented`, `artist-segmented-button`)**
  - Enclosed within a pill-shaped wrapper using `--aurral-radius-round`.
  - Active segment uses `--aurral-gray` background.
- **Counts and subcopy**
  - `artist-count` and `artist-subtext` use `--aurral-gray-light` with 0.75rem font size.

#### Cards, panels, and grids

- **Release cards (`artist-release-card`)**
  - Square cover (`artist-release-card__cover`) with `--aurral-radius` and `--aurral-surface-mid` background.
  - Title and metadata stacked below with clamp for 1–2 lines.
  - Optional metric row with star icon and small text.
- **Expanded panels (`artist-expanded-panel`, `artist-track-list`)**
  - Use `--aurral-surface-mid` background and `--aurral-radius`.
  - Track rows (`artist-track-row`) align number, controls, title, menu, and duration in a grid.
- **About card (`artist-about-card`)**
  - Large hero-like card with cover image, dark wash, big “About” text, rating badge, and bio.
- **Rail cards (library, similar artists)**
  - Use `--aurral-surface-mid`, `--aurral-radius`, and consistent widths in rails with hidden scrollbars.

#### Lists and rows

- **Release list items (`artist-release-list-item`)**
  - Small thumbnail, text stack, and actions aligned horizontally.
  - Hover: `--aurral-surface-mid` background with `--aurral-radius-sm`.
- **Track rows (`artist-track-row`, `artist-track-row--preview`)**
  - Use grid layout for number, play button, title/subtitle, playlist menu, and duration.
  - Preview progress uses a solid `--aurral-green` tinted overlay, not a gradient.

#### Modals and overlays

- **Backdrop (`artist-modal-backdrop`)**
  - Full-screen `rgba(0,0,0,0.75)` overlay with no border radius.
- **Modal (`artist-modal`)**
  - Background: `--aurral-surface-mid`.
  - Radius: `--aurral-radius`.
  - No borders or shadows; separation comes from the backdrop and surface color.
- **Context menus & popovers (`artist-dropdown`, `artist-options-menu`, `artist-floating-menu`, `artist-playlist-menu`)**
  - Base style matches `app-profile-menu__dropdown`: background `--aurral-surface-mid`, radius `--aurral-radius-sm`, no shadows.
  - Menu items (`artist-menu-item`, `app-profile-menu__item`):
    - Default text: `--aurral-gray-light`.
    - Hover background: `--aurral-gray`, hover text: `--aurral-white`.
    - Selected/active text (`.is-active`): `--aurral-green` on the same `--aurral-surface-mid` / `--aurral-gray` background.
  - Use tight padding, clear hit areas, and avoid gradients or borders for separation.

#### Media and playback

- **Artwork**
  - Always `object-fit: cover`.
  - Use `--aurral-surface-mid` or black as fallback backgrounds.
- **Preview playback**
  - Main play button: round button using brand green.
  - Track-level preview buttons use icon-only round buttons with neutral background.
  - Progress overlays are solid tinted bars with rounded corners, no gradients.
- **Video**
  - 16:9 aspect ratio for embedded top-song videos.
  - Radius: `--aurral-radius` on the video container.

### Accessibility

- **Contrast**
  - Maintain WCAG-compliant contrast using the defined palette (white or light gray on dark surfaces, dark text on light badges).
- **Focus visibility**
  - Ensure all interactive controls have visible focus when navigated via keyboard.
- **Hit targets**
  - Use generous touch targets: minimum of 40–44px for tap areas (buttons, icons, and rail items).
- **Motion**
  - Keep animations short and optional, using opacity and simple transforms rather than large movements.

### Implementation conventions

- **CSS and tokens**
  - New UI work should use the shared tokens defined in `frontend/src/index.css` (`--aurral-*` variables).
  - Prefer section-specific class prefixes (e.g. `artist-`, `app-`) for grouping related styles.
  - Avoid new Tailwind utility usage for layout/visuals; prefer local CSS classes aligned with this guide.
- **Border and shadow policy**
  - Do not introduce new `border`, `border-radius` values, gradients, or `box-shadow`s outside the tokens and rules defined here.
  - When migrating legacy components, replace borders/shadows with surface color changes and radius tokens.
- **Brand usage**
  - Before using `--aurral-green`, confirm it is the primary action on the screen or a critical status indicator; if not, prefer grayscale.

This document is the source of truth for Aurral UI decisions. All new pages and components should align with these foundations and patterns, and existing surfaces (like the Artist Details and Albums flows) should be treated as reference implementations during the transition away from Tailwind to fully local CSS.

