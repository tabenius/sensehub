# Multi-board compatibility

Goal: one UI, channel contract and shared processing core across ESP32 models.
Compatibility is based on reported capabilities, not a universal GPIO map or
the assumption that every ESP32 has WiFi or Bluetooth Classic.

## Implemented architecture

- `channel_core.h` is portable C++11. Input/output/pull masks and PWM support
  come from a board policy; GPIO numbers up to 63 are representable. It does
  not apply classic ESP32's input-only rule to S2/S3/other chips.
- `board_config.h` intersects explicit board masks with ESP-IDF's valid GPIO
  and output GPIO predicates. Empty/unconfigured boards permit no pin binding.
- `SOC_WIFI_SUPPORTED`, `SOC_BT_CLASSIC_SUPPORTED`, LEDC capability and build
  configuration gate hardware backends. SPP additionally requires the enabled
  Bluedroid/SPP configuration. BLE is not yet implemented and is advertised as
  such even on chips that support it.
- USB serial framing is the common non-radio transport path. `MODE USB` ends
  text command mode and selects SH binary framing; reboot returns to text mode.
  Physical USB configuration may send unsigned `0x21`; radio configuration
  still needs the existing fail-closed verification backend.
- `CAPABILITIES` / `0x20` reports SoC name, board profile, permitted pins,
  no-pull pins, modes, channel IDs, limits and compiled transport support.
- The UI consumes that schema, populates pin choices, disables unsupported
  modes and hides irrelevant input/output/PWM parameters. It can load a
  capability JSON file or receive the description through its embedding API.
  A reported description is distinguished from a live transport connection.

## Board selection

The standard AI-Thinker ESP32-CAM profile is selected by its Arduino board
macro (`ARDUINO_ESP32CAM` / `ARDUINO_ESP32_CAM`) or explicit build definition
`SENSEHUB_AI_THINKER_CAM=1`. It exposes only GPIO13/14, with no camera/SD,
automatic buses or scope ADC initialized.

The older classic bench profile requires `SENSEHUB_CLASSIC_BENCH=1` on classic
ESP32. Its pin map and scope/bus wiring are **not** selected for other SoCs.

For another board, select that board in its supported Arduino core and provide
the board's usable-pin masks from its schematic. For example, a hypothetical
S3 board with GPIO4 and GPIO5 available could define:

```cpp
#define SENSEHUB_BOARD_NAME "my-s3-board"
#define SENSEHUB_INPUT_GPIO_MASK ((1ULL << 4) | (1ULL << 5))
#define SENSEHUB_OUTPUT_GPIO_MASK SENSEHUB_INPUT_GPIO_MASK
#define SENSEHUB_PULL_GPIO_MASK SENSEHUB_INPUT_GPIO_MASK
```

Supply these as build flags or before including `board_config.h`; this example
is not a verified pin map for all S3 boards. Exclude flash/PSRAM, USB/UART used
by the transport, straps and occupied peripherals. Configure a recovery button
explicitly through `SENSEHUB_BOOT_BUTTON_PIN`; unconfigured boards don't touch
a guessed button pin. Nonclassic scope and bus backends remain disabled until
their board/resource configuration is implemented.

## Family coverage versus verification

ESP32, S2, S3 and the C/H/P families share the contract and policy approach.
The selected Arduino/ESP-IDF target owns SoC predicates and peripheral support,
so additions do not require the browser to know each chip name. WiFi-less parts
can use the serial path; S2/S3/C-series parts cannot use Classic SPP simply
because the product name begins with ESP32. External/hosted radios require a
separate backend, not a claim of built-in support.

**This is not a claim that the sketch has been compiled or hardware-tested on
every ESP32 model.** Host tests verify portable policy behavior and UI capability
negotiation. Board-level Arduino compilation, USB behavior, LEDC frequency/duty
and sensor timing need a pinned core and a real target build/loopback matrix.
Camera, high-rate ADC/I2S, RMT/PCNT and BLE backends are separate future modules.

`python3 firmware/tests/board_policy_test.py` compiles the policy header against
simulated SoC predicates for nine family fixtures, including radio-less and
nonclassic GPIO cases. This validates guard/policy logic, not those chips' SDK
builds or actual pinouts.
