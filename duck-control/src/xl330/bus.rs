//! XL330 hardware driver entry point (Dynamixel Protocol 2.0).
//!
//! One combined `sync_read` per tick covering the IMU board and all 15 servos, and one
//! `sync_write` of goal positions. The IMU is listed first so it answers before the servo
//! burst.
//!
//! Every sync read here is a **fast** sync read (protocol 2.0 instruction 0x8A): the devices
//! append their answers to one status packet from the broadcast id instead of each sending
//! its own, which drops fifteen packet headers and fifteen bus turnarounds from the tick.
//! `bus.fast_sync_read` in `robotd.toml` turns it off for a robot whose devices do not
//! implement the instruction. See [`open_controller`].
//!
//! Battery and thermals are the one thing that does not fit that shape: they live at registers
//! outside the block the tick fetches, so [`RobotIo::slow_sensors`] is a transaction of its
//! own, meant to be called about once a second rather than every tick.
//!
//! Written against `rustypot`, but the *numbers* — conversion factors and the EEPROM
//! registers asserted at startup — come from `microduck_runtime`, where they were arrived
//! at against real hardware. See [`super::config`].

#[cfg(test)]
use std::f64::consts::PI;
use std::time::Duration;

use rustypot::servo::dynamixel::xl330::Xl330Controller;

use super::config::{
    BAUD_RATE, CURRENT_LIMIT_MA, EEPROM_SETTLE, EXPECTED_REGISTERS, FACTORY_BAUD_RATE, FACTORY_ID,
    IMPACT_GUARD_ENABLE_ADDR, IMPACT_GUARD_ENABLE_FIRMWARE, ImpactGuard, JOINT_IDS, READ_TIMEOUT,
    REBOOT_SETTLE, homing_offset,
};
#[cfg(test)]
use super::config::{RAD_PER_SEC_PER_COUNT, READ_LEN};
use super::imu::{DEFAULT_MOUNT, IMU_DXL_ID, StaleImuTracker};
#[cfg(test)]
use super::imu::{IMU_BLOCK_LEN, STALE_RUN_WARN};
#[cfg(test)]
use crate::io::ImuStale;
use crate::io::{IoError, JointTargets, Result, RobotIo};
use crate::model::{JOINT_NAMES, NUM_JOINTS};
use crate::sflp::SflpDecoder;

pub struct DynamixelIo {
    pub(super) controller: Xl330Controller,
    /// Kept so the port can be reopened at the factory baud rate: `rustypot` owns the serial
    /// handle outright and offers no way to change its speed in place.
    port: String,
    /// IMU first, then the servos in [`JOINT_IDS`] order — the order blocks come back in.
    pub(super) ids: Vec<u8>,
    /// Kept for the same reason as `port`: [`Self::reopen`] builds a new controller, and one
    /// built without this would silently drop back to a plain sync read for the rest of the
    /// process — a motor swap quietly halving the tick's bus budget.
    fast_sync_read: bool,
    /// `bus.impact_guard*`: the settings the register check asserts on the guard's firmwares.
    impact_guard: ImpactGuard,
    /// Servos on [`IMPACT_GUARD_ENABLE_FIRMWARE`], found by the register check: every torque on
    /// sets their guard switch first.
    guard_switch: Vec<u8>,
    pub(super) imu: SflpDecoder,
    /// Blocks identical to their predecessor. The read succeeded but the board handed back
    /// the same sample, which means the policy is being fed dead orientation data — a
    /// failure that is invisible unless someone counts it. Known to happen.
    pub(super) stale_imu: StaleImuTracker,
}

