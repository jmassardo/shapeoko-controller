// SPDX-License-Identifier: MIT
//
// test_deadman.cpp — host-side Unity tests for the ENABLE deadman ("hold to
// jog") safety interlock driver (issue #57).
//
// Runs under the `native` PlatformIO environment on the CI host with NO ESP32
// attached and NO Arduino/ESP32 headers available. The deadman state machine is
// pure logic behind the `panel::hal::Hal` seam, so every safety property is
// provable off-target with an INJECTED clock and a controllable input level —
// which is exactly what the issue requires ("CI has no ESP32 ... tested as pure
// logic with an injected clock").
//
// This is the single most safety-critical input on the panel, so the coverage
// here is a first-class deliverable: asymmetric debounce (press filtered,
// release NOT), the priority release event, fail-safe on invalid input, the
// stale-sampler restart, the press/release-between-samples edge case, and
// Millis wraparound are all exercised explicitly.
//
// LINKING NOTE (test_build_src coupling — read before editing platformio.ini):
// The native env sets `test_build_src = no`, so src/deadman.cpp is NOT
// separately compiled or linked into this test binary. We therefore pull the
// implementation directly into THIS translation unit with the #include below.
// Because src/ is not separately compiled in this env, that creates NO
// duplicate-symbol collision — that single fact is what makes it legal. If a
// future reader flips `test_build_src` to `yes`, this #include of deadman.cpp
// MUST be removed, or the build will fail with duplicate-symbol link errors.

#include "deadman.h"              // resolved via the project include/ dir (on CPPPATH)
#include "../../src/deadman.cpp"  // pulls the implementation INTO this TU (see note above)

#include <unity.h>

#include <cstddef>
#include <cstdint>

#include "hal.h"
#include "pins.h"

using panel::deadman::DeadmanInput;
using panel::deadman::DeadmanStatus;
using panel::deadman::kEventIdDeadmanRelease;
using panel::deadman::kMaxSampleIntervalMs;
using panel::deadman::kPressDebounceMs;
using panel::deadman::State;
using panel::hal::DigitalLevel;
using panel::hal::Millis;
using panel::hal::PinMode;

namespace {

// A test-double HAL with an injectable monotonic clock and a controllable level
// for the ENABLE pin. Crucially it can also return an INVALID DigitalLevel (a
// value outside {kLow, kHigh}) to exercise the fail-safe path — DigitalLevel is
// `enum class : uint8_t`, so static_cast<DigitalLevel>(2) is how a broken/garbage
// HAL manifests. This is the only way to test that acceptance criterion without
// editing hal.h (which #57 must not touch).
class FakeHal final : public panel::hal::Hal {
 public:
  Millis now = 0;

  // Level reported for the ENABLE pin. Default HIGH == released (pull-up), which
  // matches the physical fail-safe resting state.
  DigitalLevel enable_level = DigitalLevel::kHigh;

  Millis monotonic_millis() const override { return now; }

  void configure_pin(std::uint8_t gpio, PinMode mode) override {
    last_configured_gpio = gpio;
    last_mode = mode;
    configure_calls++;
  }

  DigitalLevel digital_read(std::uint8_t gpio) const override {
    // Only the ENABLE pin is meaningful here; anything else reads released.
    return (gpio == panel::pins::kPinEnableDeadman) ? enable_level
                                                    : DigitalLevel::kHigh;
  }

  void digital_write(std::uint8_t /*gpio*/, DigitalLevel /*level*/) override {}
  panel::hal::AnalogValue analog_read(std::uint8_t /*gpio*/) const override { return 0; }
  std::size_t serial_write(const std::uint8_t* /*data*/, std::size_t len) override { return len; }
  std::size_t serial_read(std::uint8_t* /*out*/, std::size_t /*len*/) override { return 0; }
  panel::hal::BootInfo boot_info() const override { return {}; }

