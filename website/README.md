# Chittr website

Public homepage for `https://chittr.dev`. The application's browser interface remains in `../web/`.

This is a static site with no runtime or build dependencies. `npm run build` copies only `index.html`, `styles.css`, `script.js`, and `assets/` into `dist/` for publication.

## Local preview

```sh
cd website
npm run check
npm run build
python3 -m http.server 8765 --directory dist
```

Open `http://localhost:8765/?instant` to see the completed hero transcript. Without `?instant`, the transcript animates unless the browser prefers reduced motion.

## Deployment

Cloudflare Pages builds this directory from GitHub. `main` is the production branch; other branches produce previews. Use the [deploy-website repo skill](../.agents/skills/deploy-website/SKILL.md) for deployment guidance.

## Editing

- Fonts load from Google Fonts with system fallbacks.
- Participant colours are CSS custom properties applied through `data-agent` attributes.
- The hero transcript is scripted in `script.js`.
- Light and dark palettes follow the browser preference or `data-theme="dark"` on the root element.
- The existing product links reference `github.com/chittr/chittr` and `@chittr/cli`. Update these when the public repository and package destinations are finalized.
