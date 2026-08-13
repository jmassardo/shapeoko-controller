// SPDX-License-Identifier: MIT
//
// pins.h — the SINGLE, CENTRAL home for every hardware pin/channel identifier
// used by the Shapeoko Pro XXL operator-panel firmware.
//
// -----------------------------------------------------------------------------
// HARD RULE (enforced in code review, issue #53):
//   NO GPIO number, expander bit, ADC channel, or bus pin may appear ANYWHERE
//   outside this header. Every other translation unit must refer to these
//   symbolic names. If you find yourself typing a raw pin number in a driver,
//   add a symbol here instead.
// -----------------------------------------------------------------------------
//
// Physical control names are taken from the canonical machine-readable panel
// spec (hardware/panel-spec.yaml) and the mockup (docs/hardware/panel-mockup.svg).
// Each symbol below is commented with the physical control it names.
//
// -----------------------------------------------------------------------------
// I/O EXPANSION STRATEGY (why most signals sit behind I2C expanders)
// -----------------------------------------------------------------------------
// The direct pin budget does NOT close: the panel needs 34 signals but the
// ESP32 (esp32dev / ESP32-WROOM) offers only 24 usable GPIO — a deficit of 10.
// The panel therefore carries TWO MCP23017 I2C I/O expanders (16 bits each),
// and most *digital* signals live behind them.
//
// FOUR signals MUST stay on direct, interrupt-capable ESP32 GPIO and MUST NOT
// be moved behind the expanders:
//   1. ENABLE deadman        (kPinEnableDeadman)
//   2. E-stop aux contact     (kPinEstopAux)
//   3. MPG quadrature A       (kPinMpgQuadA)
//   4. MPG quadrature B       (kPinMpgQuadB)
// Rationale (do not remove): the 100-PPR handwheel will DROP COUNTS if its
// quadrature edges have to be polled across the I2C bus, and the two safety
// inputs must be readable without I2C latency or a bus-fault dependency. Any
// revision that expander-izes these four is rejected by design.
//
// The panel's three ANALOG signals (FEED pot, SPINDLE pot, CT run-sense) and
// the CC1101 SPI bus likewise cannot live behind an MCP23017 — the MCP23017 is
// digital-only and has no ADC or SPI — so they too are on direct ESP32 pins.
//
// -----------------------------------------------------------------------------
// PROVISIONAL NUMBERS
// -----------------------------------------------------------------------------
// The final numeric assignments depend on the I/O-expansion decision in #131
// and the authoritative I/O map in #118, neither of which is landed yet.
// Every NUMBER below is therefore PROVISIONAL and marked "provisional (#118/
// #131)". They are placeholders chosen to be electrically plausible (non-
// strapping where practical, ADC1 for analog, VSPI for the RF radio) so the
// scaffold compiles and links; they are NOT authoritative. The ONLY thing that
// is non-negotiable here is the placement CLASS: the four signals above are
// direct interrupt-capable GPIO, and the analog/SPI signals are direct.
//
// -----------------------------------------------------------------------------
// SAFETY NOTE (do not weaken)
// -----------------------------------------------------------------------------
// The E-stop is a hardware contactor with always-on control power. Software
// only ever OBSERVES E-stop state via kPinEstopAux; it never asserts or clears
// it. There is no E-stop output pin, and there never will be one here.
//
// DUST NOTE: there is deliberately NO dust-relay output pin. Dust collection is
// commanded by a cloned 433.92 MHz RF transmission through the CC1101 radio
// (#63, #137), not a switched relay. The DUST lamp reflects current-sense
// CONFIRMATION of the collector running (#138), not merely commanded state.

#ifndef PANEL_PINS_H
#define PANEL_PINS_H

#include <cstdint>

