//! HD1910 mechanical calibration and unit conversions.
//Compatible: explicit calibration for the replacement hardware.
use super::{
    fail,
    imu::{IMU_ID, ImuV1},
};
use crate::{io::Result, model::NUM_JOINTS};
use serde::{Deserialize, Serialize};
use std::collections::HashSet;

/// Joint order must be exactly crate::JOINT_NAMES; IDs may differ from the original robot.
#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct JointCalibration {
    pub id: u8,
    pub zero_ticks: u16,
    /// +1 or -1: maps increasing encoder positions to the training joint axis.
    pub direction: i8,
    /// Measured safe encoder limits, in single-turn position mode (0..4095).
    pub min_ticks: u16,
    pub max_ticks: u16,
}
impl JointCalibration {
    pub(super) fn validate(&self) -> Result<()> {
        validate_ids(&[self.id])?;
        if ![-1, 1].contains(&self.direction)
            || self.min_ticks >= self.max_ticks
            || self.max_ticks > 4095
            || self.zero_ticks < self.min_ticks
            || self.zero_ticks > self.max_ticks
        {
            return Err(fail(format!(
                "invalid mechanical calibration for servo {}",
                self.id
            )));
        }
        Ok(())
    }
    pub(super) fn target(&self, radians: f64) -> Result<u16> {
        let ticks = f64::from(self.zero_ticks)
            + radians * f64::from(self.direction) * 4096.0 / std::f64::consts::TAU;
        // Check before rounding: rounding must not disguise an out-of-range command.
        if !ticks.is_finite()
            || ticks < f64::from(self.min_ticks)
            || ticks > f64::from(self.max_ticks)
        {
            return Err(fail(format!(
                "target outside safe range for servo {}",
                self.id
            )));
        }
        Ok(ticks.round() as u16)
    }
}
#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct Config {
    pub joints: [JointCalibration; NUM_JOINTS],
    /// Sensor-to-trunk quaternion `[w,x,y,z]`, measured for this assembly.
    pub imu_mount: [f64; 4],
    /// HD1910 speed/current units must be measured or confirmed by its datasheet.
    pub speed_rad_s_per_unit: f64,
    pub current_ma_per_unit: f64,
}
impl Config {
    pub fn validate(&self) -> Result<()> {
        for joint in &self.joints {
            joint.validate()?;
        }
        validate_ids(&self.joints.iter().map(|j| j.id).collect::<Vec<_>>())?;
        if !self.speed_rad_s_per_unit.is_finite()
            || self.speed_rad_s_per_unit <= 0.
            || !self.current_ma_per_unit.is_finite()
            || self.current_ma_per_unit <= 0.
        {
            return Err(fail("speed/current units must be finite and positive"));
        }
        ImuV1::new(self.imu_mount)?;
        Ok(())
    }
}
pub(super) fn validate_ids(ids: &[u8]) -> Result<()> {
    if ids.len() > NUM_JOINTS {
        return Err(fail("at most 15 HD1910 servos may share this robot bus"));
    }
    let mut seen = HashSet::new();
    for &id in ids {
        if id == 0 || id >= 254 || id == IMU_ID || !seen.insert(id) {
            return Err(fail(
                "servo IDs must be unique, in 1..253, and exclude IMU ID 200",
            ));
        }
    }
    Ok(())
}