impl DynamixelIo {
    /// Open the bus. `fast_sync_read` is `bus.fast_sync_read` from `robotd.toml` — see
    /// [`open_controller`] for what it costs to have wrong.
    pub fn open(port: &str, fast_sync_read: bool) -> Result<Self> {
        let controller = open_controller(port, BAUD_RATE, fast_sync_read)?;

        let mut ids = Vec::with_capacity(NUM_JOINTS + 1);
        ids.push(IMU_DXL_ID);
        ids.extend_from_slice(&JOINT_IDS);

        Ok(Self {
            controller,
            port: port.to_owned(),
            ids,
            fast_sync_read,
            impact_guard: ImpactGuard::DEFAULT,
            guard_switch: Vec::new(),
            imu: SflpDecoder::new(DEFAULT_MOUNT),
            stale_imu: StaleImuTracker::default(),
        })
    }

    /// The impact guard settings `robotd.toml` asks for: [`ImpactGuard::DEFAULT`] unless told
    /// otherwise, or [`ImpactGuard::OFF`]. Applied by [`Self::check_registers`], so call it before.
    pub fn set_impact_guard(&mut self, guard: ImpactGuard) {
        self.impact_guard = guard;
    }

    /// The body IMU's sensor→trunk mount, which is the robot's ([`DEFAULT_MOUNT`]
    /// for a `zero3`, [`super::imu::BETA_MOUNT`] for a `beta`). Starts the decoder afresh, so
    /// call it right after [`Self::open`], before the first read.
    pub fn set_imu_mount(&mut self, mount: [f64; 4]) {
        self.imu = SflpDecoder::new(mount);
    }

    /// Assert — and correct — the EEPROM registers the control loop depends on.
    ///
    /// Returns how many needed fixing. A servo that has been factory-reset or swapped in
    /// arrives with `return_delay_time = 250`, which alone would eat 40% of the tick
    /// budget across the bus. Checking costs one read per register at startup and removes
    /// a whole class of "why is it slow on this robot".
    pub fn check_registers(&mut self) -> Result<usize> {
        let mut fixed = 0;
        for &id in &JOINT_IDS {
            fixed += self.check_registers_of(id)?;
        }
        Ok(fixed)
    }

