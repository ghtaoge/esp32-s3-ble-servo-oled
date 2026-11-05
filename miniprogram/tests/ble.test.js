const { test } = require('node:test');
const assert = require('node:assert/strict');
const p = require('../utils/protocol');
const { ServoClient, message } = require('../utils/ble');

const tick = () => new Promise(resolve => setImmediate(resolve));
const device = { deviceId: 'test-device', name: 'S3-SERVO-TEST' };

// Use the wire format directly so tests also detect a shared encoder/decoder error.
function status(patch = {}) {
  const s = Object.assign({ sequence: 0, op: 0, result: 0, flags: 1,
    target: 90, output: 90, minAngle: 0, maxAngle: 180,
    minPulse: 1000, maxPulse: 2000 }, patch);
  if (s.pulse === undefined) s.pulse = s.flags & 2 ? 1500 : 0;
  const b = new Uint8Array(18);
  b.set([0x5A, 1, s.sequence, s.op, s.result, s.flags]);
  const view = new DataView(b.buffer);
  view.setUint16(6, s.target, true);
  view.setUint16(8, s.output, true);
  view.setUint16(10, s.pulse, true);
  b[12] = s.minAngle; b[13] = s.maxAngle;
  view.setUint16(14, s.minPulse, true);
  view.setUint16(16, s.maxPulse, true);
  return b.buffer;
}

function fixture() {
  let valueListener, connectionListener, foundListener;
  const f = { writes: [], reads: [], states: [], connections: [], closed: [], created: [],
    onWrite: null, onRead: null, onServices: null, scanEnds: 0, found: [], scanCalls: [], detached: [] };
  f.emit = (patch, extra = {}) => valueListener(Object.assign({ deviceId: device.deviceId,
    serviceId: p.SERVICE_UUID.toUpperCase(), characteristicId: p.STATUS_UUID.toUpperCase(),
    value: status(patch) }, extra));
  f.ack = (args, patch = {}) => {
    const frame = new Uint8Array(args.value);
    f.emit(Object.assign({ sequence: frame[2], op: frame[3], flags: frame[3] === 1 ? 3 : 1,
      target: frame[3] === 1 ? frame[4] | frame[5] << 8 : 90 }, patch));
  };
  f.drop = () => connectionListener({ deviceId: device.deviceId, connected: false });
  const ok = args => args.success({});
  global.wx = {
    onBluetoothDeviceFound(fn) { foundListener = fn; }, offBluetoothDeviceFound() { f.detached.push('found'); },
    onBLECharacteristicValueChange(fn) { valueListener = fn; }, offBLECharacteristicValueChange() { f.detached.push('value'); },
    onBLEConnectionStateChange(fn) { connectionListener = fn; }, offBLEConnectionStateChange() { f.detached.push('connection'); },
    authorize(args) { if (f.onAuthorize) f.onAuthorize(args); else ok(args); },
    openBluetoothAdapter: ok, closeBluetoothAdapter: ok,
    startBluetoothDevicesDiscovery(args) {
      f.scanCalls.push('start');
      if (f.onStart) f.onStart(args); else ok(args);
    },
    stopBluetoothDevicesDiscovery(args) {
      f.scanCalls.push('stop');
      if (f.onStop) f.onStop(args); else ok(args);
    },
    getBluetoothDevices(args) { args.success({ devices: [] }); },
    createBLEConnection(args) { f.created.push(args.deviceId); ok(args); },
    closeBLEConnection(args) {
      f.closed.push(args.deviceId);
      if (f.onClose) { f.onClose(args); return; }
      args.success({});
    },
    getBLEDeviceServices(args) {
      if (f.onServices) { f.onServices(args); return; }
      args.success({ services: [{ uuid: p.SERVICE_UUID.toUpperCase() }] });
    },
    getBLEDeviceCharacteristics(args) { args.success({ characteristics: [
      { uuid: p.WRITE_UUID.toUpperCase(), properties: { write: true } },
      { uuid: p.STATUS_UUID.toUpperCase(), properties: { read: true, notify: true } }
    ] }); },
    notifyBLECharacteristicValueChange: ok,
    readBLECharacteristicValue(args) {
      f.reads.push(args);
      if (f.onRead) { f.onRead(args); return; }
      args.success({});
      queueMicrotask(() => f.emit());
    },
    writeBLECharacteristicValue(args) {
      f.writes.push(args);
      if (f.onWrite) { f.onWrite(args); return; }
      args.success({});
      queueMicrotask(() => f.ack(args));
    }
  };
  f.client = new ServoClient({
    onDevice: d => f.found.push(d), onScanEnd: () => f.scanEnds++,
    onState: state => f.states.push(state),
    onConnection: (connected, d) => f.connections.push({ connected, device: d })
  });
  f.discover = devices => foundListener({ devices });
  f.connect = () => f.client.connect(device);
  return f;
}

