# Hardware checkpoint

Tobias confirmed the standard **AI-Thinker ESP32-CAM**, currently without a
camera attached. The earlier possible S3 recollection was superseded by this
confirmation. This is the classic ESP32 camera board, not an ESP32-S3 profile.

Before enabling hardware channels, confirm the printed board/module name or
chip identification and consult that board's pinout. Classic ESP32 and ESP32-S3
have different GPIO/ADC/peripheral constraints. ESP32-S3 supports BLE but not
Bluetooth Classic SPP, so the existing `BluetoothSerial` transport is not an S3
transport implementation. WiFi is the existing transport direction for an S3;
BLE would need a separate adapter.

The conservative AI-Thinker profile admits GPIO13/14 for digital lab use with
camera and SD drivers uninitialized. Scope and automatic I2C/SPI initialization
are disabled. GPIO0/2/4/12/15/16 are excluded from the first lab profile because
of boot/strapping, flash LED, SD and PSRAM constraints. The exposed analog pins
are ADC2 on this board, so the built-in ADC/WiFi scope path is unavailable.

Board support is now capability-driven; see `multi-board.md`. The UI defaults
to an explicitly labeled AI-Thinker preview and can load capability JSON from
any board. Firmware selects this profile for the ESP32-CAM Arduino board macro
or explicit `SENSEHUB_AI_THINKER_CAM=1`. Physical hardware testing is pending.