    /// [`Self::check_registers`] for one servo.
    fn check_registers_of(&mut self, id: u8) -> Result<usize> {
        let mut fixed = 0;
        for &(name, want) in EXPECTED_REGISTERS {
            // rustypot returns a Vec even for a single-id read. An empty one means the
            // servo did not answer, which must not be read as "register is fine".
            let raw = match name {
                "return_delay_time" => self.controller.read_return_delay_time(id),
                "baud_rate" => self.controller.read_baud_rate(id),
                "pwm_slope" => self.controller.read_pwm_slope(id),
                "shutdown" => self.controller.read_shutdown(id),
                other => unreachable!("unhandled register {other}"),
            }
            .map_err(|e| IoError::Bus(format!("read {name} on {id}: {e}")))?;

            let got = *raw.first().ok_or(IoError::ShortRead {
                what: "register read",
                expected: 1,
                got: 0,
            })?;

            if got == want {
                continue;
            }
            tracing::warn!(id, register = name, got, want, "correcting motor register");
            match name {
                "return_delay_time" => self.controller.write_return_delay_time(id, want),
                "baud_rate" => self.controller.write_baud_rate(id, want),
                "pwm_slope" => self.controller.write_pwm_slope(id, want),
                "shutdown" => self.controller.write_shutdown(id, want),
                other => unreachable!("unhandled register {other}"),
            }
            .map_err(|e| IoError::Bus(format!("write {name} on {id}: {e}")))?;
            std::thread::sleep(EEPROM_SETTLE);
            fixed += 1;
        }

        // An EEPROM register like the others, so it is written only with torque off, which is how
        // a servo powers up and how a fresh one is adopted.
        let want = homing_offset(id);
        let got = *self
            .controller
            .read_homing_offset(id)
            .map_err(|e| IoError::Bus(format!("read homing_offset on {id}: {e}")))?
            .first()
            .ok_or(IoError::ShortRead {
                what: "register read",
                expected: 1,
                got: 0,
            })?;
        if got != want {
            tracing::warn!(
                id,
                register = "homing_offset",
                got,
                want,
                "correcting motor register"
            );
            self.controller
                .write_homing_offset(id, want)
                .map_err(|e| IoError::Bus(format!("write homing_offset on {id}: {e}")))?;
            std::thread::sleep(EEPROM_SETTLE);
            fixed += 1;
        }

        let got = *self
            .controller
            .read_current_limit(id)
            .map_err(|e| IoError::Bus(format!("read current_limit on {id}: {e}")))?
            .first()
            .ok_or(IoError::ShortRead {
                what: "register read",
                expected: 1,
                got: 0,
            })?;
        if got != CURRENT_LIMIT_MA {
            if self.torque_on(id)? {
                tracing::warn!(
                    id,
                    register = "current_limit",
                    got,
                    want = CURRENT_LIMIT_MA,
                    "torque is on; correcting at the next start"
                );
            } else {
                tracing::warn!(
                    id,
                    register = "current_limit",
                    got,
                    want = CURRENT_LIMIT_MA,
                    "correcting motor register"
                );
                self.controller
                    .write_current_limit(id, CURRENT_LIMIT_MA)
                    .map_err(|e| IoError::Bus(format!("write current_limit on {id}: {e}")))?;
                std::thread::sleep(EEPROM_SETTLE);
                // Position control caps the current at Goal Current, which takes Current Limit
                // only at boot or on a mode change: without this the new limit waits for the
                // next power cycle.
                self.controller
                    .write_goal_current(id, CURRENT_LIMIT_MA as i16)
                    .map_err(|e| IoError::Bus(format!("write goal_current on {id}: {e}")))?;
                fixed += 1;
            }
        }

        // The guard's settings exist only on its firmware: elsewhere these addresses are unused.
        let firmware = *self
            .controller
            .read_firmware_version(id)
            .map_err(|e| IoError::Bus(format!("read firmware_version on {id}: {e}")))?
            .first()
            .ok_or(IoError::ShortRead {
                what: "register read",
                expected: 1,
                got: 0,
            })?;
        // A swapped-in servo is checked again under the same id, maybe on another firmware.
        self.guard_switch.retain(|&s| s != id);
        if firmware == IMPACT_GUARD_ENABLE_FIRMWARE {
            self.guard_switch.push(id);
        }
        if self.impact_guard.written_to(firmware) {
            for (addr, want) in self.impact_guard.blocks() {
                let got = self
                    .controller
                    .read_raw_data(id, addr, want.len() as u8)
                    .map_err(|e| IoError::Bus(format!("read impact guard {addr} on {id}: {e}")))?;
                if got == want {
                    continue;
                }
                if self.torque_on(id)? {
                    tracing::warn!(
                        id,
                        addr,
                        ?got,
                        ?want,
                        "impact guard: torque is on; setting it at the next start"
                    );
                    continue;
                }
                tracing::warn!(id, addr, ?got, ?want, "setting the impact guard");
                self.controller
                    .write_raw_data(id, addr, want.to_vec())
                    .map_err(|e| IoError::Bus(format!("write impact guard {addr} on {id}: {e}")))?;
                std::thread::sleep(EEPROM_SETTLE);
                fixed += 1;
            }
        }
        Ok(fixed)
    }

    /// Whether `id` has torque on, which makes it refuse an EEPROM write.
    ///
    /// The first start on a new EEPROM value is usually an update restarting `robotd` under a
    /// standing robot. Cutting torque would drop the robot, and failing the check would hold the
    /// loop off the bus: such a write waits for the next start with the servos limp instead.
    fn torque_on(&mut self, id: u8) -> Result<bool> {
        self.controller
            .read_torque_enable(id)
            .map_err(|e| IoError::Bus(format!("read torque_enable on {id}: {e}")))?
            .first()
            .copied()
            .ok_or(IoError::ShortRead {
                what: "register read",
                expected: 1,
                got: 0,
            })
    }

