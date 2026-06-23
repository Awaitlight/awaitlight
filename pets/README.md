# Custom idle companion ("pet")

When no agent is working, Awaitlight shows a small original pixel creature that walks,
hops, sleeps, and plays by itself on a black screen. You can replace it with your own art —
**bring your own sprite, and you are responsible for the rights to whatever you use.**

Awaitlight ships **only** its own original creature. No third-party or copyrighted
characters are included or distributed. If you draw or import someone else's character,
that is entirely your call and your responsibility.

## The hook

The dashboard looks for a global function on the page:

```js
window.AWAITLIGHT_PET = function (ctx, api) {
  // Draw one frame of your companion here.
  // `ctx` is the 2D canvas context. `api` gives you the live pose + drawing helpers.
};
```

If `window.AWAITLIGHT_PET` is defined, the idle engine calls it every frame instead of
drawing the built-in creature. The rest of the engine (autonomous walk / hop / sleep /
wave / poke behaviors, blinking, the ground shadow, Zzz and sparkle effects) keeps running,
so you only have to draw the body — you get the animation for free.

If your function throws, the engine logs a warning once and falls back to the built-in pet.

## What `api` gives you

The second argument is a live object (re-read it each frame; the values reflect the
current frame):

| Field | What it is |
| --- | --- |
| `P` | Pose state: `lift`, `squash`, `lean`, `face` (1 / -1), `eyeMode` (`open` / `happy` / `sleep`), `look`, `blink`, `rArm`, `lArm`, `walking`, `zzz`, `spark`, and `x` (world x). |
| `beh` | Current behavior, e.g. `{ name: 'walk', t, dur }`. Names include `idle`, `walk`, `hop`, `look`, `wave`, `sleep`, `sparkle`, and the prop actions (`flag`, `gym`, `basketball`, `soccer`, `typing`, `juggle`, `permission`, etc.). |
| `COL` | The brand palette (`body`, `bodyHi`, `bodyLo`, `foot`, `eye`, `iris`, `white`, `star`, `glow`, …). Use it or ignore it. |
| `zT` | A monotonically increasing time (seconds) for your own cycles. |
| `S`, `BW`, `BH`, `BBOT` | Pixel scale and the reference body box, so your sprite tracks the screen size. |

### Drawing helpers (all already squash/stretch/face-aware)

- `art(ax, ay, w, h, color)` — fill a rectangle in the pet's local pixel grid.
- `artRound(axLeft, ayBottom, w, h, r, color)` — a rounded-rect block.
- `tri(cx, ayBase, w, h, color)` — a triangle (ears, spikes…).
- `legs(xs, w, h, color, footColor)` — little feet with an automatic walk bob.
- `drawEye(ax, ayBottom)` — the default eye (respects `eyeMode` / blink).
- `ground()`, `drawZzz()`, `drawSpark()`, `puff(...)` — shared effects.

Coordinates are in the pet's local grid: `x` runs left/right around the body center,
`y` runs upward from the floor. The helpers apply position, squash, lean, and facing for
you, so the same code works while the pet walks, hops, or sleeps.

## Minimal example

```html
<script>
window.AWAITLIGHT_PET = function (ctx, api) {
  const { art, artRound, drawEye, P, COL } = api;
  artRound(-8, 4, 16, 12, 5, COL.body);   // round body
  drawEye(-2, 11);                          // one eye, follows blink/look
};
</script>
```

Drop that on the page before the dashboard script runs (or inject it however you load the
dashboard), and your creature takes over the idle screen.

## A note on rights

The built-in creature is original to Awaitlight. Anything you supply through
`window.AWAITLIGHT_PET` (or any sprite you load) is yours to clear: do not use characters,
logos, or art you don't have permission to use. Awaitlight does not distribute, host, or
endorse any companion you add.
