# Accessibility Findings (Cross-Project Reference)

Collected findings on making real-time, WebSocket-driven dashboards accessible
via keyboard and screen reader. Originally developed for Lexie (a live amateur
radio spot dashboard), but the patterns, gotchas, and rules documented here
apply to any project with live-updating UI, ARIA live regions, screen reader
support, or keyboard navigation. Reference this document in any similar project.

---

## 1. The innerHTML Problem: Live Updates vs Focus Stability

### The core tension

Real-time dashboards want to redraw. Screen readers and keyboard users need the
DOM to stay still. These two goals are fundamentally at odds.

### What goes wrong

`element.innerHTML = ''` destroys every child node instantly. If the user had
focus on one of those children, the browser moves focus to `<body>` (or the
nearest ancestor that is still focusable). There is no reliable cross-browser
way to "park" focus before an innerHTML nuke and have it survive — the browser
processes the DOM mutation and focus loss in the same synchronous frame.

After focus lands on `<body>`, the next Tab keypress walks the entire document
tab order from the top. If there are tabbable elements between the destroyed
region and the rebuilt region (like a live feed panel), focus will land there
first, creating a jarring jump.

### What works

- **Incremental DOM updates.** Don't destroy and recreate elements. Update
  `.textContent`, `.innerHTML` of leaf nodes, or swap attributes in place.
  The focused element survives because it's the same DOM node.
- **`appendChild()` for reordering.** Calling `parent.appendChild(existingChild)`
  on a node that is already in the DOM *moves* it rather than cloning it. Focus
  is preserved because the node identity doesn't change. Use this for re-sorting
  a list without rebuilding it.
- **Save/restore focus by ID.** When a full rebuild is unavoidable (e.g., the
  user changed a filter and the entire set of visible items changed), save
  `document.activeElement.id` before the rebuild and call
  `document.getElementById(savedId).focus()` after. This is a best-effort
  fallback — it only works if the element is recreated with the same ID.
- **`aria-busy="true"`** on the container during rebuild tells screen readers to
  stop reading the region until it stabilizes. Remove it after the rebuild is
  complete.

### Current approach in Lexie

