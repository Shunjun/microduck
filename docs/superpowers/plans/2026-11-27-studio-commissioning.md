# Studio commissioning and standard components implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans to implement task-by-task.

**Goal:** Complete the user's authorized first-install calibration, runtime hardware settings, and full shadcn/Tailwind Studio migration, retaining individual zero fine-tuning.

**Architecture:** robotd owns all hardware and persisted settings. A control-thread supervisor safely unloads and reopens the bus when the configured port changes; the IPC thread stays responsive. Studio is React/Vite with genuine shadcn components, Tailwind tokens preserving the companion visual direction, and the existing WebGL/media engines reused without old DOM page mounts. Rust embeds checked-in generated frontend output; build scripts and CI rebuild it explicitly.

**Tech Stack:** Rust/Axum, React, TypeScript, Vite, Tailwind, shadcn/ui.

**Spec:** User requirements recorded in this conversation; mechanism documentation is `docs/design/servo-studio.md` and `docs/design/feetech-hardware.md`.

## Global constraints
- Do not deploy, push, publish, or commit. Preserve existing changes, including individual zero editing and commissioning startup regression fix.
- Never start development servers except isolated debugging; never command real hardware during verification.
- Keep original --port support, remove our --servo-debug CLI flag. Main installed service has no --port argument.
- Explicit CLI --port is effective across restarts and locks webpage/backend port editing. Show both configured and effective ports.
- Missing/invalid calibration automatically uses commissioning IO, no ordinary policy or movement. Wrong/missing ports must not strand config requests.
- Configuration is persisted via existing layered params editor. Save/reopen is distinct from successful bus communication; UI must show failures honestly.
- Normal and limp P are separate persisted values. Hold/follow debug P is separate and temporary. Follow uses existing behavior.
- Wizard: hardware -> read servos -> directions/limits -> standard pose capture/save -> separate body IMU -> explicit finish. Never automatically start normal motion.
- Calibration preview is fixed DEFAULT_POSITION. Per-joint zero fine-tuning and Home remain available after capture.
- Do not invent physical unit conversions or IMU mounting direction. Allow explicit entry for missing required speed/current units; explain blocked finish.
- Preserve control joystick deadman/disconnect behavior, real telemetry, camera lifecycle, action upload/edit/register, policies, autonomous entry only.
- React props with more than 3 properties use named types. Global CSS only shared tokens/base; use Tailwind for page/component layout.
- Add //Compatible only where genuinely adapting existing mechanisms. No old-version fallback branches. Update IPC to 72 and update Studio together.

## Shared interface (fixed for parallel implementation)
`robot.hardware` result retains active_driver/configured_driver/restart_required and adds:
- configured_port: string, effective_port: string, port_override: boolean
- ports: [{path: string, accessible: boolean}]
- normal_p: number, limp_p: number
- calibration_required: boolean, calibration_error: string|null
- bus_status: string (waiting/reconfiguring/ready/error), bus_error: string|null
`robot.setHardware` retains servo_driver string and adds optional port:string, normal_p:u16, limp_p:u16. Backend validates before any write, atomically saves params, requests safe reopen for port or gains; a different driver defers the whole hardware transaction until restart_required is resolved (port/gains are validated for the selected target and never sent through the old protocol).
`/api/debug` retains all existing operations, adds `units` with speed_rad_s_per_unit:f64 and current_ma_per_unit:f64, and `finish`. Status adds optional speed_rad_s_per_unit/current_ma_per_unit and calibration_required:boolean, calibration_error:string|null. Finish validates complete calibration, unloads and requests reopening normal IO, clears intents; no automatic enable. Existing set_zero contract stays unchanged.

## Review focus
- Port edited while initial bus open retries -> config still works and old port is released before new open.
- CLI override -> backend rejects editing and UI displays lock explanation.
- Failed save/reopen -> do not report hardware ready or resume old commands.
- Wizard incomplete IMU/units/directions -> finish refuses with actionable error, no motion.
- Route changes/disconnect/reconnect -> no joystick replay, no leaked camera/preview subscriptions.

