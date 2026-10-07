// SenseHub ESP32 firmware prototype — typed GPIO channels and optional sensors.
// Board pin ownership and SoC backend capabilities are in board_config.h.
// WiFi TCP / Classic SPP are compiled only where supported; serial framing is
// the shared fallback. Camera, SD, BLE and high-speed logic capture are pending.
// The old ADC1 scope and automatic buses require the explicit classic bench
// profile; they are not defaults for a camera board or another SoC family.
// Electrical limits and attached wiring belong to the exact board/sensor.
// Arduino integration is not yet board-compiled or hardware-tested.

#include <Arduino.h>
#include "board_config.h"
#if HAVE_WIFI
#include <WiFi.h>
#endif
#include <Wire.h>
#include <SPI.h>
#include <esp_timer.h>
#include <Preferences.h>
#include <esp_arduino_version.h>
#include "channel_core.h"

static const bool CAMERA_BOARD = SENSEHUB_AI_THINKER_CAM != 0;
#if defined(CONFIG_IDF_TARGET_ESP32)
static const bool BENCH_BUSES = SENSEHUB_CLASSIC_BENCH != 0;
static const bool SCOPE_ENABLED = SENSEHUB_CLASSIC_BENCH != 0;
#else
static const bool BENCH_BUSES = false, SCOPE_ENABLED = false;
#endif
static const sensehub::PinPolicy CHANNEL_POLICY = sensehub::boardPolicy();

#if HAVE_BT
#include <BluetoothSerial.h>
BluetoothSerial SerialBT;
#endif

#define FW_MAJOR 0
#define FW_MINOR 1
#define CAPS_ADC 0x01
#define CAPS_BT 0x02
#define CAPS_WIFI 0x04
#define CAPS_I2C 0x08
#define CAPS_SPI 0x10
#define CAPS_DHT 0x20

// ---- user configuration (edit before flashing) ----
// No WiFi credentials live here. They arrive over a signed JOIN and are
// stored in NVS only after a successful join, so a stranger with the source
// learns nothing and a rebooted hub rejoins without another ceremony.
static const uint16_t WIFI_PORT = 3232;
static const char *BT_NAME = "SenseHub";
static const int BOOT_BUTTON_PIN = SENSEHUB_BOOT_BUTTON_PIN;
static const uint32_t SETUP_WINDOW_MS = 600000;  // 10 min TOFU window after boot
static const int SCOPE_PIN = 34;          // ADC1, input-only: no driver to fight
static const int I2C_SDA = 21, I2C_SCL = 22;
static const int SPI_SCK = 18, SPI_MISO = 19, SPI_MOSI = 23;
static const int SPI_CS_PINS[] = {};      // add configured CS pins here, e.g. {5, 17}

// ---- CRC-16/CCITT shared with the app side ----
static uint16_t crc16Update(uint16_t crc, const uint8_t *data, size_t len) {
  for (size_t i = 0; i < len; i++) {
    crc ^= (uint16_t)data[i] << 8;
    for (uint8_t b = 0; b < 8; b++) crc = (crc & 0x8000) ? (crc << 1) ^ 0x1021 : crc << 1;
  }
  return crc;
}
static uint16_t crc16(const uint8_t *data, size_t len) { return crc16Update(0xFFFF, data, len); }

// ---- ring buffer: single producer (timer), single consumer (loop) ----
// Power of two so indices wrap with a mask. Overwrite-oldest keeps the live
// display moving; drops are counted, never hidden.
template <uint16_t N> struct RingBuffer {
  static_assert((N & (N - 1)) == 0, "ring size must be a power of two");
  volatile uint16_t buf[N];
  volatile uint16_t head = 0, tail = 0;
  volatile uint32_t dropped = 0, sequence = 0;
  bool push(uint16_t v) {
    uint16_t h = head;
    buf[h & (N - 1)] = v;
    if ((uint16_t)(h - tail) >= N) { tail = h - N + 1; dropped++; }
    head = h + 1; sequence++;
    return true;
  }
  uint16_t available() const { return head - tail; }
  // Copy up to n oldest samples without blocking the producer.
  uint16_t peek(uint16_t *out, uint16_t n, uint32_t *seq0) {
    uint16_t t = tail, avail = head - t;
    if (n > avail) n = avail;
    *seq0 = sequence - avail;
    for (uint16_t i = 0; i < n; i++) out[i] = buf[(t + i) & (N - 1)];
    return n;
  }
  void consume(uint16_t n) { tail += n; }
};
static RingBuffer<4096> scopeRing;

// ---- runtime state ----
static volatile uint32_t g_sampleRateHz = 8000;
static volatile bool g_streaming = SCOPE_ENABLED;
static uint8_t g_transport = HAVE_BT ? 0 : HAVE_WIFI ? 1 : 3; // 2 USB framed; 3 idle
static bool g_usbFramed = false;
static int8_t g_replyTransport = -1;      // command replies return over their source
static const uint16_t BATCH = 128;
static uint16_t batchBuf[BATCH];

// ---- pairing state (see docs/protocol.md: trust on first use in reach) ----
static Preferences prefs;
static bool g_claimed = false;
static uint8_t g_adminKey[32];
static uint32_t g_lastCounter = 0;
static uint8_t g_nonce[24];
static bool g_nonceLive = false;
static uint32_t g_bootMs = 0;
static char g_apName[24];

static bool setupWindowOpen() {
  return !g_claimed && (millis() - g_bootMs < SETUP_WINDOW_MS);
}

