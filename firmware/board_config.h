#pragma once
#include <soc/soc_caps.h>
#include <driver/gpio.h>
#include "channel_core.h"
#ifndef SOC_LEDC_SUPPORTED
#define SOC_LEDC_SUPPORTED 0
#endif

// Select a *board* explicitly. The Arduino ESP32-CAM board selects its profile;
// other boards begin with an empty user-supplied pin mask rather than guesses.
#ifndef SENSEHUB_AI_THINKER_CAM
#if defined(ARDUINO_ESP32CAM) || defined(ARDUINO_ESP32_CAM)
#define SENSEHUB_AI_THINKER_CAM 1
#else
#define SENSEHUB_AI_THINKER_CAM 0
#endif
#endif
#ifndef SENSEHUB_CLASSIC_BENCH
#define SENSEHUB_CLASSIC_BENCH 0
#endif
#ifndef SENSEHUB_BOARD_NAME
#define SENSEHUB_BOARD_NAME "custom-board-unconfigured"
#endif
#ifndef SENSEHUB_INPUT_GPIO_MASK
#define SENSEHUB_INPUT_GPIO_MASK 0ULL
#endif
#ifndef SENSEHUB_OUTPUT_GPIO_MASK
#define SENSEHUB_OUTPUT_GPIO_MASK 0ULL
#endif
#ifndef SENSEHUB_PULL_GPIO_MASK
#define SENSEHUB_PULL_GPIO_MASK SENSEHUB_OUTPUT_GPIO_MASK
#endif
#ifndef SENSEHUB_BOOT_BUTTON_PIN
#if defined(CONFIG_IDF_TARGET_ESP32) && (SENSEHUB_AI_THINKER_CAM || SENSEHUB_CLASSIC_BENCH)
#define SENSEHUB_BOOT_BUTTON_PIN 0
#else
#define SENSEHUB_BOOT_BUTTON_PIN -1
#endif
#endif

#if SOC_WIFI_SUPPORTED
#define HAVE_WIFI 1
#else
#define HAVE_WIFI 0
#endif
#if SOC_BLE_SUPPORTED
#define HAVE_BLE_HARDWARE 1
#else
#define HAVE_BLE_HARDWARE 0
#endif
#if SOC_BT_CLASSIC_SUPPORTED && defined(CONFIG_BT_ENABLED) && defined(CONFIG_BLUEDROID_ENABLED) && defined(CONFIG_BT_SPP_ENABLED)
#define HAVE_BT 1
#else
#define HAVE_BT 0
#endif

namespace sensehub {
inline const char *boardName() {
  if (SENSEHUB_AI_THINKER_CAM) return "ai-thinker-esp32-cam-no-camera-no-sd";
  if (SENSEHUB_CLASSIC_BENCH) return "classic-esp32-conservative";
  return SENSEHUB_BOARD_NAME;
}
inline PinPolicy boardPolicy() {
  PinPolicy policy;
  if (SENSEHUB_AI_THINKER_CAM || SENSEHUB_CLASSIC_BENCH) {
#if defined(CONFIG_IDF_TARGET_ESP32)
    policy = profilePolicy(SENSEHUB_AI_THINKER_CAM ? AiThinkerCam : ClassicBench);
#endif
    // A classic board profile on a different SoC stays empty.
  } else {
    policy.inputs = SENSEHUB_INPUT_GPIO_MASK;
    policy.outputs = SENSEHUB_OUTPUT_GPIO_MASK & policy.inputs;
    policy.pulls = SENSEHUB_PULL_GPIO_MASK & policy.inputs;
    policy.pwm = SOC_LEDC_SUPPORTED != 0;
  }
  // SoC validation is necessary but insufficient: board masks still exclude
  // flash, PSRAM, USB, strapping and externally occupied pins from the schematic.
  for (uint8_t pin = 0; pin < 64; pin++) {
    if (!GPIO_IS_VALID_GPIO(pin)) { policy.inputs &= ~pinBit(pin); policy.pulls &= ~pinBit(pin); }
    if (!GPIO_IS_VALID_OUTPUT_GPIO(pin)) policy.outputs &= ~pinBit(pin);
  }
  policy.outputs &= policy.inputs;
  // Conservatively omit pulls on input-only pads; don't reuse classic pin
  // numbers as a proxy for capability on another SoC.
  policy.pulls &= policy.outputs;
  policy.pwm = policy.pwm && SOC_LEDC_SUPPORTED;
  return policy;
}
} // namespace sensehub
