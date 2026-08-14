// SPDX-License-Identifier: MIT
//
// deadman.h — the ENABLE deadman ("hold to jog") safety interlock driver for
// the Shapeoko Pro XXL operator panel (issue #57).
//
// -----------------------------------------------------------------------------
// WHAT THIS IS AND WHY IT MATTERS
// -----------------------------------------------------------------------------
// The ENABLE deadman is the operator's live-man switch: motion (MPG jogging) is
// permitted ONLY while the operator is actively holding ENABLE. The instant the
// operator lets go, motion must stop. This is the single most safety-critical
// input on the panel — a defect here means a CNC router keeps jogging after the
// operator has let go of the deadman. Every design choice below is made in the
// SAFE direction, and the reasoning is written down so a future editor cannot
// weaken it by accident.
//
// This driver is PURE LOGIC behind the `panel::hal::Hal` seam (include/hal.h).
// It contains no Arduino/ESP32 headers and therefore compiles and is fully unit
// tested on the host `native` CI environment with an injected fake clock/input.
//
// -----------------------------------------------------------------------------
// ELECTRICAL POLARITY — active LOW, and WHY that is the primary fail-safe
// -----------------------------------------------------------------------------
// ENABLE is a direct, interrupt-capable ESP32 GPIO: `panel::pins::kPinEnableDeadman`.
// It is one of exactly four reserved-direct signals (see pins.h) and may NEVER
// be routed behind the MCP23017 I2C expanders — safety inputs must be readable
// without I2C latency or a bus-fault dependency.
//
// The pin is configured `PinMode::kInputPullup` (matching src/main.cpp). The
// button is wired to close the line to ground when pressed. Therefore:
//
//     pressed  = the line is pulled LOW  (button closed to GND)  = kLow
//     released = the line floats HIGH via the internal pull-up   = kHigh
//
// This active-LOW convention is itself the PRIMARY ELECTRICAL FAIL-SAFE: if the
// ENABLE wire is cut, the connector falls out, or the button fails open, the
// pull-up drives the line HIGH, which decodes as RELEASED — motion stops. A
// broken deadman can only ever fail toward "stopped", never toward "jogging".
// Do NOT invert this polarity.
//
// -----------------------------------------------------------------------------
// ASYMMETRIC DEBOUNCE — press is filtered, release is NOT
// -----------------------------------------------------------------------------
// PRESS is debounced (~10 ms of stable assertion) to reject electrical noise so
// the machine cannot be spuriously enabled. RELEASE is ZERO-debounce: the very
// first sample that reads "released" stops motion immediately, with no timer, no
// filter, and no hysteresis. Debouncing a release would add latency to STOPPING
// motion, which is exactly the wrong direction for safety. This asymmetry is a
// LOCKED constraint and may not be "cleaned up" into a symmetric debounce.
//
// -----------------------------------------------------------------------------
// STALE-SAMPLER FAIL-SAFE (added safety behaviour, not a descope)
// -----------------------------------------------------------------------------
// The press debounce is measured in wall-clock milliseconds. If the sampler
// stalls, two samples 200 ms apart could otherwise satisfy the 10 ms window on
// stale data and promote a press straight to Held — spuriously ENABLING jog,
// which is the dangerous direction. To prevent this, callers MUST invoke
// `update()` at >= 200 Hz (interval <= 5 ms). If an over-long interval is
// observed while a press candidate is pending, the candidate window is RESTARTED
// rather than promoted, and a sticky `fault_sample_overrun` diagnostic is
// exposed in status. Noise rejection is thereby preserved even under a stalled
// scheduler.
//
// -----------------------------------------------------------------------------
// PRIORITY RELEASE EVENT
// -----------------------------------------------------------------------------
// A Held -> Released transition LATCHES a sticky priority release event. The
// frame scheduler (#65) drains it via `consumeReleaseEvent()` and emits a
// `MessageType::kEvent` (0x03) frame that preempts the periodic STATUS slot,
// supporting the ENABLE-release -> machine-serial 0x85 stop within 50 ms
// end-to-end. The latch is STICKY until consumed so a slow scheduler can never
// miss it; `consumeReleaseEvent()` returns true exactly once per release, then
// clears.
//
// A PressCandidate -> Released transition does NOT latch a release event: no jog
// window ever opened, so there is nothing to cancel. This is precisely the
// issue's "press and release both occur between two samples" edge case — no Held
// state is latched and no MPG enable window opens.
//
// -----------------------------------------------------------------------------
// LINUX / PI SIDE: DO NOT RE-DEBOUNCE
// -----------------------------------------------------------------------------
// By the time a panel frame reaches the Raspberry Pi / Linux host, ALL debounce
// and release handling has ALREADY happened here on the MCU. Linux-side
// debouncing of the deadman is NOT permitted: adding host-side filtering would
// re-introduce release latency (the exact hazard this driver eliminates) and
// would double-count press debounce. The host consumes deadman/EVENT state as
// authoritative and acts on it immediately.

