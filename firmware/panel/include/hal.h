// SPDX-License-Identifier: MIT
//
// hal.h — the thin Hardware Abstraction Layer boundary for the Shapeoko panel
// firmware.
//
// PURPOSE
// -------
// Every later driver (debouncers, the quadrature decoder, analog filters, the
// E-stop observer, the serial framing, the scheduler) is pure logic that we
// want to unit-test on the host CI runner WITHOUT an ESP32 attached. This
// header is the seam that makes that possible: drivers talk to `Hal`, never to
// Arduino/ESP-IDF directly. On real hardware `Hal` is implemented against the
// Arduino core (see src/main.cpp); in tests it is implemented by a fake.
//
// This header therefore includes NO Arduino/ESP32 headers and defines only
// abstract interfaces + small value types, so it compiles unchanged in the
// `native` (host) environment.
//
// SCOPE (issue #53): this is a SCAFFOLD. It declares only the minimal surface
// that src/main.cpp and the smoke test need — monotonic time, digital I/O,
// analog read, serial read/write, and reset/boot metadata. It intentionally
// does NOT implement debouncing, quadrature decoding, analog filtering, E-stop
// logic, or the serial protocol; those belong to later issues (#54, #56-#65,
// #137, #138).
//
// SAFETY: nothing in this HAL can command the E-stop. E-stop is a hardware
// contactor; software only ever reads its auxiliary contact as a digital
// input. The HAL exposes read/write of generic pins, but there is no E-stop
// output pin anywhere (see include/pins.h).

#ifndef PANEL_HAL_H
#define PANEL_HAL_H

#include <cstddef>
#include <cstdint>

namespace panel {
namespace hal {

// Monotonic milliseconds since boot. Monotonic = never runs backwards; wraps
// after ~49.7 days, which callers must handle with unsigned subtraction.
using Millis = std::uint32_t;

// A raw 10/12-bit ADC reading (0..4095 on ESP32). Widened to 16 bits so host
// tests need no platform assumptions.
using AnalogValue = std::uint16_t;

// Logic level of a digital line.
enum class DigitalLevel : std::uint8_t { kLow = 0, kHigh = 1 };

// How a digital pin is driven/read. InputPullup requests the MCU's internal
// pull-up where the pin supports one.
enum class PinMode : std::uint8_t { kInput = 0, kInputPullup = 1, kOutput = 2 };

// Why the MCU last reset. Used by boot metadata so later issues can, e.g.,
// distinguish a clean power-on from a watchdog recovery. Kept minimal here.
enum class ResetReason : std::uint8_t {
  kUnknown = 0,
  kPowerOn,
  kSoftware,
  kWatchdog,
  kBrownout,
  kExternal,
};

// Snapshot of reset/boot metadata read once at startup.
struct BootInfo {
  ResetReason reset_reason = ResetReason::kUnknown;
  // Free-running boot counter (RTC-backed on hardware). Placeholder for now.
  std::uint32_t boot_count = 0;
};

// The hardware seam. All members are pure-virtual so both the Arduino-backed
// implementation and the host test fake must supply them. Implementations must
// be cheap and non-blocking; higher-level timing/logic lives in later drivers.
class Hal {
 public:
  virtual ~Hal() = default;

  // ---- time -------------------------------------------------------------
  // Monotonic milliseconds since boot.
  virtual Millis monotonic_millis() const = 0;

  // ---- digital I/O ------------------------------------------------------
  // Configure a direct MCU GPIO (numbers come only from include/pins.h).
  virtual void configure_pin(std::uint8_t gpio, PinMode mode) = 0;
  virtual DigitalLevel digital_read(std::uint8_t gpio) const = 0;
  virtual void digital_write(std::uint8_t gpio, DigitalLevel level) = 0;

  // ---- analog input -----------------------------------------------------
  virtual AnalogValue analog_read(std::uint8_t gpio) const = 0;

  // ---- serial (host link) ----------------------------------------------
  // Non-blocking best-effort byte transport. Return the count actually moved;
  // the framed protocol on top of this belongs to #54, not here.
  virtual std::size_t serial_write(const std::uint8_t* data, std::size_t len) = 0;
  virtual std::size_t serial_read(std::uint8_t* out, std::size_t len) = 0;

  // ---- reset / boot metadata -------------------------------------------
  virtual BootInfo boot_info() const = 0;
};

}  // namespace hal
}  // namespace panel

#endif  // PANEL_HAL_H
