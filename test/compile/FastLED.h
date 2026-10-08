// Minimal stand-in for FastLED so generated code can be syntax checked without the real library.
#pragma once
#include <stdint.h>
#include <string.h>
#define PROGMEM
#define pgm_read_byte(p) (*(const uint8_t*)(p))
#define pgm_read_word(p) (*(const uint16_t*)(p))
static inline float pgm_read_float(const void* p) { float f; memcpy(&f, p, sizeof f); return f; }
struct CHSV { uint8_t h, s, v; CHSV(uint8_t a, uint8_t b, uint8_t c) : h(a), s(b), v(c) {} };
struct CRGB { uint8_t r, g, b; enum HTMLColorCode { Black = 0 }; CRGB() : r(0), g(0), b(0) {} CRGB(HTMLColorCode) : r(0), g(0), b(0) {} CRGB(const CHSV&) : r(0), g(0), b(0) {} };
enum EOrder { RGB, GRB, BRG, RBG, GBR, BGR };
struct WS2815 {}; struct WS2812B {};
struct CFastLED { template <typename T, int PIN, EOrder O> void addLeds(CRGB*, int, int) {} void setMaxPowerInVoltsAndMilliamps(int, int) {} void show() {} };
static CFastLED FastLED; unsigned long millis();
