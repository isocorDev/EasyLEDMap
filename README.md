# LED Mapper

Turn a photo of addressable LEDs into a pixel map for WLED, FastLED and TouchDesigner.

You add a photo, trace the path the data takes, and the tool counts and places the LEDs along
it. Then you mark dead pixels, name groups, and export. Everything runs in the browser. Photos
are never uploaded.

Status: version 0.1. It was built for S-type (bendable) strips with 5050 LEDs and is tested on
those. See [What it does not do yet](#what-it-does-not-do-yet).

## Run it

- **Online:** open the GitHub Pages site for this repository. After the first visit it also
  works with no network, and Chrome or Edge can install it as an app.
- **From a file:** download `dist/led-mapper.html` and double-click it. It is the whole tool in
  one file, so it is the easy choice for a job site with no internet.
- **From source:** `python3 -m http.server 8765` in this folder, then open
  http://localhost:8765.

## Map a strip

1. **Setup.** Pick the chipset. Voltage, current per pixel and colour order fill in and can be
   changed.
2. **Add photos.** One or more. Shoot as straight-on as you can, with the panel filling the
   frame.
3. **Set the spacing.** Choose Draw path. The first time on each photo it asks you to click
   two LEDs that sit next to each other.
4. **Draw the path.** Click the first LED, where data enters. Then click the last LED of that
   straight run. The tool counts the LEDs between your two clicks and places them. Keep
   clicking corners along the wire.
   - With **Rows and turns** on, legs alternate: a row of live pixels, then a turn whose
     in-between LEDs are marked dead. So a serpentine takes two clicks per row.
   - The count for each leg shows in the bar. `[` and `]` fix it. `Backspace` steps back.
   - On a curved turn, hold `Shift` and click each LED in it. Shift-click places exactly one LED.
   - `J` marks the last leg as a wire jump with no LEDs between the two points.
   - `Enter` finishes. With **Group each row** on, every row becomes its own group.
5. **Check the numbers.** Index labels appear at the ends of every run, so you can compare
   them with numbers written on the piece. LEDs with a dashed ring are ones the tool was unsure
   about.
6. **Fix anything.** Select, drag, delete, mark dead (`D`), change the count of a run
   (`[` `]`), insert an LED on the wire (Add LED), undo (`Ctrl+Z`).
7. **Export**, and export again whenever you change something.
8. **Save project** writes a `.ledmap` file you can reopen later. Work is also kept in the
   browser between visits.

### More than one strip

Each strip is one data pin. Choose **Add strip** before drawing the next one, then set its GPIO
in the Strips panel. Strips are numbered in list order: the second strip's first pixel follows
the first strip's last.

### Lit LEDs

For a photo taken with the LEDs on, choose **Find lit LEDs**. The tool finds the bright spots
and orders them by nearest neighbour. Select the true first pixel and choose a reorder button
to start from there.

### Angled photos and several photos

**Flatten photo** corrects for camera angle: drag four handles onto any flat rectangle of known
size in the shot (floor tiles work well). The **Layout** tab arranges several photos into one
assembly. Photos are scaled to match each other using their LED spacing.

## Keys

| Key | Does |
|---|---|
| `V` `P` `A` `H` | Select, Draw path, Add LED, Pan |
| Scroll, pinch | Zoom. Hold `Space` and drag to pan |
| `F` | Fit to window |
| `[` `]` | One fewer or one more LED in the last leg, or in the selected run |
| `D` | Dead or live |
| `G` | New group from the selection |
| `T` `J` | While drawing: switch the last leg between row and turn, or make it a wire jump |
| `Shift`-click | While drawing: place one LED. In Select: select a range along the wire |
| Double-click | Select a whole run |
| Arrows | Nudge the selection |
| `Ctrl+Z`, `Ctrl+Shift+Z`, `Ctrl+S` | Undo, redo, save |

## What the exports contain

Every export lets you choose the origin, Y direction, number range and number type, and
whether to keep the layout's proportions.

**WLED**
- `ledmap.json`: maps the pixels effects see onto the wire. Dead pixels are left unmapped, so
  they stay dark. The map is padded with -1 to the full length, because WLED 0.15 lights
  pixels past the end of a short map.
- `led_map_wled.h`: group start and length tables, group centres and pixel positions, for
  custom effects and usermods.
- `lm_group_effect_example.h`: a starting point for an effect that lights each group as one
  pixel.
- `wled_setup.md`: output table (GPIO, type, length), current settings, and how to load the map.

Stock WLED cannot make many unequal groups each behave as one pixel: segments are capped at 32
on a standard ESP32 and segment grouping only handles equal sizes. That is why groups are
exported as a header for custom effects.

**FastLED**
- `led_map.h`: positions, group and dead flags for every LED in data order, strip pins and
  ranges, and an optional `XY(x, y)` grid lookup.
- `led_map_example.ino`: `addLeds` calls for each strip and a small demo loop.

**TouchDesigner**
- `led_map.csv`: one row per LED with x, y, u, v, strip, group, dead flag, and Art-Net universe
  and channel.
- `led_groups.csv`, `led_layout.png`, and `led_uv_16bit.png`, a UV lookup texture for a Remap
  TOP.

The generated C++ is syntax checked by the test suite against stub headers. It has not been
run on hardware by the tool's authors for every configuration: read it before you flash it.

## What it does not do yet

- **Unlit strips are not found automatically.** You trace the path and the tool counts the
  LEDs between your clicks. Lit LEDs are found automatically.
- Turn counts are an estimate from distance. Check them, or Shift-click each LED.
- Flattened photos show as LED positions only in the Layout tab. The photo is not warped.
- No snapping of two photos of one panel onto each other. Align them by hand in Layout.
- No DXF import, no power injection planner, no video or 3D capture.
- Touch works for viewing and simple edits. Dense editing wants a mouse or trackpad.

## Develop

No build step and no dependencies. The app is plain scripts in `js/`.

```
npm test           # counting, exporters, and a compile check of generated code (needs g++)
npm run serve      # in one terminal
npm run test:ui    # in another: browser tests, needs Playwright
npm run build      # writes dist/led-mapper.html
```

To publish on GitHub Pages: Settings, Pages, deploy from the `main` branch, root folder.

## Credits and licence

Designed by Matt Richard. Code written with Claude (Anthropic).

MIT licence. See [LICENSE](LICENSE) and [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