    /// The expected servo IDs that do not answer a ping, in [`JOINT_IDS`] order.
    ///
    /// Fifteen pings, each bounded by [`READ_TIMEOUT`], so about half a second when the servos
    /// are unpowered and a few milliseconds when they are not. Run at startup, where this is what
    /// decides whether [`Self::adopt_replacement`] has anything to do, and by
    /// [`RobotIo::census`] when a running loop's reads start failing — never on a tick.
    pub fn missing_servos(&mut self) -> Result<Vec<u8>> {
        let mut missing = Vec::new();
        for &id in &JOINT_IDS {
            let answered = self
                .controller
                .ping(id)
                .map_err(|e| IoError::Bus(format!("ping {id}: {e}")))?;
            if !answered {
                missing.push(id);
            }
        }
        Ok(missing)
    }

    /// Does the IMU board answer a ping?
    ///
    /// Asked apart from [`Self::missing_servos`] because the census covers servos only, and a
    /// silent IMU board otherwise surfaces as the first [`RobotIo::read`] failing — which, from
    /// outside, looks exactly like no robot at all.
    pub fn imu_answers(&mut self) -> Result<bool> {
        self.controller
            .ping(IMU_DXL_ID)
            .map_err(|e| IoError::Bus(format!("ping imu {IMU_DXL_ID}: {e}")))
    }

    /// Flash a factory-fresh servo so it takes the place of the one that is missing.
    ///
    /// A new XL330 answers as ID 1 at 57 600 baud. Neither is used on this bus, so when exactly
    /// one expected servo is silent the new one can be found, given the missing ID, switched to
    /// the bus's speed, and then handed the same EEPROM check every other servo gets. That is
    /// the whole of a motor swap: nobody has to run a configuration tool first.
    ///
    /// The servo is rebooted at the end, deliberately. A servo flashed this way comes out of it
    /// with its hardware-error alert set (the observation behind this whole path), and that
    /// alert holds torque off until the servo is power-cycled or rebooted. Rebooting here means
    /// the servo that comes out of this is indistinguishable from one that was always there.
    ///
    /// Returns `Ok(false)` when nothing answers at the factory defaults: the servo is simply
    /// missing, or was replaced by one that is not fresh. The bus is back at [`BAUD_RATE`]
    /// either way, so the caller can keep waiting on it.
    pub fn adopt_replacement(&mut self, id: u8) -> Result<bool> {
        let name = JOINT_IDS
            .iter()
            .position(|&j| j == id)
            .map(|i| JOINT_NAMES[i])
            .ok_or_else(|| IoError::Bus(format!("{id} is not a joint id")))?;

        // A servo that was already re-flashed to 1 Mbps but kept its ID is the one case where
        // reopening the port would lose it; look at this speed first.
        let baud = if self.ping_fresh()? {
            BAUD_RATE
        } else {
            self.reopen(FACTORY_BAUD_RATE)?;
            if !self.ping_fresh()? {
                self.reopen(BAUD_RATE)?;
                return Ok(false);
            }
            FACTORY_BAUD_RATE
        };
        tracing::warn!(
            id,
            joint = name,
            found_at_baud = baud,
            "factory-fresh servo on the bus; flashing it as the missing joint"
        );

        // ID first, then the baud rate: the servo answers the second write at the old speed
        // and switches only afterwards, so both are acknowledged. The other order would need
        // a reopen between the two writes for nothing.
        self.controller
            .write_id(FACTORY_ID, id)
            .map_err(|e| IoError::Bus(format!("write id {id} on {FACTORY_ID}: {e}")))?;
        std::thread::sleep(EEPROM_SETTLE);
        if baud != BAUD_RATE {
            let want = EXPECTED_REGISTERS
                .iter()
                .find(|(n, _)| *n == "baud_rate")
                .map(|&(_, v)| v)
                .expect("baud_rate is an expected register");
            self.controller
                .write_baud_rate(id, want)
                .map_err(|e| IoError::Bus(format!("write baud_rate on {id}: {e}")))?;
            std::thread::sleep(EEPROM_SETTLE);
            self.reopen(BAUD_RATE)?;
        }

        // Now an ordinary servo at the right address: the same check the others get pins
        // return_delay_time and the rest.
        let fixed = self.check_registers_of(id)?;

        RobotIo::reboot(self, id)?;
        std::thread::sleep(REBOOT_SETTLE);
        let back = self
            .controller
            .ping(id)
            .map_err(|e| IoError::Bus(format!("ping {id} after reboot: {e}")))?;
        if !back {
            return Err(IoError::Bus(format!(
                "servo {id} ({name}) was flashed but did not come back from its reboot"
            )));
        }
        // The reboot exists to clear this; say so if it did not, because a servo that keeps
        // its alert will hold torque off and the symptom — one limp joint — points nowhere.
        let hardware_error = self
            .controller
            .read_hardware_error_status(id)
            .map_err(|e| IoError::Bus(format!("read hardware_error_status on {id}: {e}")))?
            .first()
            .copied()
            .unwrap_or(0);
        if hardware_error != 0 {
            tracing::error!(
                id,
                joint = name,
                hardware_error,
                "replacement servo still reports a hardware error after its reboot"
            );
        }
        tracing::warn!(
            id,
            joint = name,
            registers_fixed = fixed,
            "replacement servo adopted"
        );
        Ok(true)
    }