enum VerifyResult { V_OK, V_NO_KEY, V_BAD_SIG };

// Ed25519 verify hook. Fail closed until the operator selects a backend
// (e.g. a TweetNaCl-derived verify-only routine). Test against the RFC 8032
// vector quoted in docs/protocol.md before trusting it.
static VerifyResult verifyEd25519(const uint8_t *msg, size_t msgLen,
                                  const uint8_t *sig, const uint8_t *pubkey) {
  (void)msg; (void)msgLen; (void)sig; (void)pubkey;
  return V_NO_KEY;
}

// ---- framed output (BT or TCP client, whichever streams) ----
#if HAVE_WIFI
static WiFiServer tcpServer(WIFI_PORT);
static WiFiClient tcpClient;
#endif
static bool wifiUp = false;

static void sendFrame(uint8_t type, const uint8_t *payload, uint16_t len) {
  if (len > 4096) return;
  uint8_t hdr[5] = {0x53, 0x48, type, (uint8_t)(len >> 8), (uint8_t)(len & 0xFF)};
  uint8_t crcIn[3];
  crcIn[0] = type; crcIn[1] = hdr[3]; crcIn[2] = hdr[4];
  uint16_t crc = crc16Update(crc16(crcIn, 3), payload, len);
  uint8_t tail[2] = {(uint8_t)(crc >> 8), (uint8_t)(crc & 0xFF)};
  auto writeAll = [&](const uint8_t *p, size_t n) {
#if HAVE_BT
    if ((g_replyTransport < 0 ? g_transport : g_replyTransport) == 0 && SerialBT.hasClient()) SerialBT.write(p, n);
#endif
#if HAVE_WIFI
    if ((g_replyTransport < 0 ? g_transport : g_replyTransport) == 1 && tcpClient && tcpClient.connected()) tcpClient.write(p, n);
#endif
    if ((g_replyTransport < 0 ? g_transport : g_replyTransport) == 2 && g_usbFramed) Serial.write(p, n);
  };
  writeAll(hdr, 5);
  if (len) writeAll(payload, len);
  writeAll(tail, 2);
}

static void sendHello() {
  uint8_t caps = CAPS_DHT;
  if (SCOPE_ENABLED) caps |= CAPS_ADC;
  if (BENCH_BUSES) caps |= CAPS_I2C | CAPS_SPI;
#if HAVE_BT
  caps |= CAPS_BT;
#endif
#if HAVE_WIFI
  caps |= CAPS_WIFI;
#endif
  uint8_t p[3] = {FW_MAJOR, FW_MINOR, caps};
  sendFrame(0x01, p, 3);
}

static void sendLog(uint8_t level, const char *text) {
  uint8_t p[128];
  size_t n = strlen(text);
  if (n > 120) n = 120;
  p[0] = level;
  memcpy(p + 1, text, n);
  sendFrame(0x05, p, n + 1);
}

// ---- fast path: timer sampling into the ring ----
static void IRAM_ATTR sampleTimer(void *arg) {
  (void)arg;
  // esp_timer runs in a high-priority task, not a true ISR: analogRead is
  // acceptable here, Serial/allocations are not.
  scopeRing.push((uint16_t)analogRead(SCOPE_PIN));
}
static esp_timer_handle_t sampleHandle = nullptr;

static void startSampler(uint32_t rateHz) {
  if (!SCOPE_ENABLED) return; // Scope needs an explicitly wired bench profile.
  if (sampleHandle) { esp_timer_stop(sampleHandle); esp_timer_delete(sampleHandle); }
  const esp_timer_create_args_t args = {.callback = sampleTimer, .name = "scope"};
  esp_timer_create(&args, &sampleHandle);
  esp_timer_start_periodic(sampleHandle, 1000000UL / rateHz);
  g_sampleRateHz = rateHz;
}

// ---- oversampling helper for slow channels (not the fast ring) ----
static uint16_t oversampledRead(int pin, uint8_t extraBits) {
  // +1 bit of resolution per 4x samples. Costs time: use on slow channels.
  uint8_t n = 1 << (extraBits * 2);
  uint32_t acc = 0;
  for (uint8_t i = 0; i < n; i++) acc += analogRead(pin);
  return (uint16_t)(acc >> extraBits);
}

// ---- sensor hub: slow poll table ----
enum SensorKind : uint8_t {
  K_NONE=0, K_DIGITAL=1, K_ANALOG_SLOW=2, K_DHT22=3, K_HCSR04=4, K_PIR=5,
};
struct Slot { SensorKind kind = K_NONE; int pin = -1, pin2 = -1; uint32_t interval = 1000, last = 0; float value = 0; uint8_t status = 2; };
static Slot slots[8];

static bool dht22Read(int pin, float *tempC, float *humidity) {
  // Minimal DHT22 bit-bang. Returns false on any timeout: a missing sensor
  // reads as an error, never as plausible weather.
  uint8_t data[5] = {0};
  pinMode(pin, OUTPUT);
  digitalWrite(pin, LOW);
  delay(2);
  digitalWrite(pin, HIGH);
  delayMicroseconds(30);
  pinMode(pin, INPUT_PULLUP);
  unsigned long t = micros();
  while (digitalRead(pin) == HIGH) { if (micros() - t > 100) return false; }
  t = micros();
  while (digitalRead(pin) == LOW) { if (micros() - t > 100) return false; }
  t = micros();
  while (digitalRead(pin) == HIGH) { if (micros() - t > 100) return false; }
  for (uint8_t i = 0; i < 40; i++) {
    t = micros();
    while (digitalRead(pin) == LOW) { if (micros() - t > 100) return false; }
    t = micros();
    while (digitalRead(pin) == HIGH) { if (micros() - t > 150) return false; }
    if (micros() - t > 50) data[i / 8] |= (1 << (7 - (i % 8)));
  }
  if (((data[0] + data[1] + data[2] + data[3]) & 0xFF) != data[4]) return false;
  *humidity = ((data[0] << 8) | data[1]) / 10.0f;
  int16_t raw = ((data[2] & 0x7F) << 8) | data[3];
  *tempC = (data[2] & 0x80 ? -raw : raw) / 10.0f;
  return true;
}

