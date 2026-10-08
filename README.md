# EasyLEDMap

Turn a photo of addressable LEDs into a pixel map for WLED, FastLED and TouchDesigner.

You add a photo, trace the path the data takes, and the tool counts and places the LEDs along
it. Then you mark dead pixels, name groups, and export. Everything runs in the browser. Photos
are never uploaded.

Status: version 0.2. It was built for S-type (bendable) strips with 5050 LEDs. There are two
ways to map: photograph the LEDs lit, which is the most accurate, or trace an unlit strip by
hand. See [What it does not do yet](#what-it-does-not-do-yet).

## Run it

- **Online:** open the GitHub Pages site for this repository. After the first visit it also
  works with no network, and Chrome or Edge can install it as an app.
- **From a file:** download `dist/easyledmap.html` and double-click it. It is the whole tool in
  one file, so it is the easy choice for a job site with no internet.
- **From source:** `python3 -m http.server 8765` in this folder, then open
  http://localhost:8765.

## Map from a photo of lit LEDs

This is the accurate route. Every LED position comes from the photo, so uneven spacing and
squeezed turns do not matter.

1. Light the strip in a repeating **red, green, blue** cycle. In WLED: effect **Solid Pattern
   Tri**, the three colours set to red, green and blue, the Size slider at its lowest, and
   brightness low (10 to 20 of 255). Set each output a little longer than you think it is, so no
   LED at the end stays dark.
2. Photograph it straight-on with the panel filling the frame. Lower the exposure until each LED
   is a separate dot. A shot with the room lights dimmed is the safest.
3. Add the photo and choose **Find lit LEDs**. The tool finds the LEDs, reads the wiring order
   and direction from the colour cycle, and makes a first guess at rows and turns: LEDs in
   turns go dead and each row becomes a group.
4. Check the guess. Short runs at the ends of a panel are the likeliest to be wrong. Select a
   run and use Mark dead or Mark live, or run **Find rows and turns** again after fixing.

If more than one strip is lit in the photo, set "Separate strips lit in this photo" under
Photographing lit LEDs before you choose Find lit LEDs.

Lit in a single colour instead? The LEDs are still found, but ordered by nearest neighbour.
Select the true first pixel and choose a reorder button.

## Map an unlit strip by tracing

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
   - **Finish strip** (or `Enter`) says the strip is complete. Your next click then starts a
     new strip. `Escape` only pauses, and Continue picks a finished strip up again.
   - With **Group each row** on, every row becomes its own group.
5. **Check the numbers.** Index labels appear at the ends of every run, so you can compare
   them with numbers written on the piece. LEDs with a dashed ring are ones the tool was unsure
   about.
6. **Fix anything, at any time.** The LEDs you clicked are pinned, shown with a white centre.
   The ones the tool placed between them float. Drag any LED to where it really is and it
   becomes a pin: the LEDs either side spread out to follow. Select a floating LED and press
   `[` or `]` to change how many sit between its two pins. You can also delete, mark dead
   (`D`), insert an LED on the wire (Add LED), and undo (`Ctrl+Z`).
7. **Export**, and export again whenever you change something.
8. **Save project** writes a `.ledmap` file you can reopen later. Work is also kept in the
   browser between visits.

### More than one strip

Each strip is one data pin. Finish one strip and your next click starts the next. Set each
strip's GPIO in the Strips panel. Strips are numbered in list order: the second strip's first pixel follows
the first strip's last.

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
| `[` `]` | One fewer or one more LED in the last leg, between two pins, or in the selected run |
| `Enter`, `Escape` | While drawing: finish the strip, or pause it |
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
  LEDs between your clicks. On S-type strips the spacing varies and turns get squeezed, so
  counts in turns are often off. A lit photo avoids all of that.
- Lit detection has been tested on generated photos, not yet on a wide range of real ones.
- Rows and turns are guessed from the shape of the strip. It is a first pass to correct.
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
python3 tools/make_fixture.py   # redraws the generated test photos
npm run build      # writes dist/easyledmap.html
```

To publish on GitHub Pages: Settings, Pages, deploy from the `main` branch, root folder.

## Credits and licence

Designed by Matt Richard. Code written with Claude (Anthropic).

MIT licence. See [LICENSE](LICENSE) and [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
