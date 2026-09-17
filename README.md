# Dhaka's Metro Lifeline and Its Ballooning Price Tag

A scroll-driven visual story for The Daily Star, told on top of a Mapbox map of Dhaka's six planned MRT lines.

Live URL: https://campaign.thedailystar.net/metro-rail-story/

Stack: Vite + TypeScript (no UI framework), mapbox-gl v3 (ESM build), self-hosted Newsreader and Libre Franklin fonts. No third-party runtime requests except Mapbox.

**Deploying? Read [DEPLOY.md](DEPLOY.md)**: what goes to GitHub, Vercel and The Daily Star server.

## Run it

```bash
npm install
npm run dev          # http://localhost:5173
```

```bash
npm run build        # regenerates map data, type-checks, builds dist/
npm start            # production server on PORT (default 8080)
```

For local development, `.env.local` holds the Mapbox token. That file is git-ignored. See `.env.example`.

## The Mapbox token

A browser always needs *some* token to load Mapbox tiles. The page resolves it in this order:

| Mode | Variable | What the browser receives |
| --- | --- | --- |
| **Static hosting (The Daily Star server)** | `VITE_MAPBOX_PUBLIC_TOKEN` at build time | A `pk.` token compiled into the bundle. No extra request, so the map starts fastest. Restrict it by URL in the Mapbox account to the origins that serve the story (`https://campaign.thedailystar.net`, your Vercel domain), without paths: browsers send only the origin to Mapbox. |
| Server (Vercel / Node), optional | `MAPBOX_SECRET_TOKEN` | Used only when no build-time token is set. `api/mapbox-token` mints a temporary `tk.` token that expires within an hour. |
| Local development | `MAPBOX_PUBLIC_TOKEN` | `api/mapbox-token` hands out this `pk.` token. |

The endpoint rejects cross-site callers unless they are listed in `ALLOWED_ORIGINS`.

**Rotate the current development token before launch.** It was shared in a chat, so treat it as exposed.

## Loading and performance

- `index.html` paints a loading screen on the first frame (inline CSS, no script needed). It draws the real network while the map loads, and lifts only once the map has fully rendered its first scene and the fonts are in. It never stays longer than 12 seconds; if the map is slower, the story shows and the map fades in when ready. A CSS-only failsafe hides it after 20 seconds even if scripts never run.
- The map code, mapbox's shared chunk and its worker are preloaded from `<head>` (see `preloadMap` in `vite.config.ts`), so they download in parallel with the entry script instead of one after another. Chrome may log "preloaded but not used" for the worker file; that is expected and harmless.
- The basemap's TileJSON is inlined in `src/map/basemap.ts`, saving a request before the first tile.
- `npm start` pre-compresses every asset (brotli and gzip) at startup.
- Older phones: `svh`/`lvh` units (Chrome 108+, Safari 15.4+) always follow a `vh` fallback, or the story's spacing collapses and the cards stack edge to edge. See the note above `.scrolly` in `main.css` before adding new ones.

## Reading and interaction

- Each scroll step fires as soon as its card peeks in at the bottom of the screen (`src/scroll/steps.ts`), in both directions.
- A line named in the text takes that line's map colour (`<span class="line-ref" data-line="1">`). Line 1's red is lifted slightly for text contrast (`--text-line-1`).
- The network explorer: on desktop, a tab on its edge slides it away to show the whole map. On phones and narrow windows it is a bottom sheet with the six lines in two rows of three (no sideways scrolling): drag the grip to resize, flick to minimise or expand, or use the chevron. Clicking a line or station on the map always brings the explorer back open with its details, even if it was minimised or slid away.
- The cards and the explorer sit above the afterword's fade-to-ink gradient, which only darkens the map as the story moves on.
- On the map, a plain scroll always scrolls the story. Ctrl + scroll (⌘ + scroll, or a trackpad pinch) zooms the map in the explorer; the +/- buttons, double-click and two-finger pinch work too.
- A back-to-top button appears once the reader has scrolled past the map.

## The cost chart