static void pollSlot(uint8_t i, uint32_t now) {
  Slot &s = slots[i];
  if (s.kind == K_NONE || now - s.last < s.interval) return;
  s.last = now;
  s.status = 2;
  if (s.kind == K_DIGITAL || s.kind == K_PIR) {
    pinMode(s.pin, CHANNEL_POLICY.pulls & sensehub::pinBit(uint8_t(s.pin)) ? INPUT_PULLUP : INPUT);
    s.value = (float)digitalRead(s.pin);
    s.status = 0;
  } else if (s.kind == K_ANALOG_SLOW) {
    s.value = oversampledRead(s.pin, 2) * 3.3f / 4095.0f;
    s.status = 0;
  } else if (s.kind == K_DHT22) {
    float t, h;
    if (dht22Read(s.pin, &t, &h)) { s.value = t; s.status = 0; }
  } else if (s.kind == K_HCSR04 && s.pin2 >= 0) {
    pinMode(s.pin, OUTPUT);
    digitalWrite(s.pin, LOW); delayMicroseconds(2);
    digitalWrite(s.pin, HIGH); delayMicroseconds(10);
    digitalWrite(s.pin, LOW);
    unsigned long us = pulseIn(s.pin2, HIGH, 30000);
    if (us) { s.value = us / 58.0f; s.status = 0; }
  }
  uint8_t p[7];
  p[0] = i; p[1] = (uint8_t)s.kind;
  uint32_t bits;
  memcpy(&bits, &s.value, 4);
  p[2] = bits >> 24; p[3] = bits >> 16; p[4] = bits >> 8; p[5] = bits;
  p[6] = s.status;
  sendFrame(0x03, p, 7);
}

// ---- I2C detect with the known-device registry ----
static uint8_t i2cReadReg(uint8_t addr, uint8_t reg, uint8_t *out) {
  Wire.beginTransmission(addr);
  Wire.write(reg);
  if (Wire.endTransmission(false) != 0) return 0;
  if (Wire.requestFrom(addr, (uint8_t)1) != 1) return 0;
  *out = Wire.read();
  return 1;
}

struct FoundDev { uint8_t bus, addr; uint16_t devId; uint8_t conf; char name[20]; };
static FoundDev found[32];
static uint8_t foundCount = 0;

static void reportDev(uint8_t bus, uint8_t addr, uint16_t devId, uint8_t conf, const char *name) {
  if (foundCount >= 32) return;
  FoundDev &f = found[foundCount++];
  f.bus = bus; f.addr = addr; f.devId = devId; f.conf = conf;
  strncpy(f.name, name, 19); f.name[19] = 0;
}

static void scanI2C() {
  foundCount = 0;
  for (uint8_t addr = 0x08; addr < 0x78; addr++) {
    Wire.beginTransmission(addr);
    if (Wire.endTransmission() != 0) continue;
    uint8_t v = 0;
    if (i2cReadReg(addr, 0x75, &v) && v == 0x68) { reportDev(0, addr, 0x6050, 1, "mpu6050"); continue; }
    if (i2cReadReg(addr, 0xD0, &v)) {
      if (v == 0x58) { reportDev(0, addr, 0x2800, 1, "bmp280"); continue; }
      if (v == 0x60) { reportDev(0, addr, 0x2801, 1, "bme280"); continue; }
    }
    if (addr == 0x68) {
      // MPU6050 ruled out above. A DS3231 answers time registers in BCD.
      uint8_t sec = 0;
      if (i2cReadReg(addr, 0x00, &sec) && ((sec & 0x7F) < 0x60) && ((sec & 0x0F) < 0x0A)) { reportDev(0, addr, 0x3231, 0, "ds3231?"); continue; }
    }
    if (addr == 0x38) { reportDev(0, addr, 0x3810, 0, "aht10/20?"); continue; }
    if (addr == 0x23 || addr == 0x5C) { reportDev(0, addr, 0x1750, 0, "bh1750?"); continue; }
    if (addr >= 0x40 && addr <= 0x4F) { reportDev(0, addr, 0x2119, 0, "ina219?"); continue; }
    if (addr == 0x3C || addr == 0x3D) { reportDev(0, addr, 0x1306, 0, "ssd1306?"); continue; }
    if (addr == 0x44 || addr == 0x45) { reportDev(0, addr, 0x2730, 0, "sht3x?"); continue; }
    reportDev(0, addr, 0x0000, 0, "unknown-i2c");
  }
}

static uint8_t spiRead(uint8_t cs, uint8_t reg) {
  digitalWrite(cs, LOW);
  SPI.transfer(reg);
  uint8_t v = SPI.transfer(0x00);
  digitalWrite(cs, HIGH);
  return v;
}

