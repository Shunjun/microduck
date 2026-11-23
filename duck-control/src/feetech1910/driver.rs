//! Calibrated HD1910 implementation of the shared control interface.
//Compatible: maps Feetech feedback and targets to RobotIo units.
use super::{
    bus::{FeetechBus, RegisterBus, SerialBus},
    config::Config,
    fail,
};
use crate::{
    io::{ImuStale, JointTargets, Result, RobotIo, Sensors, SlowSensors},
    model::NUM_JOINTS,
};

/// Calibrated RobotIo adapter. robotd's hardware selection is a separate integration step.
pub struct FeetechIo<B = SerialBus> {
    pub(super) bus: FeetechBus<B>,
    config: Config,
    last_slow: Option<SlowSensors>,
}
impl FeetechIo<SerialBus> {
    pub fn open(path: &str, config: Config) -> Result<Self> {
        config.validate()?;
        Self::new(SerialBus::open(path)?, config)
    }
}
impl<B: RegisterBus> FeetechIo<B> {
    pub fn new(bus: B, config: Config) -> Result<Self> {
        config.validate()?;
        let ids = config.joints.iter().map(|joint| joint.id).collect();
        Ok(Self {
            bus: FeetechBus::new(bus, ids, config.imu_mount)?,
            config,
            last_slow: None,
        })
    }
}
impl<B: RegisterBus> RobotIo for FeetechIo<B> {
    fn read(&mut self) -> Result<Sensors> {
        let frame = self.bus.read()?;
        let mut sensors = Sensors {
            imu: frame.imu,
            ..Sensors::default()
        };
        let mut slow = SlowSensors {
            volts: 0.,
            temps_c: [0.; NUM_JOINTS],
        };
        for (i, (servo, joint)) in frame.servos.iter().zip(&self.config.joints).enumerate() {
            if servo.status != 0 {
                return Err(fail(format!(
                    "servo {} hardware status 0x{:02x}",
                    joint.id, servo.status
                )));
            }
            if !(0..=4095).contains(&servo.position_ticks) {
                return Err(fail(format!(
                    "servo {} position is outside single-turn range",
                    joint.id
                )));
            }
            sensors.positions[i] = f64::from(servo.position_ticks - i32::from(joint.zero_ticks))
                * f64::from(joint.direction)
                * std::f64::consts::TAU
                / 4096.;
            sensors.velocities[i] = f64::from(servo.speed_raw)
                * f64::from(joint.direction)
                * self.config.speed_rad_s_per_unit;
            sensors.currents_ma[i] = f64::from(servo.current_raw) * self.config.current_ma_per_unit;
            slow.volts += servo.voltage / NUM_JOINTS as f64;
            slow.temps_c[i] = f64::from(servo.temperature_c);
        }
        self.last_slow = Some(slow);
        Ok(sensors)
    }
    fn write(&mut self, targets: &JointTargets) -> Result<()> {
        self.bus
            .write_positions(&self.config.joints, &targets.positions)
    }
    fn set_torque(&mut self, on: bool) -> Result<()> {
        self.bus.set_torque(on)
    }
    fn set_gain(&mut self, kp: u16) -> Result<()> {
        //Compatible: the runtime supplies HD1910 P directly, without XL330 scaling.
        let gain = u8::try_from(kp)
            .ok()
            .filter(|gain| *gain <= 254)
            .ok_or_else(|| fail("HD1910 P gain is outside 0..254"))?;
        self.bus.set_position_gain(gain)
    }

    fn reboot(&mut self, _id: u8) -> Result<()> {
        Err(fail("Feetech reboot is not implemented by this backend"))
    }
    fn slow_sensors(&mut self) -> Result<SlowSensors> {
        self.last_slow
            .ok_or_else(|| fail("read feedback before requesting slow sensors"))
    }
    fn imu_ready(&self) -> bool {
        self.bus.imu_ready()
    }
    fn imu_stale(&self) -> ImuStale {
        self.bus.imu_stale()
    }
}