Between the timeline and the route game, two paragraphs lead into a dumbbell chart of four lines: each line's initial estimate (hollow dot) and revised cost (filled dot) on one shared scale, sorted by percentage change. It is plain HTML and CSS in `index.html` (every figure reads without JavaScript); `src/costs.ts` only animates the revised dots out from the estimates the first time the chart is seen, and `src/styles/costs.css` styles it. Each row's `--from` and `--to` are its two costs divided by 1,20,000, the top of the scale: update them together with the printed figures.

## The route game ("Pick a station")

After the timeline, readers pick a start and a destination (in the two station fields, or by tapping stations on a second map) and ride the finished network.

- **Routes** (`src/game/routes.ts`): every chain of up to four rides is enumerated, then pruned to trips a person would take: no station passed twice, no change at a station where an earlier or later line could have been boarded directly, and one option per sequence of lines (the shortest place to change). Lines running side by side (6 and 2 at Motijheel and Kamlapur, 2 and 4 to Signboard) keep only the option that can be ridden soonest. An extra change is only offered if it shortens the trip by 10%. At most three options are listed, fewest changes first, then shortest.
- **Lines still being planned** (2 and 4): trips on them have no date. The ride is drawn dashed, the caption says the line is "still on paper", and the result says the trip happens once the line "leaves the drawing board". If another route avoids those lines, the result card offers it with its date and plays it in one tap (`findDatedRoute` in `src/game/routes.ts`).
- **What the reader sees:** the same station twice gives "You can just walk"; one route plays at once; several are listed (hover or focus previews one on the map); no connection gives "No route exists" (every pair of stations is connected today, so this only guards against future data changes). Reset, or "Plan another trip" on the result card, starts over.
- **The ride** (`src/game/game-map.ts`): the camera is close on the platform, pulls back as the train gets going and closes in again on the interchange or destination, where a caption says which line to switch to. The ride pauses while the map is off screen or the tab is hidden, and "Skip ride" jumps to the end. The result names the latest completion deadline among the lines used.
- **Loading:** the game's map is a second Mapbox map, created only when the section comes within a screen of view (so it adds a map load only for readers who get that far). Its code is a small separate chunk; mapbox-gl itself is shared with the story map. Without WebGL or a token, the fields still work and the result card appears without the ride.

## Deploy targets

The token endpoint logic lives in `server/mapbox-token.mjs` (Web standard `Request`/`Response`) and runs unchanged on:

- **Static server (The Daily Star):** build with `VITE_MAPBOX_PUBLIC_TOKEN`, upload the contents of `dist/`. Relative asset paths, so it works from `/metro-rail-story/`.
- **Vercel:** `vercel.json` + `api/mapbox-token.js` (Edge runtime). Set the env variables in the project settings.
- **Any Node host / VPS / Docker:** `npm run build && npm start`. Serves `dist/` with brotli, long-lived caching for hashed assets, and the security headers in `server/security-headers.mjs`.
- **Cloudflare Pages:** `functions/api/mapbox-token.js` + `public/_headers`. Build command `npm run build`, output `dist`.

## SEO and sharing

- Canonical URL, description, robots directives, Open Graph, X/Twitter card and JSON-LD (`NewsArticle`, `WebPage`, `NewsMediaOrganization`, contributors) are written directly in `index.html`. **Update `datePublished` / `article:published_time` (currently 2026-09-17) if the story goes live on another date.**
- `public/og-image.png` (1200x630), `public/apple-touch-icon.png` and `public/publisher-logo.png` ship with the build.
- `public/sitemap.xml`, `public/robots.txt` and `public/llms.txt` (a plain summary for AI crawlers). Crawlers only read `robots.txt` at a domain root, so on campaign.thedailystar.net the site-wide file applies; submit `https://campaign.thedailystar.net/metro-rail-story/sitemap.xml` in Google Search Console.
- The full narrative is plain HTML, so crawlers that do not run JavaScript still read the whole story. The loading screen has no text in the DOM.

## What editors can safely change

| To change | Edit |
| --- | --- |
| Story copy, headline, timeline entries, footer credits | `index.html` |
| Share title, description and dates | `<head>` of `index.html` (meta tags and JSON-LD) |
| Numbers in the network explorer | `src/data/lines.ts` |
| What the map shows at each step (lines, labels, camera) | `src/story/steps.ts` |
| Turn camera moves or trains off | `src/config.ts` (`cameraMotion`, `trains`) |
| Cost chart figures | the `.costs` section of `index.html` (see "The cost chart" above) |
| Route game wording (prompts, captions, results) | `src/game/copy.ts` |
| Line completion deadlines used by the route game | `completion` in `src/data/lines.ts` (`'running'`, `'planning'` or a year and month; also `KAMLAPUR_OPENING`) |
| Line colours | `src/data/lines.ts`, `--line-*` and `--text-line-*` in `src/styles/main.css`, and the loading screen colours in `index.html` (the set was validated for colour-blind readers, so re-check if you change them) |