static void scanSPI() {
  for (uint8_t i = 0; i < sizeof(SPI_CS_PINS) / sizeof(SPI_CS_PINS[0]); i++) {
    uint8_t cs = SPI_CS_PINS[i];
    pinMode(cs, OUTPUT);
    digitalWrite(cs, HIGH);
    SPI.beginTransaction(SPISettings(1000000, MSBFIRST, SPI_MODE0));
    uint8_t mfrc = spiRead(cs, ((0x37 << 1) & 0x7E) | 0x80);
    if ((mfrc & 0xF0) == 0x90) { reportDev(2, cs, 0xC522, 1, "mfrc522"); }
    else {
      uint8_t cfg = spiRead(cs, 0x00);
      if (cfg == 0x08) reportDev(2, cs, 0x2401, 0, "nrf24?");
      else reportDev(2, cs, 0x0000, 0, "unknown-spi");
    }
    SPI.endTransaction();
  }
}

static void sendDetect() {
  uint8_t p[512];
  p[0] = 1;  // one bus group in this reply; extend with I2C1 as needed
  size_t n = 1;
  for (uint8_t i = 0; i < foundCount && n + 22 < sizeof(p); i++) {
    const FoundDev &f = found[i];
    uint8_t nameLen = strlen(f.name);
    p[n++] = f.bus; p[n++] = f.addr;
    p[n++] = f.devId >> 8; p[n++] = f.devId & 0xFF;
    p[n++] = f.conf; p[n++] = nameLen;
    memcpy(p + n, f.name, nameLen); n += nameLen;
  }
  sendFrame(0x04, p, n);
}

// ---- typed channel API: independent of legacy sensor slots ----
static sensehub::ChannelState labChannels[8]; // ids 8..15, no collision with scope/slots

static void releaseChannelHardware(const sensehub::ChannelConfig &c) {
  if (c.mode == sensehub::Disabled) return;
  if (c.mode == sensehub::PwmOutput) {
#if SOC_LEDC_SUPPORTED
#if ESP_ARDUINO_VERSION_MAJOR >= 3
    ledcDetach(c.pin);
#else
    ledcDetachPin(c.pin);
#endif
#endif
  }
  if (c.mode == sensehub::DigitalOutput || c.mode == sensehub::PwmOutput) digitalWrite(c.pin, LOW);
  pinMode(c.pin, INPUT);
}

static bool startChannelHardware(const sensehub::ChannelConfig &c) {
  if (c.mode == sensehub::Disabled) return true;
  if (c.mode == sensehub::DigitalInput) {
    pinMode(c.pin, c.pull == 1 ? INPUT_PULLUP : c.pull == 2 ? INPUT_PULLDOWN : INPUT);
  } else if (c.mode == sensehub::DigitalOutput) {
    digitalWrite(c.pin, c.output ? HIGH : LOW); pinMode(c.pin, OUTPUT);
  } else {
#if SOC_LEDC_SUPPORTED
#if ESP_ARDUINO_VERSION_MAJOR >= 3
    if (!ledcAttachChannel(c.pin, c.frequency, 10, 0)) return false;
    if (!ledcWrite(c.pin, c.duty)) { ledcDetach(c.pin); return false; }
#else
    if (ledcSetup(0, c.frequency, 10) <= 0) return false;
    ledcAttachPin(c.pin, 0); ledcWrite(0, c.duty);
#endif
#else
    return false;
#endif
  }
  return true;
}

static sensehub::Error applyChannel(const sensehub::ChannelConfig &c) {
  auto error = sensehub::validate(c, labChannels, 8, CHANNEL_POLICY);
  if (error != sensehub::Ok) return error;
  if (c.mode != sensehub::Disabled) for (const auto &slot : slots) {
    if (slot.kind != K_NONE && (slot.pin == c.pin || slot.pin2 == c.pin)) return sensehub::PinBusy;
  }
  auto &state = labChannels[c.id - 8]; const auto old = state.config;
  releaseChannelHardware(old);
  if (!startChannelHardware(c)) {
    // Restore the old binding if attachment failed. If restoration fails too,
    // report the resulting disabled state instead of claiming the old output.
    releaseChannelHardware(c);
    if (!startChannelHardware(old)) { auto disabled = old; disabled.mode = sensehub::Disabled; sensehub::configure(state, disabled); }
    return sensehub::HardwareFailure;
  }
  sensehub::configure(state, c); return sensehub::Ok;
}

static void sendChannelConfig(uint8_t id) {
  const auto &s = labChannels[id - 8]; const auto &c = s.config;
  uint8_t p[20] = {c.id,c.mode,c.pin,c.pull,c.invert,
    uint8_t(c.pollMs >> 8),uint8_t(c.pollMs),uint8_t(c.debounceMs >> 8),uint8_t(c.debounceMs),c.output,
    uint8_t(c.frequency >> 24),uint8_t(c.frequency >> 16),uint8_t(c.frequency >> 8),uint8_t(c.frequency),uint8_t(c.duty >> 8),uint8_t(c.duty),
    uint8_t(s.revision >> 24),uint8_t(s.revision >> 16),uint8_t(s.revision >> 8),uint8_t(s.revision)};
  sendFrame(0x0A, p, sizeof(p));
}

