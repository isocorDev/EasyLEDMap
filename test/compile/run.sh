#!/bin/sh
# Syntax checks the generated FastLED and WLED code against stub headers. Needs g++.
# This proves the code parses as C++. It does not prove it runs on hardware.
set -e
cd "$(dirname "$0")"; OUT=$(mktemp -d); node gen.js "$OUT"
for v in a b c; do
  cp "$OUT/$v/led_map_example.ino" "$OUT/$v/sketch.cpp"
  g++ -std=c++11 -Wall -fsyntax-only -I. -I"$OUT/$v" "$OUT/$v/sketch.cpp"
  if [ -f "$OUT/$v/lm_group_effect_example.h" ]; then printf '#include "wled_stub.h"\n#include "lm_group_effect_example.h"\nint main(){return mode_lm_groups();}\n' > "$OUT/$v/w.cpp"
  else printf '#include "wled_stub.h"\n#include "led_map_wled.h"\nint main(){return LM_NUM_PIXELS;}\n' > "$OUT/$v/w.cpp"; fi
  g++ -std=c++11 -Wall -fsyntax-only -I. -I"$OUT/$v" "$OUT/$v/w.cpp"
done
rm -rf "$OUT"; echo "compile: generated code parses in all three configurations"
