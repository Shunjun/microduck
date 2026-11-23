//! Motor backend selection and runtime boundary. No hardware is opened at startup by this module.
use std::path::Path;
use std::time::Duration;

use duck_control::feetech1910::{Config as FeetechConfig, FeetechIo};
use duck_control::io::{ImuStale, Result, ServoIdentity};
use duck_control::xl330::DynamixelIo;
use duck_control::{IoError, JointTargets, NUM_JOINTS, RobotIo, Sensors, SlowSensors};

//Compatible: this build uses the original joint IDs/order for both servo families.
pub use duck_ipc_proto::JOINT_IDS;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
#[allow(
    dead_code,
    reason = "The entry point constructs exactly one driver variant at build time"
)]
pub enum MotorDriver {
    Xl330,
    Feetech1910,
}

impl MotorDriver {
    pub const fn name(self) -> &'static str {
        match self {
            Self::Xl330 => "XL330",
            Self::Feetech1910 => "Feetech HD1910",
        }
    }

    pub const fn imu_id(self) -> u8 {
        match self {
            Self::Xl330 => duck_control::xl330::imu::IMU_DXL_ID,
            Self::Feetech1910 => duck_control::feetech1910::imu::IMU_ID,
        }
    }
}

pub fn load_feetech_config(path: &Path) -> Result<FeetechConfig> {
    let raw = std::fs::read(path).map_err(|error| {
        IoError::Bus(format!(
            "read Feetech calibration {}: {error}; no XL330 calibration is substituted",
            path.display()
        ))
    })?;
    let config: FeetechConfig = serde_json::from_slice(&raw).map_err(|error| {
        IoError::Bus(format!(
            "invalid Feetech calibration {}: {error}",
            path.display()
        ))
    })?;
    config.validate()?;
    let ids = config.joints.each_ref().map(|joint| joint.id);
    if ids != JOINT_IDS {
        return Err(IoError::Bus(format!(
            "Feetech joint IDs/order must match the shared joint table {JOINT_IDS:?}; got {ids:?}"
        )));
    }
    Ok(config)
}

pub enum BusIo {
    Xl330(Box<DynamixelIo>),
    Feetech1910(Box<FeetechIo>),
}

impl BusIo {
    pub fn open_feetech(port: &str, calibration: &Path) -> Result<Self> {
        // Validate the complete calibration before opening a device or sending any packets.
        let config = load_feetech_config(calibration)?;
        FeetechIo::open(port, config).map(|io| Self::Feetech1910(Box::new(io)))
    }

    pub fn imu_answers(&mut self) -> Result<bool> {
        match self {
            Self::Xl330(io) => io.imu_answers(),
            // FeetechIo::open already read and validated the IMU's model/firmware identity.
            Self::Feetech1910(_) => Ok(true),
        }
    }

    pub fn interpolate_to(
        &mut self,
        target: &[f64; NUM_JOINTS],
        duration: Duration,
        step: Duration,
    ) -> Result<()> {
        match self {
            Self::Xl330(io) => io.interpolate_to(target, duration, step),
            Self::Feetech1910(io) => {
                if step.is_zero() {
                    return Err(IoError::Bus("interpolation step must be nonzero".into()));
                }
                let start = io.read()?.positions;
                let steps = (duration.as_secs_f64() / step.as_secs_f64())
                    .ceil()
                    .max(1.0) as u32;
                for i in 1..=steps {
                    let t = f64::from(i) / f64::from(steps);
                    let next = std::array::from_fn(|j| start[j] + (target[j] - start[j]) * t);
                    io.write(&JointTargets::new(next))?;
                    std::thread::sleep(step);
                }
                Ok(())
            }
        }
    }
}

macro_rules! dispatch {
    ($this:expr, $method:ident $(, $arg:expr)*) => {
        match $this {
            BusIo::Xl330(io) => io.$method($($arg),*),
            BusIo::Feetech1910(io) => io.$method($($arg),*),
        }
    };
}

impl RobotIo for BusIo {
    fn read(&mut self) -> Result<Sensors> {
        dispatch!(self, read)
    }
    fn write(&mut self, targets: &JointTargets) -> Result<()> {
        dispatch!(self, write, targets)
    }
    fn set_gain(&mut self, kp: u16) -> Result<()> {
        dispatch!(self, set_gain, kp)
    }
    fn set_torque(&mut self, on: bool) -> Result<()> {
        match self {
            Self::Xl330(io) => RobotIo::set_torque(io.as_mut(), on),
            Self::Feetech1910(io) => io.set_torque(on),
        }
    }
    fn reboot(&mut self, id: u8) -> Result<()> {
        dispatch!(self, reboot, id)
    }
    fn slow_sensors(&mut self) -> Result<SlowSensors> {
        dispatch!(self, slow_sensors)
    }
    fn imu_stale(&self) -> ImuStale {
        dispatch!(self, imu_stale)
    }
    fn imu_ready(&self) -> bool {
        dispatch!(self, imu_ready)
    }
    fn measures_velocity(&self) -> bool {
        dispatch!(self, measures_velocity)
    }
    fn measures_load(&self) -> bool {
        dispatch!(self, measures_load)
    }
    fn hardware_errors(&mut self) -> Result<Option<[u8; NUM_JOINTS]>> {
        dispatch!(self, hardware_errors)
    }
    fn set_goal_pwm(&mut self, pwm: u16) -> Result<()> {
        dispatch!(self, set_goal_pwm, pwm)
    }
    fn impact_guard(&mut self) -> Result<Option<[u8; NUM_JOINTS]>> {
        dispatch!(self, impact_guard)
    }
    fn census(&mut self) -> Result<Option<duck_control::io::Census>> {
        dispatch!(self, census)
    }
    fn servo_identity(&mut self) -> Result<Option<[ServoIdentity; NUM_JOINTS]>> {
        dispatch!(self, servo_identity)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn calibration() -> serde_json::Value {
        serde_json::json!({
            "joints": JOINT_IDS.map(|id| serde_json::json!({"id":id,"zero_ticks":2048,"direction":1,"min_ticks":1024,"max_ticks":3072})),
            "imu_mount":[1,0,0,0], "speed_rad_s_per_unit":0.1, "current_ma_per_unit":2.0
        })
    }
    #[test]
    fn feetech_config_keeps_ids_but_never_invents_calibration() {
        let dir = tempfile::tempdir().unwrap();
        let file = dir.path().join("feetech1910.json");
        assert!(load_feetech_config(&file).is_err());
        let mut value = calibration();
        std::fs::write(&file, value.to_string()).unwrap();
        assert_eq!(
            load_feetech_config(&file).unwrap().joints[0].id,
            JOINT_IDS[0]
        );
        value["joints"].as_array_mut().unwrap().swap(0, 1);
        std::fs::write(&file, value.to_string()).unwrap();
        assert!(
            load_feetech_config(&file)
                .unwrap_err()
                .to_string()
                .contains("IDs/order")
        );
        value = calibration();
        value["joints"][0]["direction"] = 0.into();
        std::fs::write(&file, value.to_string()).unwrap();
        assert!(load_feetech_config(&file).is_err());
    }
    #[test]
    fn both_drivers_address_the_same_bus_imu() {
        assert_eq!(MotorDriver::Feetech1910.imu_id(), 200);
        assert_eq!(MotorDriver::Xl330.imu_id(), 200);
    }
}
