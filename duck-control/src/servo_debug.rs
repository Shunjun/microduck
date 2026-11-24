//! Restricted raw-servo access, used only while robotd suspends normal output.
use crate::{IoError, NUM_JOINTS, io::Result};
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct JointSetting {
    pub id: u8,
    pub zero_ticks: Option<u16>,
    pub direction: Option<i8>,
    pub min_ticks: Option<u16>,
    pub max_ticks: Option<u16>,
}
impl JointSetting {
    pub fn validate(&self) -> Result<()> {
        if self.direction.is_some_and(|d| d != 1 && d != -1)
            || self.zero_ticks.is_some_and(|v| v > 4095)
            || self.min_ticks.is_some_and(|v| v > 4095)
            || self.max_ticks.is_some_and(|v| v > 4095)
            || matches!((self.min_ticks, self.max_ticks), (Some(a), Some(b)) if a >= b)
            || matches!((self.zero_ticks,self.min_ticks), (Some(z),Some(m)) if z < m)
            || matches!((self.zero_ticks,self.max_ticks), (Some(z),Some(m)) if z > m)
        {
            return Err(error("invalid direction, zero or mechanical limits"));
        }
        Ok(())
    }
    pub fn checked_target(&self, ticks: u16) -> Result<()> {
        self.validate()?;
        match (self.min_ticks, self.max_ticks) {
            (Some(lo), Some(hi)) if (lo..=hi).contains(&ticks) => Ok(()),
            _ => Err(error("configure mechanical limits before moving")),
        }
    }
    pub fn radians(&self, ticks: u16) -> Option<f64> {
        Some(
            f64::from(self.direction?)
                * (f64::from(ticks) - f64::from(self.zero_ticks?))
                * std::f64::consts::TAU
                / 4096.,
        )
    }
}
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct JointReading {
    pub id: u8,
    pub ticks: Option<u16>,
    pub torque: Option<bool>,
    pub p: Option<u8>,
    pub voltage: Option<f64>,
    pub temperature: Option<u8>,
    pub current_raw: Option<u16>,
    pub error: Option<String>,
}
impl JointReading {
    pub fn missing(id: u8, reason: String) -> Self {
        Self {
            id,
            ticks: None,
            torque: None,
            p: None,
            voltage: None,
            temperature: None,
            current_raw: None,
            error: Some(reason),
        }
    }
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "op", rename_all = "snake_case", deny_unknown_fields)]
pub enum DeviceOp {
    Read,
    Position { id: u8, ticks: u16 },
    Torque { id: Option<u8>, on: bool },
    Gain { id: Option<u8>, p: u8 },
    Configure { joints: [JointSetting; NUM_JOINTS] },
}
pub fn error(message: impl Into<String>) -> IoError {
    IoError::Bus(message.into())
}
pub fn zero_for_pose(ticks: u16, direction: i8, angle: f64) -> Result<u16> {
    if ticks > 4095 || ![-1, 1].contains(&direction) || !angle.is_finite() {
        return Err(error("invalid calibration sample"));
    }
    let zero = f64::from(ticks) - angle * f64::from(direction) * 4096. / std::f64::consts::TAU;
    if !(0.0..=4095.0).contains(&zero) {
        return Err(error("zero lies outside the single-turn encoder range"));
    }
    Ok(zero.round() as u16)
}
pub fn settings() -> [JointSetting; NUM_JOINTS] {
    std::array::from_fn(|i| JointSetting {
        id: crate::JOINT_IDS[i],
        zero_ticks: None,
        direction: None,
        min_ticks: None,
        max_ticks: None,
    })
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn reference_pose_is_not_assumed_to_be_zero_radians() {
        assert_eq!(
            zero_for_pose(2048, 1, std::f64::consts::FRAC_PI_2).unwrap(),
            1024
        );
        assert_eq!(
            zero_for_pose(2048, -1, std::f64::consts::FRAC_PI_2).unwrap(),
            3072
        );
        assert!(zero_for_pose(10, 0, 0.).is_err());
        assert!(zero_for_pose(10, 1, std::f64::consts::PI).is_err());
    }
}