#ifndef PANEL_DEADMAN_H
#define PANEL_DEADMAN_H

#include <cstdint>

#include "hal.h"
#include "pins.h"

namespace panel {
namespace deadman {

// ---------------------------------------------------------------------------
// EVENT payload constant (owned here per frame_types.h: "EVENT internals are
// owned by #56-#65", and #57 is one of those). The EVENT payload layout is
// normatively `event_id u8, flags u8 (+ reserved)` (frame_types.h). This u8
// identifies the deadman-release priority event within that layout. It is
// deliberately defined HERE and NOT in frame_types.h so the shared cross-
// language wire header (mirrored by #55) stays byte-stable.
inline constexpr std::uint8_t kEventIdDeadmanRelease = 0x01;

// The maximum permitted interval between `update()` calls. >= 200 Hz sampling
// means an interval of at most 5 ms. An observed interval greater than this
// latches the sample-overrun diagnostic and restarts any pending press window.
inline constexpr hal::Millis kMaxSampleIntervalMs = 5;

// Stable-assertion window required before a press is accepted (noise rejection).
// A press must read LOW continuously for at least this long to promote to Held.
inline constexpr hal::Millis kPressDebounceMs = 10;

// The interlock state machine. `Released` is the safe resting state; jogging is
// permitted ONLY in `Held`.
enum class State : std::uint8_t {
  kReleased = 0,       // not pressed (or failed safe) — NO jogging
  kPressCandidate = 1, // pressed, but debounce window not yet satisfied — NO jogging
  kHeld = 2,           // pressed and debounced — jogging ENABLED
};

// A snapshot of the interlock for status reporting / diagnostics. Fault flags
// are sticky (latched) so a transient fault remains visible after the input
// recovers.
struct DeadmanStatus {
  State state = State::kReleased;
  bool jog_enabled = false;             // true ONLY in Held
  bool fault_invalid_level = false;     // an out-of-range HAL level was seen (sticky)
  bool fault_sample_overrun = false;    // update() interval exceeded 5 ms (sticky)
  hal::Millis last_sample_interval_ms = 0;  // observed interval on the last update()
};

// The ENABLE deadman driver. Construct with a `Hal&`, call `begin()` once to
// claim the pin, then call `update()` at >= 200 Hz. All raw GPIO access is kept
// behind the HAL; invalid readings default to RELEASED.
class DeadmanInput {
 public:
  explicit DeadmanInput(hal::Hal& hal);

  // Configure the ENABLE pin as a pulled-up input. The driver owns its own pin
  // setup and always uses the symbolic pin name (never a raw GPIO number).
  void begin();

  // Sample the ENABLE input once. MUST be called at >= 200 Hz (interval
  // <= 5 ms). Applies asymmetric debounce: press requires ~10 ms stable LOW;
  // release acts on the FIRST released sample with zero debounce.
  void update();

  // True ONLY while the interlock is Held. This is the MPG emission gate for
  // #60/#65: firmware must stop emitting MPG detent events when this is false.
  bool isJogEnabled() const;

  // Drain the sticky priority release event. This is a DESTRUCTIVE / DRAINING
  // read, NOT a query: it returns true exactly once after a Held -> Released
  // transition and CLEARS the latch as a side effect, so it is deliberately
  // NON-const. Do not mistake it for a read-only accessor — calling it consumes
  // the stop signal. Used by the frame scheduler (#65).
  bool consumeReleaseEvent();

  // Current interlock state.
  State state() const;

  // Full status snapshot (state + jog gate + sticky fault flags + last interval).
  DeadmanStatus status() const;

 private:
  hal::Hal& hal_;
  State state_ = State::kReleased;

  // Wall-clock timestamp when the current press candidate window opened.
  hal::Millis press_candidate_start_ = 0;

  // Sample-rate tracking. `have_last_sample_` guards the very first update(),
  // which has no predecessor and therefore cannot trip the overrun diagnostic.
  hal::Millis last_sample_time_ = 0;
  bool have_last_sample_ = false;
  hal::Millis last_sample_interval_ms_ = 0;

  // Sticky priority release event; drained (and cleared) by the non-const
  // `consumeReleaseEvent()` the scheduler uses.
  bool release_event_latched_ = false;

  // Sticky fault flags: once latched they remain set for the LIFETIME of this
  // object — there is intentionally no reset/clear API (none is needed by #57).
  // Note that `last_sample_interval_ms_` is deliberately NOT sticky: it is
  // overwritten on every update() so live sampler health stays observable.
  bool fault_invalid_level_ = false;
  bool fault_sample_overrun_ = false;
};

}  // namespace deadman
}  // namespace panel

#endif  // PANEL_DEADMAN_H
