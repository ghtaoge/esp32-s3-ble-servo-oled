const { test } = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const path = require('node:path');
const initial = { target: 90, output: 90, pulse: 0, enabled: false, moving: false, oledReady: false,
  minAngle: 0, maxAngle: 180, minPulse: 1000, maxPulse: 2000 };
function fakeClock() {
  let now = 0, next = 0;
  const timers = new Map();
  return {
    setTimeout(fn, delay) { const id = ++next; timers.set(id, { fn, at: now + delay }); return id; },
    clearTimeout(id) { timers.delete(id); },
    advance(ms) {
      const until = now + ms;
      while (true) {
        const due = Array.from(timers).filter(([, timer]) => timer.at <= until).sort((a, b) => a[1].at - b[1].at)[0];
        if (!due) break;
        now = due[1].at; timers.delete(due[0]); due[1].fn();
      }
      now = until;
    },
    get pending() { return timers.size; }
  };
}
function fixture() {
  let definition, privacy;
  const clock = fakeClock(), updates = [];
  class FakeClient {
    constructor(events) { this.events = events; this.angles = []; this.releases = 0; this.refreshes = 0; }
    async scan() {}
    async stopScan() {}
    async connect(device) { this.ready = true; this.events.onState(initial); this.events.onConnection(true, device); return initial; }
    async disconnect() { this.ready = false; }
    async destroy() { this.ready = false; }
    async refresh() { this.refreshes++; return initial; }
    async setAngle(angle) { this.angles.push(angle); const state = { ...initial, enabled: true, target: angle, pulse: 1500 }; this.events.onState(state); return state; }
    async release() { this.releases++; this.events.onState(initial); return initial; }
  }
  const wx = {
    onNeedPrivacyAuthorization(handler) { privacy = handler; },
    offNeedPrivacyAuthorization() {},
    getPrivacySetting(options) { options.success({ privacyContractName: '《测试隐私指引》' }); }
  };
  const context = { Page(def) { definition = def; }, require() { return { ServoClient: FakeClient, message: e => e.message }; },
    wx, setTimeout: clock.setTimeout, clearTimeout: clock.clearTimeout, console, Set };
  vm.runInNewContext(fs.readFileSync(path.resolve(__dirname, '../pages/index/index.js'), 'utf8'), context);
  const page = { ...definition, data: JSON.parse(JSON.stringify(definition.data)), setData(patch) { updates.push(JSON.parse(JSON.stringify(patch))); Object.assign(this.data, patch); } };
  page.onLoad();
  return { page, privacy: resolve => privacy(resolve), client: page.client, clock, updates,
    metrics() { return { calls: updates.length, bytes: updates.reduce((sum, patch) => sum + Buffer.byteLength(JSON.stringify(patch)), 0) }; } };
}
async function connect(page) {
  page.setData({ devices: [{ deviceId: 'board', name: 'S3-SERVO-TEST' }] });
  await page.connect({ currentTarget: { dataset: { id: 'board' } } });
}
test('page connection and visibility refresh do not issue movement commands', async () => {
  const { page, client } = fixture();
  try {
    await connect(page);
    page.onShow(); await Promise.resolve();
    assert.equal(page.data.connected, true);
    assert.equal(page.data.oledReady, false);
    assert.equal(client.refreshes, 1);
    assert.deepEqual(client.angles, []);
    assert.equal(client.releases, 0);
  } finally { page.onUnload(); }
});
test('drag previews locally and sends one angle on release even when OLED is absent', async () => {
  const { page, client, clock } = fixture();
  try {
    await connect(page);
    page.previewAngle({ detail: { value: 40 } });
    page.previewAngle({ detail: { value: 45 } });
    clock.advance(40);
    assert.deepEqual(client.angles, []);
    client.events.onState({ ...initial, target: 90 });
    assert.equal(page.data.angle, 45, 'periodic state must not move the thumb during a drag');
    await page.changeAngle({ detail: { value: 45 } });
    assert.deepEqual(client.angles, [45]);
    assert.equal(page.data.target, 45);
    assert.match(page.data.syncText, /已接收 45/);
    await page.center();
    await page.release();
    assert.deepEqual(client.angles, [45, 90]);
    assert.equal(client.releases, 1);
    assert.equal(page.data.enabled, false);
  } finally { page.onUnload(); }
});
test('the page blocks commands while disconnected or another command is pending', async () => {
  const { page, client } = fixture();
  let finish;
  try {
    await page.center(); assert.deepEqual(client.angles, []);
    await connect(page);
    client.setAngle = angle => { client.angles.push(angle); return new Promise(resolve => { finish = resolve; }); };
    const command = page.center();
    await page.release();
    await page.preset({ currentTarget: { dataset: { angle: '135' } } });
    assert.equal(client.releases, 0);
    assert.deepEqual(client.angles, [90]);
    finish({ ...initial, target: 90 }); await command;
  } finally { page.onUnload(); }
});
test('remote disconnect prevents an old command result from changing a newer connection', async () => {
  const { page, client } = fixture();
  let finish;
  try {
    await connect(page);
    client.setAngle = () => new Promise(resolve => { finish = resolve; });
    const command = page.transmit(false, 135);
    client.events.onConnection(false);
    await connect(page);
    finish({ ...initial, target: 135, enabled: true });
    await command;
    assert.equal(page.data.target, 90);
    assert.equal(page.data.enabled, false);
    assert.equal(page.data.syncText, '');
  } finally { page.onUnload(); }
});
test('privacy tap waits for the native agreement event and resolves all waiting API calls once', () => {
  const { page, privacy } = fixture();
  const responses = [];
  try {
    privacy(result => responses.push(result));
    privacy(result => responses.push(result));
    page.preparePrivacyAgree();
    assert.equal(page.data.showPrivacy, true);
    assert.equal(page.data.privacyName, '《测试隐私指引》');
    assert.equal(responses.length, 0);
    page.agreePrivacy();
    assert.equal(responses.length, 2);
    assert.ok(responses.every(result => result.event === 'agree' && result.buttonId === 'agree-privacy'));
    assert.equal(page.data.showPrivacy, false);
    page.agreePrivacy(); assert.equal(responses.length, 2);
  } finally { page.onUnload(); }
});
test('unload cancels privacy and ignores any later client callbacks', () => {
  const { page, client, privacy } = fixture();
  const responses = [];
  privacy(result => responses.push(result));
  page.onUnload();
  const before = JSON.stringify(page.data);
  client.events.onState({ ...initial, target: 135 });
  client.events.onConnection(true, { name: 'late' });
  assert.equal(JSON.stringify(page.data), before);
  assert.equal(responses[0].event, 'disagree');
});