test('connect obtains initial state from a characteristic event without moving the servo', async () => {
  const f = fixture();
  try {
    f.onRead = args => { args.success({ value: status({ target: 12 }) }); };
    let finished = false;
    const connecting = f.connect().then(s => { finished = true; return s; });
    while (!f.reads.length) await tick();
    await tick();
    assert.equal(finished, false, 'read success does not contain the characteristic result in WeChat');
    f.emit({ target: 75, output: 70 });
    const state = await connecting;
    assert.equal(state.target, 75);
    assert.equal(state.enabled, false);
    assert.equal(f.client.ready, true);
    assert.equal(f.writes.length, 0);
    assert.equal(f.connections.at(-1).connected, true);
  } finally { await f.client.destroy(); }
});

test('angle and release use separate six-byte commands and return board-confirmed state', async () => {
  const f = fixture();
  try {
    await f.connect();
    const angle = await f.client.setAngle(135);
    const released = await f.client.release();
    assert.equal(angle.target, 135);
    assert.equal(angle.enabled, true);
    assert.equal(released.enabled, false);
    const frames = f.writes.map(w => Array.from(new Uint8Array(w.value)));
    assert.deepEqual(frames, [[0xA5, 1, 1, 1, 135, 0], [0xA5, 1, 2, 2, 0, 0]]);
  } finally { await f.client.destroy(); }
});

test('commands serialize until their own application ACK arrives', async () => {
  const f = fixture();
  try {
    await f.connect();
    f.onWrite = args => args.success({});
    const first = f.client.setAngle(30);
    const second = f.client.setAngle(150);
    await tick();
    assert.equal(f.writes.length, 1);
    f.ack(f.writes[0]);
    await first; await tick();
    assert.equal(f.writes.length, 2);
    f.ack(f.writes[1]);
    assert.equal((await second).target, 150);
    assert.deepEqual(f.writes.map(w => new Uint8Array(w.value)[4]), [30, 150]);
  } finally { await f.client.destroy(); }
});

test('an ACK arriving before the write success callback is retained', async () => {
  const f = fixture();
  try {
    await f.connect();
    f.onWrite = args => {
      f.ack(args);
      queueMicrotask(() => args.success({}));
    };
    assert.equal((await f.client.setAngle(45)).target, 45);
  } finally { await f.client.destroy(); }
});

test('periodic sequence-zero state and another command sequence cannot acknowledge a command', async () => {
  const f = fixture();
  try {
    await f.connect();
    f.onWrite = args => args.success({});
    let finished = false;
    const setting = f.client.setAngle(120).then(s => { finished = true; return s; });
    await tick();
    f.emit({ target: 120, flags: 7 });
    f.emit({ sequence: 255, op: 1, target: 120, flags: 3 });
    await tick();
    assert.equal(finished, false);
    f.ack(f.writes[0]);
    assert.equal((await setting).target, 120);
  } finally { await f.client.destroy(); }
});

test('unrelated device, service and characteristic events cannot change or fail a pending command', async () => {
  const f = fixture();
  try {
    await f.connect();
    f.onWrite = args => args.success({});
    const command = f.client.setAngle(60);
    await tick();
    const before = f.states.length;
    f.emit({}, { deviceId: 'unrelated', value: new ArrayBuffer(1) });
    f.emit({}, { serviceId: 'different-service', value: new ArrayBuffer(1) });
    f.emit({}, { characteristicId: 'different-characteristic', value: new ArrayBuffer(1) });
    await tick();
    assert.equal(f.states.length, before);
    f.ack(f.writes[0]);
    assert.equal((await command).target, 60);
  } finally { await f.client.destroy(); }
});