static void pinList(uint64_t mask, char *text, size_t size) {
  size_t n = 0; text[n++] = '[';
  for (uint8_t pin = 0; pin < 64; pin++) if (mask & sensehub::pinBit(pin)) {
    const int wrote = snprintf(text + n, size - n, "%s%u", n > 1 ? "," : "", pin);
    if (wrote < 0 || size_t(wrote) >= size - n) return; n += wrote;
  }
  if (n + 2 <= size) { text[n++] = ']'; text[n] = 0; }
}
static void sendCapabilities(bool usb = false) {
  static char json[4096];
  char inputs[256], outputs[256], noPull[256];
  pinList(CHANNEL_POLICY.inputs, inputs, sizeof(inputs));
  pinList(CHANNEL_POLICY.outputs, outputs, sizeof(outputs));
  pinList(CHANNEL_POLICY.inputs & ~CHANNEL_POLICY.pulls, noPull, sizeof(noPull));
  int n = snprintf(json, sizeof(json),
    "{\"schemaVersion\":1,\"profile\":\"%s\",\"soc\":\"%s\",\"transportSupport\":{\"usbFramed\":true,\"wifi\":%s,\"bluetoothSpp\":%s,\"bleHardware\":%s,\"bleImplemented\":false},\"channelIds\":[8,9,10,11,12,13,14,15],"
    "\"availablePins\":%s,\"outputPins\":%s,\"noPullPins\":%s,\"scopeSampler\":%s,\"modes\":%s,\"capture\":\"loop-poll\",\"timestampUnit\":\"us\","
    "\"nominalMinPollMs\":1,\"pwmSlots\":%u,\"pwmResolutionBits\":10,\"pwmMaxHz\":20000,"
    "\"processing\":[\"invert\",\"stable-debounce\"],\"identity\":\"user-configured GPIO; sensor unknown\",\"channels\":[",
    sensehub::boardName(), ESP.getChipModel(), HAVE_WIFI ? "true" : "false", HAVE_BT ? "true" : "false", HAVE_BLE_HARDWARE ? "true" : "false",
    inputs, outputs, noPull, SCOPE_ENABLED ? "true" : "false",
    !CHANNEL_POLICY.inputs ? "[]" : !CHANNEL_POLICY.outputs ? "[\"digital-input\"]" : CHANNEL_POLICY.pwm ? "[\"digital-input\",\"digital-output\",\"pwm-output\"]" : "[\"digital-input\",\"digital-output\"]",
    CHANNEL_POLICY.pwm && CHANNEL_POLICY.outputs ? 1 : 0);
  for (uint8_t i = 0; i < 8 && n > 0 && size_t(n) < sizeof(json) - 180; i++) {
    const auto &s = labChannels[i]; const auto &c = s.config;
    n += snprintf(json + n, sizeof(json) - n,
      "%s{\"id\":%u,\"mode\":%u,\"pin\":%u,\"pollMs\":%u,\"debounceMs\":%u,\"revision\":%lu}",
      i ? "," : "",c.id,c.mode,c.pin,c.pollMs,c.debounceMs,(unsigned long)s.revision);
  }
  if (n < 0 || size_t(n) >= sizeof(json) - 3) return;
  snprintf(json + n, sizeof(json) - n, "]}");
  if (usb) Serial.println(json); else sendFrame(0x08, (const uint8_t *)json, strlen(json));
}

static void pollLabChannels(uint64_t nowUs) {
  for (auto &state : labChannels) {
    const auto &c = state.config;
    if (c.mode != sensehub::DigitalInput || (state.sampled && nowUs - state.lastPoll < uint64_t(c.pollMs) * 1000)) continue;
    const auto observation = sensehub::observe(state, digitalRead(c.pin) == HIGH, nowUs);
    uint8_t p[20]; p[0] = c.id;
    for (uint8_t i = 0; i < 8; i++) p[1 + i] = uint8_t(nowUs >> (56 - 8 * i));
    p[9] = observation.raw; p[10] = observation.value;
    p[11] = (observation.valid ? 0 : 1) | (observation.gap ? 2 : 0);
    const uint32_t seq = state.sequence++;
    for (uint8_t i = 0; i < 4; i++) { p[12 + i] = seq >> (24 - 8 * i); p[16 + i] = state.revision >> (24 - 8 * i); }
    sendFrame(0x09, p, sizeof(p));
  }
}

// ---- framed inbound: pairing first, signatures after ----
static void handleInner(uint8_t type, const uint8_t *p, uint16_t n, bool viaBt);

static void handleSigned(const uint8_t *p, uint16_t n, bool viaBt) {
  if (n < 4 + 1 + 64) return;
  uint32_t ctr = ((uint32_t)p[0] << 24) | ((uint32_t)p[1] << 16) | ((uint32_t)p[2] << 8) | p[3];
  uint8_t inner = p[4];
  size_t bodyLen = n - 4 - 1 - 64;
  if (ctr <= g_lastCounter) return;  // replay or reorder: silent drop
  uint8_t signedPart[4 + 1 + 512];
  if (bodyLen + 5 > sizeof(signedPart)) return;
  memcpy(signedPart, p, 4 + 1 + bodyLen);
  if (verifyEd25519(signedPart, 4 + 1 + bodyLen, p + 4 + 1 + bodyLen, g_adminKey) != V_OK) return;
  g_lastCounter = ctr;
  prefs.putUInt("lastctr", ctr);
  handleInner(inner, p + 5, bodyLen, viaBt);
}

