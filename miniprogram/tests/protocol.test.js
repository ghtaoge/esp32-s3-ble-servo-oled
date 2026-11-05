const { test } = require('node:test');
const assert = require('node:assert/strict');
const p = require('../utils/protocol');
function state(patch = {}) {
  const b = Uint8Array.from([0x5A, 1, 0, 0, 0, 1, 90, 0, 90, 0, 0, 0, 0, 180, 0xE8, 3, 0xD0, 7]);
  Object.keys(patch).forEach(index => { b[index] = patch[index]; });
  return b.buffer;
}
test('wire commands encode endpoints and release in the six-byte protocol', () => {
  assert.deepEqual(Array.from(p.command(1, 1, 0)), [0xA5, 1, 1, 1, 0, 0]);
  assert.deepEqual(Array.from(p.command(255, 1, 180)), [0xA5, 1, 255, 1, 180, 0]);
  assert.deepEqual(Array.from(p.command(32, 2)), [0xA5, 1, 32, 2, 0, 0]);
});
test('invalid angles, sequences and release payloads never become commands', () => {
  for (const angle of [-1, 181, 2.5, NaN, Infinity, '90', null]) assert.throws(() => p.command(1, 1, angle));
  for (const sequence of [0, 256, -1, 1.5, '1']) assert.throws(() => p.command(sequence, 1, 90));
  assert.throws(() => p.command(1, 3, 90));
  assert.throws(() => p.command(1, 2, 90));
});
test('decode distinguishes released outputs and enabled motion without claiming measured position', () => {
  const released = p.decode(state()).state;
  assert.deepEqual(released, { oledReady: true, enabled: false, moving: false, target: 90, output: 90, pulse: 0,
    minAngle: 0, maxAngle: 180, minPulse: 1000, maxPulse: 2000 });
  const enabled = p.decode(state({ 2: 12, 3: 1, 5: 6, 6: 135, 8: 100, 10: 0x14, 11: 6 }));
  assert.equal(enabled.sequence, 12);
  assert.equal(enabled.op, 1);
  assert.equal(enabled.state.oledReady, false);
  assert.equal(enabled.state.enabled, true);
  assert.equal(enabled.state.moving, true);
  assert.equal(enabled.state.pulse, 1556);
});
test('truncated, incompatible or inconsistent status frames are rejected', () => {
  for (const frame of [new ArrayBuffer(17), new ArrayBuffer(19), new Uint8Array(18), null]) assert.throws(() => p.decode(frame));
  for (const patch of [{ 0: 0 }, { 1: 2 }, { 3: 1 }, { 2: 1 }, { 2: 1, 3: 3 }, { 4: 1 },
    { 2: 1, 3: 1, 4: 4 }, { 5: 8 }, { 6: 181 }, { 8: 181 }, { 5: 5 }, { 10: 1 },
    { 5: 3 }, { 12: 1 }, { 13: 150 }, { 14: 0, 15: 0 }, { 16: 0xE8, 17: 3 }]) {
    assert.throws(() => p.decode(state(patch)), JSON.stringify(patch));
  }
});
test('nonzero command results remain available to the BLE client', () => {
  for (let result = 1; result <= 3; result++) assert.equal(p.decode(state({ 2: 1, 3: 1, 4: result })).result, result);
});
