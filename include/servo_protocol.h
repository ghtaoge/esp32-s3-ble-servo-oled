#pragma once
#include <stddef.h>
#include <stdint.h>

namespace servo {
constexpr uint8_t Version = 1;
constexpr uint16_t MinAngle = 0, MaxAngle = 180;
constexpr size_t CommandSize = 6, StatusSize = 18;
enum Operation : uint8_t { SetAngle = 1, Release = 2 };
enum Result : uint8_t { Ok = 0, BadFrame = 1, BadAngle = 2, PwmError = 3 };
struct Command { uint8_t sequence = 0, op = 0; uint16_t angle = 0; };
constexpr uint16_t read16(const uint8_t* bytes) { return bytes[0] | uint16_t(bytes[1]) << 8; }
constexpr void write16(uint8_t* bytes, uint16_t value) { bytes[0] = value; bytes[1] = value >> 8; }
constexpr Result decode(const uint8_t* bytes, size_t size, Command& cmd) {
  if (!bytes || size != CommandSize || bytes[0] != 0xA5 || bytes[1] != Version || !bytes[2]) return BadFrame;
  cmd.sequence = bytes[2]; cmd.op = bytes[3]; cmd.angle = read16(bytes + 4);
  if (cmd.op != SetAngle && cmd.op != Release) return BadFrame;
  if ((cmd.op == SetAngle && cmd.angle > MaxAngle) || (cmd.op == Release && cmd.angle != 0)) return BadAngle;
  return Ok;
}
constexpr uint16_t pulseFor(uint16_t angle, uint16_t minUs, uint16_t maxUs) {
  return minUs + (uint32_t(angle) * (maxUs - minUs) + 90) / 180;
}
constexpr uint16_t stepToward(uint16_t output, uint16_t target, uint16_t step = 2) {
  if (output < target) return target - output <= step ? target : output + step;
  return output - target <= step ? target : output - step;
}
}
