# Shapeoko Pro XXL — Operator Panel Firmware

ESP32 firmware for the physical operator panel of the Shapeoko Pro XXL
controller. This directory is a **scaffold** (issue #53): it establishes the
PlatformIO project, the build environments, the Hardware Abstraction Layer
(HAL) seam, and the centralised pin map so that every later driver can be built
for real ESP32 hardware while its pure logic is compiled and unit-tested on the
host CI runner **without an ESP32 attached**.

It deliberately implements **no panel behaviour** yet — no debouncing, no
quadrature decoding, no analog filtering, no E-stop logic, and no serial
protocol. Those arrive in later issues (#54, #56–#65, #137, #138).

This firmware toolchain (PlatformIO / C++) is **independent** of the repo's
Node/TypeScript workspaces and the `hardware/` Python tooling. It is not a member
of any npm workspace and must not be coupled to one; CI (#14) runs it as its own
job.

## Layout

```
firmware/panel/
├── platformio.ini            # esp32dev (real build) + native (host tests)
├── include/
│   ├── hal.h                 # thin hardware seam (no Arduino headers)
│   └── pins.h                # the ONLY place pin numbers may appear
├── src/
│   └── main.cpp              # esp32dev entry point + Arduino-backed HAL
└── test/
    └── test_smoke/
        └── test_smoke.cpp    # Unity smoke test, runs on the host
```

## Build & test

PlatformIO is required. Install it into a virtualenv **outside this repo tree**
(do not vendor it into the source tree):

```bash
python3 -m venv "$HOME/.cache/shapeoko-venvs/panel-pio"
"$HOME/.cache/shapeoko-venvs/panel-pio/bin/pip" install platformio
export PATH="$HOME/.cache/shapeoko-venvs/panel-pio/bin:$PATH"
```

- Host unit tests (no ESP32 needed):
  ```bash
  pio test -d firmware/panel -e native
  ```
- Real firmware build:
  ```bash
  pio run -d firmware/panel -e esp32dev
  ```

Build artifacts land in `firmware/panel/.pio/` (git-ignored).

## Environments

| Environment | Purpose | Framework | Test framework |
| ----------- | ------- | --------- | -------------- |
| `esp32dev`  | The real ESP32-WROOM panel MCU build | Arduino | — |
| `native`    | Host build of the Unity smoke test on CI, no ESP32 | none (host) | Unity |

`native` sets the default `test_build_src = no`, so host tests never pull in
`src/main.cpp` or any Arduino header. They exercise pure logic through the HAL
seam using an in-memory fake `Hal`. That is exactly the property that keeps all
later drivers host-testable.

## Warnings are errors

`-Wall -Wextra -Werror` is applied to **our** source and test code in every
environment, so any warning fails the build or test. It is scoped to code we own
(`build_src_flags` for `src/`, per-env `build_flags` for the `native` test
build) and not to framework/library code we do not control. Our sources are
compiled at C++17 (`-std=gnu++17` on target, `-std=c++17` on host).

## Framework choice: Arduino (not ESP-IDF)

The panel MCU build uses the **Arduino** framework on `esp32dev`. Rationale:

- **No existing ESP-IDF standardisation.** This is the first firmware in the
  repo; there is no prior ESP-IDF convention to match, so the "use ESP-IDF if it
  is already standardised" exception in the issue does not apply.
- **Smallest correct scaffold.** Arduino exposes everything the panel needs —
  GPIO, hardware timers, USB CDC serial, the watchdog, and ordinary C++ — with
  minimal configuration, which suits a one-day scaffold and deterministic panel
  I/O.
- **Future-proofed by the HAL.** All hardware access goes through `include/hal.h`.
  Drivers depend on the `Hal` interface, not on Arduino APIs, so a later move to
  ESP-IDF (or any other backend) would replace only the concrete HAL in
  `main.cpp` and touch no driver logic.

## The HAL seam (`include/hal.h`)

`hal.h` declares an abstract `panel::hal::Hal` interface — monotonic time,
digital I/O, analog read, serial read/write, and reset/boot metadata — plus the
small value types those use. It includes **no** Arduino/ESP32 headers, so it
compiles unchanged on the host. `src/main.cpp` provides the Arduino-backed
implementation for the target; the smoke test provides an in-memory fake for the
host. Only the minimal surface `main.cpp` and the smoke test need is present;
the real drivers are later issues.

## The pin map (`include/pins.h`)

**Every** GPIO number, expander bit, ADC channel, and bus pin lives in
`include/pins.h` and nowhere else. If any other file hardcodes a pin number,
that is a review failure by design. Each symbol is commented with the physical
control it names, taken from `hardware/panel-spec.yaml` and
`docs/hardware/panel-mockup.svg`.

### I/O expansion strategy

The direct pin budget does not close: the panel needs **34 signals** but the
ESP32 offers only **24 usable GPIO** — a deficit of **10**. The panel therefore
carries **two MCP23017 I²C I/O expanders** (16 bits each, addresses `0x20` and
`0x21`), and most *digital* signals sit behind them.

### Four signals stay on direct, interrupt-capable GPIO — non-negotiable

These four **must not** be moved behind the I²C expanders:

| Signal | Symbol | Why it must stay direct |
| ------ | ------ | ----------------------- |
| ENABLE deadman | `kPinEnableDeadman` | Safety input must be readable without I²C latency or bus-fault dependency |
| E-stop aux contact | `kPinEstopAux` | Safety input must be readable without I²C latency or bus-fault dependency |
| MPG quadrature A | `kPinMpgQuadA` | A 100-PPR handwheel drops counts if quadrature edges are polled across I²C |
| MPG quadrature B | `kPinMpgQuadB` | Same — quadrature edges need direct, interrupt-capable pins |

The three **analog** signals (FEED pot, SPINDLE pot, CT run-sense) and the
**CC1101 SPI** bus are also direct, because the MCP23017 is digital-only with no
ADC or SPI.

### Provisional numbers

The final numeric assignments depend on the I/O-expansion decision in **#131**
and the authoritative I/O map in **#118**, neither landed yet. Every *number* in
`pins.h` is therefore **provisional** and marked as such. What is fixed here is
the placement **class**: the four signals above are direct interrupt-capable
GPIO, and the analog/SPI signals are direct. The numbers are electrically
plausible placeholders so the scaffold compiles and links; they are not
authoritative until reconciled against #118/#131.

## Safety notes

- **E-stop is a hardware contactor** with always-on control power. Software only
  ever **observes** the E-stop auxiliary contact (`kPinEstopAux`) as an input.
  There is no E-stop output pin, and nothing here can assert or clear it.
- **There is no dust-relay pin.** Dust collection is commanded by a cloned
  433.92 MHz RF transmission through the CC1101 radio (#63, #137), not a switched
  relay. The DUST lamp reflects current-sense **confirmation** that the collector
  is running (#138), not merely commanded state.

## Licensing

This project is **MIT** (see the repository `LICENSE`). gSender is **GPL-3.0**
and is **reference only** — no code may be copied or transliterated from it. A CI
scan (`tools/check-no-gpl3-headers.mjs`) enforces this.
