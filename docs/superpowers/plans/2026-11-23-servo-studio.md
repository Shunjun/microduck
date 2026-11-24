# Servo Studio Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add a Rust web control package with HD1910 debugging and pose-based calibration.
**Architecture:** robotd remains the only serial owner. Debug requests are queued by RPC and executed on its control thread. studio serves embedded local assets and proxies a bounded debug API. Commissioning startup supports incomplete calibration without requiring IMU.
**Tech Stack:** Rust, Axum, Tokio, browser JavaScript/Canvas, existing duck mesh.
**Spec:** docs/superpowers/specs/2026-11-23-servo-studio-design.md (user revisions supersede initial serial takeover proposal).

## Global Constraints
- Shared UART is owned only by robotd; no development service starts except isolated debugging.
- No unverified safe limits or direction invented. Calibration changes software zero_ticks only.
- Rust 1.89+ and no APIs newer than 1.94.1. Compatibility comments use //Compatible.
- Calibration page always displays the fixed standard reference, not measured pose.
- Enter debug pauses normal outputs. Leaving debug stays relaxed and requires explicit normal re-enable.

## Review Focus
- Stale feedback must never be captured or presented as a successful motion.
- Nonzero reference angles and invalid directions/limits must be checked before any writes.
- Command errors must be acknowledged as errors rather than queued success.
- An incomplete calibration may be drafted but must not become a valid motion profile accidentally.
- Normal commands must not race debug control or leave an active policy after debug exit.

### Task 1: Device debug boundary
Files: duck-control/src/servo_debug.rs; feetech1910/debug.rs; io.rs; driver.rs; config.rs.
- [x] Test range checks, partial feedback and raw readback without requiring IMU.
- [x] Add typed per-joint raw feedback/settings and restricted commands; implement real HD1910 and fake devices.
- [x] Test standard-pose calibration calculation with nonzero reference angle and configuration preservation.

### Task 2: robotd owner-thread integration
Files: robotd/src/servo_debug.rs, main.rs, hardware.rs; duck-ipc-proto/src/lib.rs.
- [x] Add queued debug enter/exit/state operations, softened hold/follow, bounded moves and capture/save.
- [x] Add commissioning startup with missing calibration and no IMU dependency.
- [x] Pause all normal output while debug owns control; reject normal robot intent requests except stop/relax.
- [x] Test transition and error behavior, capture stability and atomic configuration saving.

### Task 3: Rust web package
Files: studio/Cargo.toml, src/{main,lib,rpc}.rs, web/{index.html,app.js,preview.js,style.css}, README.md; workspace/docs registry.
- [x] Proxy only debug RPC, ship all resources locally and serve existing duck mesh.
- [x] Build joint readback/editor, tuning controls and zero-reference calibration workflow.
- [x] Implement local 3D mesh posing with measured and fixed-reference views.
- [x] Run unit tests, Linux compilation, formatting and isolated simulated UI checks.

Validation: 473 tests passed across duck-control/protocol/robotd/studio before final transition additions; eight focused debug tests passed after transition fixes. Linux ARM64 check passed for robotd/studio. btd/mediad/robotctl/updater consumer check passed. Native configd has an existing CLOCK_BOOTTIME portability error; cross-check requires uncached async-broadcast dependency. Browser simulation exercised enter/follow/capture/save/body-IMU save/home and desktop/mobile layouts with no JS errors. No real motion or deployment. Hardware read-only check found Orange Pi physical 3/5 I2C0 disabled; see feetech-hardware.md.