/// Explicit simulator for off-board UI checks; never opened implicitly on a real serial failure.
#[derive(Clone)]
pub struct SimDevice {
    pub joints: [JointSetting; NUM_JOINTS],
    pub readings: Vec<JointReading>,
}
impl Default for SimDevice {
    fn default() -> Self {
        let joints = std::array::from_fn(|i| JointSetting {
            id: crate::JOINT_IDS[i],
            zero_ticks: Some(2048),
            direction: Some(1),
            min_ticks: Some(0),
            max_ticks: Some(4095),
        });
        let readings = joints
            .iter()
            .map(|j| JointReading {
                id: j.id,
                ticks: Some(
                    (2048.
                        + crate::model::DEFAULT_POSITION
                            [crate::JOINT_IDS.iter().position(|id| *id == j.id).unwrap()]
                            * 4096.
                            / std::f64::consts::TAU)
                        .round() as u16,
                ),
                torque: Some(false),
                p: Some(180),
                voltage: Some(7.4),
                temperature: Some(30),
                current_raw: Some(0),
                error: None,
            })
            .collect();
        Self { joints, readings }
    }
}
impl SimDevice {
    pub fn execute(&mut self, op: &DeviceOp) -> Result<Vec<JointReading>> {
        match op {
            DeviceOp::Configure { joints } => {
                for j in joints {
                    j.validate()?;
                }
                self.joints = *joints;
            }
            DeviceOp::Position { id, ticks } => {
                let i = self
                    .joints
                    .iter()
                    .position(|j| j.id == *id)
                    .ok_or_else(|| error("unknown joint"))?;
                self.joints[i].checked_target(*ticks)?;
                self.readings[i].ticks = Some(*ticks);
            }
            DeviceOp::Torque { id, on } => {
                for r in &mut self.readings {
                    if id.is_none() || *id == Some(r.id) {
                        r.torque = Some(*on);
                    }
                }
            }
            DeviceOp::Gain { id, p } => {
                if *p > 254 {
                    return Err(error("P must be 0..254"));
                }
                for r in &mut self.readings {
                    if id.is_none() || *id == Some(r.id) {
                        r.p = Some(*p);
                    }
                }
            }
            DeviceOp::Read => {}
        }
        Ok(self.readings.clone())
    }
}

/// Unmounted sensor-to-world quaternion and sensor-axis gyro, for static body IMU checks.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ImuReading {
    pub quat: [f64; 4],
    pub gyro: [f64; 3],
    pub counter: u8,
}
pub fn quat_mul(a: [f64; 4], b: [f64; 4]) -> [f64; 4] {
    [
        a[0] * b[0] - a[1] * b[1] - a[2] * b[2] - a[3] * b[3],
        a[0] * b[1] + a[1] * b[0] + a[2] * b[3] - a[3] * b[2],
        a[0] * b[2] - a[1] * b[3] + a[2] * b[0] + a[3] * b[1],
        a[0] * b[3] + a[1] * b[2] - a[2] * b[1] + a[3] * b[0],
    ]
}
pub fn rotate(q: [f64; 4], v: [f64; 3]) -> [f64; 3] {
    let r = quat_mul(
        quat_mul(q, [0., v[0], v[1], v[2]]),
        [q[0], -q[1], -q[2], -q[3]],
    );
    [r[1], r[2], r[3]]
}
pub fn gravity(q: [f64; 4]) -> [f64; 3] {
    rotate([q[0], -q[1], -q[2], -q[3]], [0., 0., -1.])
}
/// Gravity fixes tilt only; mounting yaw must already be established independently.
pub fn level_mount(mount: [f64; 4], q: [f64; 4]) -> Result<[f64; 4]> {
    for v in [mount, q] {
        let n = v.iter().map(|x| x * x).sum::<f64>();
        if !n.is_finite() || (n - 1.).abs() > 0.01 {
            return Err(error("IMU quaternions must be unit length"));
        }
    }
    let a = rotate(mount, gravity(q));
    let dot = -a[2];
    let rotation = if dot < -0.999999 {
        [0., 1., 0., 0.]
    } else {
        let v = [1. + dot, -a[1], a[0], 0.];
        let n = v.iter().map(|x| x * x).sum::<f64>().sqrt();
        v.map(|x| x / n)
    };
    Ok(quat_mul(rotation, mount))
}

#[cfg(test)]
mod leveling_tests {
    use super::*;
    #[test]
    fn static_leveling_rotates_gravity_without_inventing_forward_axis() {
        let angle = 0.2_f64;
        let q = [(angle / 2.).cos(), (angle / 2.).sin(), 0., 0.];
        let mount = level_mount([1., 0., 0., 0.], q).unwrap();
        let g = rotate(mount, gravity(q));
        assert!(g[0].abs() < 1e-9 && g[1].abs() < 1e-9 && (g[2] + 1.).abs() < 1e-9);
        assert!(level_mount([0.; 4], q).is_err());
    }
}
