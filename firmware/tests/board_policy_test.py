"""Compile board_config against simulated SoC predicates, not real SDK boards."""
from pathlib import Path
import subprocess
import tempfile

firmware = Path(__file__).resolve().parents[1]
cases = [
    ("ESP32-CAM", "CONFIG_IDF_TARGET_ESP32", 13, 40, 1, 1, 1, True),
    ("ESP32-S2", "CONFIG_IDF_TARGET_ESP32S2", 4, 47, 1, 0, 1, False),
    ("ESP32-S3", "CONFIG_IDF_TARGET_ESP32S3", 38, 49, 1, 0, 1, False),
    ("ESP32-C2", "CONFIG_IDF_TARGET_ESP32C2", 4, 21, 1, 0, 1, False),
    ("ESP32-C3", "CONFIG_IDF_TARGET_ESP32C3", 10, 22, 1, 0, 1, False),
    ("ESP32-C5", "CONFIG_IDF_TARGET_ESP32C5", 4, 29, 1, 0, 1, False),
    ("ESP32-C6", "CONFIG_IDF_TARGET_ESP32C6", 6, 31, 1, 0, 1, False),
    ("ESP32-H2", "CONFIG_IDF_TARGET_ESP32H2", 10, 28, 0, 0, 1, False),
    ("ESP32-P4", "CONFIG_IDF_TARGET_ESP32P4", 4, 55, 0, 0, 1, False),
]
with tempfile.TemporaryDirectory(prefix="sensehub-board-policy-", dir="/tmp/opencode") as temporary:
    root = Path(temporary)
    (root / "soc").mkdir(); (root / "driver").mkdir()
    (root / "soc/soc_caps.h").write_text("#pragma once\n")
    (root / "driver/gpio.h").write_text("#pragma once\n#define GPIO_IS_VALID_GPIO(p) ((p)<TEST_GPIO_LIMIT)\n#define GPIO_IS_VALID_OUTPUT_GPIO(p) ((p)<TEST_GPIO_LIMIT && (p)!=TEST_INPUT_ONLY)\n")
    source = root / "test.cpp"
    source.write_text('''#include "board_config.h"
#include <assert.h>
int main() {
  auto policy = sensehub::boardPolicy();
  assert(policy.inputs == EXPECTED_MASK);
  assert(policy.outputs == EXPECTED_MASK);
  assert(policy.pulls == EXPECTED_MASK);
  assert(HAVE_WIFI == EXPECT_WIFI);
  assert(HAVE_BT == EXPECT_BT);
  assert(policy.pwm);
  assert(!sensehub::inputPin(63, policy));
}
''')
    for name, target, pin, limit, wifi, bt, ledc, camera in cases:
        mask = (1 << 13) | (1 << 14) if camera else 1 << pin
        # Extra invalid pad demonstrates intersection, not blind trust in masks.
        supplied = mask | (1 << 63)
        definitions = {
            target: 1, "SOC_WIFI_SUPPORTED": wifi, "SOC_BT_CLASSIC_SUPPORTED": bt,
            "SOC_BLE_SUPPORTED": 0, "SOC_LEDC_SUPPORTED": ledc,
            "CONFIG_BT_ENABLED": 1, "CONFIG_BLUEDROID_ENABLED": 1, "CONFIG_BT_SPP_ENABLED": 1,
            "SENSEHUB_AI_THINKER_CAM": int(camera), "TEST_GPIO_LIMIT": limit, "TEST_INPUT_ONLY": 62,
            "EXPECTED_MASK": f"{mask}ULL", "EXPECT_WIFI": wifi, "EXPECT_BT": bt,
            "SENSEHUB_INPUT_GPIO_MASK": f"{supplied}ULL", "SENSEHUB_OUTPUT_GPIO_MASK": f"{supplied}ULL",
        }
        executable = root / "test"
        command = ["g++", "-std=c++11", "-Wall", "-Wextra", "-Werror", "-I", str(root), "-I", str(firmware), str(source), "-o", str(executable)]
        command += [f"-D{k}={v}" for k, v in definitions.items()]
        subprocess.run(command, check=True)
        subprocess.run([str(executable)], check=True)
        print(f"{name}: simulated policy/backend guards passed")
print("This matrix does not compile Arduino integration or verify actual board pinouts.")
