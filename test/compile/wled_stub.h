// Minimal stand-in for the parts of the WLED 0.15 effect API the example uses.
#include <stdint.h>
#define PROGMEM
#define pgm_read_word(p) (*(const uint16_t*)(p))
#define FRAMETIME 16
struct Seg { uint32_t color_from_palette(uint16_t, bool, bool, uint8_t) { return 0; } void setPixelColor(int, uint32_t) {} };
static Seg SEGMENT; struct Strip { unsigned long now; }; static Strip strip;
