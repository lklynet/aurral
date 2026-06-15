# Aurral documentation

Static documentation site for [docs.aurral.org](https://docs.aurral.org), built with [Astro Starlight](https://starlight.astro.build/).

## Local development

```bash
cd docs
npm install
npm run dev
```

Open `http://localhost:4321`.

## Build

```bash
cd docs
npm run build
```

Output is written to `docs/dist/`.

## Cloudflare Pages

Create a second Cloudflare Pages project for `docs.aurral.org`:

| Setting | Value |
| --- | --- |
| Production branch | `main` |
| Root directory | `docs` |
| Build command | `npm install && npm run build` |
| Build output directory | `dist` |
| Node version | `20` or newer |

Add a custom domain:

1. In the Pages project, open **Custom domains**.
2. Add `docs.aurral.org`.
3. Create the CNAME Cloudflare shows (`docs` → `<project>.pages.dev`).

No framework preset is required. Starlight builds to static HTML in `dist/`, which Pages serves directly.

### Optional preview deployments

Connect the same repository and root directory. Cloudflare will build pull request previews automatically when enabled on the project.

## Content

Pages live in `src/content/docs/` as Markdown or MDX. Sidebar order is configured in `astro.config.mjs`.

Theme tokens in `src/styles/custom.css` match [aurral.org](https://aurral.org): dark background, DM Sans, JetBrains Mono, and Aurral green accents.

## Main site

The marketing site remains in [`../web`](../web) and deploys separately to [aurral.org](https://aurral.org). Link between them freely — the docs sidebar includes an **aurral.org** entry at the top.
