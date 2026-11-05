const SERVICE_UUID = 'e75a0001-4e42-4ea0-9b38-33c7bc713100';
const WRITE_UUID = 'e75a0002-4e42-4ea0-9b38-33c7bc713100';
const STATUS_UUID = 'e75a0003-4e42-4ea0-9b38-33c7bc713100';

function command(sequence, op, angle = 0) {
  if (!Number.isInteger(sequence) || sequence < 1 || sequence > 255) throw new Error('无效的指令编号');
  if (op !== 1 && op !== 2) throw new Error('无效的舵机指令');
  if (!Number.isInteger(angle) || angle < 0 || angle > 180 || (op === 2 && angle !== 0)) throw new Error('角度必须是 0 到 180 的整数');
  return Uint8Array.from([0xA5, 1, sequence, op, angle & 255, angle >> 8]);
}

function decode(buffer) {
  if (!(buffer instanceof ArrayBuffer) || buffer.byteLength !== 18) throw new Error('开发板状态数据长度不正确');
  const b = new Uint8Array(buffer);
  const word = offset => b[offset] | b[offset + 1] << 8;
  if (b[0] !== 0x5A || b[1] !== 1 || b[4] > 3 || (b[5] & ~7) ||
      (b[2] === 0 ? b[3] !== 0 || b[4] !== 0 : b[3] !== 1 && b[3] !== 2)) throw new Error('开发板状态协议不兼容');
  const state = {
    oledReady: !!(b[5] & 1), enabled: !!(b[5] & 2), moving: !!(b[5] & 4),
    target: word(6), output: word(8), pulse: word(10),
    minAngle: b[12], maxAngle: b[13], minPulse: word(14), maxPulse: word(16)
  };
  if (state.minAngle !== 0 || state.maxAngle !== 180 || state.target > 180 || state.output > 180 ||
      !state.minPulse || state.minPulse >= state.maxPulse || state.maxPulse >= 20000 ||
      (!state.enabled && (state.pulse !== 0 || state.moving)) ||
      (state.enabled && (state.pulse < state.minPulse || state.pulse > state.maxPulse))) throw new Error('开发板状态超出有效范围');
  return { sequence: b[2], op: b[3], result: b[4], state };
}

module.exports = { SERVICE_UUID, WRITE_UUID, STATUS_UUID, command, decode };