    /// Does anything answer at the factory ID, at whatever speed the port is open at?
    fn ping_fresh(&mut self) -> Result<bool> {
        self.controller
            .ping(FACTORY_ID)
            .map_err(|e| IoError::Bus(format!("ping factory id {FACTORY_ID}: {e}")))
    }

    /// Close the port and open it again at `baud`.
    ///
    /// The old handle has to be gone first: `serialport` opens ttys exclusively, so opening a
    /// second handle while the first lives fails with `EBUSY`. Hence the placeholder controller
    /// — one with no port, never used — standing in while the real one is dropped.
    fn reopen(&mut self, baud: u32) -> Result<()> {
        self.controller = Xl330Controller::new();
        self.controller = open_controller(&self.port, baud, self.fast_sync_read)?;
        Ok(())
    }

    /// Present positions only — a lighter read than [`RobotIo::read`], used once at startup
    /// to adopt the pose the robot is already in.
    pub fn present_positions(&mut self) -> Result<[f64; NUM_JOINTS]> {
        let values = self
            .controller
            .sync_read_present_position(&JOINT_IDS)
            .map_err(|e| IoError::Bus(format!("read present positions: {e}")))?;
        if values.len() != NUM_JOINTS {
            return Err(IoError::ShortRead {
                what: "present positions",
                expected: NUM_JOINTS,
                got: values.len(),
            });
        }
        let mut out = [0.0; NUM_JOINTS];
        out.copy_from_slice(&values);
        Ok(out)
    }

    /// Torque on every servo.
    ///
    /// One transaction per joint, so this is not something to call per tick — the control loop calls
    /// it once, when someone enables the policy on a limp robot. See [`RobotIo::set_torque`] for what
    /// has *not* changed: nothing touches torque because a process started.
    ///
    /// **Every servo is written, whatever the others said.** Fourteen acknowledged transactions
    /// in a row, and one dropped ack used to end the loop there — which for `on = false` on the
    /// way to a power-off meant a robot that sat down and switched off with half its legs still
    /// locked, because the tick that saw the error was the last one that could have retried.
    /// Writing the rest costs the same as it would have, and the error names every joint that
    /// did not answer so the caller can decide whether to ask again.
    ///
    /// **Torque on sets a V4 servo's guard switch first**, to what `bus.impact_guard` asks
    /// ([`ImpactGuard::enable`]). Its switch is off after every power-up and every start of its
    /// firmware, and whether a reboot, torque off or a latched error also clears it is unknown;
    /// every one of those ends limp, so torque on is the one moment that covers them all. A servo
    /// still stiff after a `robotd` restart takes the write too. Written either way, because a
    /// switch left on by an earlier run survives a `robotd` restart.
    pub fn set_torque(&mut self, on: bool) -> Result<()> {
        let mut failed = Vec::new();
        if on {
            let enable = self.impact_guard.enable();
            for &id in &self.guard_switch {
                if let Err(e) =
                    self.controller
                        .write_raw_data(id, IMPACT_GUARD_ENABLE_ADDR, vec![enable])
                {
                    failed.push(format!("impact guard enable on {id}: {e}"));
                }
            }
        }
        for &id in &JOINT_IDS {
            if let Err(e) = self.controller.write_torque_enable(id, on) {
                failed.push(format!("torque {on} on {id}: {e}"));
            }
        }
        if failed.is_empty() {
            Ok(())
        } else {
            Err(IoError::Bus(failed.join("; ")))
        }
    }