  // Observable for assertions.
  std::uint8_t last_configured_gpio = panel::pins::kNoGpio;
  PinMode last_mode = PinMode::kInput;
  int configure_calls = 0;
};

// Set the ENABLE level to pressed (LOW) / released (HIGH).
void set_pressed(FakeHal& hal, bool pressed) {
  hal.enable_level = pressed ? DigitalLevel::kLow : DigitalLevel::kHigh;
}

// Advance the injected clock to `t` and take one sample.
void sample_at(DeadmanInput& dm, FakeHal& hal, Millis t) {
  hal.now = t;
  dm.update();
}

// Drive a debounced press to Held at 5 ms sample steps (<= 5 ms => no overrun).
void hold_press(DeadmanInput& dm, FakeHal& hal, Millis start) {
  set_pressed(hal, true);
  sample_at(dm, hal, start);                     // candidate opens
  sample_at(dm, hal, start + 5);                 // within window
  sample_at(dm, hal, start + kPressDebounceMs);  // >= 10 ms => Held
}

}  // namespace

// --- pin ownership ----------------------------------------------------------

void test_begin_configures_pullup_on_symbolic_pin(void) {
  FakeHal hal;
  DeadmanInput dm(hal);
  dm.begin();
  // Must claim the ENABLE pin by its symbolic name as a pulled-up input, so a
  // cut wire reads HIGH = released (primary electrical fail-safe).
  TEST_ASSERT_EQUAL_UINT8(panel::pins::kPinEnableDeadman, hal.last_configured_gpio);
  TEST_ASSERT_EQUAL(PinMode::kInputPullup, hal.last_mode);
  TEST_ASSERT_EQUAL_INT(1, hal.configure_calls);
}

// --- resting state ----------------------------------------------------------

void test_initial_state_is_released_and_no_jog(void) {
  FakeHal hal;
  DeadmanInput dm(hal);
  dm.begin();
  TEST_ASSERT_EQUAL(State::kReleased, dm.state());
  TEST_ASSERT_FALSE(dm.isJogEnabled());
  TEST_ASSERT_FALSE(dm.consumeReleaseEvent());
}

// --- press debounce (~10 ms stable) -----------------------------------------

void test_press_rejected_before_debounce_window(void) {
  FakeHal hal;
  DeadmanInput dm(hal);
  dm.begin();
  set_pressed(hal, true);
  sample_at(dm, hal, 0);   // candidate opens
  sample_at(dm, hal, 5);   // elapsed 5 ms < 10 ms
  // Still only a candidate — jog must NOT be enabled yet.
  TEST_ASSERT_EQUAL(State::kPressCandidate, dm.state());
  TEST_ASSERT_FALSE(dm.isJogEnabled());
  // 9 ms is still short of the window.
  sample_at(dm, hal, 9);
  TEST_ASSERT_EQUAL(State::kPressCandidate, dm.state());
  TEST_ASSERT_FALSE(dm.isJogEnabled());
}

void test_press_accepted_at_debounce_threshold(void) {
  FakeHal hal;
  DeadmanInput dm(hal);
  dm.begin();
  set_pressed(hal, true);
  sample_at(dm, hal, 0);                 // candidate opens
  sample_at(dm, hal, 5);                 // within window
  sample_at(dm, hal, kPressDebounceMs);  // elapsed exactly 10 ms => accepted
  TEST_ASSERT_EQUAL(State::kHeld, dm.state());
  TEST_ASSERT_TRUE(dm.isJogEnabled());
}

// --- zero-debounce release --------------------------------------------------

void test_release_from_held_is_immediate_zero_debounce(void) {
  FakeHal hal;
  DeadmanInput dm(hal);
  dm.begin();
  hold_press(dm, hal, 0);
  TEST_ASSERT_TRUE(dm.isJogEnabled());

  // A SINGLE released sample must drop out of Held immediately — no timer.
  set_pressed(hal, false);
  sample_at(dm, hal, 12);
  TEST_ASSERT_EQUAL(State::kReleased, dm.state());
  TEST_ASSERT_FALSE(dm.isJogEnabled());
}

// --- priority release event -------------------------------------------------

void test_release_from_held_latches_priority_event(void) {
  FakeHal hal;
  DeadmanInput dm(hal);
  dm.begin();
  hold_press(dm, hal, 0);
  set_pressed(hal, false);
  sample_at(dm, hal, 12);
  // The Held -> Released transition must have latched the sticky priority event.
  const DeadmanStatus st = dm.status();
  TEST_ASSERT_EQUAL(State::kReleased, st.state);
  TEST_ASSERT_TRUE(dm.consumeReleaseEvent());
}