test('a malformed current-device status fails the command and allows retry', async () => {
  const f = fixture();
  try {
    await f.connect();
    f.onWrite = args => {
      args.success({});
      f.emit({}, { value: new ArrayBuffer(17) });
    };
    await assert.rejects(f.client.setAngle(50));
    f.onWrite = null;
    assert.equal((await f.client.setAngle(70)).target, 70);
  } finally { await f.client.destroy(); }
});

test('an ACK for the same sequence but wrong operation fails instead of confirming movement', async () => {
  const f = fixture();
  try {
    await f.connect();
    f.onWrite = args => { args.success({}); f.ack(args, { op: 2 }); };
    await assert.rejects(f.client.setAngle(90));
  } finally { await f.client.destroy(); }
});

test('board errors reject their matching command while leaving the queue usable', async () => {
  const f = fixture();
  try {
    await f.connect();
    for (const result of [1, 2, 3]) {
      f.onWrite = args => { args.success({}); f.ack(args, { result }); };
      await assert.rejects(f.client.setAngle(80));
    }
    f.onWrite = null;
    assert.equal((await f.client.setAngle(80)).target, 80);
  } finally { await f.client.destroy(); }
});

test('write failure rejects promptly and does not poison later commands', async () => {
  const f = fixture();
  try {
    await f.connect();
    f.onWrite = args => args.fail({ errCode: 10008, errMsg: 'write failed' });
    await assert.rejects(f.client.setAngle(80));
    f.onWrite = null;
    assert.equal((await f.client.setAngle(100)).target, 100);
  } finally { await f.client.destroy(); }
});

test('a remote disconnect cancels the in-flight command and every queued command', async () => {
  const f = fixture();
  try {
    await f.connect();
    f.onWrite = args => { args.success({}); queueMicrotask(() => f.drop()); };
    const results = await Promise.allSettled([f.client.setAngle(10), f.client.release(), f.client.setAngle(170)]);
    assert.ok(results.every(r => r.status === 'rejected'));
    assert.equal(f.writes.length, 1);
    assert.equal(f.client.ready, false);
    assert.equal(f.connections.at(-1).connected, false);
    f.onWrite = null;
    await f.connect();
    assert.equal(f.writes.length, 1, 'reconnect must not replay any old movement');
    assert.equal((await f.client.setAngle(90)).target, 90);
  } finally { await f.client.destroy(); }
});

test('refresh is serialized after a command and never sends a movement command', async () => {
  const f = fixture();
  try {
    await f.connect();
    f.onWrite = args => args.success({});
    const setting = f.client.setAngle(55);
    const refreshing = f.client.refresh();
    await tick();
    assert.equal(f.reads.length, 1);
    f.ack(f.writes[0]);
    await setting; await refreshing;
    assert.equal(f.reads.length, 2);
    assert.equal(f.writes.length, 1);
  } finally { await f.client.destroy(); }
});

test('disconnect cancels even after ACK and a late old write failure cannot reject a new session command', async () => {
  const f = fixture();
  let oldWrite;
  try {
    await f.connect();
    f.onWrite = args => { oldWrite = args; f.ack(args); };
    const oldJobs = Promise.allSettled([f.client.setAngle(25), f.client.setAngle(155)]);
    await tick();
    assert.ok(oldWrite);
    await f.client.disconnect();
    assert.ok((await oldJobs).every(r => r.status === 'rejected'));
    f.onWrite = args => args.success({});
    await f.connect(); // Reuse the exact descriptor object to expose identity-only guards.
    let finished = false;
    const current = f.client.setAngle(85).then(s => { finished = true; return s; });
    await tick();
    assert.equal(f.writes.length, 2, 'the queued old-session angle must never be replayed');
    oldWrite.fail({ errCode: 10008, errMsg: 'late old-session failure' });
    await tick();
    assert.equal(finished, false);
    f.ack(f.writes[1]);
    assert.equal((await current).target, 85);
  } finally { await f.client.destroy(); }
});

