//! XL330 implementation of the shared RobotIo control interface.
use super::bus::DynamixelIo;
use super::config::{
    HARDWARE_ERROR_ADDR, IDENTITY_ADDR, IDENTITY_LEN, IMPACT_GUARD_ADDR, JOINT_IDS,
    RAD_PER_SEC_PER_COUNT, READ_ADDR, READ_LEN, SLOW_READ_ADDR, SLOW_READ_LEN, VOLTS_PER_COUNT,
};
use super::imu::{IMU_BLOCK_LEN, STALE_RUN_WARN};
use crate::io::{ImuStale, IoError, JointTargets, Result, RobotIo, Sensors, SlowSensors};
use crate::model::NUM_JOINTS;
use std::f64::consts::PI;

impl RobotIo for DynamixelIo {
    fn read(&mut self) -> Result<Sensors> {
        let blocks = self
            .controller
            .sync_read_raw_data(&self.ids, READ_ADDR, READ_LEN)
            .map_err(|e| IoError::Bus(format!("combined imu+motor sync_read: {e}")))?;

        if blocks.len() != self.ids.len() {
            return Err(IoError::ShortRead {
                what: "sync_read blocks",
                expected: self.ids.len(),
                got: blocks.len(),
            });
        }

        let mut sensors = Sensors::default();

        // Slot 0 is the IMU board.
        if blocks[0].len() == IMU_BLOCK_LEN {
            let mut raw = [0u8; IMU_BLOCK_LEN];
            raw.copy_from_slice(&blocks[0]);
            // Say so, or the counters are numbers nobody ever reads — but only once the run
            // is long enough to mean something. Rate-limited past that because a board which
            // has stopped refreshing produces one of these every single tick, and 50 Hz of
            // identical warnings would evict the journal.
            let run = self.stale_imu.observe(&raw);
            if run == STALE_RUN_WARN || (run > STALE_RUN_WARN && run.is_multiple_of(500)) {
                tracing::warn!(
                    consecutive = run,
                    total = self.stale_imu.stale.total,
                    "imu board has returned the same sample {run} reads running — orientation is frozen"
                );
            }
            sensors.imu = self.imu.decode(&raw);
        } else {
            return Err(IoError::ShortRead {
                what: "imu block",
                expected: IMU_BLOCK_LEN,
                got: blocks[0].len(),
            });
        }

        for (joint, block) in blocks[1..].iter().enumerate() {
            if block.len() != READ_LEN as usize {
                return Err(IoError::ShortRead {
                    what: "motor block",
                    expected: READ_LEN as usize,
                    got: block.len(),
                });
            }
            // [0..2] present_pwm, unused · [2..4] current · [4..8] velocity · [8..12] position
            sensors.currents_ma[joint] = (i16::from_le_bytes([block[2], block[3]]) as f64).abs();
            let velocity = i32::from_le_bytes([block[4], block[5], block[6], block[7]]);
            sensors.velocities[joint] = velocity as f64 * RAD_PER_SEC_PER_COUNT;
            let position = i32::from_le_bytes([block[8], block[9], block[10], block[11]]);
            sensors.positions[joint] = (2.0 * PI * position as f64 / 4096.0) - PI;
        }

        Ok(sensors)
    }

    fn write(&mut self, targets: &JointTargets) -> Result<()> {
        self.controller
            .sync_write_goal_position(&JOINT_IDS, &targets.positions)
            .map_err(|e| IoError::Bus(format!("sync_write goal positions: {e}")))
    }

    fn set_torque(&mut self, on: bool) -> Result<()> {
        // The inherent method, which predates the trait and is still what `robotd init` uses.
        DynamixelIo::set_torque(self, on)
    }

    fn reboot(&mut self, id: u8) -> Result<()> {
        // The status packet is a courtesy the servo may not manage before it resets, so only a
        // failure to send is an error here.
        self.controller
            .reboot(id)
            .map(|_| ())
            .map_err(|e| IoError::Bus(format!("reboot {id}: {e}")))
    }

    fn set_gain(&mut self, kp: u16) -> Result<()> {
        // I and D are written too, at zero — the prototype's `--ki`/`--kd` defaults, which
        // its startup writes to every motor. These are RAM registers, so every power-up
        // restores the servo's factory values, and the factory D gain is not zero: left in
        // place it damps the servo's internal PID, and the robot runs measurably softer
        // than the prototype at the *same* kP. That is not a tuning choice anyone made, so
        // it is pinned here rather than exposed as a knob.
        const KI: u16 = 0;
        const KD: u16 = 0;
        for &id in &JOINT_IDS {
            self.controller
                .write_position_p_gain(id, kp)
                .map_err(|e| IoError::Bus(format!("position_p_gain {kp} on {id}: {e}")))?;
            self.controller
                .write_position_i_gain(id, KI)
                .map_err(|e| IoError::Bus(format!("position_i_gain {KI} on {id}: {e}")))?;
            self.controller
                .write_position_d_gain(id, KD)
                .map_err(|e| IoError::Bus(format!("position_d_gain {KD} on {id}: {e}")))?;
        }
        Ok(())
    }

    /// One `sync_write` to every joint. Goal PWM is RAM and writable with torque on, so this
    /// lands at once, mid-walk, without a reboot — which is why it is Goal PWM and not the
    /// EEPROM PWM Limit, which only reaches Goal PWM at boot.
    fn set_goal_pwm(&mut self, pwm: u16) -> Result<()> {
        self.controller
            .sync_write_goal_pwm(&JOINT_IDS, &[pwm; NUM_JOINTS])
            .map_err(|e| IoError::Bus(format!("sync_write goal_pwm {pwm}: {e}")))
    }

