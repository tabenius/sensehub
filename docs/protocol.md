# SenseHub wire protocol v0

Binary framing shared by the ESP32 firmware and the companion app, over
Bluetooth SPP or WiFi TCP. Little machine, explicit bytes: every multi-byte
integer is big-endian, floats are IEEE-754 big-endian.

## Frame

```
u8[2] magic      0x53 0x48  ("SH")
u8    type
u16   length      payload bytes that follow
u8[]  payload
u16   crc         CRC-16/CCITT (poly 0x1021, init 0xFFFF) over type+length+payload
```

Maximum payload 4096 bytes. A parser must resynchronise on the magic bytes
and reject short/overlong frames without crashing; the Rust side tests this
with garbage-injected streams.

## Device → app

| Type | Name    | Payload |
|------|---------|---------|
| 0x01 | HELLO   | u8 fw_major, u8 fw_minor, u8 caps bitmask (bit0 ADC, bit1 BT, bit2 WiFi, bit3 I2C, bit4 SPI, bit5 DHT) |
| 0x02 | SAMPLES | u8 channel, u32 start_seq, u16 count, u16[count] raw ADC (12-bit, right-justified) |
| 0x03 | SENSOR  | u8 slot, u8 kind, f32 value, u8 status (0 ok, 1 stale, 2 error) |
| 0x04 | DETECT  | u8 bus_count, then per bus: u8 bus (0 I2C0, 1 I2C1, 2 SPI0), u8 addr_or_cs, u16 device_id, u8 confidence (0 tentative, 1 confirmed), u8 name_len, u8[name_len] name |
| 0x05 | LOG     | u8 level (0 info, 1 warn, 2 error), UTF-8 text |
| 0x06 | ACK     | u8 request_type, u8 code (0 ok, else error) |

## App → device

| Type | Name   | Payload |
|------|--------|---------|
| 0x10 | CONFIG | u32 sample_rate_hz, u8 adc_channel, u8 transport (0 BT, 1 WiFi), u8 batch |
| 0x11 | SCAN   | u8 buses bitmask (bit0 I2C0, bit1 I2C1, bit2 SPI0) → answers DETECT |
| 0x12 | POLL   | u8 slot → answers SENSOR |
| 0x13 | PING   | empty → answers ACK |
| 0x14 | CLAIM  | admin_pubkey[32], signature[64] over (nonce \|\| admin_pubkey); TOFU pairing, setup mode only |
| 0x15 | NONCE  | empty → answers NONCE_REPLY |
| 0x16 | JOIN   | signed envelope (see below): u8 ssid_len, ssid, u8 psk_len, psk |

## Device → app (pairing additions)

| Type | Name        | Payload |
|------|-------------|---------|
| 0x07 | NONCE_REPLY | u8[24] nonce, u8[8] device_id, u8 claimed (0 setup-open, 1 claimed) |

## Boot, pairing, and network switching

Boot is always access-point first: the device brings up `SenseHub-XXXX`
(open, setup-only) plus Bluetooth discoverable. Streaming starts only after
an explicit transport selection; nothing is exposed to a network the owner
did not choose.

Pairing is trust-on-first-use inside physical reach, not a default password
that survives deployment:

1. App opens the BT channel and requests NONCE.
2. App sends CLAIM with a fresh admin Ed25519 public key and a signature over
   the nonce concatenated with that key, proving possession at claim time.
3. The device stores the key, leaves setup mode, and refuses further unsigned
   setup commands. The setup window also closes ten minutes after boot.
4. Recovery is physical: hold the BOOT button for five seconds to unclaim.

After claiming, privileged commands (CONFIG, SCAN, JOIN) travel as signed
envelopes: u32 BE monotonic counter, u8 inner_type, inner payload, then a
u8[64] Ed25519 signature over (counter \|\| inner_type \|\| inner payload).
The device keeps the highest seen counter and rejects replays and
backwards counters. Unsigned setup commands are refused once claimed.

WiFi switching is commanded over Bluetooth, never over the WiFi link being
replaced: the app sends a signed JOIN, the device keeps serving AP+BT in
APSTA mode while attempting STA association, and reports success or timeout
without stranding itself offline. If the join fails, it stays reachable and
says so.

Keys are minisign-shaped: plain Ed25519, 32-byte public keys that an operator
may generate with `minisign -G` and paste as the key portion. The command
wire format is its own domain-separated protocol, not `.minisig` files —
minisign signs files, we sign commands, same primitive. The firmware exposes
a single `verifyEd25519()` call site; the operator selects the Ed25519
verify backend (e.g. a TweetNaCl-derived verify-only routine).

Before trusting any backend, verify it against RFC 8032 §7.1 TEST 1 (empty
message): the published secret, public key, and signature for the empty
string must verify, and a flipped signature bit must fail. The RFC text is
authoritative; no bytes are quoted here precisely so nobody transcribes them
wrong from this document.

Threat-model honesty: BT SPP without Secure Simple Pairing is not a private
channel, so the WiFi passphrase in a JOIN is visible to a radio observer
during setup. The signature proves *who* ordered the join, not that nobody
listened. Setup is therefore a proximity act — same room, same bench — and
the passphrase should be rotated afterwards if that assumption ever fails.

## Sensor kinds

0 none, 1 digital, 2 analog_slow, 3 dht22, 4 hcsr04, 5 pir,
6 i2c_bmp280, 7 i2c_bme280, 8 i2c_mpu6050, 9 i2c_bh1750, 10 i2c_ina219,
11 i2c_ssd1306, 12 i2c_ahtx0, 13 spi_mfrc522, 14 spi_nrf24.

## Known-device registry (firmware side)

Confirmed identity comes from a version register, never from an ACK alone:

| Device | Bus | Addr | Probe |
|--------|-----|------|-------|
| MPU6050 | I2C | 0x68/0x69 | reg 0x75 == 0x68 → confirmed |
| BMP280 | I2C | 0x76/0x77 | reg 0xD0 == 0x58 → confirmed |
| BME280 | I2C | 0x76/0x77 | reg 0xD0 == 0x60 → confirmed |
| BH1750 | I2C | 0x23/0x5C | ACK only → tentative |
| INA219 | I2C | 0x40–0x4F | ACK only → tentative |
| SSD1306 | I2C | 0x3C/0x3D | ACK only → tentative |
| AHT10/AHT20 | I2C | 0x38 | ACK + status-byte bit3 cal flag → confirmed-ish (confidence 1 only after init handshake) |
| DS3231 vs MPU6050 | I2C | 0x68 | disambiguate: 0x75==0x68 → MPU6050; else BCD-plausible seconds at 0x00 → DS3231 tentative |
| MFRC522 | SPI | CS pin | VersionReg 0x37 high nibble 0x9 → confirmed |
| NRF24L01 | SPI | CS pin | CONFIG reg default 0x08 → tentative (it is writable, so never confirmed) |

ACK-only hits are reported with confidence 0 and the word "tentative" in the
name, e.g. "ina219?". The app must display tentative and confirmed differently.
SPI has no bus enumeration: only explicitly configured CS pins are probed, and
probing never writes — reads only.
