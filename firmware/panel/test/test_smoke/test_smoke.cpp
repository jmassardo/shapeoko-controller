// SPDX-License-Identifier: MIT
//
// test_smoke.cpp — host-side Unity smoke test for the panel firmware scaffold
// (issue #53).
//
// Runs under the `native` PlatformIO environment on the CI host with NO ESP32
// attached and NO Arduino/ESP32 headers available. It proves two things:
//
//   1. The HAL boundary (include/hal.h) compiles and is usable as pure host
//      code: a fake `Hal` can be implemented and driven entirely off-target,
//      which is the property that keeps every later driver host-testable.
//   2. The centralised pin map (include/pins.h) upholds the safety-critical
//      placement rule: the ENABLE deadman, E-stop aux, and both MPG quadrature
//      channels are on direct, interrupt-capable GPIO (never behind the I2C
//      expanders) and are distinct pins.
//
// It deliberately tests NO panel behaviour (debounce/quadrature/analog/E-stop/
// serial protocol) — none exists yet by design.

#include <unity.h>

#include <cstddef>
#include <cstdint>
#include <vector>

#include "hal.h"
#include "pins.h"

namespace {

// A minimal in-memory Hal used to show host code compiles and runs through the
// HAL seam with no hardware. It is a test double, not production logic.
class FakeHal final : public panel::hal::Hal {
 public:
  panel::hal::Millis now = 0;

  panel::hal::Millis monotonic_millis() const override { return now; }

  void configure_pin(std::uint8_t gpio, panel::hal::PinMode mode) override {
    last_configured_gpio = gpio;
    last_mode = mode;
  }

  panel::hal::DigitalLevel digital_read(std::uint8_t gpio) const override {
    return (gpio == high_pin) ? panel::hal::DigitalLevel::kHigh
                              : panel::hal::DigitalLevel::kLow;
  }

  void digital_write(std::uint8_t gpio, panel::hal::DigitalLevel level) override {
    last_written_gpio = gpio;
    last_written_level = level;
  }

  panel::hal::AnalogValue analog_read(std::uint8_t /*gpio*/) const override {
    return analog_value;
  }

  std::size_t serial_write(const std::uint8_t* data, std::size_t len) override {
    for (std::size_t i = 0; i < len; ++i) {
      tx.push_back(data[i]);
    }
    return len;
  }

  std::size_t serial_read(std::uint8_t* out, std::size_t len) override {
    std::size_t n = 0;
    while (n < len && rx_pos < rx.size()) {
      out[n++] = rx[rx_pos++];
    }
    return n;
  }

  panel::hal::BootInfo boot_info() const override { return boot; }

  // Observable state / fixtures for assertions.
  std::uint8_t last_configured_gpio = panel::pins::kNoGpio;
  panel::hal::PinMode last_mode = panel::hal::PinMode::kInput;
  std::uint8_t last_written_gpio = panel::pins::kNoGpio;
  panel::hal::DigitalLevel last_written_level = panel::hal::DigitalLevel::kLow;
  std::uint8_t high_pin = panel::pins::kNoGpio;
  panel::hal::AnalogValue analog_value = 0;
  panel::hal::BootInfo boot{};
  std::vector<std::uint8_t> tx;
  std::vector<std::uint8_t> rx;
  std::size_t rx_pos = 0;
};

}  // namespace

// --- HAL seam works as pure host code --------------------------------------

void test_hal_monotonic_time_is_readable(void) {
  FakeHal hal;
  hal.now = 4242;
  TEST_ASSERT_EQUAL_UINT32(4242U, hal.monotonic_millis());
}

