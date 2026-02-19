# Focus & Accessibility Notes

## Grid focus jumps on new country arrival

### Problem

When a new country was added to the country grid while using a non-alphabetical
sort order (e.g. "Most spots", "Closest"), focus would:

1. Jump from the currently focused country card to the live feed panel.
2. After a moment, land on a random card in the grid.

This made keyboard navigation unusable during active spots.

### Root cause

`renderCountryCard()` called `rebuildDisplay()` for non-alpha sorts to get the
ordering right. `rebuildDisplay()` does `countryGrid.innerHTML = ''` and
`feedList.innerHTML = ''`, which destroys every DOM element — including the one
that held focus. The browser then moved focus to `<body>`, and the wrapped
`rebuildDisplay` tried to restore it by ID, but by then the browser had already
shifted focus unpredictably through the feed panel (which was tabbable) and into
newly created cards.

Two compounding issues:

- **Feed panel was tabbable.** `feedList` and its `.feed-item` children had no
  `tabindex="-1"`, so when focus fell out of the destroyed grid, the browser's
  sequential focus navigation could land in the feed.
- **`innerHTML = ''` destroys focus atomically.** There is no "focus parking"
  trick that reliably survives an `innerHTML` nuke in all browsers. Even parking
  focus on the grid container before clearing it does not prevent the browser
  from briefly exposing the feed panel as the next focusable element.

### Fix

1. Added `tabindex="-1"` to `.feed-panel`, `#feedList`, and every `.feed-item`
   so the feed is never a tab stop.
2. Replaced the `rebuildDisplay()` call in the new-country path with
   `resortGridInPlace()`, which re-orders existing DOM nodes using
   `appendChild()`. Moving an already-attached node preserves it (and its focus)
   rather than destroying and recreating it.
3. `rebuildDisplay()` (full innerHTML nuke) is now only called for explicit user
   actions like toggling mode/band filters or changing sort order, where brief
   focus disruption is expected.