static void handleClaim(const uint8_t *p, uint16_t n) {
  // CLAIM: admin_pubkey[32] + sig[64] over (nonce || pubkey). Setup window only.
  if (!setupWindowOpen() || !g_nonceLive || n != 96) return;
  uint8_t msg[24 + 32];
  memcpy(msg, g_nonce, 24);
  memcpy(msg + 24, p, 32);
  if (verifyEd25519(msg, sizeof(msg), p + 32, p) != V_OK) return;
  memcpy(g_adminKey, p, 32);
  prefs.putBytes("adminkey", g_adminKey, 32);
  prefs.putBool("claimed", true);
  prefs.putUInt("lastctr", 0);
  g_claimed = true;
  g_lastCounter = 0;
  g_nonceLive = false;
  sendLog(0, "claimed by admin key; setup closed");
}

static void handleJoin(const uint8_t *p, uint16_t n, bool viaBt) {
#if HAVE_WIFI
  // JOIN is honored from Bluetooth so the WiFi link being replaced never has
  // to carry its own replacement. AP stays up throughout (APSTA).
  if (n < 2 || p[0] + 1 > n) return;
  uint8_t ssidLen = p[0];
  if (1 + ssidLen + 1 > n) return;
  uint8_t pskLen = p[1 + ssidLen];
  if (1 + ssidLen + 1 + pskLen != n || ssidLen == 0 || ssidLen > 32 || pskLen > 64) return;
  char ssid[33], psk[65];
  memcpy(ssid, p + 1, ssidLen); ssid[ssidLen] = 0;
  memcpy(psk, p + 2 + ssidLen, pskLen); psk[pskLen] = 0;
  (void)viaBt;
  WiFi.mode(WIFI_AP_STA);
  WiFi.begin(ssid, psk);
  unsigned long t0 = millis();
  while (WiFi.status() != WL_CONNECTED && millis() - t0 < 15000) delay(250);
  if (WiFi.status() == WL_CONNECTED) {
    wifiUp = true;
    prefs.putString("ssid", ssid);
    prefs.putString("psk", psk);
    sendLog(0, "station joined; AP and BT still serving");
  } else {
    sendLog(2, "station join failed; AP and BT still serving");
  }
  memset(psk, 0, sizeof(psk));
#else
  (void)p; (void)n; (void)viaBt; sendLog(2, "WiFi backend unavailable on this target");
#endif
}

static void handleInner(uint8_t type, const uint8_t *p, uint16_t n, bool viaBt) {
  (void)viaBt;
  if (type == 0x10 && n == 6) {  // CONFIG
    if (!SCOPE_ENABLED) { const uint8_t ack[2] = {0x10, sensehub::UnsupportedPin}; sendFrame(0x06, ack, 2); return; }
    uint32_t rate = ((uint32_t)p[0] << 24) | ((uint32_t)p[1] << 16) | ((uint32_t)p[2] << 8) | p[3];
    if (rate >= 100 && rate <= 40000) startSampler(rate);
  } else if (type == 0x11 && n == 1) {
    if (!BENCH_BUSES) { const uint8_t ack[2] = {0x11, sensehub::UnsupportedPin}; sendFrame(0x06, ack, 2); return; }
    if (p[0] & 0x01) { scanI2C(); }
    if (p[0] & 0x04) { scanSPI(); }
    sendDetect();
  } else if (type == 0x12 && n == 1 && p[0] < 8) {
    slots[p[0]].last = 0;  // force an immediate reading and report
    pollSlot(p[0], millis());
  } else if (type == 0x16) {
    handleJoin(p, n, viaBt);
  } else if (type == 0x21) {
    sensehub::ChannelConfig config;
    const auto code = sensehub::decodeConfig(p, n, config) ? applyChannel(config) : sensehub::Invalid;
    const uint8_t ack[2] = {0x21, uint8_t(code)}; sendFrame(0x06, ack, 2);
    if (config.id >= 8 && config.id <= 15) sendChannelConfig(config.id);
  }
}

// Minimal streaming parser shared by the BT and TCP byte sources.
struct FrameParser {
  uint8_t buf[4200];
  size_t len = 0;
  void feed(const uint8_t *data, size_t n, uint8_t sourceTransport) {
    const bool viaBt = sourceTransport == 0;
    if (len + n > sizeof(buf)) len = 0;
    memcpy(buf + len, data, n);
    len += n;
    for (;;) {
      size_t at = 0;
      while (at + 1 < len && !(buf[at] == 0x53 && buf[at + 1] == 0x48)) at++;
      if (at > 0) { memmove(buf, buf + at, len - at); len -= at; }
      if (len < 5) return;
      uint16_t payLen = ((uint16_t)buf[3] << 8) | buf[4];
      if (payLen > 4096) { memmove(buf, buf + 2, len - 2); len -= 2; continue; }
      if (len < (size_t)5 + payLen + 2) return;
      uint8_t chk[3 + 4096];
      chk[0] = buf[2]; chk[1] = buf[3]; chk[2] = buf[4];
      memcpy(chk + 3, buf + 5, payLen);
      uint16_t want = ((uint16_t)buf[5 + payLen] << 8) | buf[6 + payLen];
      uint8_t type = buf[2];
      if (crc16(chk, 3 + payLen) == want) {
        g_replyTransport = sourceTransport;
        if (type == 0x13) { uint8_t ok[2] = {0x13, 0}; sendFrame(0x06, ok, 2); }
        else if (type == 0x20 && payLen == 0) sendCapabilities();
        else if (type == 0x15) {
          for (uint8_t i = 0; i < 24; i++) g_nonce[i] = (uint8_t)esp_random();
          g_nonceLive = true;
          uint8_t rp[24 + 8 + 1];
          memcpy(rp, g_nonce, 24);
          uint64_t mac = ESP.getEfuseMac();
          for (uint8_t i = 0; i < 8; i++) rp[24 + i] = (mac >> (8 * i)) & 0xFF;
          rp[32] = g_claimed ? 1 : 0;
          sendFrame(0x07, rp, 33);
        }
        else if (type == 0x14) handleClaim(buf + 5, payLen);
        else if (sourceTransport == 2 && type == 0x21) handleInner(type, buf + 5, payLen, false);
        else if (g_claimed) handleSigned(buf + 5, payLen, viaBt);
        // Unclaimed and outside the setup window: silent drop, no oracle.
        g_replyTransport = -1;
      }
      memmove(buf, buf + 5 + payLen + 2, len - 5 - payLen - 2);
      len -= 5 + payLen + 2;
    }
  }
};
static FrameParser btParser, tcpParser, usbParser;