void test_hal_digital_io_round_trips_through_boundary(void) {
  FakeHal hal;
  hal.configure_pin(panel::pins::kPinEnableDeadman, panel::hal::PinMode::kInputPullup);
  TEST_ASSERT_EQUAL_UINT8(panel::pins::kPinEnableDeadman, hal.last_configured_gpio);

  hal.high_pin = panel::pins::kPinEstopAux;
  TEST_ASSERT_EQUAL(panel::hal::DigitalLevel::kHigh,
                    hal.digital_read(panel::pins::kPinEstopAux));
  TEST_ASSERT_EQUAL(panel::hal::DigitalLevel::kLow,
                    hal.digital_read(panel::pins::kPinMpgQuadA));

  hal.digital_write(panel::pins::kPinCc1101Cs, panel::hal::DigitalLevel::kHigh);
  TEST_ASSERT_EQUAL_UINT8(panel::pins::kPinCc1101Cs, hal.last_written_gpio);
  TEST_ASSERT_EQUAL(panel::hal::DigitalLevel::kHigh, hal.last_written_level);
}

void test_hal_analog_and_serial_boundaries(void) {
  FakeHal hal;
  hal.analog_value = 2048;
  TEST_ASSERT_EQUAL_UINT16(2048, hal.analog_read(panel::pins::kPinFeedPot));

  const std::uint8_t msg[] = {0x01, 0x02, 0x03};
  TEST_ASSERT_EQUAL_UINT32(3U, hal.serial_write(msg, sizeof(msg)));
  TEST_ASSERT_EQUAL_UINT32(3U, hal.tx.size());

  hal.rx = {0xAA, 0xBB};
  std::uint8_t buf[4] = {0};
  TEST_ASSERT_EQUAL_UINT32(2U, hal.serial_read(buf, sizeof(buf)));
  TEST_ASSERT_EQUAL_UINT8(0xAA, buf[0]);
  TEST_ASSERT_EQUAL_UINT8(0xBB, buf[1]);
}

void test_hal_boot_info_defaults_to_unknown(void) {
  FakeHal hal;
  TEST_ASSERT_EQUAL(panel::hal::ResetReason::kUnknown, hal.boot_info().reset_reason);
}

// --- Safety-critical pin placement rule (issue #53 hard constraint) ---------

void test_safety_and_quadrature_signals_are_direct_gpio(void) {
  // Must be assigned to a real direct GPIO, i.e. NOT the "lives behind an
  // expander / unassigned" sentinel. These four may never move behind I2C.
  TEST_ASSERT_NOT_EQUAL(panel::pins::kNoGpio, panel::pins::kPinEnableDeadman);
  TEST_ASSERT_NOT_EQUAL(panel::pins::kNoGpio, panel::pins::kPinEstopAux);
  TEST_ASSERT_NOT_EQUAL(panel::pins::kNoGpio, panel::pins::kPinMpgQuadA);
  TEST_ASSERT_NOT_EQUAL(panel::pins::kNoGpio, panel::pins::kPinMpgQuadB);
}

void test_direct_safety_pins_are_distinct(void) {
  const std::uint8_t p[] = {
      panel::pins::kPinEnableDeadman,
      panel::pins::kPinEstopAux,
      panel::pins::kPinMpgQuadA,
      panel::pins::kPinMpgQuadB,
  };
  for (std::size_t i = 0; i < sizeof(p); ++i) {
    for (std::size_t j = i + 1; j < sizeof(p); ++j) {
      TEST_ASSERT_NOT_EQUAL(p[i], p[j]);
    }
  }
}

void test_two_mcp23017_expanders_have_distinct_addresses(void) {
  TEST_ASSERT_NOT_EQUAL(panel::pins::kMcp23017Addr[0], panel::pins::kMcp23017Addr[1]);
}

void setUp(void) {}
void tearDown(void) {}

int main(int, char**) {
  UNITY_BEGIN();
  RUN_TEST(test_hal_monotonic_time_is_readable);
  RUN_TEST(test_hal_digital_io_round_trips_through_boundary);
  RUN_TEST(test_hal_analog_and_serial_boundaries);
  RUN_TEST(test_hal_boot_info_defaults_to_unknown);
  RUN_TEST(test_safety_and_quadrature_signals_are_direct_gpio);
  RUN_TEST(test_direct_safety_pins_are_distinct);
  RUN_TEST(test_two_mcp23017_expanders_have_distinct_addresses);
  return UNITY_END();
}
