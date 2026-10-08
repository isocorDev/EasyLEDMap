# Third party notices

LED Mapper bundles no third party code. It uses only what the browser provides.

The files it exports are meant to be used with other projects, each under its own licence:

- **WLED** is licensed under the EUPL v1.2. `ledmap.json` is a data file that WLED reads.
  `led_map_wled.h` and `lm_group_effect_example.h` are meant to be compiled into a WLED build,
  and the example effect calls the WLED effect API. If you distribute a WLED build that
  includes them, the EUPL applies to that build. This is orientation, not legal advice.
- **FastLED** is licensed under the MIT licence. `led_map.h` and `led_map_example.ino`
  include `FastLED.h` and call its API.
- **TouchDesigner** is a commercial product of Derivative. The CSV and PNG exports are plain
  data files.

The generated files themselves carry no licence terms from LED Mapper: use them as you like.