## Map data

`data/source/mrt-network.kml` is the hand-drawn source. `npm run data` (part of `npm run build`) turns it into `src/data/network.json`:

1. Parses station and line placemarks and works out which lines serve each station, so interchanges (Kamlapur, Karwan Bazar, Gabtoli, Mirpur 10, Notun Bazar, Motijheel, Aftabnagar, Signboard) become one shared station.
2. Snaps lines through their stations. The drawn lines stopped 30 to 80 m short of Kamlapur.
3. Eases lines that share an alignment (Motijheel to Kamlapur, Gabtoli to Technical, Signboard) into parallel tracks so neither colour hides the other.
4. Derives underground sections from the station lists in `MRT routes and stations names.docx`.

Station names follow the KML where the two documents differ. Mostul is tagged underground in the KML but sits on the elevated Purbachal alignment, so it is treated as elevated.

## Notes for the copy desk

These are in the storyline as supplied and were left unchanged unless noted:

- **Route costs** (from the editors' cost table; shown in the story, the timeline, the cost chart and the network explorer): Line 6 Tk 21,985.07 crore initial, Tk 32,717.72 crore revised (+48.82%). Line 1 Tk 52,561 / 1,20,794 / 1,14,394 crore (initial / revised / second revised; +117.64% overall). Line 5N Tk 41,238.54 / 93,190 / 89,848 crore (+117.87%). Line 5S Tk 54,619 crore initial, Tk 45,504 crore revised (-16.69%). Line 2 Tk 61,000 crore, Line 4 Tk 28,400 crore (initial). The figures add up: Lines 1 and 5N were approved at a combined Tk 93,800 crore, first revised to Tk 2,13,984 crore, and approved by ECNEC on September 16, 2026 at Tk 2,04,242 crore. Line 5S was approved the same day.
- **Line 5S:** 17.2 km and 17.4 km in consecutive sentences, and "The project will run from this month" has no date on a standalone page.
- **Line 1:** the text says 21 stations; the KML has 19.
- **Timeline entries not in the storyline** (verify): Line 6 inauguration on Dec 28, 2022; service reaching Motijheel in Nov 2023.
- **Completion deadlines** (supplied by the editors; used in the timeline, the network explorer and the route game): Line 6 running; Line 5 North December 2034; Line 1 December 2035; Line 5 South December 2036. Line 2 and Line 4 are still in the planning stage, with no deadline. To check: the Line 5 South story card still says the project runs "to August 2033"; the timeline's "Around 2035" entry was replaced by the three deadlines (the afterword still says "likely around 2035"); and trips that use Line 6's Kamlapur station say "early 2027" rather than "running now".
- **Cost section copy** (as supplied, en dash replaced with a comma): "is forecast to 1,339,197 daily boardings" may want a verb ("forecast to reach").
- **Typographic edits only:** em dashes (and "--") replaced with commas or hyphens. Currency is written "Tk 93,800 crore" (no full stop after Tk, and never a bare figure) throughout.

## Accessibility and motion

- The full narrative is plain HTML and reads without JavaScript (the loading screen is hidden when scripts are off). The network explorer is keyboard-operable and works without WebGL; the bottom sheet's grip also resizes with the arrow keys.
- `prefers-reduced-motion`: lines fade in instead of drawing, the camera cuts instead of flying, trains park at stations, panels change state without sliding, back-to-top jumps instead of gliding, and scroll-linked fades keep opacity only.
- Map motion runs only while the map is on screen and the tab is visible.
- Route game: the station fields are ARIA comboboxes (arrow keys, Enter, Escape; typing narrows the list and accepts common spellings such as Kamalapur or Natun Bazar). Boarding, changes and the result are announced to screen readers. With reduced motion there is no ride: the trip is drawn and the result appears at once.