test('disconnect during service discovery cannot let an old connect continuation revive the session', async () => {
  const f = fixture();
  let services;
  try {
    f.onServices = args => { services = args; };
    const connecting = f.connect();
    const result = Promise.allSettled([connecting]);
    while (!services) await tick();
    await f.client.disconnect();
    assert.equal((await result)[0].status, 'rejected');
    assert.equal(f.client.ready, false);
    assert.equal(f.writes.length, 0);
    f.onServices = null;
    await f.connect();
    services.success({ services: [{ uuid: 'old-service-must-be-ignored' }] });
    assert.equal((await f.client.setAngle(95)).target, 95);
  } finally { await f.client.destroy(); }
});

test('discovery accepts the servo service or name and ignores unrelated BLE devices', async () => {
  const f = fixture();
  try {
    await f.client.scan();
    f.discover([
      { deviceId: 'by-name', name: 'S3-SERVO-1234' },
      { deviceId: 'by-service', advertisServiceUUIDs: [p.SERVICE_UUID.toUpperCase()] },
      { deviceId: 'other', name: 'S3-OLED-1234' }
    ]);
    assert.deepEqual(f.found.map(d => d.deviceId), ['by-name', 'by-service']);
  } finally { await f.client.destroy(); }
});

test('BLE error messages provide actionable adapter, timeout and permission guidance', () => {
  assert.match(message({ errCode: 10001 }), /蓝牙/);
  assert.match(message({ errCode: 10008 }), /超时/);
  assert.match(message({ errCode: 10006 }), /断开/);
  assert.match(message({ errCode: 10016 }), /权限|允许/);
});

test('an early ACK cannot hide a missing write callback, and a late failure cannot reject a newer command', async t => {
  const f = fixture();
  let oldWrite;
  try {
    await f.connect();
    t.mock.timers.enable({ apis: ['setTimeout'] });
    f.onWrite = args => { oldWrite = args; f.ack(args); };
    const timedOut = assert.rejects(f.client.setAngle(40), /超时/);
    await tick();
    t.mock.timers.tick(3500);
    await timedOut;
    assert.equal(f.client.session.cancel.size, 0);
    f.onWrite = args => args.success({});
    let finished = false;
    const next = f.client.setAngle(100).then(state => { finished = true; return state; });
    await tick();
    oldWrite.fail({ errCode: 10008, errMsg: 'late failure in the same session' });
    await tick();
    assert.equal(finished, false);
    f.ack(f.writes[1]);
    assert.equal((await next).target, 100);
  } finally { await f.client.destroy(); }
});

test('read deadline includes the native callback even when state already arrived', async t => {
  const f = fixture();
  try {
    await f.connect();
    t.mock.timers.enable({ apis: ['setTimeout'] });
    f.onRead = () => f.emit({ target: 35 });
    const timedOut = assert.rejects(f.client.refresh(), /超时/);
    await tick();
    t.mock.timers.tick(3500);
    await timedOut;
    f.onRead = null;
    assert.equal((await f.client.refresh()).target, 90);
  } finally { await f.client.destroy(); }
});

test('successful commands remove cancellation listeners instead of retaining them for the session lifetime', async () => {
  const f = fixture();
  try {
    await f.connect();
    for (let i = 0; i < 40; i++) await f.client.setAngle(i);
    assert.equal(f.client.session.cancel.size, 0);
    assert.equal(f.client.queued, 0);
    assert.equal(f.client.pending, null);
  } finally { await f.client.destroy(); }
});

test('rapid API calls have a bounded queue and cancelling discards every accepted movement', async () => {
  const f = fixture();
  try {
    await f.connect();
    f.onWrite = args => args.success({});
    const results = Promise.allSettled(Array.from({ length: 100 }, (_, i) => f.client.setAngle(i)));
    await tick();
    assert.equal(f.writes.length, 1);
    assert.ok(f.client.queued <= 8, 'queued jobs must remain bounded while an ACK is missing');
    await f.client.disconnect();
    const settled = await results;
    assert.ok(settled.every(r => r.status === 'rejected'));
    assert.ok(settled.some(r => /过多/.test(r.reason.message)));
    assert.equal(f.client.queued, 0);
  } finally { await f.client.destroy(); }
});

