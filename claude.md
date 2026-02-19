# Lexie - Real-Time DX Country Spotter

## What This Is

Amateur radio real-time dashboard that monitors global propagation spots. Connects to the g7vrd STOMP feed, aggregates spots from PSK Reporter, DX Cluster, skimmer networks, and WSPR, then displays spotted countries in a filterable card grid with live feed.

## Tech Stack

- **Runtime:** Node.js
- **Server:** Built-in `http` module + `ws` (WebSocket) + `@stomp/stompjs`
- **Frontend:** Vanilla JS, CSS3, no frameworks — single-page app entirely in `index.html`
- **Packaging:** `pkg` for standalone binaries
- **Deployment:** Node.js server or Vercel (MQTT variant)

## File Map

| File | Purpose |
|------|---------|
| `server.js` | HTTP + WebSocket server; STOMP client subscribing to g7vrd feed; spot processing pipeline |
| `index.html` | Entire frontend UI — HTML, CSS, JS all inline (~1344 lines) |
| `dxcc.js` | Hardcoded prefix-to-country lookup map (fast fallback) |
| `cty-lookup.js` | Parses `cty.dat` (ARRL database); callsign → country/coordinates/grid |
| `cty.dat` | ARRL DXCC entity data file |
| `wsjtx-parser.js` | WSJT-X UDP binary protocol parser (utility, not in main data path) |
| `relay.js` | Local relay: captures WSJT-X UDP → forwards over WebSocket to remote server |
| `vercel/index.html` | Alternative UI using MQTT instead of WebSocket for serverless deploy |
| `package.json` | Dependencies: `ws`, `@stomp/stompjs`, `pkg` |

## Architecture

```
g7vrd STOMP Feed (wss://ws.g7vrd.co.uk/dx/websocket)
    ↓ 4 topics: /topic/psks/v1, spots/v1, skims/v1, wsprs/v1
server.js (STOMP client → parse → enrich via cty-lookup → broadcast)
    ↓ WebSocket (JSON: {type, callsign, country, mode, band, grid, ...})
index.html (filter by mode/band → render cards + live feed + TTS/ARIA)
```

## Commands

```bash
npm install        # Install deps
npm start          # node server.js — serves on http://localhost:3000
```

## Environment Variables

- `PORT` — HTTP server port (default: 3000)
- `WSJTX_PORT` — UDP port for relay.js (default: 2237)
- `LEXIE_SERVER` — Remote server URL for relay.js

## Key Constants (server.js)

- `G7VRD_WS_URL` = `wss://ws.g7vrd.co.uk/dx/websocket`
- `MAX_SPOTS` = 2000 (in-memory circular buffer)

## Key Constants (index.html)

- `FREEZE_MS` = 10000 (screen reader DOM freeze window)
- Modes: FT8, FT4, FT2, CW, SSB, RTTY, PSK, VARAC, JT65, Q65, JS8, WSPR, MSK144, FreeDV
- Bands: 160m, 80m, 60m, 40m, 30m, 20m, 17m, 15m, 12m, 10m, 6m

## Data Structures (frontend, in-memory)

- `allSpots[]` — circular buffer of spot objects `{callsign, country, mode, category, band, grid, message, timestamp}`
- `countries` — `Map<name, {count, lastSeen, callsignModes: Map<call, Set<modes>>}>`
- `callsignGrids` — `Map<callsign, grid>`
- LocalStorage keys: `activeModes`, `activeBands`, `myQth`, `sortMode`, `voiceMode`

## Coding Conventions

- `camelCase` variables/functions, `SCREAMING_SNAKE_CASE` constants
- Prefixes: `is*` (boolean), `make*` (factory), `handle*` (event), `render*` (DOM)
- No classes except `WSJTXParser`; functional style with closures, Map/Set
- Arrow functions and template literals throughout
- HTML generated via template literals, not a template engine

## UI Behavior Notes

- **Conserve space in grid cards.** Horizontal and vertical space are both precious — more visible cards means more useful information at a glance. Stack secondary data vertically (e.g. band pills in a column) rather than stretching cards horizontally. Card height should be driven by primary content (callsign/mode pairs), not metadata. Avoid inline spans that widen the name row when a vertical column would fit alongside existing content.
- Country cards show: name, callsign count, bands (stacked vertically on right, sorted by frequency via ALL_BANDS), distance — in all sort modes
- Distance suppressed for domestic countries (SKIP_DIST: US, Canada, Mexico)
- Bands tracked per country via `data.bands` Set, added in all 3 aggregation paths (rebuild, incremental, filter-recount). Formatted by `formatBands()` which returns `{ html, speech }` — html is band-pill spans for the vertical column, speech uses "20 meters, 40 meters". Card structure: `.card-body` (flex row) contains `.card-main` (callsign list) + `.band-col` (stacked pills on right).
- Country announcements speak: "New country: {country} on {mode} {band}, {distance}". The `announceCountry` function must receive the spot's grid to compute distance — also stored in `pendingNewCountries` queue for deferred announcements. NOTE: The ARIA live region `#srAnnounce` must NOT have an `aria-label` like "New country announcements" — that was removed because screen readers prefix it before every announcement. The "New country:" prefix in the spoken text itself is intentional and must stay.
- Distances rounded to nearest 10 (both display and speech). Display uses `formatDist` (compact: "6520mi"). Speech uses `speakDist` ("65 hundred 20 miles" or "kilometers") — screen readers say raw numbers inefficiently (e.g. "six thousand five hundred and twenty three"), so `speakDist` breaks into hundreds format. `speakDist` must be used in ALL aria-labels and announcements — `formatDist` is ONLY for visible text in innerHTML. Three aria-label locations: full rebuild loop, incremental update (existingEl), and new card creation in `renderCountryCard`.

## Accessibility (critical design concern)

- `accessibility-findings.md` is a **cross-project reference** — patterns, gotchas, and rules there apply to any live-updating UI with screen reader support. Update it with new findings that would benefit future projects.

- ARIA live region `#srAnnounce` uses `role="status"` with NO `aria-label` — adding a label or using `role="log"` causes screen readers to prefix every announcement with the label text. Use 100ms clear-then-set delay.
- Callsigns spaced for screen readers (`J A 1 X Y Z`)
- Focus save/restore by element ID; skip DOM updates on focused elements
- Incremental DOM updates (appendChild reordering) to preserve focus
- Keyboard navigation: arrow keys, Tab, Ctrl+S; event capture phase for SR compat
- Three voice modes: off, self-voice (TTS), screen-reader (ARIA)

## Performance Patterns

- Incremental card updates (no full rebuilds)
- Feed UI limited to 200 items
- Speech synthesis 10s safety timeout
- WebSocket reconnect with 2s backoff
