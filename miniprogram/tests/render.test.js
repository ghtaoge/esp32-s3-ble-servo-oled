const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { spawnSync } = require('node:child_process');
const compiler = process.env.WXML_COMPILER || '';
let render;
if (fs.existsSync(compiler)) {
  const mini = path.resolve(__dirname, '..');
  const output = path.resolve(mini, '../.local/wxml-test.js');
  fs.mkdirSync(path.dirname(output), { recursive: true });
  const result = spawnSync(compiler, ['-o', output, 'pages/index/index.wxml'], { cwd: mini, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  const context = { window: {}, console }; vm.createContext(context);
  vm.runInContext(fs.readFileSync(output, 'utf8'), context);
  const registry = {}; context.$gwx(undefined, registry);
  render = context.$gwx(Object.keys(registry.entrys)[0], registry);
}
function find(tree, predicate) {
  if (!tree || typeof tree !== 'object') return undefined;
  if (predicate(tree)) return tree;
  for (const child of tree.children || []) { const value = find(child, predicate); if (value) return value; }
}
const options = { skip: render ? false : 'Set WXML_COMPILER to WeChat wcc.exe to test compiled templates' };
const base = { connected: false, devices: [], oledReady: false, sending: false, enabled: false, showPrivacy: false,
  angle: 90, target: 90, output: 90, pulse: 0, minAngle: 0, maxAngle: 180, minPulse: 1000, maxPulse: 2000 };
const button = (tree, action) => find(tree, node => node.attr && node.attr.bindtap === action);
const slider = tree => find(tree, node => node.attr && node.attr.bindchange === 'changeAngle');
test('compiled angle controls use release-only dispatch and work without an OLED', options, () => {
  let tree = render(base);
  assert.ok(button(tree, 'search'));
  assert.ok(button(tree, 'center').attr.disabled);
  assert.ok(slider(tree).attr.disabled);
  assert.equal(slider(tree).attr.bindchanging, 'previewAngle');
  tree = render({ ...base, connected: true });
  assert.equal(!!button(tree, 'center').attr.disabled, false);
  assert.equal(!!slider(tree).attr.disabled, false);
  assert.ok(button(tree, 'release').attr.disabled);
  tree = render({ ...base, connected: true, enabled: true });
  assert.equal(!!button(tree, 'release').attr.disabled, false);
  tree = render({ ...base, connected: true, enabled: true, sending: true });
  assert.ok(slider(tree).attr.disabled);
  assert.ok(button(tree, 'release').attr.disabled);
});
test('compiled privacy dialog binds the native authorization event', options, () => {
  const tree = render({ ...base, showPrivacy: true });
  const agree = find(tree, node => node.attr && node.attr.id === 'agree-privacy');
  assert.equal(agree.attr.openType, 'agreePrivacyAuthorization');
  assert.equal(agree.attr.bindagreeprivacyauthorization, 'agreePrivacy');
});