- New spots arriving: incremental update (`renderCountryCard` updates existing
  card's inner HTML without destroying the card element itself). **Exception:**
  if the card currently has focus, skip the content/aria-label update entirely
  to avoid triggering a screen reader re-announcement.
- New country arriving, alpha sort: insert a new card node at the correct
  position. No existing nodes are touched.
- New country arriving, non-alpha sort: append the new card, then call
  `resortGridInPlace()` which uses `appendChild()` to move existing nodes into
  sorted order — **but only if no card has focus.** If focus is in the grid,
  the resort is skipped and the card lands at the end; the next full rebuild
  (filter change, freeze expiry) will correct the order.
- Filter/sort change (user-initiated): full `rebuildDisplay()` with
  `innerHTML = ''`. Focus is saved by ID beforehand and restored after. This is
  acceptable because the user initiated the action and expects the view to
  change.

### Gotcha: appendChild moves are not focus-safe for screen readers

`parent.appendChild(existingChild)` preserves the DOM node and its JavaScript
focus state. However, screen readers maintain a separate **virtual cursor**
that tracks position in the accessibility tree. When a node is detached and
reattached (even to the same parent in a different position), screen readers
may interpret this as the element disappearing and reappearing. The virtual
cursor loses its position and the screen reader falls back to reading from the
top of the page — announcing the page title, headings, and other landmarks
before the user can recover.

**Rule:** Never move a DOM node that has (or might have) screen reader focus.
Either skip the move, or defer it until the user navigates away.

### Gotcha: updating aria-label or innerHTML on a focused element

Changing `aria-label` on the currently focused element causes screen readers to
re-announce the element with its new label. Changing `innerHTML` of children
inside the focused element can trigger partial re-reads. In a live-updating
dashboard, this means every spot update to the focused country card interrupts
the screen reader mid-sentence.

**Rule:** Check `element === document.activeElement` before mutating content or
accessible attributes. Skip the update if focused — the data layer tracks the
change and the next rebuild will catch up.

### Gotcha: role="list" + role="listitem" is verbose

`role="list"` with `role="listitem"` children causes screen readers to announce
"list, N items" on entry and "X of N" on every item. For a grid with 100+
country cards, this creates constant noise: "Japan, 5 callsigns, 47 of 129,
level 1." The position info is rarely useful when cards are sorted dynamically.

**Fix:** Remove `role="list"` and `role="listitem"`. Use plain `div` elements
with `tabindex="0"` and `aria-label`. The cards remain keyboard-navigable
without the list semantics overhead.

---

## 2. Tab Order: What Should and Shouldn't Be Tabbable

### Principle

Only interactive or user-navigable regions should be tab stops. Display-only
regions that update continuously (like a log feed) should be removed from the
tab order entirely, otherwise the browser will send focus there when the user
doesn't expect it — especially during DOM mutations.

### Specifics

| Element | `tabindex` | Why |
|---------|-----------|-----|
| `.country-card` | `0` | User navigates these to read country details |
| `#countryGrid` (container) | `-1` | Focusable programmatically (focus parking during rebuild) but not a tab stop |
| `.feed-panel` | `-1` | Display-only, continuously updating |
| `#feedList` | `-1` | Display-only log region |
| `.feed-item` | `-1` | Individual log entries; not interactive |
| Mode/band filter buttons | default (`0`) | Interactive toggle buttons |
| Header controls (selects, inputs) | default (`0`) | Standard form controls |

### Gotcha: roles with implicit aria-live

Several ARIA roles carry an **implicit `aria-live="polite"`**:

- `role="log"` — implicit `aria-live="polite"`
- `role="status"` — implicit `aria-live="polite"`
- `role="alert"` — implicit `aria-live="assertive"`
- `role="timer"` — implicit `aria-live="off"` (the safe one)
- `role="marquee"` — implicit `aria-live="off"`

This means any DOM mutation inside these elements will be announced by the
screen reader, even if the element has `tabindex="-1"` and is off-screen.
Live regions don't need focus to fire; they trigger on DOM mutation alone.

In Lexie, `role="log"` on the feed list caused the screen reader to read every
feed item aloud (including the `→` arrow character between callsign and
country). `role="status"` on the stats bar caused it to announce updated
counters on every spot. Both sounded like random
interruptions with "right arrow" announcements.

**Fix:** Either add `aria-live="off"` to explicitly override the implicit
behavior, or change the role to one without implicit liveness (e.g.,
`role="region"`). In Lexie, the feed list uses `role="log" aria-live="off"` to
keep semantic meaning while suppressing announcements. The stats bar was
changed from `role="status"` to `role="region"` since it has no semantic need
for the status role. If you have a separate dedicated ARIA live region for
announcements (like `#srAnnounce`), no other region should also be live.

Also set `tabindex="-1"` on non-interactive containers and their children to
prevent them from being tab stops.

---

## 3. Screen Freeze: Pausing Updates During Navigation

### Problem

Screen readers read DOM content asynchronously. If the DOM changes while the
screen reader is mid-sentence on a card, it may restart, skip content, or read
stale text. With spots arriving every few seconds, the grid is constantly
updating — making it impossible for a screen reader user to finish reading a
card.

### Solution: navigation-triggered freeze

When the announce mode is set to "self-voice" or "screen-reader" and the user
is navigating inside the country grid (detected via `keydown` and `focusin`
events on grid children), all DOM updates are deferred for a configurable
window (currently 10 seconds after the last navigation event).

Key details:

- **Capture-phase listeners.** Screen readers can intercept keyboard events
  before they bubble. Using `addEventListener(..., true)` (capture phase)
  ensures we detect navigation even when the screen reader consumes the event.
- **`freezeSuppressed` flag.** When the freeze timer expires and we do a
  catch-up rebuild, the rebuild itself moves focus (to restore the user's
  position). This `focusin` would re-trigger the freeze. The `freezeSuppressed`
  flag prevents this feedback loop.
- **Deferred new-country announcements.** New countries that arrive during the
  freeze are queued in `pendingNewCountries` and announced (via TTS or ARIA live
  region) after the freeze expires, so the user doesn't miss them.
- **Data keeps accumulating.** The freeze only affects DOM updates. The
  `allSpots` array and `currentCountries` map continue to be updated, so when
  the freeze expires and `rebuildDisplay()` runs, the view is fully current.

---

## 4. Announcing New Countries

Two parallel announcement channels, selectable by the user:

### Self-voice (Web Speech API / TTS)

- Uses `SpeechSynthesisUtterance` with a queued drain loop.
- `speechSynthesis` can silently pause in the background; a 5-second
  `setInterval` calls `speechSynthesis.resume()` to recover.
- Browsers require a user gesture before allowing speech. On page load, if
  self-voice is selected, a one-shot `click`/`keydown` listener calls
  `speak('Voice enabled')` to unlock the API.
- A 10-second safety timeout per utterance calls `speechSynthesis.cancel()` if
  `onend`/`onerror` never fire (observed in some browser/OS combinations).

### Screen reader (ARIA live region)

- A visually-hidden `div#srAnnounce` with `aria-live="polite"` and
  `aria-atomic="true"`. Uses `role="status"` with **no `aria-label`** — adding
  a label or using `role="log"` causes screen readers to prefix every
  announcement with the label text (e.g., "New country announcements: Japan"
  instead of just "Japan").
- To force re-announcement of identical text (e.g., two new countries in quick
  succession), the content is cleared to `''` and then set after a 100ms
  `setTimeout`. Without this clear-then-set pattern, screen readers may not
  re-read content that looks identical to the previous value.

### Distance in announcements

- Distances are rounded to the nearest 10 (both display and speech).
- Screen readers pronounce raw numbers inefficiently: "6523" becomes "six
  thousand five hundred and twenty three miles" — too many words for a quick
  notification. The `speakDist()` function formats distances in hundreds:
  "65 hundred 20 miles" (or "kilometers"), which screen readers read naturally
  as shorter phrases.
- `formatDist()` is for visual display only (compact: "6520mi"). Never use it
  in announcement text or `aria-label` attributes — always use `speakDist()`
  for anything a screen reader will read aloud. This includes:
  - ARIA live region announcements (`#srAnnounce`)
  - Self-voice TTS announcements (`speak()`)
  - `aria-label` on country cards (all three paths: full rebuild, incremental
    update, and new card creation)
  - Any future `aria-label` or `aria-description` that contains a distance
- **General rule:** any numeric value in an `aria-label` or live region will be
  read aloud by a screen reader. Raw display-formatted numbers (e.g., "6520mi")
  get expanded into verbose speech ("six thousand five hundred and twenty mi").
  Always use a speech-optimized formatter for accessible text, even when the
  visual display uses a compact format. This applies to distances, counts,
  frequencies, or any large number that a screen reader might encounter.

---

## 5. Callsign Pronunciation

Screen readers will try to pronounce callsigns like "JA1XYZ" as words, which
is unintelligible. The `spaceCall()` helper inserts spaces between characters
(`"J A 1 X Y Z"`) so the screen reader spells them out letter by letter. This
is used in `aria-label` attributes on cards and feed items — the visual display
still shows the callsign without spaces.

---

## 6. Toggle Buttons: aria-pressed

Mode and band filter buttons use `aria-pressed="true"/"false"` to communicate
toggle state to screen readers. The visual state is driven by the `.active`
CSS class, but `aria-pressed` is the accessible equivalent. Both must be kept
in sync on every click.

---

## 7. Keyboard Shortcuts

`Ctrl+S` moves focus to the first country card in the grid. This provides a
quick way to jump into the grid from anywhere on the page without tabbing
through all the filter buttons.

---

## 8. Lessons / Rules of Thumb

1. **Never `innerHTML = ''` a region that might have focus** unless it's in
   direct response to a user action where focus disruption is expected.
2. **Don't move or mutate a focused element.** `appendChild` on the focused
   node detaches/reattaches it, causing screen readers to lose their virtual
   cursor and re-read from the page top. Changing `aria-label` or `innerHTML`
   on a focused element triggers re-announcement. Check
   `el === document.activeElement` before any mutation; skip and defer.
3. **Remove non-interactive regions from tab order.** If the user can't
   meaningfully interact with it, set `tabindex="-1"`. Log panels, status
   displays, and decoration should not be tab stops.
4. **Watch for roles with implicit `aria-live`.** `role="log"`, `role="status"`,
   and `role="alert"` are secretly live regions. Any DOM mutation inside them
   triggers screen reader announcements without focus. Override with
   `aria-live="off"` or use `role="region"` instead.
5. **Hide visual detail with `aria-hidden="true"`.** Cards with rich visual
   content (callsign lists, mode pills) should expose a concise `aria-label`
   and hide inner content from screen readers. Otherwise the screen reader
   reads every child element on focus.
6. **Skip `role="list"` / `role="listitem"` for large dynamic collections.**
   Screen readers announce "X of N, level 1" on every item. For 100+ items
   with dynamic sort order, this is noise. Plain `div` + `tabindex="0"` +
   `aria-label` is quieter and equally navigable.
7. **Freeze the DOM when a screen reader is reading.** Detect navigation into
   an accessible region and pause updates. Queue announcements for delivery
   after the freeze.
8. **Use capture-phase event listeners** for detecting screen reader navigation.
   Bubble-phase listeners may not fire because the screen reader intercepts the
   event.
9. **Clear-then-set ARIA live regions** with a small delay. Identical text
   won't be re-announced without the clear step.
10. **`aria-busy="true"`** during rebuilds tells screen readers to wait.
11. **Space out callsigns** (or any code/alphanumeric identifier) in aria-labels
    so screen readers spell them rather than guessing pronunciation.
12. **Compute derived data (like distance) in all render paths.** If a value is
    only computed in the full-rebuild path but not the incremental path, cards
    created incrementally (e.g., after page reload) will be missing that data.
13. **Never put `aria-label` on ARIA live regions.** Screen readers prefix the
    label before every announcement, adding unwanted preamble. Use
    `role="status"` with no label.
14. **Format numbers for speech, not display — everywhere screen readers read.**
    Screen readers read "6520" as "six thousand five hundred and twenty" —
    verbose for a quick notification. Break large numbers into hundreds format
    ("65 hundred 20 miles") and round to the nearest 10 to eliminate unnecessary
    precision. Keep a separate display formatter for compact visual output. This
    applies not just to live region announcements but to **all `aria-label` and
    `aria-description` attributes** — any text the screen reader vocalizes must
    use the speech-optimized formatter. It's easy to miss `aria-label` because
    it's "just an attribute" but it's the primary text screen readers read.
