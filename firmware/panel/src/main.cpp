// SPDX-License-Identifier: MIT
//
// main.cpp — ESP32 panel firmware entry point (SCAFFOLD, issue #53).
//
// This is intentionally almost empty. Its only jobs in this issue are to:
//   * prove the esp32dev/Arduino build links against the HAL and pin map, and
//   * provide the concrete Arduino-backed `Hal` implementation that later
//     drivers will be handed.
//
// It implements NO panel behaviour: no debouncing, no quadrature decoding, no
// analog filtering, no E-stop logic, no serial protocol. Those are #54 and
// #56-#65 / #137 / #138. Do not grow this file into a driver.
//
// This translation unit is compiled ONLY for the `esp32dev` environment. The
// `native` test build sets test_build_src = no, so host unit tests never pull
// in Arduino.h; they exercise pure logic through the `Hal` seam with a fake.

#include <Arduino.h>

#include "hal.h"
#include "pins.h"

namespace {

using panel::hal::AnalogValue;
using panel::hal::BootInfo;
using panel::hal::DigitalLevel;
using panel::hal::Hal;
using panel::hal::Millis;
using panel::hal::PinMode;
using panel::hal::ResetReason;

// Arduino/ESP32-backed HAL. Thin, non-blocking pass-through to the core; all
// real logic lives in later, host-tested drivers that receive a `Hal&`.
class ArduinoHal final : public Hal {
 public:
  Millis monotonic_millis() const override { return static_cast<Millis>(millis()); }

  void configure_pin(std::uint8_t gpio, PinMode mode) override {
    switch (mode) {
      case PinMode::kInput:
        pinMode(gpio, INPUT);
        break;
      case PinMode::kInputPullup:
        pinMode(gpio, INPUT_PULLUP);
        break;
      case PinMode::kOutput:
        pinMode(gpio, OUTPUT);
        break;
    }
  }

  DigitalLevel digital_read(std::uint8_t gpio) const override {
    return digitalRead(gpio) == HIGH ? DigitalLevel::kHigh : DigitalLevel::kLow;
  }

  void digital_write(std::uint8_t gpio, DigitalLevel level) override {
    digitalWrite(gpio, level == DigitalLevel::kHigh ? HIGH : LOW);
  }

  AnalogValue analog_read(std::uint8_t gpio) const override {
    return static_cast<AnalogValue>(analogRead(gpio));
  }

  std::size_t serial_write(const std::uint8_t* data, std::size_t len) override {
    return Serial.write(data, len);
  }

  std::size_t serial_read(std::uint8_t* out, std::size_t len) override {
    std::size_t n = 0;
    while (n < len && Serial.available() > 0) {
      out[n++] = static_cast<std::uint8_t>(Serial.read());
    }
    return n;
  }

  BootInfo boot_info() const override {
    BootInfo info;
    switch (esp_reset_reason()) {
      case ESP_RST_POWERON:
        info.reset_reason = ResetReason::kPowerOn;
        break;
      case ESP_RST_SW:
        info.reset_reason = ResetReason::kSoftware;
        break;
      case ESP_RST_INT_WDT:
      case ESP_RST_TASK_WDT:
      case ESP_RST_WDT:
        info.reset_reason = ResetReason::kWatchdog;
        break;
      case ESP_RST_BROWNOUT:
        info.reset_reason = ResetReason::kBrownout;
        break;
      case ESP_RST_EXT:
        info.reset_reason = ResetReason::kExternal;
        break;
      default:
        info.reset_reason = ResetReason::kUnknown;
        break;
    }
    return info;
  }
};

ArduinoHal g_hal;

}  // namespace

void setup() {
  Serial.begin(115200);

  // Bring up the four direct, interrupt-capable safety/quadrature inputs so the
  // scaffold demonstrates the HAL + centralised pin map wiring. All pin numbers
  // come from include/pins.h; none are hardcoded here. No behaviour is attached
  // yet — the deadman, E-stop observer, and MPG decoder are later issues.
  g_hal.configure_pin(panel::pins::kPinEnableDeadman, PinMode::kInputPullup);
  g_hal.configure_pin(panel::pins::kPinEstopAux, PinMode::kInputPullup);
  g_hal.configure_pin(panel::pins::kPinMpgQuadA, PinMode::kInput);
  g_hal.configure_pin(panel::pins::kPinMpgQuadB, PinMode::kInput);

  const BootInfo boot = g_hal.boot_info();
  Serial.printf("shapeoko panel scaffold up; reset_reason=%u\n",
                static_cast<unsigned>(boot.reset_reason));
}

void loop() {
  // Scaffold heartbeat: no panel logic yet. Yield so the RTOS idle/watchdog is
  // serviced. Real cooperative scheduling arrives with the driver issues.
  static Millis last = 0;
  const Millis now = g_hal.monotonic_millis();
  if (now - last >= 1000U) {
    last = now;
  }
  delay(10);
}