void test_consume_release_event_returns_true_once_then_false(void) {
  FakeHal hal;
  DeadmanInput dm(hal);
  dm.begin();
  hold_press(dm, hal, 0);
  set_pressed(hal, false);
  sample_at(dm, hal, 12);
  // Sticky until consumed, then clears; must not re-fire.
  TEST_ASSERT_TRUE(dm.consumeReleaseEvent());
  TEST_ASSERT_FALSE(dm.consumeReleaseEvent());
  TEST_ASSERT_FALSE(dm.consumeReleaseEvent());
}

void test_release_event_is_sticky_until_consumed(void) {
  FakeHal hal;
  DeadmanInput dm(hal);
  dm.begin();
  hold_press(dm, hal, 0);
  set_pressed(hal, false);
  sample_at(dm, hal, 12);
  // Simulate a slow scheduler: several more released samples occur before the
  // scheduler drains the event. It must NOT be lost.
  sample_at(dm, hal, 17);
  sample_at(dm, hal, 22);
  TEST_ASSERT_TRUE(dm.consumeReleaseEvent());
  TEST_ASSERT_FALSE(dm.consumeReleaseEvent());
}

// --- edge case: press AND release between two samples -----------------------

void test_press_candidate_release_latches_nothing(void) {
  FakeHal hal;
  DeadmanInput dm(hal);
  dm.begin();
  // One sample reads pressed (opens a candidate window), but the operator lets
  // go before the debounce completes: the next sample reads released. No Held
  // state was ever latched, so NO release event and NO jog window.
  set_pressed(hal, true);
  sample_at(dm, hal, 0);   // candidate opens
  TEST_ASSERT_EQUAL(State::kPressCandidate, dm.state());
  set_pressed(hal, false);
  sample_at(dm, hal, 3);   // released before 10 ms
  TEST_ASSERT_EQUAL(State::kReleased, dm.state());
  TEST_ASSERT_FALSE(dm.isJogEnabled());
  // Nothing to cancel: the priority event must NOT be latched.
  TEST_ASSERT_FALSE(dm.consumeReleaseEvent());
}

void test_never_held_when_press_and_release_straddle_samples(void) {
  FakeHal hal;
  DeadmanInput dm(hal);
  dm.begin();
  // The press+release both happen entirely between two samples: the sampler
  // never even observes a pressed level. State must remain Released throughout.
  set_pressed(hal, false);  // by the time we sample, already released again
  sample_at(dm, hal, 0);
  sample_at(dm, hal, 5);
  TEST_ASSERT_EQUAL(State::kReleased, dm.state());
  TEST_ASSERT_FALSE(dm.isJogEnabled());
  TEST_ASSERT_FALSE(dm.consumeReleaseEvent());
}

// --- fail-safe: invalid / floating input ------------------------------------

void test_invalid_level_fails_safe_to_released_with_fault(void) {
  FakeHal hal;
  DeadmanInput dm(hal);
  dm.begin();
  // A garbage HAL level (outside {kLow, kHigh}) must decode as RELEASED and set
  // the sticky invalid-level fault.
  hal.enable_level = static_cast<DigitalLevel>(2);
  sample_at(dm, hal, 0);
  const DeadmanStatus st = dm.status();
  TEST_ASSERT_EQUAL(State::kReleased, st.state);
  TEST_ASSERT_FALSE(st.jog_enabled);
  TEST_ASSERT_TRUE(st.fault_invalid_level);
}

void test_invalid_level_while_held_stops_and_latches_release(void) {
  FakeHal hal;
  DeadmanInput dm(hal);
  dm.begin();
  hold_press(dm, hal, 0);
  TEST_ASSERT_TRUE(dm.isJogEnabled());
  // Input goes garbage while jogging: must fail safe to Released, latch the
  // priority release event (motion was live), and flag the fault.
  hal.enable_level = static_cast<DigitalLevel>(0xFF);
  sample_at(dm, hal, 12);
  const DeadmanStatus st = dm.status();
  TEST_ASSERT_EQUAL(State::kReleased, st.state);
  TEST_ASSERT_FALSE(st.jog_enabled);
  TEST_ASSERT_TRUE(st.fault_invalid_level);
  TEST_ASSERT_TRUE(dm.consumeReleaseEvent());
}

