// SPDX-License-Identifier: MIT
//
// deadman.cpp — implementation of the ENABLE deadman ("hold to jog") safety
// interlock driver (issue #57). See include/deadman.h for the full safety
// rationale; this file only implements the state machine described there.
//
// PURE LOGIC: no Arduino/ESP32 headers. Everything goes through `panel::hal::Hal`
// so this compiles and runs on the host `native` CI environment with a fake HAL.
//
// All time arithmetic uses UNSIGNED subtraction on `hal::Millis` (uint32), which
// wraps after ~49.7 days; `(now - start)` is therefore correct across the wrap.

#include "deadman.h"

namespace panel {
namespace deadman {

DeadmanInput::DeadmanInput(hal::Hal& hal) : hal_(hal) {}

void DeadmanInput::begin() {
  // The driver owns its own pin setup. Always use the symbolic pin name — never
  // a raw GPIO number (hard rule, pins.h). Pull-up so a cut wire reads HIGH =
  // released (the primary electrical fail-safe; see deadman.h).
  hal_.configure_pin(pins::kPinEnableDeadman, hal::PinMode::kInputPullup);
}

void DeadmanInput::update() {
  const hal::Millis now = hal_.monotonic_millis();

  // ---- sample-rate diagnostic ------------------------------------------
  // The very first update() has no predecessor, so it can never trip the
  // overrun diagnostic. Thereafter, track the interval and latch a sticky
  // fault if the caller sampled slower than 200 Hz (interval > 5 ms).
  bool overrun_now = false;
  if (have_last_sample_) {
    const hal::Millis interval = now - last_sample_time_;  // unsigned; wrap-safe
    last_sample_interval_ms_ = interval;
    if (interval > kMaxSampleIntervalMs) {
      overrun_now = true;
      fault_sample_overrun_ = true;  // sticky
    }
  } else {
    last_sample_interval_ms_ = 0;
    have_last_sample_ = true;
  }
  last_sample_time_ = now;

  // ---- read the input through the HAL, failing safe ---------------------
  // A well-behaved HAL returns kLow or kHigh. Anything else is a broken/garbage
  // reading; per the LOCKED constraint we treat it as RELEASED and latch a
  // sticky invalid-level fault so it is visible in status.
  const hal::DigitalLevel raw = hal_.digital_read(pins::kPinEnableDeadman);
  bool pressed;
  if (raw == hal::DigitalLevel::kLow) {
    pressed = true;   // active-LOW: closed to GND = pressed
  } else if (raw == hal::DigitalLevel::kHigh) {
    pressed = false;  // pulled up = released
  } else {
    fault_invalid_level_ = true;  // sticky
    pressed = false;              // fail safe to RELEASED
  }

  // ---- state machine ----------------------------------------------------
  // RELEASE PATH FIRST and UNCONDITIONAL: any sample that reads released acts
  // immediately with ZERO debounce — no timers, no filtering. This is the
  // safety-critical fast path.
  if (!pressed) {
    if (state_ == State::kHeld) {
      // A real jog window was open; latch the sticky priority release event so
      // the scheduler (#65) can emit a preempting EVENT frame. A
      // PressCandidate -> Released transition latches NOTHING (no window ever
      // opened): this is the press-and-release-between-samples edge case.
      release_event_latched_ = true;
    }
    state_ = State::kReleased;
    return;
  }

  // PRESS PATH: pressed == true.
  switch (state_) {
    case State::kReleased:
      // First stable-looking assertion: open a debounce window from `now`.
      state_ = State::kPressCandidate;
      press_candidate_start_ = now;
      break;

    case State::kPressCandidate:
      if (overrun_now) {
        // Stale sampler: the elapsed time may be an artefact of a scheduler
        // stall, not of a genuinely stable press. RESTART the window rather
        // than promoting on stale data — preserving noise rejection in the
        // SAFE direction (do not spuriously enable jog). Added fail-safe.
        press_candidate_start_ = now;
      } else if ((now - press_candidate_start_) >= kPressDebounceMs) {
        // Stable LOW for the full debounce window: accept the press.
        state_ = State::kHeld;
      }
      // else: still within the window — remain a candidate.
      break;

    case State::kHeld:
      // Already enabled; nothing to do while it stays pressed.
      break;
  }
}

bool DeadmanInput::isJogEnabled() const { return state_ == State::kHeld; }

bool DeadmanInput::consumeReleaseEvent() {
  const bool latched = release_event_latched_;
  release_event_latched_ = false;
  return latched;
}

State DeadmanInput::state() const { return state_; }

DeadmanStatus DeadmanInput::status() const {
  DeadmanStatus s;
  s.state = state_;
  s.jog_enabled = (state_ == State::kHeld);
  s.fault_invalid_level = fault_invalid_level_;
  s.fault_sample_overrun = fault_sample_overrun_;
  s.last_sample_interval_ms = last_sample_interval_ms_;
  return s;
}

}  // namespace deadman
}  // namespace panel
