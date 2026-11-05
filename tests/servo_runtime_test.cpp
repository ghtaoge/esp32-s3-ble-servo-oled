// Compile with C++17 and -fsyntax-only. Test the real runtime helpers without
// requiring ESP32 hardware, an RTOS simulator, or a duplicate implementation.
#include "servo_runtime.h"

namespace {
constexpr bool unchangedRowsHaveNoSpan() {
  uint8_t frame[128] = {}, previous[128] = {};
  for (size_t offset = 0; offset < 128; ++offset) {
    frame[offset] = previous[offset] = uint8_t(offset);
  }
  const auto span = servo::changedTiles(frame, previous);
  return span.first == 0 && span.count == 0;
}

constexpr bool findsEverySingleChangedByte() {
  uint8_t frame[128] = {}, previous[128] = {};
  for (size_t offset = 0; offset < 128; ++offset) {
    frame[offset] = 0xA5;
    const auto span = servo::changedTiles(frame, previous);
    const auto reversed = servo::changedTiles(previous, frame);
    if (span.first != offset / 8 || span.count != 1 ||
        reversed.first != span.first || reversed.count != span.count) return false;
    frame[offset] = 0;
  }
  return true;
}

constexpr bool sparseChangesIncludeFirstAndLastChangedTiles() {
  uint8_t frame[128] = {}, previous[128] = {};
  frame[17] = 1;   // Tile 2.
  frame[103] = 1;  // Tile 12, leaving unchanged tiles in between.
  auto span = servo::changedTiles(frame, previous);
  if (span.first != 2 || span.count != 11) return false;
  frame[0] = 1;
  frame[127] = 1;
  span = servo::changedTiles(frame, previous);
  return span.first == 0 && span.count == 16;
}

constexpr bool neverIncludesBytesFromAdjacentRows() {
  uint8_t frame[130] = {}, previous[130] = {};
  // The tested row starts at index 1 and ends at index 128.
  frame[0] = 1;
  frame[129] = 1;
  auto span = servo::changedTiles(frame + 1, previous + 1);
  if (span.count != 0) return false;
  frame[128] = 1;
  span = servo::changedTiles(frame + 1, previous + 1);
  return span.first == 15 && span.count == 1;
}

constexpr bool allChangedSpansStayWithinSixteenTiles() {
  uint8_t frame[128] = {}, previous[128] = {};
  for (uint8_t first = 0; first < 16; ++first) {
    frame[size_t(first) * 8 + 7] = 1;
    for (uint8_t last = first; last < 16; ++last) {
      frame[size_t(last) * 8] = 2;
      const auto span = servo::changedTiles(frame, previous);
      if (span.first != first || span.count != last - first + 1 ||
          span.count == 0 || span.first + span.count > 16) return false;
      frame[size_t(last) * 8] = 0;
    }
    frame[size_t(first) * 8 + 7] = 0;
  }
  return true;
}

constexpr bool waitDeadlinesWorkAcrossClockRollover() {
  constexpr uint32_t starts[] = {0U, 123456U, 0xFFFFFFF0U, 0xFFFFFFFFU};
  for (uint32_t start : starts) {
    for (uint32_t elapsed = 0; elapsed <= 100; ++elapsed) {
      const uint32_t now = start + elapsed;
      const uint32_t wait = servo::waitForStep(now, start, true);
      if (elapsed < 20) {
        if (wait != 20 - elapsed) return false;
      } else if (wait != 0) {
        return false;
      }
      if (servo::waitForStep(now, start, false) != 20) return false;
    }
  }
  return true;
}

constexpr bool reconnectsInvalidateEveryEarlierToken() {
  uint32_t token = 0;
  for (uint32_t generation = 1; generation <= 1000; ++generation) {
    const bool connected = (generation & 1U) != 0;
    const uint32_t next = servo::nextLink(token, connected);
    if (next == token || servo::linkConnected(next) != connected ||
        (next & ~1U) != generation * 2U) return false;
    token = next;
  }
  return true;
}

static_assert(unchangedRowsHaveNoSpan(), "Unchanged framebuffer rows must not be transmitted");
static_assert(findsEverySingleChangedByte(), "All 128 byte positions must map to the correct tile");
static_assert(sparseChangesIncludeFirstAndLastChangedTiles(), "Sparse changes must include the complete tile span");
static_assert(neverIncludesBytesFromAdjacentRows(), "Comparison must stop exactly at the row boundary");
static_assert(allChangedSpansStayWithinSixteenTiles(), "Every tile-pair span must stay inside the 16-tile display width");
static_assert(servo::waitForStep(100, 100, true) == 20, "A new step is due in 20ms");
static_assert(servo::waitForStep(119, 100, true) == 1, "Wait only until the next deadline");
static_assert(servo::waitForStep(120, 100, true) == 0, "A due step must never block on the queue");
static_assert(servo::waitForStep(1000, 100, true) == 0, "An overdue step must run immediately");
static_assert(servo::waitForStep(5U, 0xFFFFFFF5U, true) == 4, "Unsigned millisecond rollover must preserve remaining time");
static_assert(servo::waitForStep(9U, 0xFFFFFFF5U, true) == 0, "A deadline crossing rollover must be due exactly once elapsed");
static_assert(servo::waitForStep(1U, 1000U, false) == 20, "Idle waiting must be bounded regardless of the previous step time");
static_assert(waitDeadlinesWorkAcrossClockRollover(), "Check every deadline offset before and after clock rollover");
static_assert(!servo::linkConnected(0) && servo::linkConnected(3), "The low token bit holds connection state");
static_assert(servo::nextLink(0, true) == 3, "Connect advances the generation");
static_assert(servo::nextLink(3, false) == 4, "Disconnect advances the generation and clears the connected bit");
static_assert(servo::nextLink(4, true) == 7, "Rapid reconnect cannot reuse the previous connected token");
static_assert(servo::nextLink(3, true) == 5, "Even repeated same-state events must invalidate older queued work");
static_assert(reconnectsInvalidateEveryEarlierToken(), "Exercise repeated rapid connect/disconnect changes");
static_assert(servo::nextLink(0xFFFFFFFFU, false) == 0, "Disconnected generation wrap must remain valid");
static_assert(servo::nextLink(0xFFFFFFFEU, true) == 1, "Connected generation wrap must preserve its state bit");
static_assert(servo::nextLink(servo::nextLink(0xFFFFFFFFU, false), true) == 3,
              "Reconnect after generation wrap must invalidate the pre-wrap token");
}