void test_invalid_level_fault_is_sticky_after_recovery(void) {
  FakeHal hal;
  DeadmanInput dm(hal);
  dm.begin();
  hal.enable_level = static_cast<DigitalLevel>(3);
  sample_at(dm, hal, 0);
  // Input recovers to a clean released reading, but the fault stays latched.
  set_pressed(hal, false);
  sample_at(dm, hal, 5);
  TEST_ASSERT_TRUE(dm.status().fault_invalid_level);
}

// --- sample-rate diagnostic -------------------------------------------------

void test_first_update_does_not_trip_overrun(void) {
  FakeHal hal;
  DeadmanInput dm(hal);
  dm.begin();
  // Even at a large absolute timestamp, the FIRST update has no predecessor and
  // must not report an overrun.
  set_pressed(hal, false);
  sample_at(dm, hal, 1000000);
  const DeadmanStatus st = dm.status();
  TEST_ASSERT_FALSE(st.fault_sample_overrun);
  TEST_ASSERT_EQUAL_UINT32(0U, st.last_sample_interval_ms);
}

void test_sample_overrun_latches_and_reports_interval(void) {
  FakeHal hal;
  DeadmanInput dm(hal);
  dm.begin();
  set_pressed(hal, false);
  sample_at(dm, hal, 0);   // first sample: no interval
  sample_at(dm, hal, 3);   // 3 ms: within budget
  TEST_ASSERT_FALSE(dm.status().fault_sample_overrun);
  sample_at(dm, hal, 60);  // 57 ms: far over the 5 ms budget
  const DeadmanStatus st = dm.status();
  TEST_ASSERT_TRUE(st.fault_sample_overrun);
  TEST_ASSERT_EQUAL_UINT32(57U, st.last_sample_interval_ms);
}

void test_interval_at_budget_is_not_an_overrun(void) {
  FakeHal hal;
  DeadmanInput dm(hal);
  dm.begin();
  set_pressed(hal, false);
  sample_at(dm, hal, 0);
  sample_at(dm, hal, kMaxSampleIntervalMs);  // exactly 5 ms — allowed
  const DeadmanStatus st = dm.status();
  TEST_ASSERT_FALSE(st.fault_sample_overrun);
  TEST_ASSERT_EQUAL_UINT32(kMaxSampleIntervalMs, st.last_sample_interval_ms);
}

// --- stale-window press restart (added fail-safe) ---------------------------

void test_stale_window_restarts_press_candidate(void) {
  FakeHal hal;
  DeadmanInput dm(hal);
  dm.begin();
  set_pressed(hal, true);
  sample_at(dm, hal, 0);   // candidate opens
  sample_at(dm, hal, 3);   // within budget, still candidate
  TEST_ASSERT_EQUAL(State::kPressCandidate, dm.state());

  // A big gap: a stalled sampler. The elapsed wall-clock time (100 ms) exceeds
  // the 10 ms debounce, but promoting here would defeat noise rejection in the
  // DANGEROUS direction. The window must RESTART, not promote to Held.
  sample_at(dm, hal, 100);
  TEST_ASSERT_EQUAL(State::kPressCandidate, dm.state());
  TEST_ASSERT_FALSE(dm.isJogEnabled());
  TEST_ASSERT_TRUE(dm.status().fault_sample_overrun);

  // From the restarted window, a fresh full debounce at good sample rate does
  // promote to Held.
  sample_at(dm, hal, 105);
  sample_at(dm, hal, 110);  // 10 ms after the restart at t=100
  TEST_ASSERT_EQUAL(State::kHeld, dm.state());
  TEST_ASSERT_TRUE(dm.isJogEnabled());
}

// --- jog gate --------------------------------------------------------------

void test_jog_enabled_only_in_held(void) {
  FakeHal hal;
  DeadmanInput dm(hal);
  dm.begin();
  // Released
  TEST_ASSERT_FALSE(dm.isJogEnabled());
  // PressCandidate
  set_pressed(hal, true);
  sample_at(dm, hal, 0);
  TEST_ASSERT_EQUAL(State::kPressCandidate, dm.state());
  TEST_ASSERT_FALSE(dm.isJogEnabled());
  // Held
  sample_at(dm, hal, 5);
  sample_at(dm, hal, 10);
  TEST_ASSERT_EQUAL(State::kHeld, dm.state());
  TEST_ASSERT_TRUE(dm.isJogEnabled());
}

// --- re-press after release re-opens the jog window -------------------------

