# Stability audit — 2026-09-10

Flashes and jitter only. No copy changed, nothing redesigned, nothing added.

Every finding below was reproduced in a headless Chromium at **390×844** and
**1280×900** against the published board. The arbiter throughout is the
browser's own `layout-shift` API — what was *painted*, not what changed between
two animation frames. That distinction threw out four candidates on its own:
the ✕ on the Atlas, Chapters and the portrait all move between frames and none
of them ever reaches the screen, because the correction lands in the same
frame's `requestAnimationFrame` phase, before the paint. Those are not in the
fixed list; see **Checked and clear**.

The harness is `review/stability/harness.mjs`. It runs the app with
`?demo=full`, so every key it touches resolves into the `lvtest.demo.`
namespace and the live board is unreachable by construction — one case asserts
exactly that, by reading raw key names rather than through the patched
`getItem`, on every run.

```
node review/stability/harness.mjs                      # 16 cases, both widths
node review/stability/harness.mjs --only=companion-seat
node review/stability/harness.mjs --root=<pristine>    # the same cases, red
```

**Boot, before and after** (CLS, the app's whole first second):

| | landing on this week | landing on the board |
|---|---|---|
| 390×844 before | **0.0705** | 0.0000 |
| 390×844 after | 0.0000 | 0.0000 |
| 1280×900 before | 0.0000 | **1.1291** |
| 1280×900 after | 0.0000 | 0.0000 |

Every screen, opened cold at both widths, now reports no painted shift at all.

---

## Fixed

### 1. this week · the check-ins · the empty board

**What happens** — the page opens, and a moment later everything under the
title drops: 69px on this week at 390 (the title re-wraps as it goes), 124px on
the weekly and quarterly check-ins, taking the ✕ with it. On a warm cache it is
one frame; on a cold one it is however long the drawing takes to arrive.

**Cause** — three lanes reserve the companion's seat with
`:has(<slot> .companion)`. That selector does not ask *does this board have a
companion*. It asks *has the SVG finished being fetched*, and the answer is no
for a whole round trip. `mountCompanion` is `async` and the art comes from
`fetch`, so the page always lays out once without the lane.

The ruling already on `.lv-station-row` asks for the opposite in as many
words — *"the reservation is the same size whether the creature is a cat, a
moth or nothing at all, so nothing it does can move anything"*. The `:has` gate
was quietly making it untrue.

**Fix** — the slot carries `.seated`, written synchronously in the same pass as
the render that asked for the mount: in `mountCompanion` before its first
`await`, and in this week at the decision itself, because the arriving branch
there waits half a second before it mounts. Art that never arrives leaves the
lane reserved and empty rather than collapsing it, which would be the same jump
later and under a reader already looking at the page.

**Status** — fixed, `6151e11`. Cases
`companion-seat-is-reserved-before-the-art-arrives`,
`x-mark-does-not-jump-openWeekSheet`.

### 2. how this works · the art of letting go · every sheet

**What happens** — the sheet opens with its ✕ at the corner of the *window*,
and one painted frame later the mark snaps onto the paper. 36px on the release
page and 84px on "how this works" at 390; 58px and 55px at 1280.

**Cause** — 169b gave the book *pages* a synchronous seat for exactly this
reason. The sheets never got one: `openBookPage` called `markTopBook` only for
`.book-page`, so a sheet's mark was left to `seatSoon`. A `requestAnimationFrame`
on its own would still be before the paint — what is not is the chain that
actually fires here. The class-change observer's seat runs while the sheet is
still being laid out and `pageSheetOf` has nothing to measure, so the seat that
lands is the ResizeObserver's; a ResizeObserver callback runs *after* the
frame's rAF phase, so the `seatSoon` it queues belongs to the next frame.

**Fix** — `openBookPage` seats a non-page overlay itself. `seatSoon` is
untouched and stays the backstop for every later change.

**Status** — fixed, `ec5f219`. Cases `x-mark-does-not-jump-openRelease`,
`x-mark-does-not-jump-help-sheet`.

### 3. the shelf tour

**What happens** — the screen goes entirely black for ~380ms with nothing lit
in it, and then the spotlight, the ghost cursor and the scrap of paper all
slide in from the top-left corner of the screen. Scored 0.96 — by a wide margin
the largest single shift in the app.

**Cause** — all three are inserted with no geometry and placed 380ms later
(after `scrollIntoView` settles), and all three carry a transition on exactly
the properties that placement writes. So the first placement plays as a move
from a position nothing was ever at — a transition firing on first paint
instead of on a change. The blackout is the same fact from the other side: the
dimming is the hole's own `box-shadow` spreading 200vmax from its box, so a
hole with no geometry yet lights nothing.

**Fix** — `#walkOverlay.walk-first` holds both the transitions and the paint
until the first beat is placed, and `walkStart` drops the class after that
write. The overlay itself is untouched, so a tap during those 380ms still lands
on the tour rather than on the board behind it.

**Status** — fixed, `022b2cf`. Case
`tour-spotlight-does-not-animate-in-from-0,0`.

### 4. the empty board · the portrait's spread

**What happens** — on a phone, the page is exactly the browser toolbar's height
taller than the screen, with nothing in that extra height. Reaching the bottom
retracts the toolbar, the overflow goes with it, the scroll settles back, the
toolbar returns and it overflows again. This is the shake at the foot of a
scroll, in its textbook form.

**Cause** — two rules size a page in `vh`:

```
body.empty-board .app   min-height: 100vh
.pt-spread              min-height: min(640px, 68vh)
```

`vh` on a phone is the **large** viewport — the window with the toolbar
retracted — not the window in front of the reader. Both of these are pages
built to be about the window tall with nothing under them, so each comes out
overflowing by precisely the toolbar. `.pt-spread`'s own note had already asked
for the opposite: *"it gives way on a short window rather than forcing a scroll
on a page with three lines on it."*

**Fix** — both resolve from `svh`, with the plain `vh` left in front as the
fallback so nothing that lacks `svh` changes at all. `svh` and not `dvh`: `dvh`
tracks the toolbar as it slides, which trades the shake for a page that
breathes all the way down. `svh` is the window at its smallest, so the page fits
at every point of the toolbar's travel and never asks to scroll.

**Status** — fixed, `b4f2a21`. Case `no-page-is-sized-by-the-large-viewport`.
Its first half reads the stylesheet rather than measuring, and says so: a
headless browser has no toolbar, so `vh`, `svh` and `dvh` all resolve to the
same number there and no measurement could tell them apart. Its second half
holds the behaviour that made the rule wrong — the empty board must not
overflow its window. **This one is reasoned and guarded, not seen.** It wants a
look on a real phone.

### 5. the board, at desktop width

**What happens** — the board is drawn once at full size and then shrinks. The
goal columns travel 294px upward at 1280; the resting shelf lands 669px down
from where it was painted. CLS 0.164.

**Cause** — `fitBoardToWindow` shrinks the board's own measures until the page
fits the window, by measuring rather than guessing, which is right. It ran a
frame late, which is not. The reason given for the `requestAnimationFrame` was
that the shelf's inline-sized SVG needed a frame to be laid out — it does not:
the search's own `root.scrollHeight` read forces a synchronous layout of the
whole document, SVG included, which is the same layout the frame would have
produced.

**Fix** — the fit runs in the pass that rendered the board. The frame-later
pass stays as a second opinion rather than the only one: the search clears the
factor and re-derives it from scratch, so repeating it is idempotent, and it is
what still catches anything that genuinely settled late. `--lv-fit` comes out
identical at 1280×900, 1440×780, 1100×1000, 1280×1400 and 390×844 before and
after.

**Status** — fixed, `120708c`. Case `board-is-fitted-before-its-first-paint`.

---

## Listed, not fixed — each wants its own session

### 6. any screen · the app shows a previous publish, then reloads into the current one

**What happens** — reproduced end to end. With the page slower to arrive than
the worker's patience:

```
t=4.0s   the page paints — with the PREVIOUS publish's text in it
t=18.0s  the page reloads itself — now the current publish
```

**Cause** — two deliberate mechanisms meeting. `sw.js` serves the page
network-first but waits only `PAGE_WAIT_MS = 4000`; past that it answers with
the kept copy, which is the last publish. The real fetch keeps running and
refreshes the cache behind it. Separately, a return to the app calls
`reg.update()`; the new `sw.js` (its `VERSION` is stamped with the commit)
installs, `skipWaiting` and `clients.claim()` fire `controllerchange`, and the
page reloads itself at the first quiet moment. Nothing here is a mistake on its
own; together they are "an old version for a moment, then the current one".

Worth weighing in that session: the board HTML is **2.7MB**, so four seconds is
not a generous allowance on a phone; and when the worker's own `VERSION` has
*not* changed there is no `controllerchange`, so a page served stale stays
stale with nothing to correct it.

**Why not now** — this is delivery and caching, and the trade it governs is
offline-first behaviour on a weak signal. Not a rendering fix, and not one to
make without deciding what the app should do on a slow network.

**Status** — not fixed. Reproduction in this session; the mechanism is in
`sw.js` (`networkFirstPage`) and the registration block at the foot of
`life-vision-board.html`.

### 7. this week · the sand ground reads and writes layout inside a scroll handler

**What happens** — `twSandGroundPaint` sets `host.style.height = "0px"`, reads
`ov.scrollHeight` (a forced synchronous layout), and writes the height back. It
is called from `#thisWeekOverlay`'s scroll listener and from an unthrottled
`window.resize`.

**Verdict** — it cannot shake the page, and I checked rather than assumed: the
scroll listener's gate is `ov.scrollHeight > host.offsetHeight + 1`, so the
ground is never the tallest thing at the moment it runs, so collapsing it
cannot shorten the scroller below the content and the browser has nothing to
clamp. Measured: with the page forced 600px longer, one scroll event, scrollTop
992 → 992.

It did have a real defect, and that one is fixed by **(1)**: the ground was
measured before the header reserved the companion's lane, came out 69px short
(1230 against 1299), and so repainted on the **first scroll of every open**.
After the fix the ground matches the page at open and the handler no longer
fires.

**Why not now** — a forced layout in a scroll handler is worth restructuring,
but it is not a flash or a jitter, and rewriting it is exactly the "clean up
while you're in there" this session was told to avoid.

**Status** — not fixed, trigger removed.

### 8. this week · a transform written onto a transitioned slot

`companionWanderTo`'s last line is `slot.style.transform = y ? … : ""` on
`#twCompanion`, which carries `transition: transform 2.8s`. Everywhere else the
roam machinery writes a transform it first does `transition = "none"` → force a
reflow → `transition = ""` (see `companionRoamStop`, `roamClampToViewport`,
`roamMove`). This one branch does not, so a non-zero `y` would glide the
companion in over 2.8s from wherever it was.

Dead in today's layout — the note above it records that the goal blocks it aims
at are gone (item 138), so `y` is always 0 and the write is `""`. Listed
because it is a live instance of the pattern waiting for those blocks to come
back. **Status** — not fixed.

### 9. atlas · opens at the top, then scrolls to the current quarter

`openAtlas` scrolls to "you are here" inside a `requestAnimationFrame`, one
frame after the render. Same shape as **(5)**, and deliberate — it is the reason
the book was opened. Not observed to paint in between, and not reproducible on
the demo board, whose current quarter starts high enough that the scroll never
fires. Listed as a thing to watch on a board with several quarters behind it.
**Status** — not fixed, not reproduced.

---

## Checked and clear

- **Anything rendered more than once on open.** Every mount, counted by
  wholesale replacement of its children, across this week, the Atlas, Chapters,
  the FAQ, Tomorrow, the portrait, the weekly check-in and the release page, at
  both widths: exactly one render each. Held by
  `one-render-per-screen-open`.
- **Web fonts swapping in.** Zero font network requests — Great Vibes, Fraunces
  and Public Sans are all embedded as base64 `woff2` in the file.
  `document.fonts.ready` resolves at 115–250ms, and boot CLS is 0.0000 at both
  widths. Nothing swaps and nothing reflows behind it.
- **Images or SVGs without dimensions.** There is no `<img>` anywhere in the
  app. Every drawing is inline SVG with a `viewBox`, sized by CSS. The two
  `<svg>` without a `viewBox` are the `width="0" height="0"` filter
  definitions and a standalone export, neither of which is laid out.
- **Hover states that change size.** One rule in the stylesheet changes an
  element's size on hover — `.empty-seed:hover svg { transform: scale(1.06) }` —
  and a transform cannot move a neighbour. Nothing else touches width, height,
  padding, margin, font-size or border-width on `:hover`, `:active` or `:focus`.
- **Focus and the on-screen keyboard.** Focusing every visible field on seven
  screens produced no painted shift. The one keyboard-aware piece, this week's
  corner strip, lifts a `position: fixed` element by the visual viewport's own
  measure while the strip is open and writes nothing that lays out.
- **Stacking between overlays.** "How this works" and the books sheet both land
  above the Facts page and take the tap; the check-in ladder is consistent. One
  thing to know about, though nothing shows it: `.book-page.book-top
  { z-index: 200 }` never applies to anything, because every book page declares
  its own id z-index (157–166) and an id outranks two classes. The mechanism
  that actually keeps one book on top is
  `.book-page.open:not(.book-top) { visibility: hidden }`, not the z-index. No
  visible defect; the rule reads as the mechanism while not being it.
- **Scroll and resize handlers that read and write layout in the same frame.**
  Catalogued, six of them: the sand ground (**7** above); `seatSoon` →
  `seatCloseMark`, rAF-batched and writing only to an absolutely positioned
  mark; `roamClampToViewport`, debounced 120ms and suppressing its own
  transition; the paper canvas's `render`, debounced 180ms and touching only a
  canvas; the drawn focus ring, which reads a rect and writes an out-of-flow
  element nothing depends on; and the visual-viewport dock, which reads no
  layout at all.
- **A scroll-driven feedback loop.** 120 slow wheel ticks to the bottom
  followed by 40 hard ones, then overscroll, on the landing, the board, the
  Atlas, Chapters and the FAQ, at both widths: **zero** painted shifts
  anywhere, and `scrollHeight` never varied by a pixel during any of it.
- **A page that overflows by less than a phone toolbar** — the shape that makes
  a toolbar hunt. Every screen either fits exactly or overflows by hundreds of
  pixels: board 919, this week 392, Atlas 1005, Chapters 1342, FAQ 489, weekly
  check-in 703, Tomorrow 0.
- **100vh, `background-attachment: fixed`, scroll anchoring.** The two `vh`
  rules are **(4)**. There is no `background-attachment` anywhere. Nothing
  disables scroll anchoring, and no screen re-renders while it is scrolled.

---

## Still open — what I could not reproduce

**The shake at the foot of a scroll.** I found and fixed the two structural
causes I could see — the `vh` pages in **(4)**, and the sand ground's routine
trigger in **(7)** — but I could not make any page shake in a headless
Chromium, on any screen, at either width. Headless has no retracting toolbar
and no classic scrollbar, which is exactly where this class of bug lives, so a
negative there is weak evidence.

Two things would settle it quickly:

- **which page**, and whether it has goals on it. If it was the empty board or
  the portrait, **(4)** is very likely it and is already fixed. If it was a
  board with goals, it is not.
- **which browser, and phone or desktop.** A desktop-only shake points at
  classic scrollbars — the page gains a pixel, a scrollbar appears, the content
  narrows, it reflows shorter, the scrollbar goes. The book pages already carry
  `scrollbar-gutter: stable both-edges` against exactly that; the document
  itself does not.
