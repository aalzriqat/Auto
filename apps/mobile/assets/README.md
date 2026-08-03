# AutoFlow mobile brand assets

## Source of truth

`assets/brand/source/` holds the **only** files you should generate from:

| File | What it is |
|------|------------|
| `autoflow-lockup.png` | 787×450 RGBA — the full logo: dark car + neon blue/orange flow + `AUTOFLOW` wordmark |
| `autoflow-mark.png` | 762×302 RGBA — the **mark only** (car + flow, no wordmark) |

Both carry **true alpha**, including the soft neon glow as genuine partial
transparency, so they composite correctly on any background. They were recovered
by exact two-background matting from a pair of renders of the identical artwork —
one on pure white, one on pure black:

```
α = 1 − (C_white − C_black) / 255      F = C_black / α
```

⚠️ **If you ever need to regenerate these, ask for that same white/black pair.**
A single render "on a transparent background" from an image generator is usually
a lie — it comes back as RGB with a checkerboard *painted into the pixels*, which
cannot be keyed cleanly. Three separate exports failed that way before the
white/black pair worked. A logo composited onto white also cannot be lifted off
it afterwards: the glow is baked in and leaves a grey halo on any dark background.

## The three generated files

| File | Size | Contents |
|------|------|----------|
| `icon.png` | 1024×1024 **RGB, no alpha** | The mark at 88% on `#0a0f1c`. iOS rejects an alpha channel on app icons. |
| `adaptive-icon.png` | 1024×1024 **RGBA, transparent** | Android adaptive **foreground**: the mark at **62%**, centred. The plate colour comes from `adaptiveIcon.backgroundColor`, *not* from this file. |
| `splash-logo.png` | 1400×800 RGBA | The full lockup, transparent, with no padding baked in. |

### Two rules these files exist to enforce

1. **The adaptive foreground must be transparent and stay inside the centre ~66%.**
   Android crops it to a circle/squircle. The version before this one was an
   opaque white square whose artwork ran edge to edge — so every launcher both
   drew a white box *and* sliced through the logo.
2. **Never bake padding or bars into the splash.** The previous `splash-logo.png`
   carried 150px of solid black across the top and bottom of a square canvas,
   which rendered as literal black bands on the splash screen.

## Colours

`#0a0f1c` is the mobile app's own dark canvas (`darkColors.background` in
`src/theme.ts`). The icon plate, `splashscreen_background`, `iconBackground` and
the web PWA `theme_color`/`background_color` all use it, so there is no colour
seam between the splash, the app, and the installed icon. Change it in one place
and you must change it in all of them.

The artwork is drawn for a dark backdrop — on white the neon glow washes out and
the dark car reads as a heavy blob. Don't put it on a light plate.

## Applying the icon — this app has a customized native `android/` dir

**Do not run `npx expo prebuild --clean`.** `android/` is committed and hand-tuned
(autolinking excludes, gradle tweaks, signing config) and prebuild wipes them.

Generate the density buckets directly instead:

- `mipmap-{mdpi,hdpi,xhdpi,xxhdpi,xxxhdpi}/ic_launcher.png` — 48/72/96/144/192, opaque
- `…/ic_launcher_round.png` — same sizes, circle-masked
- `…/ic_launcher_foreground.png` — 108/162/216/324/432, transparent, from `adaptive-icon.png`
- `drawable-*/splashscreen_logo.png` — 288/432/576/864/1152, transparent

Then rebuild the APK and verify on-device. ⚠️ Verifying a release APK by filename
does not work — `optimizeReleaseResources` renames resources (e.g.
`mipmap-anydpi-v26/ic_launcher.xml` → `res/BW.xml`). Use `aapt2 dump badging` or
`aapt2 dump resources` instead.
