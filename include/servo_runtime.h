#pragma once
#include <stddef.h>
#include <stdint.h>

namespace servo {
// One atomic token carries both connection state and generation. A fast
// disconnect/reconnect must still invalidate every command from the old link.
constexpr bool linkConnected(uint32_t token) { return token & 1U; }
constexpr uint32_t nextLink(uint32_t token, bool connected) {
  return ((token + 2U) & ~1U) | uint32_t(connected);
}
constexpr uint32_t waitForStep(uint32_t now, uint32_t stepAt, bool moving) {
  const uint32_t elapsed = now - stepAt;
  return !moving ? 20U : elapsed >= 20U ? 0U : 20U - elapsed;
}

struct TileSpan { uint8_t first = 0, count = 0; };
// SSD1306 R0 full-buffer layout: 16 tiles per 128-byte row, 8 bytes per tile.
constexpr TileSpan changedTiles(const uint8_t* frame, const uint8_t* previous) {
  TileSpan span;
  for (uint8_t tile = 0; tile < 16; ++tile) {
    for (uint8_t byte = 0; byte < 8; ++byte) {
      const size_t offset = size_t(tile) * 8 + byte;
      if (frame[offset] == previous[offset]) continue;
      if (!span.count) span.first = tile;
      span.count = tile - span.first + 1;
      break;
    }
  }
  return span;
}
}