test('simultaneous refreshes share one read and a late command ACK cannot satisfy that read', async () => {
  const f = fixture();
  try {
    await f.connect();
    f.onRead = args => args.success({});
    const first = f.client.refresh();
    const second = f.client.refresh();
    assert.equal(first, second);
    let finished = false;
    first.then(() => { finished = true; });
    await tick();
    assert.equal(f.reads.length, 2);
    f.emit({ sequence: 255, op: 1, target: 20, flags: 3 });
    await tick();
    assert.equal(finished, false);
    f.emit({ target: 110 });
    assert.equal((await first).target, 110);
    assert.equal((await second).target, 110);
    assert.equal(f.writes.length, 0);
  } finally { await f.client.destroy(); }
});

test('stopping a scan during permission authorization prevents a late scan start', async () => {
  const f = fixture();
  let authorize;
  try {
    f.onAuthorize = args => { authorize = args; };
    const scanning = f.client.scan();
    while (!authorize) await tick();
    await f.client.stopScan();
    authorize.success({});
    await scanning;
    assert.equal(f.scanCalls.includes('start'), false);
    f.discover([{ deviceId: 'late-result', name: 'S3-SERVO-LATE' }]);
    assert.equal(f.found.length, 0);
  } finally { await f.client.destroy(); }
});

test('a delayed old scan start cannot stop a newer scan or emit stale scan-end state', async () => {
  const f = fixture();
  let start;
  try {
    f.onStart = args => { start = args; f.onStart = null; };
    const oldScan = f.client.scan();
    while (!start) await tick();
    const stopping = f.client.stopScan();
    const newScan = f.client.scan();
    await tick();
    assert.deepEqual(f.scanCalls, ['stop', 'start'], 'native start/stop calls must remain ordered');
    start.success({});
    await Promise.all([oldScan, stopping, newScan]);
    assert.deepEqual(f.scanCalls, ['stop', 'start', 'stop', 'stop', 'start']);
    assert.equal(f.client.scanRequested, true);
    assert.equal(f.scanEnds, 0, 'an old stop must not clear the UI scanning flag for the new attempt');
    f.discover([{ deviceId: 'new-result', name: 'S3-SERVO-NEW' }]);
    assert.equal(f.found.length, 1);
  } finally { await f.client.destroy(); }
});

test('the expected disconnect event while replacing a same-device connection does not cancel the replacement', async () => {
  const f = fixture();
  try {
    await f.connect();
    f.onClose = args => {
      f.drop();
      args.success({});
    };
    await f.connect();
    assert.equal(f.client.ready, true);
    assert.equal(f.writes.length, 0);
    assert.equal((await f.client.setAngle(115)).target, 115);
  } finally { await f.client.destroy(); }
});

test('destroy closes BLE and cancels pending movement immediately even if scan stop is delayed', async () => {
  const f = fixture();
  let stop, destroying;
  try {
    await f.connect();
    f.onWrite = args => args.success({});
    const cancelled = assert.rejects(f.client.setAngle(10));
    await tick();
    f.onStop = args => { stop = args; };
    destroying = f.client.destroy();
    assert.deepEqual(f.detached, ['found', 'value', 'connection']);
    await tick();
    assert.equal(f.client.ready, false);
    assert.equal(f.closed.length, 1, 'close BLE cannot wait behind discovery cleanup');
    await cancelled;
    stop.success({});
    await destroying;
    await f.client.destroy();
    assert.equal(f.closed.length, 1, 'cleanup must be idempotent');
  } finally {
    if (stop) stop.success({});
    f.onStop = null;
    if (destroying) await destroying;
    else await f.client.destroy();
  }
});

test('reconnect waits for a still-pending manual close on the same device', async () => {
  const f = fixture();
  let close, disconnected, connecting;
  try {
    await f.connect();
    f.onClose = args => { close = args; };
    disconnected = f.client.disconnect();
    connecting = f.connect().then(state => ({ state }), error => ({ error }));
    await tick();
    assert.equal(f.created.length, 1, 'a new native connection must wait for the old native close');
    f.drop(); // This event belongs to the old link whose close is still pending.
    close.success({});
    await disconnected;
    const result = await connecting;
    assert.equal(result.error, undefined);
    assert.equal(f.client.ready, true);
    assert.equal(f.created.length, 2);
    assert.equal(f.writes.length, 0);
  } finally {
    if (close) close.success({});
    f.onClose = null;
    if (disconnected) await disconnected;
    if (connecting) await connecting;
    await f.client.destroy();
  }
});
