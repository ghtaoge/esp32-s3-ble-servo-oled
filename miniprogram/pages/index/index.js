const { ServoClient, message } = require('../../utils/ble');
Page({
  data: {
    connected: false, scanning: false, connectingId: '', devices: [], deviceName: '',
    angle: 90, target: 90, output: 90, pulse: 0, enabled: false, moving: false,
    minAngle: 0, maxAngle: 180, minPulse: 500, maxPulse: 2500,
    oledReady: false, sending: false, syncText: '', errorText: '',
    stepSize: 5, angleInput: '', fineTuneOpen: false, detailsOpen: false, scanFinished: false,
    showPrivacy: false, privacyAgreePending: false, privacyName: '《用户隐私保护指引》'
  },
  onLoad() {
    this.privacyResolvers = new Set();
    this.scanAttempt = 0;
    this.operation = 0;
    this.visibility = 0;
    this.client = new ServoClient({
      onDevice: device => {
        if (this.unloaded || this.hidden || !this.data.scanning || this.data.connected || this.data.connectingId) return;
        const devices = this.data.devices.slice();
        const index = devices.findIndex(item => item.deviceId === device.deviceId);
        // Only the fields rendered in the list cross the mini-program view bridge.
        const item = { deviceId: device.deviceId, name: device.name, RSSI: Number.isFinite(device.RSSI) ? device.RSSI : null };
        if (index >= 0 && devices[index].name === item.name && devices[index].RSSI === item.RSSI) return;
        if (index < 0) devices.push(item); else devices[index] = item;
        devices.sort((a, b) => (typeof b.RSSI === 'number' ? b.RSSI : -127) - (typeof a.RSSI === 'number' ? a.RSSI : -127));
        this.update({ devices });
      },
      onScanEnd: () => this.update({ scanning: false, scanFinished: true }),
      onState: state => this.showState(state),
      onConnection: (connected, device) => {
        if (this.unloaded) return;
        if (!connected) { ++this.operation; this.cancelPreview(); this.dragging = false; this.latestState = null; }
        this.update({ connected, connectingId: '', deviceName: device ? device.name : '',
          sending: false, syncText: '', errorText: connected ? '' : '连接已断开，请重新搜索连接',
          ...(!connected ? { enabled: false, moving: false, pulse: 0 } : {}) });
      }
    });
    if (wx.onNeedPrivacyAuthorization) {
      this.privacyHandler = resolve => {
        if (typeof resolve !== 'function' || this.unloaded) return;
        this.privacyResolvers.add(resolve);
        const alreadyShown = this.data.showPrivacy;
        this.update({ showPrivacy: true });
        if (!alreadyShown && wx.getPrivacySetting) wx.getPrivacySetting({ success: result => {
          if (!this.unloaded && this.data.showPrivacy) this.update({ privacyName: result.privacyContractName || this.data.privacyName });
        }});
      };
      wx.onNeedPrivacyAuthorization(this.privacyHandler);
    }
  },
  update(patch) {
    if (this.unloaded) return;
    const changed = {};
    Object.keys(patch).forEach(key => { if (!Object.is(this.data[key], patch[key])) changed[key] = patch[key]; });
    if (Object.keys(changed).length) this.setData(changed);
  },
  showState(state) {
    if (this.unloaded) return;
    this.latestState = state;
    if (this.hidden) return;
    const patch = Object.assign({}, state);
    if (!this.dragging && !this.data.sending) patch.angle = state.target;
    this.update(patch);
  },
  onShow() {
    this.hidden = false;
    const visibility = ++this.visibility;
    if (this.latestState) this.showState(this.latestState);
    if (this.client && this.client.ready && !this.refreshing) {
      const operation = this.operation;
      const refresh = this.client.refresh();
      this.refreshing = refresh;
      refresh.then(() => { if (this.refreshing === refresh) this.refreshing = null; }, error => {
        if (this.refreshing === refresh) this.refreshing = null;
        if (!this.unloaded && !this.hidden && operation === this.operation && visibility === this.visibility) this.update({ errorText: message(error) });
      });
    }
  },
  onHide() {
    this.hidden = true;
    ++this.visibility;
    ++this.scanAttempt;
    this.cancelPreview();
    this.update({ scanning: false });
    if (this.client) this.client.stopScan();
    this.dragging = false;
  },
  onUnload() {
    this.unloaded = true;
    ++this.operation;
    ++this.scanAttempt;
    this.cancelPreview();
    this.settlePrivacy('disagree');
    if (wx.offNeedPrivacyAuthorization && this.privacyHandler) wx.offNeedPrivacyAuthorization(this.privacyHandler);
    if (this.client) this.client.destroy();
  },
  async search() {
    if (this.unloaded || this.hidden || this.data.scanning || this.data.connectingId || this.data.connected) return;
    const attempt = ++this.scanAttempt;
    this.update({ scanning: true, scanFinished: false, devices: [], errorText: '' });
    try { await this.client.scan(); }
    catch (error) { if (!this.unloaded && !this.hidden && attempt === this.scanAttempt && !this.data.connected && !this.data.connectingId) this.update({ scanning: false, errorText: message(error) }); }
  },
  async connect(event) {
    if (this.unloaded || this.hidden || this.data.connectingId || this.data.connected) return;
    const device = this.data.devices.find(item => item.deviceId === event.currentTarget.dataset.id);
    if (!device) return;
    const operation = ++this.operation;
    ++this.scanAttempt;
    this.update({ connectingId: device.deviceId, scanning: false, errorText: '', syncText: '' });
    try {
      // onState is authoritative: this promise may resolve after a newer notification.
      await this.client.connect(device);
    } catch (error) {
      if (!this.unloaded && operation === this.operation) this.update({ connectingId: '', connected: false, errorText: message(error) });
    }
  },
  stopSearch() {
    ++this.scanAttempt;
    this.update({ scanning: false, scanFinished: true });
    return this.client.stopScan();
  },
  toggleFineTune() { this.update({ fineTuneOpen: !this.data.fineTuneOpen }); },
  toggleDetails() { this.update({ detailsOpen: !this.data.detailsOpen }); },
  chooseStep(event) {
    const stepSize = Number(event.currentTarget.dataset.step);
    if ([1, 5, 10].includes(stepSize)) this.update({ stepSize });
  },
  nudge(event) {
    const direction = Number(event.currentTarget.dataset.direction);
    if (direction !== -1 && direction !== 1) return;
    const angle = Math.min(this.data.maxAngle, Math.max(this.data.minAngle, this.data.angle + direction * this.data.stepSize));
    if (angle !== this.data.angle) return this.transmit(false, angle);
  },
  editAngle(event) { this.update({ angleInput: event.detail.value }); },
  submitAngle() {
    if (!this.data.connected || this.data.sending) return;
    const text = String(this.data.angleInput).trim();
    const angle = Number(text);
    if (!/^\d{1,3}$/.test(text) || !Number.isInteger(angle) || angle < this.data.minAngle || angle > this.data.maxAngle) {
      this.update({ errorText: `请输入 ${this.data.minAngle}–${this.data.maxAngle} 之间的整数角度` });
      return;
    }
    return this.transmit(false, angle);
  },
  async disconnect() {
    ++this.operation;
    ++this.scanAttempt;
    this.cancelPreview();
    this.dragging = false;
    this.latestState = null;
    this.update({ connected: false, connectingId: '', deviceName: '', sending: false, syncText: '', errorText: '', enabled: false, moving: false, pulse: 0 });
    await this.client.disconnect();
  },
  cancelPreview() {
    clearTimeout(this.previewTimer);
    this.previewTimer = null;
  },
  previewAngle(event) {
    if (this.unloaded || this.hidden || !this.data.connected || this.data.sending) return;
    const angle = event.detail.value;
    if (!Number.isInteger(angle) || angle < this.data.minAngle || angle > this.data.maxAngle) return;
    this.dragging = true;
    this.previewValue = angle;
    // The native slider moves its own thumb; coalesce only the bound label/preview.
    if (!this.previewTimer) this.previewTimer = setTimeout(() => {
      this.previewTimer = null;
      if (!this.unloaded && !this.hidden && this.dragging && this.data.connected && !this.data.sending) this.update({ angle: this.previewValue, syncText: '' });
    }, 40);
  },
  changeAngle(event) {
    this.cancelPreview();
    this.dragging = false;
    return this.transmit(false, event.detail.value);
  },
  preset(event) { return this.transmit(false, Number(event.currentTarget.dataset.angle)); },
  center() { return this.transmit(false, 90); },
  release() { return this.transmit(true); },
  async transmit(release, angle) {
    if (this.unloaded || this.hidden || this.data.sending || !this.data.connected) return;
    const operation = this.operation;
    this.cancelPreview();
    this.dragging = false;
    this.update({ sending: true, syncText: '', errorText: '', ...(release ? {} : { angle }) });
    const finished = {};
    try {
      const state = await (release ? this.client.release() : this.client.setAngle(angle));
      // ACK confirms reception; do not replay its potentially older output snapshot.
      finished.syncText = release ? '开发板已关闭 PWM 输出' : `开发板已接收 ${state.target}° 指令`;
    } catch (error) {
      finished.errorText = message(error);
    } finally {
      if (!this.unloaded && operation === this.operation) {
        finished.sending = false;
        if (this.latestState && !this.hidden) finished.angle = this.latestState.target;
        this.update(finished);
      }
    }
  },
  openSettings() { wx.openSetting({}); },
  openPrivacy() {
    wx.openPrivacyContract({ fail: () => wx.showToast({ title: '请先在小程序后台配置隐私指引', icon: 'none' }) });
  },
  preparePrivacyAgree() {
    if (this.unloaded || !this.data.showPrivacy || this.data.privacyAgreePending) return;
    this.update({ privacyAgreePending: true });
    this.privacyTimer = setTimeout(() => {
      this.settlePrivacy('disagree', '微信未完成隐私授权，请重新搜索后再试；开发工具中请使用手机预览测试。');
    }, 3000);
  },
  settlePrivacy(event, reason = '') {
    clearTimeout(this.privacyTimer);
    const resolvers = Array.from(this.privacyResolvers);
    this.privacyResolvers.clear();
    let failed = false;
    resolvers.forEach(resolve => {
      try { resolve(event === 'agree' ? { event, buttonId: 'agree-privacy' } : { event }); }
      catch (error) { failed = true; console.warn('Privacy authorization could not complete:', error); }
    });
    const patch = { showPrivacy: this.privacyResolvers.size > 0, privacyAgreePending: false };
    if (event !== 'agree' || failed) {
      ++this.scanAttempt;
      patch.scanning = false;
      patch.errorText = reason || (failed ? '隐私授权未完成，请重新搜索后再试。' : '已取消连接，点击搜索可以重试。');
    }
    this.update(patch);
  },
  agreePrivacy() { this.settlePrivacy('agree'); },
  rejectPrivacy() { this.settlePrivacy('disagree'); },
  ignorePrivacyTap() {}
});