namespace panel {
namespace pins {

// A direct ESP32 GPIO number. Kept as a distinct type so the intent is obvious
// at call sites and so an expander bit can never be passed where a GPIO is.
using Gpio = std::uint8_t;

// Sentinel meaning "no direct GPIO is assigned" (e.g. a signal that lives
// entirely behind an I2C expander).
inline constexpr Gpio kNoGpio = 0xFF;

// ===========================================================================
// DIRECT ESP32 GPIO — interrupt-capable safety + quadrature inputs
// (MUST NOT move behind the MCP23017 expanders — see header notes)
// ===========================================================================

// ENABLE deadman ("ENABLE / hold to jog", panel-spec id: enable).
// Direct, interrupt-capable GPIO. Provisional (#118/#131).
inline constexpr Gpio kPinEnableDeadman = 25;

// E-stop auxiliary contact (observed only; panel-spec id: estop).
// Direct, interrupt-capable GPIO. Software never commands E-stop.
// Provisional (#118/#131).
inline constexpr Gpio kPinEstopAux = 26;

// MPG handwheel quadrature channel A (100-PPR wheel; panel-spec id: mpg).
// Direct, interrupt-capable GPIO. Provisional (#118/#131).
inline constexpr Gpio kPinMpgQuadA = 27;

// MPG handwheel quadrature channel B (100-PPR wheel; panel-spec id: mpg).
// Direct, interrupt-capable GPIO. Provisional (#118/#131).
inline constexpr Gpio kPinMpgQuadB = 13;

// ===========================================================================
// DIRECT ESP32 GPIO — analog inputs (ADC1; MCP23017 has no ADC)
// ===========================================================================

// FEED OVERRIDE % potentiometer (panel-spec id: feed_override).
// ADC1-capable, direct. Provisional (#118/#131).
inline constexpr Gpio kPinFeedPot = 36;  // ADC1_CH0 (input-only)

// SPINDLE OVR % potentiometer (panel-spec id: spindle_ovr).
// ADC1-capable, direct. Provisional (#118/#131).
inline constexpr Gpio kPinSpindlePot = 39;  // ADC1_CH3 (input-only)

// Dust-collector CT run-sense analog input (current transformer; #135, #138).
// Confirms the collector is actually drawing current. ADC1-capable, direct.
// Provisional (#118/#131).
inline constexpr Gpio kPinCollectorRunSense = 34;  // ADC1_CH6 (input-only)

// ===========================================================================
// DIRECT ESP32 GPIO — I2C bus to the two MCP23017 expanders
// ===========================================================================

// I2C data / clock for both MCP23017 expanders. Provisional (#118/#131).
inline constexpr Gpio kPinI2cSda = 21;
inline constexpr Gpio kPinI2cScl = 22;

// ===========================================================================
// DIRECT ESP32 GPIO — CC1101 sub-GHz radio (dust-collector RF control)
// SPI bus + GDO0 interrupt. #134, #137. MCP23017 cannot carry SPI.
// ===========================================================================

// CC1101 SPI signals (VSPI defaults). Provisional (#118/#131).
inline constexpr Gpio kPinCc1101Sck = 18;
inline constexpr Gpio kPinCc1101Miso = 19;
inline constexpr Gpio kPinCc1101Mosi = 23;
inline constexpr Gpio kPinCc1101Cs = 17;

// CC1101 GDO0 packet/status interrupt line. Direct, interrupt-capable.
// Provisional (#118/#131).
inline constexpr Gpio kPinCc1101Gdo0 = 16;

// ===========================================================================
// MCP23017 I2C I/O EXPANDERS — everything digital and latency-tolerant
// ===========================================================================

// A single bit on one of the two MCP23017 expanders. `expander` is the index
// into kMcp23017Addr[]; `bit` is 0..15 (port A = 0..7, port B = 8..15). This
// keeps expander-backed pin identity in this header alongside direct GPIO, so
// the "no numbers outside pins.h" rule holds for expander bits too.
struct ExpanderPin {
  std::uint8_t expander;  // 0 or 1 — index into kMcp23017Addr
  std::uint8_t bit;       // 0..15
};

// I2C 7-bit addresses of the two expanders (A3..A1 strapped 0b000 / 0b001).
// Provisional (#118/#131).
inline constexpr std::uint8_t kMcp23017Addr[2] = {0x20, 0x21};

// ---- Expander 0 (0x20): momentary inputs + rotary-selector positions -------
// Illuminated momentary button contacts (panel-spec ids: start/hold/reset/
// spindle/dust). Provisional bit assignments (#118/#131).
inline constexpr ExpanderPin kPinStartButton = {0, 0};    // START (cycle start/resume)
inline constexpr ExpanderPin kPinHoldButton = {0, 1};     // HOLD (feed hold)
inline constexpr ExpanderPin kPinResetButton = {0, 2};    // RESET (soft reset / clear alarm)
inline constexpr ExpanderPin kPinSpindleButton = {0, 3};  // SPINDLE (M3/M5)
inline constexpr ExpanderPin kPinDustButton = {0, 4};     // DUST (RF command request)

// AXIS selector positions OFF/X/Y/Z (panel-spec id: axis_select).
// Provisional bit assignments (#118/#131).
inline constexpr ExpanderPin kPinAxisSelOff = {0, 5};
inline constexpr ExpanderPin kPinAxisSelX = {0, 6};
inline constexpr ExpanderPin kPinAxisSelY = {0, 7};
inline constexpr ExpanderPin kPinAxisSelZ = {0, 8};

// STEP multiplier positions x1/x10/x100 (panel-spec id: step_select).
// Provisional bit assignments (#118/#131).
inline constexpr ExpanderPin kPinStepSelX1 = {0, 9};
inline constexpr ExpanderPin kPinStepSelX10 = {0, 10};
inline constexpr ExpanderPin kPinStepSelX100 = {0, 11};

// ---- Expander 1 (0x21): lamp + status-LED outputs --------------------------
// Illuminated-button back-lamps. NOTE: the DUST lamp is confirmation of the
// collector actually running (CT sense, #138), NOT a relay/command output.
// Provisional bit assignments (#118/#131).
inline constexpr ExpanderPin kPinStartLamp = {1, 0};    // START button lamp (lit = cycle running)
inline constexpr ExpanderPin kPinHoldLamp = {1, 1};     // HOLD button lamp
inline constexpr ExpanderPin kPinResetLamp = {1, 2};    // RESET button lamp
inline constexpr ExpanderPin kPinSpindleLamp = {1, 3};  // SPINDLE button lamp (lit = running)
inline constexpr ExpanderPin kPinDustLamp = {1, 4};     // DUST button lamp (lit = confirmed running)

// Status LEDs (panel-spec ids: led_pwr/led_link/led_homed/led_alarm/led_probe).
// Provisional bit assignments (#118/#131).
inline constexpr ExpanderPin kPinLedPwr = {1, 5};    // PWR
inline constexpr ExpanderPin kPinLedLink = {1, 6};   // LINK
inline constexpr ExpanderPin kPinLedHomed = {1, 7};  // HOMED
inline constexpr ExpanderPin kPinLedAlarm = {1, 8};  // ALARM
inline constexpr ExpanderPin kPinLedProbe = {1, 9};  // PROBE

}  // namespace pins
}  // namespace panel

#endif  // PANEL_PINS_H