void test_re_press_after_release_reopens_jog_window(void) {
  FakeHal hal;
  DeadmanInput dm(hal);
  dm.begin();
  hold_press(dm, hal, 0);
  TEST_ASSERT_TRUE(dm.isJogEnabled());

  // Release.
  set_pressed(hal, false);
  sample_at(dm, hal, 12);
  TEST_ASSERT_FALSE(dm.isJogEnabled());
  TEST_ASSERT_TRUE(dm.consumeReleaseEvent());

  // A fresh press must go through debounce again and re-enable jog.
  hold_press(dm, hal, 20);
  TEST_ASSERT_EQUAL(State::kHeld, dm.state());
  TEST_ASSERT_TRUE(dm.isJogEnabled());
  // The re-press must NOT spuriously re-latch a release event.
  TEST_ASSERT_FALSE(dm.consumeReleaseEvent());
}

// --- Millis wraparound ------------------------------------------------------

void test_press_window_spans_millis_wraparound(void) {
  FakeHal hal;
  DeadmanInput dm(hal);
  dm.begin();
  set_pressed(hal, true);
  // Open the candidate window just before the uint32 wrap, then step across it
  // at <= 5 ms intervals. Unsigned subtraction must compute the true elapsed
  // time across 0xFFFFFFFF -> 0.
  const Millis start = 0xFFFFFFFBU;  // 4294967291
  sample_at(dm, hal, start);         // candidate opens
  sample_at(dm, hal, 0xFFFFFFFFU);   // interval 4 ms; elapsed 4 ms
  sample_at(dm, hal, 0x00000001U);   // interval 2 ms; elapsed 6 ms (across wrap)
  TEST_ASSERT_EQUAL(State::kPressCandidate, dm.state());
  sample_at(dm, hal, 0x00000005U);   // interval 4 ms; elapsed 10 ms => Held
  TEST_ASSERT_EQUAL(State::kHeld, dm.state());
  TEST_ASSERT_TRUE(dm.isJogEnabled());
  // No spurious overrun across the wrap.
  TEST_ASSERT_FALSE(dm.status().fault_sample_overrun);
}

// --- EVENT id constant fits the wire layout ---------------------------------

void test_event_id_constant_is_a_valid_nonzero_u8(void) {
  // The EVENT payload is `event_id u8, flags u8` (frame_types.h). The deadman
  // release id must fit a single byte and be non-zero so it is distinguishable
  // from a zero-filled/default payload.
  TEST_ASSERT_NOT_EQUAL(0, kEventIdDeadmanRelease);
  TEST_ASSERT_EQUAL_UINT8(0x01, kEventIdDeadmanRelease);
}

void setUp(void) {}
void tearDown(void) {}

int main(int, char**) {
  UNITY_BEGIN();
  RUN_TEST(test_begin_configures_pullup_on_symbolic_pin);
  RUN_TEST(test_initial_state_is_released_and_no_jog);
  RUN_TEST(test_press_rejected_before_debounce_window);
  RUN_TEST(test_press_accepted_at_debounce_threshold);
  RUN_TEST(test_release_from_held_is_immediate_zero_debounce);
  RUN_TEST(test_release_from_held_latches_priority_event);
  RUN_TEST(test_consume_release_event_returns_true_once_then_false);
  RUN_TEST(test_release_event_is_sticky_until_consumed);
  RUN_TEST(test_press_candidate_release_latches_nothing);
  RUN_TEST(test_never_held_when_press_and_release_straddle_samples);
  RUN_TEST(test_invalid_level_fails_safe_to_released_with_fault);
  RUN_TEST(test_invalid_level_while_held_stops_and_latches_release);
  RUN_TEST(test_invalid_level_fault_is_sticky_after_recovery);
  RUN_TEST(test_first_update_does_not_trip_overrun);
  RUN_TEST(test_sample_overrun_latches_and_reports_interval);
  RUN_TEST(test_interval_at_budget_is_not_an_overrun);
  RUN_TEST(test_stale_window_restarts_press_candidate);
  RUN_TEST(test_jog_enabled_only_in_held);
  RUN_TEST(test_re_press_after_release_reopens_jog_window);
  RUN_TEST(test_press_window_spans_millis_wraparound);
  RUN_TEST(test_event_id_constant_is_a_valid_nonzero_u8);
  return UNITY_END();
}