    /// Ramp every joint from where it is now to `target`, linearly.
    ///
    /// Only ever called by an explicit `init` — the control loop must never move the robot
    /// on its own, because that would make an update restart a fall risk. Blocking, and
    /// deliberately so: nothing else should be talking to the bus while this runs.
    pub fn interpolate_to(
        &mut self,
        target: &[f64; NUM_JOINTS],
        duration: Duration,
        step: Duration,
    ) -> Result<()> {
        let start = self.present_positions()?;
        let steps = (duration.as_secs_f64() / step.as_secs_f64())
            .ceil()
            .max(1.0) as u32;
        for i in 1..=steps {
            let t = i as f64 / steps as f64;
            let mut next = [0.0; NUM_JOINTS];
            for j in 0..NUM_JOINTS {
                next[j] = start[j] + (target[j] - start[j]) * t;
            }
            self.write(&JointTargets::new(next))?;
            std::thread::sleep(step);
        }
        Ok(())
    }
}

/// The serial port at `baud`, wrapped in a Protocol 2 controller.
///
/// `with_fast_sync_read` routes every `sync_read_*` through instruction 0x8A, so it covers
/// the tick's combined read, [`RobotIo::slow_sensors`] and [`DynamixelIo::present_positions`]
/// without any of them naming it. The saving is a packet header and a turnaround — the
/// device's `return_delay_time`, which [`EXPECTED_REGISTERS`] pins low precisely because it
/// is paid per device — for each of the sixteen devices on the bus.
///
/// It is all or nothing: one status packet carries every block, so a device whose firmware
/// does not implement 0x8A does not answer and the whole read times out. That is the same
/// shape of failure a silent servo already causes on a plain sync read, and the tick coasts
/// over a dropped read either way. XL330 firmware needs to be v46 or newer, and the
/// `imu_to_dxl` board is `id 200` on this bus and has to implement it too — which is a
/// property of a robot's hardware and the reason `fast_sync_read` is a setting at all rather
/// than something this code decides.
///
/// Nothing here probes for support. A device that does not answer looks exactly like one that
/// is unpowered, and a startup probe would have to tell those apart to say anything useful —
/// so the answer is a key someone turns off, not a guess this code makes every boot.
fn open_controller(port: &str, baud: u32, fast_sync_read: bool) -> Result<Xl330Controller> {
    let serial = serialport::new(port, baud)
        .timeout(READ_TIMEOUT)
        .open()
        .map_err(|e| IoError::Port {
            path: port.to_owned(),
            source: std::io::Error::other(e),
        })?;
    let controller = Xl330Controller::new().with_protocol_v2();
    let controller = if fast_sync_read {
        controller.with_fast_sync_read()
    } else {
        controller
    };
    Ok(controller.with_serial_port(serial))
}

/// Which servo a factory-fresh one should become, given the IDs that did not answer.
///
/// Only an unambiguous answer is one: with two servos silent there is no telling which of them
/// the new one replaces, and guessing would flash a leg joint as a neck joint. With none silent
/// there is nothing to adopt — a stray fresh servo on a complete bus is not this code's problem.
pub fn replacement_target(missing: &[u8]) -> Option<u8> {
    match missing {
        [one] => Some(*one),
        _ => None,
    }
}

#[cfg(test)]
#[path = "tests.rs"]
mod tests;