### Task 1: Runtime settings and automatic commissioning
Files: robotd/src/main.rs, robotd/src/servo_debug.rs, new focused runtime helper if appropriate, duck-ipc-proto/src/lib.rs and affected route tests.
- [x] Add failing tests for auto commissioning selection, CLI override rejection, atomic multi-field settings validation, port change signaling, finish validation and no output.
- [x] Implement the shared contract, control-thread reconfiguration, automatic commissioning, port enumeration, gain settings and explicit finish/units.
- [x] Run targeted Rust tests, compile host; account for Linux cfg branches through code review/target checks where available.

### Task 2: Full Studio frontend migration
Files: studio/frontend/** (React app, focused page/components, package lock and actual shadcn CLI generated components), studio/web-dist/** (built output); old engine files reused as engine modules or copied with attribution.
- [x] Initialize real shadcn/Tailwind frontend via CLI; read skill docs and component docs. Preserve visual direction.
- [x] Implement all existing pages using standard components, shared typed API, explicit config page, onboarding wizard and individual zero editor.
- [x] Use the shared hardware/debug contract above (API72); protect port edits under CLI override, distinguish saved/active/bus error.
- [x] Test meaningful pure behavior and build/typecheck. Do not alter Rust or deployment files; report asset filenames and build command.

### Task 3: Integration, install migration, documentation and validation
Files: studio/src/lib.rs, packaging/workflows/dev scripts, installer hooks and owned docs.
- [x] Embed built React assets and retain binary mesh/API routes; stop serving old DOM page entrypoints. Ensure ordinary Cargo builds offline with checked-in assets.
- [x] Build frontend explicitly in release/dev/local packaging paths. Test artifact generation.
- [x] Migrate ONLY known manually added commissioning.conf containing --servo-debug, preserving its effective --port into persistent params, removing obsolete CLI override without deleting arbitrary operator drop-ins. Back up migrated file. Base installed ExecStart never includes --port.
- [x] Update owned docs for new startup/wizard/config behavior, required simultaneous API72 deploy, frontend build and simulation verification.
- [x] Run relevant Rust/Node checks, review integrated behavior, isolated browser verification on fake IO; clean up all debug processes. Report remaining unverified physical/Linux limitations accurately.

## Completion evidence
- Rust tests for robotd/Studio/proto/btd/mediad/duck-control passed in the isolated verification run; original platform-dependent ignored tests remain ignored.
- robotd-params: 162 passed after recording this fork's already-shipped 180/40 values in the historical template inventory; shared defaults remain 200/50.
- Frontend: TypeScript/Vite production build and 12 Node behavior tests passed; migrated WebRTC signaling regression passed.
- Installer migration: 6 tests passed, including concurrent parameter-lock protection and comment-only legacy flags.
- Fake IPC end-to-end: port handover, atomic validation, single-zero persistence, body IMU/units, pending marker across restart, Finish, and CLI port override passed.
- Browser: first-run waiting tty reaches scan, 15 joints read, standard-pose save and individual-zero edit before IMU verified; only selected ID changed in the saved document. Resumed saved-pose flow and separate IMU save verified. After pausing for the user's IME composition, the final unit inputs and Finish confirmation were exercised in the browser; the complete wizard reached the stopped control page.
- Browser computed styles confirm original primary #de7949, border #e8e2d8, secondary text #88857d; normal inputs/selects/buttons 42px, small buttons34px; compact28px verified on the control page; actual button heights are exactly [28,34,42] and scrollHeight equals viewport height (902px).
- Empty robot.skills responses omit built_in under the current serializer; a shared parser and regression tests preserve a real empty state; the quick list excludes configured defaults when policies are disabled.
- No deployment, push, release or commit performed. Temporary fake services are stopped after final verification.
