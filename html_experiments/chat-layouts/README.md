# Chat Layout Experiments

Mobile viewport stability — scroll, keyboard, pinch-zoom.

## Files

| file | technique | height unit |
|---|---|---|
| chat1-grid-dvh.html | CSS Grid | 100dvh |
| chat2-grid-svh.html | CSS Grid | 100svh |
| chat3-fixed.html | position:fixed header+footer | body scrolls |
| chat4-flex-svh.html | Flex column | 100svh |
| chat5-flex-dvh-js.html | Flex + JS visualViewport | var(--app-h) |

## Problem

On mobile pinch-zoom: message area shrinks because `visualViewport.height`
changes → `--app-h` CSS var updates → layout reflows.

Current webclaude = layout 5.

## Units

| unit | value | changes on keyboard | changes on zoom |
|---|---|---|---|
| lvh | largest (no keyboard) | no | no |
| svh | smallest (with keyboard) | no | no |
| dvh | current state | yes | yes |
| var(--app-h) | JS-measured visual vp | yes | yes |

## Experiment Results

| # | platform | zoom | zoom+scroll | keyboard focus | keyboard unfocus |
|---|---|---|---|---|---|
| 1 grid+dvh | iOS | ok | occasionally broken; when works: list only | zooms in, no occlude, no reset | no reset |
| 2 grid+svh | iOS | ok | occasionally broken; when works: list only | zooms in, no occlude, no reset | no reset |
| 3 fixed | iOS | ok | both list+page scroll; list scrolls relative to page | zooms in, no occlude | resets position; list content stays offset |
| 4 flex+svh | iOS | ok | occasionally broken; when works: list only | zooms in, no occlude, no reset | no reset |
| 5 flex+dvh+js | iOS | keyboard jumps to occlude content | — | unusable | — |
| 1 grid+dvh | Android | ok | list scrolls to end, then main scrolls | ok | ok |
| 2 grid+svh | Android | ok | list scrolls to end, then main scrolls | ok | ok |
| 3 fixed | Android | ok | both list+page scroll; list scrolls relative to page | ok | sometimes textbox clips under bottom edge of viewport |
| 4 flex+svh | Android | ok | list scrolls to end, then main scrolls | ok | ok |
| 5 flex+dvh+js | Android | keyboard jumps to occlude content | — | unusable | — |

## AI Prediction

- **layout 3 (fixed)**: most robust across all browsers/iOS versions; always
  works; zero zoom issues; requires JS only for dynamic input height
- **layout 4 (flex+svh)**: best fit for webclaude structure; one-line change
  from current; keyboard overlaps rather than resizes (matches WhatsApp/iMessage UX)
- **layout 2 (grid+svh)**: equivalent to 4, cleaner CSS, but grid on body is
  unconventional and may confuse future devs
- **layout 1 (grid+dvh)**: same zoom reflow as current; no improvement
- **layout 5 (current)**: zoom reflow confirmed; JS overhead; fragile

**Recommended migration**: layout 4. Replace `--app-h` JS + `height: var(--app-h)`
with `height: 100svh`. Remove visualViewport listener. Keep all other flex chain
as-is (already has `min-height: 0` from recent fix).
