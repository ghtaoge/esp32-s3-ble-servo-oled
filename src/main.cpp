#include <Arduino.h>
#include <Wire.h>
#include <U8g2lib.h>
#include <BLEDevice.h>
#include <BLEServer.h>
#include <BLEUtils.h>
#if defined(CONFIG_BLUEDROID_ENABLED)
#include <BLE2902.h>
#endif
#include <atomic>
#include "freertos/FreeRTOS.h"
#include "freertos/queue.h"
#include "servo_protocol.h"
#include "servo_runtime.h"

static_assert(SERVO_PIN != OLED_SDA && SERVO_PIN != OLED_SCL && OLED_SDA != OLED_SCL, "GPIO pins must differ");
static_assert(SERVO_MIN_US >= 500 && SERVO_MAX_US <= 2500 && SERVO_MIN_US < SERVO_MAX_US,
              "Servo calibration must stay within 500..2500 us");

namespace {
constexpr char Service[] = "e75a0001-4e42-4ea0-9b38-33c7bc713100";
constexpr char Write[] = "e75a0002-4e42-4ea0-9b38-33c7bc713100";
constexpr char Status[] = "e75a0003-4e42-4ea0-9b38-33c7bc713100";
constexpr uint32_t PeriodUs = 20000;
constexpr uint8_t Resolution = 14; // ESP32-S3 LEDC supports at most 14 bits.
constexpr uint32_t DisplayIntervalMs = 250, NotifyIntervalMs = 150, HeartbeatMs = 5000;
U8G2_SSD1306_128X64_NONAME_F_HW_I2C display(U8G2_R0, U8X8_PIN_NONE, OLED_SCL, OLED_SDA);
BLECharacteristic* statusCharacteristic = nullptr;
QueueHandle_t commands, displayQueue = nullptr;
std::atomic<uint32_t> linkState{0};
uint32_t handledLink = 0;
struct Packet { uint32_t link; uint8_t size; uint8_t bytes[servo::CommandSize]; };
struct DisplayState {
  uint16_t target, output, pulse;
  bool connected, pwmReady, enabled;
};
bool oledReady = false, pwmReady = false, enabled = false;
uint16_t target = 90, output = 90, pulse = 0;
uint32_t stepAt = 0, notifyAt = 0;
bool displayDirty = true, statusDirty = true;

bool moving() { return enabled && output != target; }
bool connected() { return servo::linkConnected(linkState.load()); }
bool writePulse(uint16_t us) {
  const uint32_t duty = (uint32_t(us) * (1UL << Resolution) + PeriodUs / 2) / PeriodUs;
  return pwmReady && ledcWrite(SERVO_PIN, duty);
}
void releaseServo() {
  if (pwmReady) ledcWrite(SERVO_PIN, 0);
  enabled = false; pulse = 0;
  // A released shaft can be moved by hand; output is only the last command.
  displayDirty = statusDirty = true;
}
void encodeStatus(uint8_t* bytes, uint8_t seq, uint8_t op, uint8_t result) {
  bytes[0] = 0x5A; bytes[1] = servo::Version; bytes[2] = seq; bytes[3] = op; bytes[4] = result;
  bytes[5] = (oledReady ? 1 : 0) | (enabled ? 2 : 0) | (moving() ? 4 : 0);
  servo::write16(bytes + 6, target); servo::write16(bytes + 8, output); servo::write16(bytes + 10, pulse);
  bytes[12] = servo::MinAngle; bytes[13] = servo::MaxAngle;
  servo::write16(bytes + 14, SERVO_MIN_US); servo::write16(bytes + 16, SERVO_MAX_US);
}
void publish(uint8_t seq = 0, uint8_t op = 0, uint8_t result = 0, bool notify = true) {
  uint8_t bytes[servo::StatusSize];
  encodeStatus(bytes, seq, op, result);
  statusCharacteristic->setValue(bytes, sizeof(bytes));
  if (notify && connected()) statusCharacteristic->notify();
  // Read always returns a fresh neutral state, never an old command error.
  if (seq || op || result) {
    encodeStatus(bytes, 0, 0, 0);
    statusCharacteristic->setValue(bytes, sizeof(bytes));
  }
  notifyAt = millis();
  statusDirty = false;
}
void drawDisplay(const DisplayState& state) {
  display.clearBuffer();
  display.drawUTF8(0, 12, state.connected ? "蓝牙已连接" : "等待蓝牙连接");
  char line[64];
  snprintf(line, sizeof(line), "目标:%3u  指令:%3u", state.target, state.output);
  display.drawUTF8(0, 28, line);
  snprintf(line, sizeof(line), "PWM:%4u us  GPIO%d", state.pulse, SERVO_PIN);
  display.drawUTF8(0, 44, line);
  display.drawUTF8(0, 60, !state.pwmReady ? "PWM初始化失败" : !state.enabled ? "已释放 / 无位置反馈" :
                  state.output != state.target ? "指令渐变 / 无反馈" : "保持指令 / 无反馈");
}
void displayTask(void*) {
  // Only this task accesses U8g2/Wire after setup. Never read control globals
  // here: the single-slot queue owns a coherent copy and discards old frames.
  DisplayState state;
  uint8_t previous[1024] = {};
  bool first = true;
  uint32_t lastAt = millis() - DisplayIntervalMs;
  for (;;) {
    xQueueReceive(displayQueue, &state, portMAX_DELAY);
    const uint32_t elapsed = millis() - lastAt;
    if (elapsed < DisplayIntervalMs) vTaskDelay(pdMS_TO_TICKS(DisplayIntervalMs - elapsed));
    // Select the newest snapshot after rate limiting, including the final stop.
    DisplayState latest;
    if (xQueueReceive(displayQueue, &latest, 0) == pdTRUE) state = latest;
    drawDisplay(state);
    const uint8_t* frame = display.getBufferPtr();
    if (first) { display.sendBuffer(); first = false; }
    else {
      for (uint8_t row = 0; row < 8; ++row) {
        const auto span = servo::changedTiles(frame + row * 128, previous + row * 128);
        if (span.count) display.updateDisplayArea(span.first, row, span.count, 1);
      }
    }
    memcpy(previous, frame, sizeof(previous));
    lastAt = millis();
  }
}
void queueDisplay() {
  if (!displayDirty) return;
  if (displayQueue) {
    const DisplayState state{target, output, pulse, connected(), pwmReady, enabled};
    xQueueOverwrite(displayQueue, &state);
  }
  displayDirty = false;
}
void initDisplay() {
  Wire.begin(OLED_SDA, OLED_SCL);
  Wire.setTimeOut(50);
  for (uint8_t address : {0x3C, 0x3D}) {
    Wire.beginTransmission(address);
    if (Wire.endTransmission() != 0) continue;
    display.setI2CAddress(address << 1);
    display.setBusClock(400000);
    display.begin();
    Wire.setTimeOut(50);
    display.setFont(u8g2_font_wqy12_t_gb2312);
    oledReady = true;
    Serial.printf("OLED SSD1306 at 0x%02X SDA=%d SCL=%d\n", address, OLED_SDA, OLED_SCL);
    return;
  }
  Serial.println("OLED not found at 0x3C/0x3D; servo BLE control remains available.");
}
class ServerCallbacks : public BLEServerCallbacks {
  void change(bool up) {
    uint32_t old = linkState.load();
    while (!linkState.compare_exchange_weak(old, servo::nextLink(old, up))) {}
  }
  void onConnect(BLEServer*) override { change(true); }
  void onDisconnect(BLEServer*) override { change(false); }
};
class WriteCallbacks : public BLECharacteristicCallbacks {
  void onWrite(BLECharacteristic* characteristic) override {
    const String value = characteristic->getValue();
    Packet packet{};
    packet.link = linkState.load();
    packet.size = value.length() == servo::CommandSize ? servo::CommandSize : 0;
    memcpy(packet.bytes, value.c_str(), value.length() < sizeof(packet.bytes) ? value.length() : sizeof(packet.bytes));
    // Bluetooth task only enqueues. No PWM, OLED or logging in the callback.
    xQueueSend(commands, &packet, 0);
  }
};
uint8_t apply(const servo::Command& cmd) {
  if (cmd.op == servo::Release) { releaseServo(); return servo::Ok; }
  if (!pwmReady) return servo::PwmError;
  if (!enabled) {
    const uint16_t us = servo::pulseFor(output, SERVO_MIN_US, SERVO_MAX_US);
    if (!writePulse(us)) { releaseServo(); return servo::PwmError; }
    enabled = true; pulse = us; stepAt = millis();
  }
  // Updating the target must not keep postponing an in-progress motion tick.
  target = cmd.angle;
  displayDirty = statusDirty = true;
  return servo::Ok;
}
uint32_t syncConnection() {
  const uint32_t link = linkState.load();
  if (handledLink != link) {
    handledLink = link;
    releaseServo(); // Also catches a disconnect/reconnect between two iterations.
    publish();
  }
  return link;
}
}
void setup() {
  Serial.begin(115200);
  Serial.setTxTimeoutMs(0); // USB host backpressure must not stall servo control.
  pinMode(SERVO_PIN, OUTPUT); digitalWrite(SERVO_PIN, LOW);
  pwmReady = ledcAttach(SERVO_PIN, 50, Resolution);
  releaseServo(); // No position command at boot or on Bluetooth connection.
  initDisplay();
  commands = xQueueCreate(8, sizeof(Packet));
  if (!commands) { Serial.println("Command queue allocation failed"); while (true) delay(1000); }
  char name[24];
  snprintf(name, sizeof(name), "S3-SERVO-%04X", static_cast<unsigned>((ESP.getEfuseMac() >> 32) & 0xFFFF));
  if (!BLEDevice::init(name)) { Serial.println("BLE init failed"); while (true) delay(1000); }
  BLEServer* server = BLEDevice::createServer();
  server->setCallbacks(new ServerCallbacks()); server->advertiseOnDisconnect(true);
  BLEService* service = server->createService(Service);
  auto* write = service->createCharacteristic(Write, BLECharacteristic::PROPERTY_WRITE);
  write->setCallbacks(new WriteCallbacks());
  statusCharacteristic = service->createCharacteristic(Status, BLECharacteristic::PROPERTY_READ | BLECharacteristic::PROPERTY_NOTIFY);
#if defined(CONFIG_BLUEDROID_ENABLED)
  statusCharacteristic->addDescriptor(new BLE2902());
#endif
  publish(0, 0, 0, false); service->start();
  BLEAdvertisementData advertisement, scanResponse;
  advertisement.setFlags(0x06); advertisement.setCompleteServices(BLEUUID(Service)); scanResponse.setName(name);
  auto* advertising = BLEDevice::getAdvertising();
  advertising->setAdvertisementData(advertisement); advertising->setScanResponseData(scanResponse); advertising->start();
  if (oledReady) {
    displayQueue = xQueueCreate(1, sizeof(DisplayState));
    if (!displayQueue || xTaskCreatePinnedToCore(displayTask, "oled", 6144, nullptr, 1, nullptr, 0) != pdPASS) {
      if (displayQueue) vQueueDelete(displayQueue);
      displayQueue = nullptr; oledReady = false;
      Serial.println("OLED task allocation failed; servo BLE control remains available.");
      publish(0, 0, 0, false);
    }
  }
  queueDisplay();
  Serial.printf("BLE=%s SERVO=GPIO%d 50Hz %d..%dus PWM=%s Flash=%lu PSRAM=%lu\n", name,
                SERVO_PIN, SERVO_MIN_US, SERVO_MAX_US, pwmReady ? "ready" : "FAILED",
                static_cast<unsigned long>(ESP.getFlashChipSize()), static_cast<unsigned long>(ESP.getPsramSize()));
}
void loop() {
  syncConnection();
  const uint32_t now = millis();
  if (moving() && now - stepAt >= 20) {
    stepAt = now;
    const uint16_t next = servo::stepToward(output, target);
    const uint16_t us = servo::pulseFor(next, SERVO_MIN_US, SERVO_MAX_US);
    if (writePulse(us)) { output = next; pulse = us; }
    else { releaseServo(); Serial.println("PWM update failed; output released"); }
    displayDirty = statusDirty = true;
    if (!moving()) publish();
  }
  // ACKs and the final motion state are immediate. Intermediate telemetry is
  // rate limited. A low-rate heartbeat repairs a lost final notification.
  // Never send an idle heartbeat without an active phone connection.
  const uint32_t sinceNotify = millis() - notifyAt;
  if ((statusDirty && sinceNotify >= NotifyIntervalMs) || (connected() && sinceNotify >= HeartbeatMs)) publish();
  queueDisplay();
  Packet packet;
  const uint32_t waitMs = servo::waitForStep(millis(), stepAt, moving());
  const bool received = xQueueReceive(commands, &packet, pdMS_TO_TICKS(waitMs)) == pdTRUE;
  const uint32_t link = syncConnection(); // Disconnect may have occurred in the wait.
  if (received && packet.link == link && servo::linkConnected(link)) {
    servo::Command cmd;
    uint8_t result = servo::decode(packet.bytes, packet.size, cmd);
    // An unrecognizable envelope has no correlatable ACK. Do not emit status
    // frames with sequence zero / unknown op that our own client must reject.
    if (result == servo::BadFrame) return;
    if (result == servo::Ok) result = apply(cmd);
    if (packet.link == linkState.load()) publish(packet.bytes[2], packet.bytes[3], result);
    else syncConnection();
  }
}
