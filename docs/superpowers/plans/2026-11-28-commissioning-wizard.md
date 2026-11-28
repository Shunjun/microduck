# Guided Commissioning Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [x]`) syntax for tracking.

**Goal:** Validate servo serial communication, capture a reference pose before directions/limits, guide joint calibration with model-only movement, and adjust follow output in the UI.

**Architecture:** robotd owns all bus access and persists the raw standard-pose sample separately from final software zero. The frontend validates a real servo response rather than normal-policy readiness. Direction evidence and measured endpoints generate calibration; mirrored legs use their own captured reference and model mirror sign, with inferred results clearly labelled and editable.

**Tech Stack:** Rust, Axum IPC, React, shadcn, Tailwind, existing CAD preview.

**Spec:** User-approved flow in conversation; mechanism document is docs/design/servo-studio.md.

## Global Constraints

- IMU controls and final completeness checks remain available with existing behavior.
- No development services except debugging; do not write test parameters or motions to hardware.
- Unknown limits must not enable arbitrary moves or home; initial low-output follow only tracks measured positions.
- Preview demonstrates virtual angles only; direction labels are 正向 / 反向, position angles use smaller secondary text.
- Follow defaults to 250/1000, slider writes on commit, verified readback precedes any increased output.
- Persist raw reference samples on the device; no final zero assumptions before direction is known.
- Props with more than three members use named interfaces. No page-specific global CSS.

## Review Focus

- No servos, stale feedback, or port change must invalidate serial validation.
- First capture must work with no directions or limits, and survive a daemon restart.
- A failed/rejected reference or calibration write must not advance the wizard.
- Mirroring must use each leg's own encoder reference and preserve unknown metadata.
- Bus faults must cancel follow, attempt unloading, and never silently increase an output ceiling.

## Tasks

- [x] Add backend reference capture, evidence-based joint configuration, and live follow ceiling requests. Add regression tests first.
- [x] Add frontend commissioning helpers and tests for handshake, direction evidence, angle labels, and mirrored ranges.
- [x] Replace first three wizard stages, retain IMU/final checks, and add existing shadcn slider for follow output.
- [x] Run Rust tests/checks, frontend tests/build, and inspect the debug preview using an isolated browser test if available.
- [x] Update protocol version, owning mechanism documentation, and embedded frontend bundle. Do not commit or deploy without request.

## Validation ledger

- Backend tests cover raw reference capture/restart, zero-independent limits, inferred mirroring, live caps, zero-percent unloading, and cap restoration/failures.
- Frontend tests and production build pass; the existing color theme and shadcn components are retained.
- Local isolated fake robotd/Studio browser check: serial verification unlocks Next, default follow is selected, raw pose saves before direction/limits, selected virtual joint animates, and the 0% slider unloads. Browser console has no errors. Debug services and tab were closed afterwards.
- Whole-branch static review found no actionable correctness issue; hardware motion was not tested or deployed.