// ---- human serial commands (USB) ----
static void handleSerialLine(const String &line) {
  if (line == "CAPABILITIES") { sendCapabilities(true); }
  else if (line.startsWith("CHANNEL ")) {
    int id, mode, pin, pull, invert, poll, hold, output, frequency, duty;
    if (sscanf(line.c_str(), "CHANNEL %d %d %d %d %d %d %d %d %d %d", &id,&mode,&pin,&pull,&invert,&poll,&hold,&output,&frequency,&duty) != 10 ||
        id < 8 || id > 15 || mode < 0 || mode > 3 || pin < 0 || pin > 63 || pull < 0 || pull > 2 || invert < 0 || invert > 1 || poll < 1 || poll > 60000 || hold < 0 || hold > 60000 || output < 0 || output > 1 || frequency < 0 || frequency > 20000 || duty < 0 || duty > 1023) {
      Serial.println("error: CHANNEL id mode pin pull invert poll_ms debounce_ms output frequency duty_10bit");
    } else {
      sensehub::ChannelConfig c; c.id=id; c.mode=mode; c.pin=pin; c.pull=pull; c.invert=invert; c.pollMs=poll; c.debounceMs=hold; c.output=output; c.frequency=frequency; c.duty=duty;
      Serial.printf("channel_config_result=%u\n", uint8_t(applyChannel(c))); sendCapabilities(true);
    }
  }
  else if (line.startsWith("RATE ")) { const long rate = line.substring(5).toInt(); if (!SCOPE_ENABLED) Serial.println("scope ADC unavailable in this board profile"); else if (rate >= 100 && rate <= 40000) { startSampler(rate); Serial.println("rate set"); } else Serial.println("rate must be 100..40000"); }
  else if (line.startsWith("CH ")) { Serial.println("single ADC1 channel in v0; reflash to move it"); }
  else if (line == "MODE BT") { if (HAVE_BT) { g_transport = 0; Serial.println("transport=bt"); } else Serial.println("Bluetooth SPP unavailable"); }
  else if (line == "MODE WIFI") { if (HAVE_WIFI) { g_transport = 1; Serial.println("transport=wifi"); } else Serial.println("WiFi unavailable"); }
  else if (line == "MODE USB") { Serial.println("transport=usb-framed; reboot to return to text commands"); g_usbFramed = true; g_transport = 2; }
  else if (line == "SCAN") { if (!BENCH_BUSES) Serial.println("buses unconfigured in this board profile"); else { scanI2C(); scanSPI(); sendDetect(); Serial.println("scan sent"); } }
  else if (line.startsWith("SLOT ")) {
    // SLOT <i> <kind> <pin> [pin2] [interval_ms]  e.g. SLOT 0 3 15 0 2000
    int i, k, pin, pin2 = -1, iv = 2000;
    if (sscanf(line.c_str(), "SLOT %d %d %d %d %d", &i, &k, &pin, &pin2, &iv) >= 3 && i >= 0 && i < 8) {
      if (k < K_DIGITAL || k > K_PIR || iv < 1 || iv > 60000 || pin < 0 || pin > 63 ||
          !sensehub::inputPin(uint8_t(pin), CHANNEL_POLICY) ||
          (!SCOPE_ENABLED && k == K_ANALOG_SLOW) ||
          (k == K_DHT22 && (!sensehub::outputPin(uint8_t(pin), CHANNEL_POLICY) || iv < 2000)) ||
          (k == K_HCSR04 && (pin2 < 0 || pin2 > 63 || pin == pin2 || !sensehub::outputPin(uint8_t(pin), CHANNEL_POLICY) || !sensehub::inputPin(uint8_t(pin2), CHANNEL_POLICY)))) {
        Serial.println("unsupported sensor/pin/interval for board profile"); return;
      }
      bool busy = false;
      for (const auto &channel : labChannels) if (channel.config.mode != sensehub::Disabled && (channel.config.pin == pin || channel.config.pin == pin2)) busy = true;
      if (busy) { Serial.println("pin used by typed channel"); return; }
      slots[i].kind = (SensorKind)k; slots[i].pin = pin; slots[i].pin2 = pin2; slots[i].interval = iv;
      Serial.println("slot set");
    } else Serial.println("usage: SLOT i kind pin [pin2] [ms]");
  }
  else if (line == "STATUS") {
    Serial.printf("rate=%lu streaming=%d transport=%s ring=%u dropped=%lu claimed=%d ap=%s\n",
      (unsigned long)g_sampleRateHz, g_streaming, g_transport == 0 ? "bt" : g_transport == 1 ? "wifi" : g_transport == 2 ? "usb" : "idle",
      scopeRing.available(), (unsigned long)scopeRing.dropped, (int)g_claimed, g_apName);
  }
  else if (line == "HELP") Serial.println("CAPABILITIES | CHANNEL id mode pin pull invert poll_ms debounce_ms output frequency duty_10bit | RATE n | MODE BT|WIFI|USB | SCAN | SLOT i kind pin [pin2] [ms] | STATUS");
  else Serial.println("unknown; try HELP");
}

