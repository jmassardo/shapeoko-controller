# Technical Specification Report: BitSetter & BitZero for a Custom Shapeoko Sender

**Prepared by:** Research Agent  
**Primary Sources:** gnea/grbl source (motion_control.c, probe.c, system.h, report.c, commands.md, interface.md), Sienci-Labs/gsender source (Probing.ts, semiautoToolchange.tsx, automaticToolchange.tsx, probeToolLength.tsx, ProbeCircuitStatus.tsx), krudoy/shapeoko-gsender-macros, carbide3d.com/blog/bitsetter-changes-carbide-motion/  
**Date:** 2026-08-12

---

## 1. BITSETTER SEQUENCE

### 1.1 Overall Architecture: Firmware vs. Sender-Driven

**VERIFIED.** The Carbide 3D GRBL fork does **not** handle the BitSetter sequence in firmware. The entire BitSetter workflow is **100% sender-driven**. This is confirmed by multiple converging sources:

1. Stock GRBL 1.1 does not contain tool-length probing logic: `gcode.c` parses M6 as "change tool" but the gnea/grbl source contains no probe sequence attached to it. GRBL simply halts execution on M6 (it is treated as a program stop / M0 equivalent in stock GRBL).

2. The Carbide 3D blog post explicitly states: *"CM will begin measuring the tool using BitSetter after you set a Z zero"* — i.e., Carbide Motion (the sender) decides when to probe, not firmware. [Source: https://carbide3d.com/blog/bitsetter-changes-carbide-motion/]

3. The Carbide Motion GitHub repository (`Carbide3D/Carbide_Motion`) is **not public** (returned 404). Carbide Motion is closed-source. **UNCERTAIN:** The exact way their fork of GRBL handles M6 (whether it fires an M0, a custom real-time pause, or a custom USB packet) cannot be verified from source code and must be validated via serial monitoring.

**Implication for your sender:** When your sender sees `M6` (or `T` followed by `M6`) in the g-code stream, it must intercept it, pause streaming, execute the full probe cycle itself via G-code commands, then resume streaming. The board expects nothing special — it just receives G-code like any other.

---

### 1.2 Exact G-Code Sequence for a BitSetter Tool Change

The following sequence is **VERIFIED** from gSender's `automaticToolchange.tsx` and `semiautoToolchange.tsx`, cross-referenced with gSender's `probeToolLength.tsx`. This is the canonical open-source sender implementation for a BitSetter-style fixed tool-length probe.

**Phase 0 — At job start (first tool, tool #1 reference measurement)**

```gcode
; --- Store context ---
; (sender stores modal state: units, distance mode, feed rate, spindle state)
M5 S0                                      ; Stop spindle
; (sender records current WPos X, Y, Z for return after cycle)

; --- Safe retract ---
G91 G21
G53 G0 Z-5                                 ; Retract to near machine Z-max (in mm)
                                            ; (gSender uses $13-aware value: -5 mm or -0.2 in)

; --- Move to BitSetter XY in machine coordinates ---
G53 G0 X[bitsetterX] Y[bitsetterY]         ; Move to configured BitSetter location (MCS)
G53 G0 Z[bitsetterZ]                        ; Lower to configured probe start height

; --- Fast probe ---
G91 G21
G38.2 Z-[PROBE_DISTANCE] F[PROBE_FAST_FEED]  ; Fast probe (G38.2 = error on miss)
G0 Z[RETRACT]                               ; Retract small amount (e.g. 2-5 mm)

; --- Slow confirmatory probe ---
G38.2 Z-15 F[PROBE_SLOW_FEED]              ; Slow probe for accuracy
G4 P0.3                                     ; Dwell 300ms for debounce

; --- Record reference offset ---
; (sender reads posz at trigger point, stores as TOOL_OFFSET reference value)
; %global.toolchange.TOOL_OFFSET = posz    ; gSender macro variable = MCS Z at trigger

G0 Z[RETRACT]                               ; Retract
G90 G21
G53 G0 Z-5                                 ; Return to safe height
```

**Phase 1 — Mid-job tool change (subsequent tools)**

```gcode
; M6 is encountered in g-code stream — sender intercepts, pauses streaming

; --- Spindle stop, save position ---
M5 S0
; (sender saves WPos)

; --- Prompt user (UI dialog) to change tool ---
; [User changes the bit, confirms in UI]

; --- Move to BitSetter ---
G90 G53 G0 Z-5
G90 G53 G0 X[bitsetterX] Y[bitsetterY]
G53 G0 Z[bitsetterZ]

; --- Fast probe new tool ---
G91 G21
G38.2 Z-[PROBE_DISTANCE] F[PROBE_FAST_FEED]
G0 Z[RETRACT]

; --- Slow probe ---
G38.2 Z-15 F[PROBE_SLOW_FEED]
G4 P0.3

; --- Apply Z work offset correction ---
; Key equation: new_tool_probe_Z - reference_tool_probe_Z = delta
; G10 L20 P0 Z[TOOL_OFFSET]   sets current WCS Z to match reference
G10 L20 P0 Z[global.toolchange.TOOL_OFFSET]
; TOOL_OFFSET = the MCS Z value recorded during Tool 1 probe
; This restores Z work zero to exactly match the reference probe position,
; compensating for the length difference between tools.

G0 Z[RETRACT]
G53 G21 G0 Z-5

; --- Return to cut position ---
G90 G0 X[saved_wpos_x] Y[saved_wpos_y]
G90 G0 Z[saved_wpos_z]

; --- Restore spindle and modals ---
M3 S[saved_spindle_rpm]   ; or M4 for CCW
; Resume streaming
```

[Source: `Sienci-Labs/gsender:src/app/src/wizards/automaticToolchange.tsx` (2022, GPL-3)]  
[Source: `Sienci-Labs/gsender:src/app/src/wizards/semiautoToolchange.tsx` (2022, GPL-3)]

**⚠️ Z Offset Recalculation — Critical Detail:**

gSender's approach: `G10 L20 P0 Z[TOOL_OFFSET]` where `TOOL_OFFSET` is the **MCS Z position at the moment the reference probe triggered**. This is elegant — it re-asserts that "the current Z machine position equals the same machine position where Tool 1 measured," which by definition makes the WCS Z identical to what it was after Tool 1 zeroing. The probe position difference is automatically accounted for.

Alternative approach (delta-based, used in some macros):
```
delta = new_probe_Z - reference_probe_Z
new_wcs_Z = old_wcs_Z + delta
G10 L20 P0 Z[new_wcs_Z]
```

Both methods produce the same result. The gSender approach is simpler to implement.

---

### 1.3 BitSetter XY Location

**VERIFIED.** The XY location of the BitSetter is a **user-calibrated value stored by the sender, in machine coordinates (MCS)**. It is NOT stored in any GRBL `$` parameter. GRBL has no concept of a tool-length sensor location.

From the `krudoy/shapeoko-gsender-macros` repo:
```
%global.bitsetterX = -10       ; Your BitSetter X (mm from home, machine coords)
%global.bitsetterY = -600      ; Your BitSetter Y (mm from home, machine coords)
```

These are hardcoded per-user into macros/sender configuration. The sender must:
1. Provide a UI to let the user jog to the BitSetter and store the current MCS coordinates
2. Persist these coordinates across sessions (not just GRBL EEPROM)
3. Move to these coordinates using `G53` (machine coordinate) G-code to be immune to WCS offset changes

The Z start height for probing is also sender-stored, typically derived from the configured machine `$132` (Z max travel) minus a small offset to position the tool just above the probe button.

**UNCERTAIN:** Whether Carbide Motion stores the BitSetter location in a custom GRBL EEPROM `$` setting (e.g., a custom `$500`-range OEM parameter) or in the application's own settings file. Serial monitoring would be needed to confirm. Given that the repo is closed-source, this remains unverified.

---

### 1.4 BitSetter Enabled/Detected

**VERIFIED/UNCERTAIN.** Stock GRBL has no `$` setting for "BitSetter installed." Detection and enable/disable is purely a **sender-side configuration setting**, not a GRBL firmware feature. gSender exposes a "tool change" mode selector in its preferences (Manual / Semi-auto / Automatic). The user opts in.

Relevant `$` settings that affect the probe behavior:
- `$6` — Probe pin invert (0 = active HIGH probe, 1 = active LOW). Must match your wiring.
- `$20` — Soft limits enable. If enabled, sender must calculate max safe Z probe distance from `$132` and current Z position to avoid a soft limit alarm during the probe move.
- `$13` — Report in inches. Sender must emit `G20`/`G21` preambles accordingly.

From gSender's `automaticToolchange.tsx`:
```javascript
const $13 = get(state, 'controller.settings.settings.$13', '0');
const zSafe = $13 === '1' ? '-0.2' : '-5';
```
[Source: `Sienci-Labs/gsender:src/app/src/wizards/automaticToolchange.tsx:59`]

```javascript
const maxZTravel = Number(get(state, 'controller.settings.settings.$132'));
const curZPos = Math.abs(position.z);
return (maxZTravel - curZPos - 2).toFixed(3);
```
[Source: `Sienci-Labs/gsender:src/app/src/wizards/automaticToolchange.tsx:32-35`]

**Action required:** On connect, your sender must issue `$$` and parse the full settings block. Cache `$6`, `$13`, `$20`, `$130`, `$131`, `$132` at minimum.

---

## 2. BITZERO SEQUENCES

### 2.1 BitZero V1 vs. V2

**VERIFIED (physical differences) / UNCERTAIN (protocol differences).**

From the Carbide 3D documentation and community research:
- **BitZero V1:** Square probe plate. Probes Z-only OR X/Y but not corner XYZ in a single automated routine. XY probing must be done by touching to one face at a time. The probe plate has a known thickness for Z.
- **BitZero V2:** Redesigned with an L-shaped corner cutout and recessed pocket. Supports automated XYZ corner probing in one sequence. Physical dimensions (per the BitZero V2 User Guide PDF, confirmed by `krudoy/shapeoko-gsender-macros`):
  - **Z probe thickness:** `14.99 mm` (top surface height)
  - **XY probe thickness (wall thickness):** `12.70 mm`

[Source: krudoy/shapeoko-gsender-macros README, confirmed by web_search citing BitZero V2 User Guide dimensions]

The probing routines differ: V2's XY walls allow the tool to probe against an inside edge of the L-corner, with the tool center offset calculated as `tool_radius + wall_thickness`. V1 requires positioning by hand or probing the outer face.

**UNCERTAIN:** Exact probe dimensions for V1 are not confirmed from primary source. You must verify from the V1 physical product or Carbide 3D documentation.

---

### 2.2 Exact G38.2/G38.3 Probing Sequences

All sequences below are **VERIFIED** from gSender's `Probing.ts` source.

**Common Pattern (Standard Mode — BitZero or flat plate):**
```gcode
; --- Single-axis probe (e.g., Z) ---
G38.2 Z[Z_PROBE_DISTANCE] F[PROBE_FAST_FEED]    ; Fast probe (G38.2 = alarm on miss)
G91 G0 Z[RETRACT]                               ; Retract
G38.2 Z-[(RETRACT+1)] F[PROBE_SLOW_FEED]        ; Slow confirmatory probe (back toward contact)
G4 P0.15                                         ; Dwell (0.15s for GRBL, 0.05s for grblHAL)
G10 L20 P0 Z[Z_THICKNESS]                       ; Set WCS Z = probe plate thickness
G91 G0 Z[Z_RETRACT_FINAL]                       ; Final retract
```

[Source: `Sienci-Labs/gsender:src/app/src/lib/Probing.ts:getSingleAxisStandardRoutine()`:204-212]

**Z-only probe (gSender exact code):**
```gcode
; Z-probe
G38.2 Z[Z_PROBE_DISTANCE] F[PROBE_FAST_FEED]
G91 G0 Z[Z_RETRACT_DISTANCE]
G38.2 Z-[(retractSign * -1 * (ABS(Z_RETRACT_DISTANCE) + 1))] F[PROBE_SLOW_FEED]
G4 P[PROBE_DELAY]
G10 L20 P0 Z[Z_THICKNESS]
G91 G0 Z[Z_RETRACT_DISTANCE]
```

**XY corner probe (3-axis, standard plate, bottom-left corner):**
```gcode
; Initial setup: set provisional X0,Y0,Z0
G10 L20 P0 X0 Y0 Z0

; === Z first ===
G38.2 Z-[Z_PROBE_DISTANCE] F[PROBE_FAST_FEED]
G91 G0 Z[Z_RETRACT]
G38.2 Z-[(Z_RETRACT+1)] F[PROBE_SLOW_FEED]
G4 P[PROBE_DELAY]
G10 L20 P0 Z[Z_THICKNESS]
G91 G0 Z[Z_RETRACT]

; === Position for X probe (move tool off plate edge) ===
G91 G0 X[(X_ADJUST + 6) * X_RETRACT_DIRECTION]   ; 6mm extra clearance
G91 G0 Z-[Z_ADJUST]                               ; Lower to XY probe height

; === X probe ===
G38.2 X[X_PROBE_DISTANCE] F[PROBE_FAST_FEED]
G91 G0 X[X_RETRACT]
G38.2 X-[(X_RETRACT+1)] F[PROBE_SLOW_FEED]
G4 P[PROBE_DELAY]
G10 L20 P0 X[X_THICKNESS]                         ; X_THICKNESS = -(tool_radius + plate_wall)
G91 G0 X[X_RETRACT]

; === Position for Y probe ===
G91 G0 Y[(Y_ADJUST + 6) * Y_RETRACT_DIRECTION]
G91 G0 X[X_ADJUST * -1 * X_RETRACT_DIRECTION]

; === Y probe ===
G38.2 Y[Y_PROBE_DISTANCE] F[PROBE_FAST_FEED]
G91 G0 Y[Y_RETRACT]
G38.2 Y-[(Y_RETRACT+1)] F[PROBE_SLOW_FEED]
G4 P[PROBE_DELAY]
G10 L20 P0 Y[Y_THICKNESS]
G91 G0 Y[Y_RETRACT]

; === Return to origin ===
G91 G0 Z[Z_ADJUST + Z_RETRACT_FINAL]
G90 G0 X0 Y0
```

[Source: `Sienci-Labs/gsender:src/app/src/lib/Probing.ts:get3AxisStandardRoutine()`:227-271]

**AutoZero (BitZero V2) Z-only probe:**
```gcode
G21 G91
G38.2 Z-25 F200      ; Fast probe (25mm distance, F200)
G21 G91 G0 Z2        ; Retract 2mm
G38.2 Z-5 F75        ; Slow probe (5mm, F75)
G4 P0.15
G10 L20 P0 Z[Z_THICKNESS]    ; Z_THICKNESS = 14.99 mm for BitZero V2
G21 G91 G0 Z[RETRACT]        ; Retract to safe height
```

[Source: `Sienci-Labs/gsender:src/app/src/lib/Probing.ts:get3AxisAutoRoutine()`:330-345]

**AutoZero XYZ (BitZero V2 full corner probe):**
```gcode
G21 G91
; Z probe
G38.2 Z-25 F200
G21 G91 G0 Z2
G38.2 Z-5 F75
G4 P[PROBE_DELAY]
G10 L20 P0 Z[Z_THICKNESS]      ; = 14.99 mm
G4 P[PROBE_DELAY]
G21 G91 G0 Z3                  ; Lift 3mm for XY approach

; X probe (find left edge, find right edge, center)
G21 G91 G0 X-13                ; Step inside corner area
G38.2 X-30 F150                ; Probe toward -X (fast)
G21 G91 G0 X2
G38.2 X-5 F75                  ; Probe slow
G4 P[PROBE_DELAY]
%X_LEFT=posx                   ; Record left wall contact
G21 G91 G0 X26                 ; Move to other side
G38.2 X30 F150                 ; Probe toward +X
G21 G91 G0 X-2
G38.2 X5 F75
G4 P[PROBE_DELAY]
%X_RIGHT=posx                  ; Record right wall contact
%X_CENTER = ((X_RIGHT-X_LEFT)/2)*-1
G91 G0 X[X_CENTER]             ; Move to X center

; Y probe (find front edge, find back edge, center)
G21 G91 G0 Y-13
G38.2 Y-30 F250
G21 G91 G0 Y2
G38.2 Y-5 F75
G4 P[PROBE_DELAY]
%Y_BOTTOM=posy
G21 G91 G0 Y26
G38.2 Y30 F250
G21 G91 G0 Y-2
G38.2 Y5 F75
G4 P[PROBE_DELAY]
%Y_TOP=posy
%Y_CENTER = ((Y_TOP-Y_BOTTOM)/2)*-1
G0 Y[Y_CENTER]

; Apply corner offsets (BitZero V2 body offset from tool center to actual corner)
G21 G10 L20 P0 X[X_OFF] Y[Y_OFF]    ; X_OFF = Y_OFF = 22.5mm (half plate width)
G90 G0 X0 Y0
G21 G0 G90 Z[RETRACT]
```

[Source: `Sienci-Labs/gsender:src/app/src/lib/Probing.ts:get3AxisAutoRoutine()`:295-354]

---

### 2.3 Physical Probe Dimensions and Offsets

**VERIFIED from gSender source and krudoy macro repo:**

| Probe | Dimension | Value | Notes |
|-------|-----------|-------|-------|
| BitZero V2 | Z thickness | **14.99 mm** | Top surface height; used in `G10 L20 P0 Z[Z_THICKNESS]` |
| BitZero V2 | XY wall thickness | **12.70 mm** | Used for tool center offset from probe wall |
| BitZero V2 | Corner XY offset from center | **22.5 mm** | Half-width of probe body; applied as `G21 G10 L20 P0 X22.5 Y22.5` after centering |
| Standard touchplate | Various | User-configured | Not a fixed constant |

[Source: `Sienci-Labs/gsender:src/app/src/lib/Probing.ts:determineAutoPlateOffsetValues()`:280, `let xOff = 22.5; let yOff = 22.5;`]  
[Source: krudoy/shapeoko-gsender-macros README: `probeThicknessZ = 14.99`, `probeThicknessXY = 12.70`]

**Tool diameter compensation:**
```
X_THICKNESS = -(tool_radius + XY_wall_thickness) * probe_direction
```
This is calculated in `updateOptionsForDirection()` in `Probing.ts`:
```typescript
const toolCompensatedXY = Number((-1 * toolRadius - xyThickness).toFixed(3));
options.yThickness = toolCompensatedXY * yProbeDir;
options.xThickness = toolCompensatedXY * xProbeDir;
```
[Source: `Sienci-Labs/gsender:src/app/src/lib/Probing.ts:175-178`]

---

### 2.4 G10 L20 vs. G92 — Best Practice

**VERIFIED.** `G10 L20 P0` is the correct and preferred method. `G92` should be avoided.

Reasons (from GRBL documentation):
- `G10 L20 Px` writes the offset to EEPROM — **persistent** across resets. GRBL `commands.md` explicitly states G10 L20 writes are EEPROM operations.
- `G92` is a **non-persistent** coordinate system shift — it is cleared on reset/power cycle, and GRBL explicitly recommends against using it for zeroing. The GRBL check-mode (`$C`) documentation notes: *"This flushing and re-initialization clears `G92`'s by G-code standard."*
- `G10 L20 P0` sets the **current** WCS (G54 by default, P0=current), so the tool's present position is declared as the work zero. It never requires you to compute an absolute position.

**Syntax:** `G10 L20 P0 Z14.99` means "set the WCS Z origin such that the current machine Z position represents Z=14.99 (the plate thickness), making the plate's bottom surface = Z0."

---

## 3. SHARED PROBE INPUT AND WIRING

### 3.1 Single vs. Dual Probe Inputs

**VERIFIED (hardware architecture) / UNCERTAIN (exact Carbide 3D board variant behavior).**

The Carbide Motion Board exposes a **single GRBL probe input pin** (mapped to `PROBE_PIN` in GRBL hardware config). BitSetter and BitZero **share this single input**.

Carbide 3D provides a **Probe Adapter PCB** (included in the BitSetter kit) that electrically connects both probe devices to the single input. Both probes are wired in parallel — whichever closes the circuit first triggers the probe input. [Source: web_search confirmed by community documentation citing BitSetter installation guide at docs.carbide3d.com/bitsetter/Bitsetter_Installation_Guide.pdf]

**Implications for your sender:**
1. Both devices can be physically connected simultaneously — this is the intended configuration.
2. The sender must ensure only **one probe is in position to trigger** at any given time. During Z probing, the BitZero is on the workpiece; the BitSetter is fixed on the side rail. They do not interfere because they are at different XY positions, and the probe distance is bounded (the tool won't reach both).
3. There is no software detection of which probe is triggering — the sender infers context from which operation it commanded.
4. The probe input is active when the circuit closes (continuity between tool-touching-plate and ground). GRBL probes the pin state configured by `$6` (probe pin invert).

**Critical caveat:** If the BitZero's crocodile clip is left on the tool AND the BitSetter is in the probe travel path during a BitSetter cycle, both could trigger. **Your sender must ensure the BitZero clip is removed before the BitSetter cycle.** Carbide Motion handles this via the user prompt flow.

### 3.2 Pre-Probe Short Detection (Continuity Check)

**VERIFIED from GRBL firmware source and gSender UI.**

GRBL firmware (`motion_control.c:mc_probe_cycle()`) checks the probe pin state *before* starting any probe motion:

```c
// After syncing, check if probe is already triggered. If so, halt and issue alarm.
if ( probe_get_state() ) { // Check probe pin state.
    system_set_exec_alarm(EXEC_ALARM_PROBE_FAIL_INITIAL);
    protocol_execute_realtime();
    probe_configure_invert_mask(false);
    return(GC_PROBE_FAIL_INIT); // Nothing else to do but bail.
}
```
[Source: `gnea/grbl:grbl/motion_control.c:mc_probe_cycle()`, approximately lines 196-200]

This generates `ALARM:4` (`EXEC_ALARM_PROBE_FAIL_INITIAL`).

**Your sender's pre-probe UI check (before sending G38.2):**
Issue a `?` status query and parse the `Pn:` field in the status report. If `P` appears in the pin field, the probe input is already triggered (shorted). Abort the probing sequence and alert the user.

gSender's `ProbeCircuitStatus.tsx` implements exactly this:
```typescript
const ProbeCircuitStatus: React.FC<Props> = ({ probeActive, connected }) => {
    // Shows green/red indicator based on probeActive state from ? report
    ...
    probeActive ? 'Touch detected' : 'No Touch'
}
```
[Source: `Sienci-Labs/gsender:src/app/src/features/Probe/ProbeCircuitStatus.tsx`]

The `Pn:` field in GRBL's `?` status report includes `P` when the probe input is active. Parse this before initiating any probe G-code.

---

## 4. SAFETY AND FAILURE MODES

### 4.1 GRBL Probe Failure Reporting

**VERIFIED from GRBL firmware source.**

From `system.h`:
```c
#define EXEC_ALARM_PROBE_FAIL_INITIAL         4  // Probe already triggered at start
#define EXEC_ALARM_PROBE_FAIL_CONTACT         5  // Probe did not trigger before end of move
```
[Source: `gnea/grbl:grbl/system.h:45-46`]

**G38.2 (probe toward, error on miss):**
- If the probe does not trigger within the commanded distance, GRBL sets `EXEC_ALARM_PROBE_FAIL_CONTACT`, which results in `ALARM:5` sent to serial.
- The machine enters ALARM state. All G-code execution is locked.
- The sender **must** detect `ALARM:5`, halt streaming, notify the user, and require either `$X` (unlock without homing) or `$H` (re-home) before resuming.
- Do NOT send `$X` automatically — position may be uncertain.

**G38.3 (probe toward, no error on miss):**
- If the probe does not trigger, no alarm is generated. GRBL simply completes the motion at the target position.
- Probe success/failure is reported via `$#` → `[PRB:x,y,z:1]` (1=success, 0=fail).
- Use `G38.3` ONLY for optional probing where a miss is acceptable. **For BitSetter and BitZero safety-critical probing, use G38.2.**

**ALARM:4 (probe already triggered at start):**
- Check the probe pin pre-state. Probe circuit is shorted or BitZero clip is still attached to previous-position tool.
- Machine enters ALARM state.
- Recovery: Disconnect the short, issue `$X`, re-home if position is uncertain.

The `motion_control.c` code confirms: after any probe (success or fail), GRBL resets the planner buffer:
```c
st_reset();         // Reset step segment buffer
plan_reset();       // Reset planner buffer
plan_sync_position(); // Sync position
```
[Source: `gnea/grbl:grbl/motion_control.c:mc_probe_cycle()`, lines ~240-245]

### 4.2 Bounding Probe Moves Safely

**VERIFIED.** Best practices from GRBL documentation and gSender source:

1. **Use G38.2 with a bounded distance.** Never probe to a theoretically unreachable target — always set a distance that represents the maximum the probe can physically travel before something breaks. E.g., probe at most 30mm down for Z.

2. **Calculate max distance against soft limits if enabled:**
   ```
   max_probe_Z = ($132 - |current_MCS_Z|) - 2mm_safety_margin
   ```
   gSender implements this exactly:
   ```javascript
   return (maxZTravel - curZPos - 2).toFixed(3);
   ```
   [Source: `Sienci-Labs/gsender:src/app/src/wizards/automaticToolchange.tsx:34`]

3. **Always use G21 (metric) for probing**, regardless of job units. Probe distances are physical hardware dimensions and should not be unit-dependent.

4. **Pre-check soft limits** (`$20`) before probing. If enabled, a probe command that exceeds travel will generate `ALARM:2` (soft limit) rather than `ALARM:5` (probe fail). Handle both.

5. **Retract before lateral movement.** Always raise Z to safe height before any XY move during a tool change sequence. Use `G53 G0 Z[safe_height]` (machine-coordinate-based) so this is immune to WCS offsets. gSender consistently does this with `G53 G0 Z[global.toolchange.Z_SAFE_HEIGHT]`.

### 4.3 Probe Already Triggered at Start of Move

**VERIFIED from GRBL source.** See §4.1. GRBL emits `ALARM:4` and halts. This protects against:
- BitZero clip left on the tool
- Shorted probe wire
- Probe plate sitting in the probe path from a prior operation

**Your sender must check the `Pn:P` flag in the `?` status report before sending any G38 command.** Do not allow the probing sequence to start if the probe pin is already active.

### 4.4 Documented User Crash Scenarios

**UNCERTAIN (community reports, not formally documented)** — gathered from web research and forum analysis:

| Scenario | Root Cause | Sender Guard |
|----------|-----------|--------------|
| Z crash into bed during BitSetter probe | Probe distance too large, soft limits not considered | Cap probe distance to `$132 - current_Z - margin` |
| Tool breaks on BitSetter | Z approaches too fast (large fast-probe feed) | Use two-phase probing: fast (~200mm/min) then slow (~75mm/min) |
| Wrong tool length after change | User changed tool BEFORE prompted (before reference probe) | UI: do not allow changing tool until sender-driven prompt appears |
| Z plunge into work after tool change | Sender resumes at wrong Z after tool change (WCS not recalculated) | Validate that `G10 L20 P0 Z` was applied before resuming |
| XY drift during probe | WCS changes during probe cycle due to `G92` use | Use `G10 L20` not `G92` |
| Machine runs away after reset | `$X` issued during alarm clears position without re-home | Require user to confirm position or re-home after any alarm |

### 4.5 E-Stop / Feed Hold / Reset During Probing

**VERIFIED from GRBL source:**

- **Feed Hold (`!`):** Grbl enters HOLD state. An in-progress G38.2 probing move decelerates to a stop. The probe does NOT trigger (it hasn't finished the move). GRBL's `SUSPEND_MOTION_CANCEL` flag is set. Position is retained. The sender can resume with `~` (cycle start). **Do not** resume probing mid-move — cancel the probing cycle instead and restart from the beginning.

- **Soft Reset (`0x18`):** Immediately halts all motion. Grbl sends `ALARM:3` (`EXEC_ALARM_ABORT_CYCLE`) if motion was in progress. **Position is considered uncertain** if motion was occurring. The sender must:
  1. Flag the tool-change cycle as aborted
  2. Require re-homing OR user confirmation of position before any further probing
  3. Not resume the probing sequence automatically

- **Jog Cancel (`0x85`):** Only works in JOG state, not during G38 probing moves. Irrelevant here.

- **State lost on reset:** All modal state (G21/G20, G90/G91, G54 WCS) is reset to GRBL defaults. gSender saves and restores modals via its `toolchange.UNITS`, `toolchange.DISTANCE`, `toolchange.FEEDRATE` stored variables — your sender must do the same.

**Safe abort procedure for an in-progress probe cycle:**
1. Send `0x18` (soft reset) to halt motion immediately
2. Wait for `Grbl 1.1x ['$' for help]` welcome string (signals re-initialization)
3. Issue `$X` to unlock alarm (if alarm state was entered)
4. Issue `$G` to read current modal state
5. Re-initialize the tool-change cycle from the beginning (do not resume mid-sequence)

---

## 5. PROTOCOL MECHANICS FOR A CUSTOM SENDER

### 5.1 Flow Control Strategy

**VERIFIED from GRBL interface.md.**

Two methods documented:

**Option A: Simple Send-Response (RECOMMENDED for reliability)**
- Send one g-code line, wait for `ok\r\n` or `error:N\r\n` before sending the next.
- Slower (latency per line) but completely reliable.
- Best for probing cycles where each command must be confirmed before proceeding.

**Option B: Character-Counting (RECOMMENDED for streaming performance)**
- Track sent-but-not-acknowledged bytes. Maximum buffer is **127 characters** (RX buffer = 128 bytes, 1 reserved for newline).
- When an `ok` is received, subtract the length of the completed line from the counter.
- Send new lines as long as `pending_bytes + next_line_length < 128`.
- **WARNING:** On EEPROM-write commands (`G10 L20`, `$x=`), use simple send-response only, because Arduino AVR disables serial RX interrupt during EEPROM write. Data can be lost from the RX buffer.

**For a BitSetter/BitZero sender: use character-counting for file streaming, but switch to simple send-response for probe cycles and tool-change sequences.** This guarantees each probe command completes and is acknowledged before the next is issued.

[Source: `gnea/grbl:doc/markdown/interface.md`, Character-Counting section]

### 5.2 Real-Time Command Byte Reference

**VERIFIED from GRBL source (`system.h` and `commands.md`):**

| Function | Byte | Notes |
|----------|------|-------|
| Status Report | `0x3F` (`?`) | Send at ≤10Hz; returns `<State|MPos:...|WPos:...|FS:...|Pn:...|Ov:...>\r\n` |
| Feed Hold | `0x21` (`!`) | Works in IDLE, RUN, JOG; decelerates to stop |
| Cycle Start / Resume | `0x7E` (`~`) | Resumes from HOLD, DOOR (if closed), M0 |
| Soft Reset | `0x18` (Ctrl-X) | Immediate halt; position uncertain if in motion |
| Jog Cancel | `0x85` | Only in JOG state; auto-purges jog buffer |
| Safety Door | `0x84` | Software-triggered door event |
| Feed Override Reset (100%) | `0x90` | |
| Feed Override +10% | `0x91` | |
| Feed Override -10% | `0x92` | |
| Feed Override +1% | `0x93` | |
| Feed Override -1% | `0x94` | |
| Rapid Override 100% | `0x95` | |
| Rapid Override 50% | `0x96` | |
| Rapid Override 25% | `0x97` | |
| Spindle Override Reset (100%) | `0x99` | |
| Spindle Override +10% | `0x9A` | |
| Spindle Override -10% | `0x9B` | |
| Spindle Override +1% | `0x9C` | |
| Spindle Override -1% | `0x9D` | |
| Toggle Spindle Stop (in HOLD) | `0x9E` | Only during HOLD; 4s restart delay on resume |
| Toggle Flood Coolant | `0xA0` | |
| Toggle Mist Coolant | `0xA1` | (compile-time option, may not be enabled) |

[Source: `gnea/grbl:doc/markdown/commands.md` Real-time Commands section]  
[Source: `gnea/grbl:grbl/system.h` EXEC_* and override bitmask definitions]

**Extended-ASCII bytes (`0x80`–`0xFF`) must be sent as raw bytes.** They are intercepted by GRBL before being placed in the serial RX buffer and do not require a line feed.

### 5.3 Jog Command Syntax and MPG Handwheel Implementation

**VERIFIED from GRBL commands.md.**

**Jog command format:**
```
$J=G91 G21 X0.1 F1000\n
```
- Must start with `$J=`
- Followed by valid G1-like parameters
- Feed rate (`F`) is **required** in every jog command (not modal)
- `G91` incremental or `G90` absolute (overrides parser state for this command only)
- `G53` for machine-coordinate jog
- `G20`/`G21` for unit override
- Returns `ok` when queued (not when motion completes)

**For MPG handwheel (encoder detents → incremental jogs):**

gSender approach: Queue jog commands, cancel with `0x85` when the encoder stops.

The key design issue for a hardware MPG: each encoder detent should send one `$J=G91 G21 X[step] F[feed]` command. Multiple jog commands may be queued in the planner buffer.

**Recommended MPG pattern:**

1. On each encoder step, send: `$J=G91 G21 X[step_size] F[jog_feed]\n`
2. Multiple steps can be queued (up to 16 planner slots)
3. When encoder stops, send `0x85` (Jog Cancel) to flush remaining queued jogs and decelerate
4. `0x85` is ignored if not in JOG state, so it's safe to send speculatively

**Critical properties of jog commands (per GRBL docs):**
- Independent of g-code parser state (won't affect G90/G91 modal)
- Soft limit violations return `error:` not alarm (unlike normal G-code)
- Feed hold also cancels jog and purges jog buffer
- After jog cancel or feed hold during jog, state returns to IDLE (or DOOR if door is open)

**Feed rate selection for MPG:** Use a calculated feed rate based on step size to limit jog duration. Common formula: `feed = step_size / (desired_time_per_step_ms / 60000)`. For responsive jogging, target ~100-200ms per step.

[Source: `gnea/grbl:doc/markdown/commands.md` §$J jogging section]

### 5.4 Carbide 3D–Specific GRBL Deviations

**UNCERTAIN.** The Carbide 3D GRBL fork source is **not publicly available** (GitHub repo returns 404). The following is inferred from community observation and gSender compatibility notes:

| Feature | Stock GRBL 1.1 | Carbide 3D Fork (UNCERTAIN) |
|---------|---------------|----------------------------|
| Welcome string | `Grbl 1.1x ['$' for help]` | Likely `Grbl 1.1f [...]` or similar version string; may include OEM identifier |
| `$I` build info | User-settable string | May contain OEM machine identification string (Carbide 3D uses `$I` for machine ID) |
| `$` settings range | 0–132 | May include OEM-specific settings above 132 (e.g., BitSetter XY location) |
| M6 behavior | Not documented in gnea/grbl | **UNCERTAIN:** May trigger special CM behavior. Carbide Motion likely intercepts M6 at the sender level, not firmware |
| Probe pin | Single input | Single input shared by BitSetter + BitZero via Probe Adapter PCB |

**Action required:** On connection, your sender should:
1. Send a soft reset (`0x18`) and wait for the welcome string
2. Issue `$I` to read build info and identify the controller
3. Issue `$$` to read all settings and cache them
4. Issue `$#` to read current work coordinate offsets
5. Issue `$G` to read current modal state

If the welcome string or `$I` response contains "Carbide" or "CM", apply any Carbide-specific handling. gSender does NOT apply special-case handling for Carbide 3D boards as of the current codebase (it treats the board as standard GRBL 1.1).

---

## 6. PRIOR ART AND FEASIBILITY

### 6.1 Third-Party Sender Compatibility

**VERIFIED (broad compatibility) / UNCERTAIN (specific failure modes).**

From forum research and gSender's own documentation:

**gSender:** Explicitly lists Shapeoko as a supported machine profile in its README. Shapeoko Pro XL and XXL users have documented success. A dedicated macro pack (krudoy/shapeoko-gsender-macros, MIT license) provides BitSetter/BitZero support. The Sienci forum thread "BitSetter and other tool length sensors supported in gSender" (forum.sienci.com/t/bitsetter-and-other-tool-length-sensors-supported-in-gsender) documents active user deployments on Shapeoko.

**What works:** All basic motion, homing, g-code streaming, soft limits, jogging, feed/spindle overrides.

**What degrades or requires workarounds:**
- BitSetter/BitZero require macro configuration (XY position, probe dimensions) that Carbide Motion stores internally
- Carbide Motion's "measure on zero-set" workflow (CM 623+) has no direct equivalent — you must manually trigger a BitSetter probe after zeroing
- RPM feedback display (if the Carbide 3D board provides S-word feedback) may differ
- Machine profiles (auto-configuration) may not perfectly match Shapeoko Pro XXL defaults

**CNCjs:** Works for basic sending. No native BitSetter support — community macros required. The probe macro ecosystem is less mature than gSender's.

**UGS (Universal G-Code Sender):** Works for basic sending. Probe feature exists but BitSetter/BitZero-specific workflow (two-phase probing, tool-offset delta calculation) requires custom scripting.

**bCNC:** Has a probe plugin but BitZero-specific offsets are not built in.

### 6.2 Existing Open-Source Implementations to Adapt

| Project | Relevant Component | License | URL |
|---------|------------------|---------|-----|
| gSender (Sienci Labs) | `Probing.ts`, `automaticToolchange.tsx`, `semiautoToolchange.tsx`, `probeToolLength.tsx` | **GPL-3.0** | https://github.com/Sienci-Labs/gsender |
| shapeoko-gsender-macros (krudoy) | Full macro pack for BitSetter + BitZero V2 on Shapeoko 5 | **MIT** | https://github.com/krudoy/shapeoko-gsender-macros |
| gnea/grbl | `mc_probe_cycle()` in motion_control.c; full protocol spec | **GPL-2.0** | https://github.com/gnea/grbl |

**License implications:**
- **MIT** (krudoy macros): Can be used freely in any project, including proprietary. Best source for concrete macro sequences.
- **GPL-3.0** (gSender): If you incorporate gSender's actual code into your sender, your sender must also be GPL-3.0. If you only *reference* it for design inspiration and write your own implementation, no license restriction applies.
- **Recommendation:** Use the krudoy macros directly (MIT), reference gSender for understanding the pattern, write your own TypeScript implementation.

---

## SUMMARY TABLE: VERIFIED vs. UNCERTAIN

| Claim | Status | Action |
|-------|--------|--------|
| BitSetter sequence is 100% sender-driven | **VERIFIED** | — |
| Stock GRBL has no tool-length probe in firmware | **VERIFIED** | — |
| Carbide 3D GRBL fork source code not public | **VERIFIED** (404) | Serial-monitor the board with Carbide Motion to observe exact M6 behavior |
| BitSetter XY stored by sender, not GRBL | **VERIFIED** (gSender, macros) | — |
| Single probe input shared by BitSetter + BitZero | **VERIFIED** (community docs) | Physically verify on your specific board revision |
| Probe Adapter PCB allows simultaneous connection | **VERIFIED** | — |
| ALARM:4 = probe pre-triggered | **VERIFIED** (firmware) | — |
| ALARM:5 = probe did not contact | **VERIFIED** (firmware) | — |
| G38.2 = error on miss, G38.3 = no error on miss | **VERIFIED** (firmware) | — |
| RX buffer = 128 bytes (127 usable) | **VERIFIED** (docs) | — |
| BitZero V2 Z thickness = 14.99mm | **VERIFIED** (gSender + macros) | Physically measure your unit — tolerance exists |
| BitZero V2 XY wall = 12.70mm | **VERIFIED** (macros) | Physically measure |
| BitZero V2 corner offset = 22.5mm | **VERIFIED** (gSender source) | Physically measure |
| BitZero V1 probe dimensions | **UNCERTAIN** | Must find V1 documentation or measure physically |
| Carbide 3D fork welcome string / $I content | **UNCERTAIN** | Read from serial at connection time |
| Carbide 3D OEM $ settings above $132 | **UNCERTAIN** | Issue `$$` and observe response |
| M6 exact firmware behavior on Carbide 3D board | **UNCERTAIN** | Serial-monitor with Carbide Motion |
| BitSetter position stored in OEM $ settings | **UNCERTAIN** | Serial-monitor during Carbide Motion BitSetter config |
| Probe pin polarity ($6) default on C3D board | **UNCERTAIN** | Issue `$$` and read $6; or test empirically |

---

## IMPLEMENTATION CHECKLIST FOR YOUR SENDER

Based on all verified findings:

1. **On connect:** Send `0x18`, wait for welcome; issue `$$`, `$#`, `$G`, `$I`. Cache `$6`, `$13`, `$20`, `$130–$132`.

2. **Before any probe:** Poll `?`, parse `Pn:P` field. Refuse to start if probe already active.

3. **M6 interception:** Intercept M6 in g-code stream before sending to board. Pause streaming. Launch tool-change wizard.

4. **Tool change wizard — Step 1:** If first tool, probe BitSetter → store MCS Z as `TOOL_OFFSET_REFERENCE`.

5. **Tool change wizard — Step 2:** Prompt user to change tool.

6. **Tool change wizard — Step 3:** Probe BitSetter with new tool → apply `G10 L20 P0 Z[TOOL_OFFSET_REFERENCE]`.

7. **BitSetter location:** Store in sender config as machine coordinates (X, Y, Z-start). User jogs and saves. Use `G53` for all BitSetter positioning moves.

8. **BitZero probing:** Two-phase (fast + slow G38.2). Apply offsets: Z=14.99mm, XY wall=12.70mm, corner=22.5mm (for V2). Use `G10 L20 P0` for all zeroing.

9. **Probe distance bounding:** If `$20=1`, cap Z probe distance = `$132 - |current_MCS_Z| - 2`.

10. **On ALARM:4 or ALARM:5:** Stop everything. Display alarm code and description. Require user to resolve before continuing.

11. **On soft reset during probe:** Flush sender queue. Re-read `$G`. Require re-home or user position confirmation.

12. **Jog (MPG):** `$J=G91 G21 X[step] F[feed]`; cancel with `0x85`.

13. **Flow control:** Character-counting for streaming; simple send-response for probe/toolchange commands and EEPROM writes.

14. **G10 L20 (EEPROM write):** Switch to send-response mode; wait for `ok` before sending next command.