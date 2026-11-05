// Compile with C++17 and -fsyntax-only. These assertions execute the same
// portable parser and motion arithmetic that src/main.cpp uses on the ESP32.
#include "servo_protocol.h"

namespace {
constexpr servo::Result resultFor(uint8_t seq, uint8_t op, uint16_t angle,
                                  uint8_t magic = 0xA5, uint8_t version = 1) {
  uint8_t bytes[] = {magic, version, seq, op, uint8_t(angle), uint8_t(angle >> 8)};
  servo::Command cmd;
  return servo::decode(bytes, sizeof(bytes), cmd);
}

constexpr bool decodesExactly(uint8_t seq, uint8_t op, uint16_t angle) {
  uint8_t bytes[] = {0xA5, 1, seq, op, uint8_t(angle), uint8_t(angle >> 8)};
  servo::Command cmd;
  return servo::decode(bytes, sizeof(bytes), cmd) == servo::Ok &&
         cmd.sequence == seq && cmd.op == op && cmd.angle == angle;
}

constexpr bool rejectsIncorrectLengths() {
  uint8_t bytes[20] = {0xA5, 1, 1, servo::SetAngle, 90, 0};
  for (size_t length = 0; length <= sizeof(bytes); ++length) {
    if (length == servo::CommandSize) continue;
    servo::Command cmd;
    if (servo::decode(bytes, length, cmd) != servo::BadFrame) return false;
  }
  servo::Command cmd;
  return servo::decode(nullptr, 0, cmd) == servo::BadFrame &&
         servo::decode(nullptr, servo::CommandSize, cmd) == servo::BadFrame;
}

constexpr bool checksLittleEndian() {
  uint8_t bytes[2] = {};
  servo::write16(bytes, 0xABCD);
  return bytes[0] == 0xCD && bytes[1] == 0xAB && servo::read16(bytes) == 0xABCD;
}

constexpr bool acceptsAllLogicalAngles() {
  for (uint16_t angle = 0; angle <= 180; ++angle) {
    if (!decodesExactly(255, servo::SetAngle, angle)) return false;
  }
  return true;
}

constexpr bool pulseRangeIsMonotonic() {
  uint16_t previous = 1000;
  for (uint16_t angle = 0; angle <= 180; ++angle) {
    const uint16_t pulse = servo::pulseFor(angle, 1000, 2000);
    if (pulse < previous || pulse < 1000 || pulse > 2000) return false;
    previous = pulse;
  }
  return true;
}

constexpr bool everyMotionStepStaysBetweenCurrentAndTarget() {
  for (uint16_t current = 0; current <= 180; ++current) {
    for (uint16_t target = 0; target <= 180; ++target) {
      const uint16_t next = servo::stepToward(current, target);
      if (current < target) {
        if (next <= current || next > target || next - current > 2) return false;
      } else if (current > target) {
        if (next >= current || next < target || current - next > 2) return false;
      } else if (next != current) {
        return false;
      }
    }
  }
  return true;
}

constexpr bool convergesBothDirections() {
  uint16_t up = 0, down = 180;
  for (unsigned step = 0; step < 90; ++step) {
    up = servo::stepToward(up, 180);
    down = servo::stepToward(down, 0);
  }
  return up == 180 && down == 0 &&
         servo::stepToward(up, 180) == 180 && servo::stepToward(down, 0) == 0;
}

static_assert(servo::CommandSize == 6 && servo::StatusSize == 18, "BLE frames must fit the default MTU");
static_assert(checksLittleEndian(), "16-bit fields must use little endian");
static_assert(rejectsIncorrectLengths(), "Reject empty, truncated and oversized commands");
static_assert(resultFor(1, servo::SetAngle, 90, 0x5A) == servo::BadFrame, "Reject incorrect magic");
static_assert(resultFor(1, servo::SetAngle, 90, 0xA5, 2) == servo::BadFrame, "Reject unsupported version");
static_assert(resultFor(0, servo::SetAngle, 90) == servo::BadFrame, "Sequence zero is reserved for telemetry");
static_assert(resultFor(1, 0, 90) == servo::BadFrame, "Reject operation zero");
static_assert(resultFor(1, 3, 90) == servo::BadFrame, "Reject unknown operation");
static_assert(resultFor(1, servo::SetAngle, 181) == servo::BadAngle, "Reject angle above 180");
static_assert(resultFor(1, servo::SetAngle, 0xFFFF) == servo::BadAngle, "Reject wrapped negative angle");
static_assert(resultFor(1, servo::SetAngle, 0x0100) == servo::BadAngle, "Check both angle bytes");
static_assert(decodesExactly(1, servo::SetAngle, 0), "Accept minimum angle");
static_assert(decodesExactly(127, servo::SetAngle, 90), "Accept center angle");
static_assert(decodesExactly(255, servo::SetAngle, 180), "Accept maximum angle and sequence");
static_assert(acceptsAllLogicalAngles(), "Accept all integer angles from zero through 180");
static_assert(decodesExactly(1, servo::Release, 0), "Release requires angle zero");
static_assert(resultFor(1, servo::Release, 1) == servo::BadAngle, "Reject a nonzero release argument");
static_assert(resultFor(1, servo::Release, 0x0100) == servo::BadAngle, "Check both release argument bytes");
static_assert(servo::pulseFor(0, 1000, 2000) == 1000, "Minimum pulse");
static_assert(servo::pulseFor(90, 1000, 2000) == 1500, "Center pulse");
static_assert(servo::pulseFor(180, 1000, 2000) == 2000, "Maximum pulse");
static_assert(servo::pulseFor(90, 600, 2400) == 1500, "Honor customized pulse calibration");
static_assert(pulseRangeIsMonotonic(), "All default pulses must stay within the calibrated range");
static_assert(servo::stepToward(89, 90) == 90 && servo::stepToward(91, 90) == 90, "Do not overshoot one-degree moves");
static_assert(everyMotionStepStaysBetweenCurrentAndTarget(), "Every pair of angles must step toward the target without overshoot");
static_assert(convergesBothDirections(), "Full-range movement must stop exactly at either endpoint");
}
