# Dhaka’s Metro Rail: Essential Transport, Escalating Costs

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

- `index.html` paints a loading screen on the first frame (inline CSS, no script needed). It draws the real network while the map loads, and lifts once the map has painted its opening view and the fonts are in (the fonts get at most 3 seconds). There is no short cap: a reader never sees the story without its map unless the map cannot be had. It lifts straight away onto the fallback when the map fails for good: no WebGL 2, a token request that fails or hangs (10-second timeout, one retry), a chunk or the style that will not load. A 60-second ceiling in `src/loader.ts` only catches something that stops answering altogether. A CSS-only failsafe hides the screen after 20 seconds if scripts never run; once they do, `Loader` switches it off (or, if it already fired, leaves the page as it is).
- The bar is the progress; the line under it is not. "Laying the tracks" told a reader nothing they could use, so the status line carries the waiting lines instead (`WAITING_LINES` in `src/loader.ts`), one every 2.6 seconds with a cross-fade. `index.html` paints the first one before any script runs, so the list has to start with the same line the markup's `data-status` holds. On a quick connection that first one is all anybody sees. The text lives in CSS (`content: attr(data-status)`), so no crawler indexes a loading message.
- The loading screen sizes everything from one custom property, `--u` (`clamp(0.875rem, min(1.9vw, 2.2vh), 1.3rem)`), so the stack keeps its proportions as it scales: the status line runs 12px on a phone to 17.9px on a large display. It follows whichever axis is tighter, which is the height on a laptop or a phone held sideways; below 34rem of height the drawing, much the tallest element, shrinks further so the stack never runs off the screen.
- The map's first frame is `load` (style up, opening tiles drawn), not `idle` (every tile settled and every fade finished): `StoryMap.painted` vs `StoryMap.ready`. The latter can trail by seconds on a slow connection for no visible difference. The route game's map fades in the same way (see below).
- The map code, mapbox's shared chunk and its worker are preloaded from `<head>` (see `preloadMap` in `vite.config.ts`), so they download in parallel with the entry script instead of one after another. Chrome may log "preloaded but not used" for the worker file; that is expected and harmless.
- The route game is a separate chunk, stylesheet included, fetched at the first idle moment after the story is readable (or sooner if the reader is already scrolling towards it). It is the largest piece of the page's own script and sits below the timeline, so loading it with the entry only made it compete with the map.
- Only the Latin subsets of the two typefaces are declared (`src/styles/fonts.css`), rather than Fontsource's full `wght.css`. `unicode-range` already kept a reader from downloading the Cyrillic and Vietnamese cuts; this keeps them out of the build as well. Both Latin files are preloaded from `<head>` (`preloadFonts` in `vite.config.ts`): the loading screen's line is set in the sans, and the story is only revealed once both faces are in.
- The timeline, the cost chart and the footer skip rendering until the reader nears them (`content-visibility: auto` in `main.css`), with a placeholder height measured at each width. That took the median full relayout (first frame, fonts arriving, a phone's address bar showing or hiding) from 13.4 ms to 7.8 ms on a laptop. A section jump in the masthead draws them all for the trip (`data-jumping`, `src/nav.ts`), so the page lands exactly on its target. The afterword is left out because its fade paints above its own box, and the route game because its map measures itself.
- The basemap's TileJSON is inlined in `src/map/basemap.ts`, saving a request before the first tile.
- `npm start` pre-compresses every asset (brotli and gzip) at startup. On Apache, `public/.htaccess` (copied into `dist/`) turns on compression and year-long caching for the hashed assets; see DEPLOY.md for the Nginx equivalent. Without those the page re-fetches about 600 KB of map code on every visit.
- Older phones: `svh`/`lvh` units (Chrome 108+, Safari 15.4+) always follow a `vh` fallback, or the story's spacing collapses and the cards stack edge to edge. See the note above `.scrolly` in `main.css` before adding new ones.
- Older phones, and the browsers that never update on them (an old Chrome, Samsung Internet, the Facebook in-app browser on an outdated WebView):
  - The build lowers syntax to Chrome 87 / Safari 14 / Firefox 78 (`build.target` in `vite.config.ts`), so the page's own code parses there even where the maps cannot run, and the story, explorer and route finder still work.
  - `src/map/support.ts` asks, before any map code downloads, whether the browser can run mapbox-gl 3: WebGL 2 (it has no WebGL 1 path, and many older phones only have WebGL 1), a shader that compiles, and `Object.hasOwn`. The page used to accept any WebGL, and those phones got a map that failed to start. The test context is released at once.
  - The line badges on both maps are drawn with plain arcs (`capsule` in `src/map/layers.ts`). `CanvasRenderingContext2D.roundRect` needs Chrome 99 / Samsung Internet 18 / Safari 16; on anything older it threw while the network was being added and took the maps down with it.
  - No `:is()` in the stylesheets (Chrome 88+): an older engine drops the whole rule.

## Reading and interaction

- Each scroll step fires as soon as its card peeks in at the bottom of the screen (`src/scroll/steps.ts`), in both directions.
- A line named in the text takes that line's map colour (`<span class="line-ref" data-line="1">`). Line 1's red is lifted slightly for text contrast (`--text-line-1`).
- The masthead carries four section jumps: The Map, Timeline, Price Tag and Take a tour! (`src/nav.ts`). Below 900px only the ride keeps its place, beside a tray button holding the whole list, so the game stays one tap away on a phone. The bar is hidden in the markup until the script reveals it, because two of the four sections are built by script. A jump holds the map on its current scene until the page lands, instead of strobing through a dozen of them on the way.
- The network explorer: on desktop, a tab on its edge slides it away to show the whole map. On phones and narrow windows it is a bottom sheet with the six lines in two rows of three (no sideways scrolling): drag the grip to resize, flick to minimise or expand, or use the chevron. Clicking a line or station on the map always brings the explorer back open with its details, even if it was minimised or slid away.
- The explorer is a box with its own scrollbar, so a detail written into it can land below the fold. `Dock.showDetail` scrolls it up to the top of the box on every selection (leaving a sliver of what was above it, and yielding if the reader scrolls themselves), the detail animates in, and a bottom fade appears whenever there is more below (`data-more`). Without that, tapping a station on the map looked like nothing had happened.
- Every detail leads with its way back ("All lines", or "Back to Line 6" from a station reached through one), and a matching reset button joins the zoom buttons on the map while anything is selected (`StoryMap.addResetButton`). A reader who picked something on the map is looking at the map, so the way out is there as well as in the panel.
- The cards and the explorer sit above the afterword's fade-to-ink gradient, which only darkens the map as the story moves on.
- On the map, a plain scroll always scrolls the story. Ctrl + scroll (⌘ + scroll, or a trackpad pinch) zooms the map in the explorer; the +/- buttons, double-click and two-finger pinch work too.
- A back-to-top button appears once the reader has scrolled past the map. It steps aside while the route game's map fills the bottom of the screen, where it would cover the map's attribution.
- Both maps credit Mapbox one mark to a corner: the wordmark bottom left, the attribution folded into a small dark (i) button bottom right. The cards, the explorer and the game's panels all sit above them. On phones the story map's corners follow the visible part of its `100lvh` stage, and its zoom buttons sit top right, below the masthead.
- The headline is one `<h1>` in three tiers: "Dhaka's Metro Rail" as a small tracked line between two stretches of track ending in a station stop, then "Essential Transport," and "Escalating Costs" one phrase to a line. Both tiers size off the tighter side of the screen (`min(vw, vh)`), so each phrase keeps its line from a 280px phone to a 4K display and the block stays in proportion on a phone held sideways. The words (and the colon, visually hidden) are unchanged for search and screen readers.
- The timeline is spaced evenly, one step per event, not proportionally to the years between them (`--tl-step` in `main.css`): scaled spacing left the 2005-2012 stretch empty and squeezed 2026-2027 together. The dates carry the intervals. `src/timeline.ts` only marks what is still planned and drops a "Today" rule between the last event and the next.

## The cost chart

Between the timeline and the route game, two paragraphs lead into a dumbbell chart of four lines: each line's initial estimate (hollow dot) and revised cost (filled dot) on one shared scale, sorted by percentage change. It is plain HTML and CSS in `index.html` (every figure reads without JavaScript); `src/costs.ts` only animates the revised dots out from the estimates the first time the chart is seen, and `src/styles/costs.css` styles it. Each row's `--from` and `--to` are its two costs divided by 1,20,000, the top of the scale: update them together with the printed figures.

## The route game ("Pick a station")

After the timeline, readers pick a start and a destination (in the two station fields, or by tapping stations on a second map) and ride the finished network.

- **Routes** (`src/game/routes.ts`): every chain of up to four rides is enumerated, then pruned to trips a person would take: no station passed twice, no change at a station where an earlier or later line could have been boarded directly, and one option per sequence of lines (the shortest place to change). Lines running side by side (6 and 2 at Motijheel and Kamlapur, 2 and 4 to Signboard) keep only the option that can be ridden soonest. An extra change is only offered if it shortens the trip by 10%. At most three options are listed, fewest changes first, then shortest.
- **Lines still being planned** (2 and 4): trips on them have no date. The ride is drawn dashed, the caption says the line is "still on paper", and the result says the trip happens once the line "leaves the drawing board". If another route avoids those lines, the result card offers it with its date and plays it in one tap (`findDatedRoute` in `src/game/routes.ts`).
- **What the reader sees:** the same station twice gives "You can just walk"; one route plays at once; several are listed (hover or focus previews one on the map); no connection gives "No metro route exists" (every pair of stations is connected today, so this only guards against future data changes). Reset, or "Plan another trip" on the result card, starts over. The card's close button (or Escape) puts it away and frames the trip on the whole map.
- **The ride** (`src/game/game-map.ts`): the camera is close on the platform, pulls back as the train gets going and closes in again on the interchange or destination, where a caption says which line to switch to. The ride pauses while the map is off screen or the tab is hidden, and "Skip ride" jumps to the end. The result names the latest completion deadline among the lines used.
- **Travel time and fare** (`src/game/estimate.ts`): every route option, caption and result card carries them. Captions run a trip clock that counts minutes as the train moves and through each change, and a change caption shows the fare paid so far. The result card gives the total time (riding and changing), the total fare (and with a 10% MRT Pass discount), a varying line about the numbers, and, for trips with changes, a leg-by-leg breakdown. The breakdown starts folded after a ride, since the captions already went leg by leg; it starts open when there was no ride (no map, reduced motion).
  - *Line 6* uses DMTCL's published figures as they are: the fare chart (`MRT-6 Fare.csv`) and the running time of each hop (`SIngle station travel time and fare.csv`, ranges such as "2.5-3 min" taken at their middle). Uttara North to Motijheel: 36 minutes, Tk 100.
  - *Distances:* each line's drawn track is scaled to its official length: Line 6 20.1 km (plus 1.16 km to Kamlapur), Line 1 19.87 km underground (the airport route) and 11.37 km elevated (Purbachal), Line 5 North 20 km, Line 5 South 17.2 km (12.8 km of it underground), Line 2 35 km with the Sadarghat branch, Line 4 16 km.
  - *Internal only.* The two rules below are how the estimates are worked out. None of it appears in reader-facing text: every estimated time and fare shows with a tilde ("~42 min", "~Tk 80", spoken "about" by screen readers), and only Line 6's published figures, between its running stations, show bare. That includes a Line 6 leg inside a longer trip and today's Line 6 ride in the "runs today" note; walking and road comparisons are always estimates. The small print says only "Estimated from Line 6's published fares and running times".
  - *Fares elsewhere:* Tk 4.70 a km, rounded up to the next Tk 10, never below Tk 20. That rule, fitted to Line 6's chart on the same scaled track, reproduces 196 of its 240 fares exactly and is never more than Tk 10 off. The chart's summary by number of stations only works because Line 6's stations are about 1.3 km apart (Line 2 has gaps of 5 to 6 km), so it is not used. Trips on to Kamlapur never cost less than the chart's fare to Motijheel.
  - *Times elsewhere:* 1.5 minutes a stop plus 0.67 minutes a km, the least-squares fit to Line 6's 15 hops (it gives the same 36 minutes end to end and implies about 90 km/h between stations).
  - *Changes:* each line is a separate ticket (no through-fare between lines has been announced). A change takes a platform walk (5 minutes between an elevated and an underground line, 3 on one level, 4 where Line 2 or 4's depth is undecided) plus a 4-minute average wait, half of Line 6's 8-minute peak interval. The wait for the first train is not counted.
  - *Rounding:* each ride is rounded to whole minutes on its own, and a trip is the sum of what is shown, so the numbers on the card always add up and a ride reads the same inside any trip.
  - *Part of the trip, today* (`today` in `src/game/estimate.ts`, `todayNote` in `src/game/copy.ts`): Line 6 runs now, so a trip that needs it and a line still to come can be made in part: Line 6 to or from the interchange where the future line meets it, and the road for the rest. Today's handover is always a running station: Mirpur 10, Karwan Bazar or Motijheel (trips on to Kamlapur stop at Motijheel, 1.2 km short, until Kamlapur station opens). The result card adds a note with today's Line 6 ride (chart fare and time), the road stretch left over (its length, a walking time when it is 2.5 km or less, vehicles sized to the distance) and the lines it waits for. Four cases: Line 6 first (1,315 routes), Line 6 last (1,315), Line 6 in the middle (636), and Line 6 alone to or from Kamlapur (30); Motijheel to Kamlapur and back gets a walking note. During the ride, each leg carries "Runs today" or "Due Aug 2033", and the change caption at the handover says the metro ends (or starts) there for now. Routes whose only Line 6 riding is the Kamlapur extension (64) get no note: nothing on them runs today.
  - *The words:* `src/game/copy.ts`. Lines are dealt like cards (none repeats until the list is used up, never the same twice running), and the line about the numbers also rotates between themes that fit the trip: time, fare, walking, road traffic (the World Bank's 7 km/h, and its warning of 4 km/h by 2035), a monthly commute, the share of the trip spent changing, Dhaka's battery rickshaws (the "Bangla Tesla": electric, everywhere, and loose with the rules of the road), and inflation for lines not yet built. Every figure in them comes from `estimate`. (There is no fare-per-kilometre line: on an estimated trip it would give the rule away.)
- **Loading:** the game's map is a second Mapbox map, created only when the section comes within a screen of view (so it adds a map load only for readers who get that far) and the reader has paused scrolling: its first frames measured 290 to 480 ms each, which mid-scroll stuttered the page. Touching the game creates it at once. Its code is a small separate chunk; mapbox-gl itself is shared with the story map. While it loads, a quiet "Loading the map" note sits under it. It fades in on its first complete frame (`load`), after 2.5 seconds at most, and always the moment a ride starts. It used to wait for `idle`, which on a slow phone came late and never came while a ride was moving the camera, so a ride started before the map had settled played over an invisible map. It re-frames itself when it changes size (a phone turned sideways). Without WebGL 2 or a token, the fields still work and the result card appears without the ride.
- **In transit:** the ride's caption is bracketed in line colour on both edges. Riding, both edges are the line under the train; changing, the left edge is the line being left and the right edge the line being boarded, in the same order as the badges.

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
| Route game fares and times (Line 6 chart, fitted rules, change times, official line lengths) | `src/game/estimate.ts` |
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
- **Line 5S:** 17.2 km, about 12.8 km of it underground and 4.4 km elevated (the explorer, the story card and the route game agree; the earlier 17.4 km / 4.6 km is gone). The project runs from September 2026 to August 2033. "The project will run from this month" still has no date on a standalone page.
- **Line 1:** the text says 21 stations; the KML has 19.
- **Timeline entries not in the storyline** (verify): Line 6 inauguration on Dec 28, 2022; service reaching Motijheel in Nov 2023.
- **Completion deadlines** (supplied by the editors; used in the timeline, the network explorer and the route game): Line 6 running; Line 5 South August 2033; Line 5 North December 2034; Line 1 December 2035. Line 2 and Line 4 are still in the planning stage, with no deadline. Line 5 South was listed as December 2036 until September 18, 2026, which contradicted its story card; The Daily Star, UNB and bdnews24 all report the approved project running September 2026 to August 2033, and Lines 1 and 5N's December 2035 and December 2034 match The Daily Star's report of the revision. The timeline's "Around 2035" entry was replaced by the three deadlines (the afterword still says "likely around 2035"); and trips that use Line 6's Kamlapur station say "early 2027" rather than "running now".
- **Cost section copy** (as supplied, en dash replaced with a comma): "is forecast to 1,339,197 daily boardings" may want a verb ("forecast to reach").
- **Typographic edits only:** em dashes (and "--") replaced with commas or hyphens. Currency is written "Tk 93,800 crore" (no full stop after Tk, and never a bare figure) throughout.

## Accessibility and motion

- The full narrative is plain HTML and reads without JavaScript (the loading screen is hidden when scripts are off). The network explorer is keyboard-operable and works without WebGL; the bottom sheet's grip also resizes with the arrow keys.
- `prefers-reduced-motion`: lines fade in instead of drawing, the camera cuts instead of flying, trains park at stations, panels change state without sliding, back-to-top jumps instead of gliding, and scroll-linked fades keep opacity only.
- Map motion runs only while the map is on screen and the tab is visible.
- Route game: the station fields are ARIA comboboxes (arrow keys, Enter, Escape; typing narrows the list and accepts common spellings such as Kamalapur or Natun Bazar). Boarding, changes and the result are announced to screen readers. With reduced motion there is no ride: the trip is drawn and the result appears at once.
