# The 37-module bag → SenseHub kinds

The common 37-in-1 kit varies by seller; check your actual bag against this
table. Kinds refer to `docs/protocol.md`. Anything marked *gap* needs a
driver the firmware does not have yet — listed explicitly instead of
pretending `digital` covers it.

## Rules that apply to nearly every module

- Most kit boards are **5 V modules**. Powering the *sensor element* from 5 V
  is often fine; letting a 5 V *signal* reach a GPIO is not. Plate 1's divider
  rule and plate 4's budgets apply to every row below.
- **HC-SR04 ECHO is 5 V**: divide to ~3.3 V before the pin. No exceptions.
- **Relay coils** want 5 V and ~70 mA through a transistor plus flyback
  diode (plate 4/5). The ESP32 pin drives the transistor base, never the coil.
- **LCD1602** (if included) wants 5 V logic; its I2C backpack pull-ups to 5 V
  are out of spec for ESP32 pins — level-shift or verify your backpack straps
  to 3V3 before trusting it.
- **DS18B20** needs a 4.7 kΩ pull-up to 3V3 and OneWire timing the firmware
  does not yet implement (*gap*: add OneWire read).
- **PIR HC-SR501** outputs 3.3 V logic: wire directly, allow ~1 min settle.

## Mapping (typical bag)

| Module | SenseHub kind | Notes |
|--------|---------------|-------|
| Joystick (2×VR + SW) | analog_slow ×2 + digital | VRx/VRy to ADC1 pins; SW is a button |
| Relay (single 5 V) | *actuator gap* | Transistor + flyback; protocol has no output kind yet |
| DHT11 | dht22 (protocol-compatible timing) | 3V3 power preferred; 1 s+ between reads |
| DS18B20 | *gap* | Needs OneWire; same pull-up and patience as DHT |
| HC-SR04 | hcsr04 | TRIG from GPIO, ECHO through a divider |
| IR receiver VS1838B | digital | 38 kHz demodulated output; decode on app side |
| IR transmitter | *actuator gap* | Needs 38 kHz carrier PWM from a timer |
| LCD1602 (+I2C backpack) | i2c tentative | See 5 V pull-up warning above |
| 7-seg / TM1637 display | *actuator gap* | Output device; future SET_PIN/display protocol |
| LEDs, RGB LED | *actuator gap* | Current-limited by design; still outputs |
| Buttons, tilt SW-520D | digital | INPUT_PULLUP; debounce in app (TV + hysteresis pattern) |
| Active buzzer | *actuator gap* | Needs only power switching |
| Passive buzzer | *actuator gap* | Needs PWM tone generation |
| Hall 44E, reed switch | digital | Open-collector style; pull-up |
| Photoresistor, thermistor, flame, sound, soil, water level | analog_slow | Power from 3V3 or divide; sound envelope only, not audio |
| PIR HC-SR501 | pir | Direct; settle time |
| Rotary encoder KY-040 | digital ×2 | Quadrature decode app-side from edge events (future) — today: raw levels |
| Keypad 4×4 | digital ×8 | Row/col scan; app-side decode |
| Stepper 28BYJ-48 + ULN2003 | *actuator gap* | 5 V supply, sequenced drive |
| Servo SG90 | *actuator gap* | 5 V supply, PWM control signal |
| DC motor + fan | *actuator gap* | Driver IC per plate 5, never direct |
| Laser emitter | *actuator gap* | Current-limited output |
| Touch TTP223 | digital | 3V3-friendly output |
| Obstacle/line IR pair | digital | Comparator output, threshold pot on board |
| MQ-2 gas | analog_slow | Heater draws ~150 mA from 5 V — budget it; burn-in required |
| DS1302 RTC | *gap* | Needs 3-wire protocol driver |
| MAX7219 matrix | *actuator gap* | SPI protocol driver (good first SPI output) |
| Traffic-light module | *actuator gap* | Three LEDs, needs three switched outputs |
| Heartbeat/pulse sensor | analog_slow | Slow analog waveform; smoothing + peak logic app-side |
| RGB 3-color | *actuator gap* | Three PWM channels |

## Sensing-hub chapter outline (proposed)

1. **Inventory against this table** — sort the actual bag into input/actuator/gap piles first.
2. **Power and levels** — one 5 V-tolerant plan for the whole bench (plates 1, 4).
3. **Pairing ceremony** — AP boot, BT claim, minisign key handling, factory reset drill.
4. **Detect walkthrough** — SCAN over I2C/SPI, reading confirmed vs tentative with the app showing the difference.
5. **Scope plus sensors** — fast ADC channel alongside 1 Hz environmental polls in one session.
6. **Tauri views** — waterfall/spectrum/cepstrum for the fast channel; level timelines and logic events for the slow ones.
7. **Honesty appendix** — tentative identities, unimplemented drivers (*gaps* above), ADC limits, radio-range claims not made.