test('view bridge work is bounded for duplicate telemetry, rapid dragging and hidden telemetry', t => {
  const f = fixture(), { page, client, clock, updates } = f;
  try {
    for (let i = 0; i < 1000; i++) client.events.onState({ ...initial });
    const duplicateStatus = f.metrics();
    assert.equal(duplicateStatus.calls, 0);
    page.data.connected = true;
    updates.length = 0;
    // 200 input events over one second, four input events per logical degree.
    for (let i = 0; i < 200; i++) { page.previewAngle({ detail: { value: Math.floor(i / 4) } }); clock.advance(5); }
    clock.advance(40);
    const drag = f.metrics();
    assert.equal(drag.calls, 25);
    assert.equal(drag.bytes, 295);
    assert.equal(page.data.angle, 49);
    assert.deepEqual(client.angles, [], 'preview coalescing never sends motion commands');
    updates.length = 0;
    page.onHide();
    for (let i = 0; i < 1000; i++) client.events.onState({ ...initial, output: i % 181 });
    const hiddenStatus = f.metrics();
    assert.equal(hiddenStatus.calls, 0);
    page.onShow();
    const resume = f.metrics();
    assert.equal(resume.calls, 1);
    assert.equal(page.data.output, 999 % 181);
    assert.equal(page.data.angle, 90);
    t.diagnostic(JSON.stringify({ duplicateStatus, drag, hiddenStatus, resume }));
  } finally { page.onUnload(); }
});