void setup() {
  Serial.begin(115200);
  for (uint8_t i = 0; i < 8; i++) labChannels[i].config.id = 8 + i;
  g_bootMs = millis();
  prefs.begin("sensehub", false);
  g_claimed = prefs.getBool("claimed", false);
  g_lastCounter = prefs.getUInt("lastctr", 0);
  if (g_claimed) prefs.getBytes("adminkey", g_adminKey, 32);
  if (BOOT_BUTTON_PIN >= 0) pinMode(BOOT_BUTTON_PIN, INPUT_PULLUP);
  if (SCOPE_ENABLED) analogSetPinAttenuation(SCOPE_PIN, ADC_11db);
  if (BENCH_BUSES) {
    Wire.begin(I2C_SDA, I2C_SCL);
    SPI.begin(SPI_SCK, SPI_MISO, SPI_MOSI);
  }
  // Boot is always access-point first: nothing joins a network uninvited.
  uint32_t chip = (uint32_t)(ESP.getEfuseMac() & 0xFFFF);
  snprintf(g_apName, sizeof(g_apName), "SenseHub-%04X", chip);
#if HAVE_WIFI
  WiFi.mode(WIFI_AP_STA);
  WiFi.softAP(g_apName);
  tcpServer.begin();  // LAN/owner side; setup commands still need pairing
  String knownSsid = prefs.getString("ssid", "");
  String knownPsk = prefs.getString("psk", "");
  if (knownSsid.length()) {
    // Recall, don't insist: a moved or changed network must never wedge boot.
    WiFi.begin(knownSsid.c_str(), knownPsk.c_str());
    unsigned long t0 = millis();
    while (WiFi.status() != WL_CONNECTED && millis() - t0 < 5000) delay(250);
    wifiUp = WiFi.status() == WL_CONNECTED;
  }
#endif
#if HAVE_BT
  SerialBT.begin(String(g_apName));
#endif
  startSampler(g_sampleRateHz);
  sendHello();
  char msg[96];
  snprintf(msg, sizeof(msg), "sensehub v%d.%d ap=%s claimed=%d", FW_MAJOR, FW_MINOR, g_apName, (int)g_claimed);
  sendLog(0, msg);
}

void loop() {
  static String line;
  static unsigned long bootHoldStart = 0;
  // Physical recovery: hold BOOT 5 s to unclaim. Documented, deliberate,
  // and the only unauthenticated state change after claiming.
  if (BOOT_BUTTON_PIN >= 0 && digitalRead(BOOT_BUTTON_PIN) == LOW) {
    if (!bootHoldStart) bootHoldStart = millis();
    if (millis() - bootHoldStart > 5000 && g_claimed) {
      prefs.putBool("claimed", false);
      g_claimed = false;
      g_nonceLive = false;
      sendLog(1, "unclaimed by physical button");
      bootHoldStart = millis();  // re-arm only after release below
    }
  } else bootHoldStart = 0;
  while (!g_usbFramed && Serial.available()) {
    char c = Serial.read();
    if (c == '\n') { handleSerialLine(line); line = ""; }
    else if (c != '\r') line += c;
  }
  if (g_usbFramed) {
    uint8_t chunk[256]; size_t n = 0;
    while (n < sizeof(chunk) && Serial.available()) chunk[n++] = Serial.read();
    if (n) usbParser.feed(chunk, n, 2);
  }
#if HAVE_BT
  while (SerialBT.available()) {
    uint8_t chunk[256];
    size_t n = 0;
    while (n < sizeof(chunk) && SerialBT.available()) chunk[n++] = SerialBT.read();
    if (n) btParser.feed(chunk, n, 0);
  }
#endif
#if HAVE_WIFI
  if (!tcpClient) tcpClient = tcpServer.available();
  if (tcpClient) {
    if (!tcpClient.connected()) tcpClient.stop();
    else {
      uint8_t chunk[512];
      int n = tcpClient.read(chunk, sizeof(chunk));
      if (n > 0) tcpParser.feed(chunk, n, 1);
    }
  }
#endif
  uint32_t now = millis();
  pollLabChannels(uint64_t(esp_timer_get_time()));
  for (uint8_t i = 0; i < 8; i++) pollSlot(i, now);
  if (g_streaming && scopeRing.available() >= BATCH) {
    uint32_t seq0;
    uint16_t n = scopeRing.peek(batchBuf, BATCH, &seq0);
    uint8_t p[5 + BATCH * 2];
    p[0] = 0;  // channel 0 = scope ADC
    p[1] = seq0 >> 24; p[2] = seq0 >> 16; p[3] = seq0 >> 8; p[4] = seq0;
    for (uint16_t i = 0; i < n; i++) { p[5 + 2 * i] = batchBuf[i] >> 8; p[6 + 2 * i] = batchBuf[i] & 0xFF; }
    sendFrame(0x02, p, 5 + 2 * n);
    scopeRing.consume(n);
  }
}