    /// Supply voltage and case temperatures, in one `sync_read` over registers 144–146.
    ///
    /// Voltage is averaged because all 15 servos sit on one pack: a single reading is the
    /// same measurement with more noise. Temperature is *not* averaged here — the caller gets
    /// every joint, because one loaded joint running hot is the case worth seeing and a mean
    /// over fifteen hides it.
    ///
    /// Note that a silent servo does not produce a short answer: `rustypot`'s `sync_read`
    /// waits for every id and fails the whole transaction if one does not reply. So this is
    /// all-or-nothing, and the caller is expected to keep its previous sample rather than
    /// treat one miss as news. The zero filter on voltage guards a device that answers with a
    /// nonsense value, which must not be averaged in as if the pack were half flat.
    fn slow_sensors(&mut self) -> Result<SlowSensors> {
        let blocks = self
            .controller
            .sync_read_raw_data(&JOINT_IDS, SLOW_READ_ADDR, SLOW_READ_LEN)
            .map_err(|e| IoError::Bus(format!("voltage+temperature sync_read: {e}")))?;

        if blocks.len() != NUM_JOINTS {
            return Err(IoError::ShortRead {
                what: "voltage+temperature blocks",
                expected: NUM_JOINTS,
                got: blocks.len(),
            });
        }

        let mut temps_c = [0.0; NUM_JOINTS];
        let mut volts = Vec::with_capacity(NUM_JOINTS);
        for (joint, block) in blocks.iter().enumerate() {
            if block.len() != SLOW_READ_LEN as usize {
                return Err(IoError::ShortRead {
                    what: "voltage+temperature block",
                    expected: SLOW_READ_LEN as usize,
                    got: block.len(),
                });
            }
            // [0..2] present_input_voltage · [2] present_temperature, already in whole °C.
            let counts = u16::from_le_bytes([block[0], block[1]]);
            let v = counts as f64 * VOLTS_PER_COUNT;
            if v > 0.0 {
                volts.push(v);
            }
            temps_c[joint] = block[2] as f64;
        }

        if volts.is_empty() {
            return Err(IoError::ShortRead {
                what: "input voltage",
                expected: NUM_JOINTS,
                got: 0,
            });
        }
        Ok(SlowSensors {
            volts: volts.iter().sum::<f64>() / volts.len() as f64,
            temps_c,
        })
    }

    fn imu_stale(&self) -> ImuStale {
        self.stale_imu.stale
    }

    fn hardware_errors(&mut self) -> Result<Option<[u8; NUM_JOINTS]>> {
        let blocks = self
            .controller
            .sync_read_raw_data(&JOINT_IDS, HARDWARE_ERROR_ADDR, 1)
            .map_err(|e| IoError::Bus(format!("hardware_error_status sync_read: {e}")))?;
        if blocks.len() != NUM_JOINTS {
            return Err(IoError::ShortRead {
                what: "hardware error blocks",
                expected: NUM_JOINTS,
                got: blocks.len(),
            });
        }
        let mut errors = [0u8; NUM_JOINTS];
        for (slot, block) in errors.iter_mut().zip(&blocks) {
            *slot = block.first().copied().unwrap_or(0);
        }
        Ok(Some(errors))
    }

    fn impact_guard(&mut self) -> Result<Option<[u8; NUM_JOINTS]>> {
        let blocks = self
            .controller
            .sync_read_raw_data(&JOINT_IDS, IMPACT_GUARD_ADDR, 1)
            .map_err(|e| IoError::Bus(format!("impact guard state sync_read: {e}")))?;
        if blocks.len() != NUM_JOINTS {
            return Err(IoError::ShortRead {
                what: "impact guard blocks",
                expected: NUM_JOINTS,
                got: blocks.len(),
            });
        }
        // Strict, unlike the alerts: an empty block read as 0 would say "armed" about a servo
        // that did not answer.
        let mut states = [0u8; NUM_JOINTS];
        for (slot, block) in states.iter_mut().zip(&blocks) {
            *slot = *block.first().ok_or(IoError::ShortRead {
                what: "impact guard block",
                expected: 1,
                got: 0,
            })?;
        }
        Ok(Some(states))
    }

    fn census(&mut self) -> Result<Option<crate::io::Census>> {
        Ok(Some(crate::io::Census {
            missing: self.missing_servos()?,
            imu_answers: self.imu_answers()?,
        }))
    }

    fn servo_identity(&mut self) -> Result<Option<[crate::io::ServoIdentity; NUM_JOINTS]>> {
        let blocks = self
            .controller
            .sync_read_raw_data(&JOINT_IDS, IDENTITY_ADDR, IDENTITY_LEN)
            .map_err(|e| IoError::Bus(format!("model/firmware sync_read: {e}")))?;
        if blocks.len() != NUM_JOINTS {
            return Err(IoError::ShortRead {
                what: "identity blocks",
                expected: NUM_JOINTS,
                got: blocks.len(),
            });
        }
        let mut ids = [crate::io::ServoIdentity::default(); NUM_JOINTS];
        for (slot, block) in ids.iter_mut().zip(&blocks) {
            if block.len() == IDENTITY_LEN as usize {
                *slot = crate::io::ServoIdentity {
                    model: u16::from_le_bytes([block[0], block[1]]),
                    firmware: block[6],
                };
            }
        }
        Ok(Some(ids))
    }

    fn imu_ready(&self) -> bool {
        self.imu.ready()
    }
}