test('a delayed connect result cannot replace newer telemetry', async () => {
  const { page, client } = fixture();
  try {
    client.connect = async device => {
      client.ready = true;
      client.events.onState(initial);
      client.events.onConnection(true, device);
      client.events.onState({ ...initial, target: 135, output: 120, enabled: true, moving: true, pulse: 1667 });
      return initial;
    };
    await connect(page);
    assert.equal(page.data.target, 135);
    assert.equal(page.data.output, 120);
    assert.equal(page.data.angle, 135);
  } finally { page.onUnload(); }
});

test('a delayed command result cannot roll back output telemetry received after its ACK', async () => {
  const { page, client } = fixture();
  let finish;
  try {
    await connect(page);
    client.setAngle = () => new Promise(resolve => { finish = resolve; });
    const sending = page.transmit(false, 135);
    const ack = { ...initial, target: 135, output: 90, enabled: true, moving: true, pulse: 1500 };
    client.events.onState(ack);
    client.events.onState({ ...ack, output: 120, pulse: 1667 });
    finish(ack); await sending;
    assert.equal(page.data.output, 120);
    assert.equal(page.data.pulse, 1667);
    assert.equal(page.data.angle, 135);
    assert.equal(page.data.sending, false);
  } finally { page.onUnload(); }
});

test('a rejected angle command restores the latest confirmed target in the slider', async () => {
  const { page, client } = fixture();
  try {
    await connect(page);
    client.setAngle = async () => { throw new Error('write failed'); };
    await page.transmit(false, 135);
    assert.equal(page.data.angle, 90);
    assert.equal(page.data.target, 90);
    assert.equal(page.data.enabled, false);
    assert.equal(page.data.errorText, 'write failed');
  } finally { page.onUnload(); }
});

test('preview timers cannot overwrite a released slider, hidden page or unloaded page', async () => {
  const { page, client, clock, updates } = fixture();
  await connect(page);
  page.previewAngle({ detail: { value: 40 } });
  assert.equal(clock.pending, 1);
  await page.changeAngle({ detail: { value: 55 } });
  clock.advance(100);
  assert.equal(page.data.angle, 55);
  assert.equal(clock.pending, 0);
  page.previewAngle({ detail: { value: 120 } });
  page.onHide(); clock.advance(100);
  assert.equal(page.data.angle, 55);
  page.onShow();
  page.previewAngle({ detail: { value: 130 } });
  page.onUnload();
  const before = updates.length;
  clock.advance(100);
  assert.equal(clock.pending, 0);
  assert.equal(updates.length, before);
  assert.deepEqual(client.angles, [55]);
});

test('visibility refreshes coalesce and errors from a previous visible interval stay suppressed', async () => {
  const { page, client } = fixture();
  let reject;
  try {
    await connect(page);
    client.refresh = () => { client.refreshes++; return new Promise((resolve, fail) => { reject = fail; }); };
    page.onShow(); page.onShow();
    assert.equal(client.refreshes, 1);
    page.onHide(); page.onShow();
    reject(new Error('old refresh failed'));
    await Promise.resolve();
    assert.equal(page.data.errorText, '');
    assert.equal(client.refreshes, 1);
    page.onShow();
    reject(new Error('current refresh failed'));
    await Promise.resolve();
    assert.equal(page.data.errorText, 'current refresh failed');
  } finally { page.onUnload(); }
});

test('scan errors and late device discoveries cannot change a connected page', async () => {
  const { page, client, updates } = fixture();
  let rejectScan;
  try {
    client.scan = () => new Promise((resolve, reject) => { rejectScan = reject; });
    const scanning = page.search();
    const device = { deviceId: 'board', name: 'S3-SERVO-TEST', RSSI: -42, advertisData: new ArrayBuffer(512) };
    updates.length = 0;
    for (let i = 0; i < 1000; i++) client.events.onDevice({ ...device, advertisData: new ArrayBuffer(i) });
    assert.equal(updates.length, 1, 'unchanged rendered devices must not be repeatedly serialized');
    assert.equal('advertisData' in page.data.devices[0], false);
    await page.connect({ currentTarget: { dataset: { id: 'board' } } });
    rejectScan(new Error('old scan failed')); await scanning;
    const before = updates.length;
    client.events.onDevice({ ...device, RSSI: -30 });
    assert.equal(page.data.connected, true);
    assert.equal(page.data.errorText, '');
    assert.equal(updates.length, before);
  } finally { page.onUnload(); }
});
