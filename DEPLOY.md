# Deploying the metro rail story

Final address: **https://campaign.thedailystar.net/metro-rail-story/**

The route is: **GitHub** (source code) → **Vercel** (builds and previews it) → **The Daily Star server** (hosts the finished files).

---

## 0. Before anything: a Mapbox token for production

1. Sign in at https://account.mapbox.com/access-tokens/ and click **Create a token**.
2. Leave the default public scopes ticked.
3. Under **URL restrictions** add these origins, with no paths after them (browsers send only the origin to Mapbox):
   - `https://campaign.thedailystar.net`
   - `https://metro-rail-story.vercel.app` (or whatever domain Vercel gives the project)
   - `http://localhost:5173` (local development)
4. Copy the token. It starts with `pk.`.
5. Delete or rotate the old development token that was shared in chat.

This token is visible to anyone who opens the page. That is normal for web maps; the URL restriction is what stops other sites from using it.

---

## 1. GitHub (repository name: `metro-rail-story`)

### Upload

```
.env.example
.gitignore
DEPLOY.md
README.md
index.html
package.json
package-lock.json
tsconfig.json
tsconfig.node.json
vercel.json
vite.config.ts
api/                    (Vercel token endpoint)
data/source/mrt-network.kml
functions/              (Cloudflare adapter, harmless elsewhere)
public/                 (share image, icons, robots.txt, sitemap.xml, llms.txt, _headers)
scripts/                (builds the map data from the KML)
server/                 (Node server + token endpoint logic)
src/                    (all story code, styles and data)
```

### Do NOT upload

| Path | Why |
| --- | --- |
| `node_modules/` | 125 MB of downloaded packages; recreated by `npm install` |
| `dist/` | build output; Vercel and the developer rebuild it |
| `.env.local` | contains the Mapbox token |
| `.claude/` | local editor settings |
| `data/source/*.docx` | optional: the storyline and station documents are not used by the build. Leave them out if the repository is public. |

The `.gitignore` file already excludes everything in that table except the `.docx` files. If you upload through GitHub's website instead of git, drag in only the items in the "Upload" list.

---

## 2. Vercel

1. **Add New > Project**, import the `metro-rail-story` repository. Vercel reads `vercel.json`: build command `npm run build`, output `dist`.
2. **Settings > Environment Variables**, add:
   - `VITE_MAPBOX_PUBLIC_TOKEN` = the `pk.` token from step 0 (all environments)
3. Deploy. If you add or change the variable after a deploy, use **Redeploy**: it is compiled in at build time.
4. Check the preview: loading screen, map, scrolling, the network panel, share preview (paste the URL into https://www.opengraph.xyz/).

---

## 3. The Daily Star server

The server only needs the **built files**: plain HTML, CSS, JavaScript, fonts and images. No Node.js is needed on the server.

### How the developer gets the built files

The GitHub zip contains source code, which does not run as-is. Build it once (Node.js 20 or newer):

```bash
npm ci
```

Create a file named `.env.local` in the project folder containing:

```
VITE_MAPBOX_PUBLIC_TOKEN=pk.your_token_here
```

Then:

```bash
npm run build
```

This creates the `dist/` folder. (Alternatively, whoever already has the project set up runs the same build and sends a zip of `dist/`.)

> Without `VITE_MAPBOX_PUBLIC_TOKEN` in the build, the story text still works on the Daily Star server but the map shows "could not load": static hosting has no `api/mapbox-token` endpoint to fall back on.

### Upload

Upload **the contents of `dist/`** (not the `dist` folder itself) into the `metro-rail-story/` directory, so that `index.html` sits at `https://campaign.thedailystar.net/metro-rail-story/index.html`:

```
metro-rail-story/
  index.html
  assets/                  (all hashed JS, CSS, fonts, logo)
  og-image.png
  apple-touch-icon.png
  publisher-logo.png
  robots.txt
  sitemap.xml
  llms.txt
  _headers                 (only used by Cloudflare; harmless, can be skipped)
```

### Do NOT upload to the Daily Star server

`src/`, `node_modules/`, `api/`, `functions/`, `server/`, `scripts/`, `data/`, `public/` (its files are already copied into `dist/`), `package.json`, `package-lock.json`, `vite.config.ts`, `tsconfig*.json`, `vercel.json`, `.env*`, `README.md`, `DEPLOY.md`.

### Server settings for the developer (recommended)

- Serve `/metro-rail-story/` with `index.html` as the directory index.
- Enable gzip or brotli for `.js`, `.css`, `.html`, `.svg`, `.json`, `.txt`, `.xml`.
- Cache `metro-rail-story/assets/*` for a year (`Cache-Control: public, max-age=31536000, immutable`); file names change on every build, so this is safe. Keep `index.html` at `no-cache`.
- `.woff2` should be served as `font/woff2`, `.js` as `text/javascript`.
- If the server sends a Content-Security-Policy, it must allow `connect-src https://api.mapbox.com https://events.mapbox.com`, `worker-src 'self' blob:` and `img-src 'self' data: blob:` (see `server/security-headers.mjs`).

Nginx example:

```nginx
location /metro-rail-story/assets/ {
  add_header Cache-Control "public, max-age=31536000, immutable";
}
location = /metro-rail-story/index.html {
  add_header Cache-Control "no-cache";
}
```

Apache (`.htaccess` inside `metro-rail-story/`):

```apache
<IfModule mod_headers.c>
  <FilesMatch "\.(js|css|woff2|svg)$">
    Header set Cache-Control "public, max-age=31536000, immutable"
  </FilesMatch>
  <FilesMatch "index\.html$">
    Header set Cache-Control "no-cache"
  </FilesMatch>
</IfModule>
<IfModule mod_deflate.c>
  AddOutputFilterByType DEFLATE text/html text/css text/javascript application/javascript image/svg+xml application/json text/plain application/xml
</IfModule>
```

---

## 4. After launch

- Submit `https://campaign.thedailystar.net/metro-rail-story/sitemap.xml` in Google Search Console (and Bing Webmaster Tools).
- Test rich results: https://search.google.com/test/rich-results
- Test the share card: https://developers.facebook.com/tools/debug/ (also refreshes Facebook's cached preview) and https://www.opengraph.xyz/ for X, LinkedIn and WhatsApp.
- If the publish date is not 17 September 2026, update `datePublished`, `dateModified`, `article:published_time` and `article:modified_time` in `index.html`, and `lastmod` in `public/sitemap.xml`, then rebuild.
- Every time the story changes: push to GitHub (Vercel rebuilds), run `npm run build` again, and re-upload the contents of `dist/`. Delete the old `assets/` folder on the server first so stale files do not pile up.
