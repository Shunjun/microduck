//! FT-SCS serial transport and mixed servo/IMU transactions.
//Compatible: HD1910 and IMU firmware-1.0.0 packet handling.
use super::{
    config::{JointCalibration, validate_ids},
    fail,
    feedback::ServoFeedback,
    imu::{IMU_ID, ImuDiagnostics, ImuV1},
};
use crate::io::{ImuStale, Result};
use rustypot::DynamixelProtocolHandler;
use std::time::Duration;

/// Transport boundary for packet tests without opening a serial port.
pub trait RegisterBus {
    fn read(&mut self, id: u8, address: u8, length: u8) -> Result<Vec<u8>>;
    /// Must preserve request order and reject device status errors.
    fn sync_read(&mut self, ids: &[u8], address: u8, length: u8) -> Result<Vec<Vec<u8>>>;
    fn sync_write(&mut self, ids: &[u8], address: u8, data: &[Vec<u8>]) -> Result<()>;
}

pub struct SerialBus {
    pub(super) port: Box<dyn serialport::SerialPort>,
    pub(super) protocol: DynamixelProtocolHandler,
}
impl SerialBus {
    pub fn open(path: &str) -> Result<Self> {
        let port = serialport::new(path, 1_000_000)
            .data_bits(serialport::DataBits::Eight)
            .parity(serialport::Parity::None)
            .stop_bits(serialport::StopBits::One)
            .flow_control(serialport::FlowControl::None)
            .timeout(Duration::from_millis(10))
            .open()
            .map_err(|e| fail(format!("serial port {path}: {e}")))?;
        //Compatible: FT-SCS uses the v1 0x82/0x83 packet format, never v2 fast sync read.
        Ok(Self {
            port,
            protocol: DynamixelProtocolHandler::v1(),
        })
    }
}
impl RegisterBus for SerialBus {
    fn read(&mut self, id: u8, address: u8, length: u8) -> Result<Vec<u8>> {
        let (bytes, status) = self
            .protocol
            .read_with_error(self.port.as_mut(), id, address, length)
            .map_err(|e| fail(e.to_string()))?;
        if !status.is_ok() {
            return Err(fail(format!("device {id}: status 0x{:02x}", status.byte())));
        }
        if bytes.len() != usize::from(length) {
            return Err(fail(format!("device {id}: short register read")));
        }
        Ok(bytes)
    }
    fn sync_read(&mut self, ids: &[u8], address: u8, length: u8) -> Result<Vec<Vec<u8>>> {
        let replies = self
            .protocol
            .sync_read_with_error(self.port.as_mut(), ids, address, length)
            .map_err(|e| fail(e.to_string()))?;
        if replies.len() != ids.len() {
            return Err(fail("missing FT sync-read response"));
        }
        replies
            .into_iter()
            .zip(ids)
            .map(|((bytes, status), id)| {
                if !status.is_ok() {
                    return Err(fail(format!("device {id}: status 0x{:02x}", status.byte())));
                }
                if bytes.len() != usize::from(length) {
                    return Err(fail(format!("device {id}: short sync-read response")));
                }
                Ok(bytes)
            })
            .collect()
    }
    fn sync_write(&mut self, ids: &[u8], address: u8, data: &[Vec<u8>]) -> Result<()> {
        if ids.is_empty()
            || ids.len() != data.len()
            || data
                .iter()
                .any(|v| v.is_empty() || v.len() != data[0].len())
        {
            return Err(fail("invalid FT sync-write dimensions"));
        }
        self.protocol
            .sync_write(self.port.as_mut(), ids, address, data)
            .map_err(|e| fail(e.to_string()))
    }
}

/// Combined frame preserves caller joint order; IMU is always requested last.
#[derive(Debug)]
pub struct Feedback {
    pub servos: Vec<ServoFeedback>,
    pub imu: crate::imu::ImuData,
    pub diagnostics: ImuDiagnostics,
}
pub struct FeetechBus<B = SerialBus> {
    pub(super) bus: B,
    ids: Vec<u8>,
    imu: ImuV1,
    recovery_count: Option<u32>,
}
impl FeetechBus<SerialBus> {
    pub fn open(path: &str, ids: Vec<u8>, mount: [f64; 4]) -> Result<Self> {
        validate_ids(&ids)?;
        ImuV1::new(mount)?;
        Self::new(SerialBus::open(path)?, ids, mount)
    }
}
impl<B: RegisterBus> FeetechBus<B> {
    /// Checks IMU identity and every servo model without changing any registers.
    pub fn new(mut bus: B, ids: Vec<u8>, mount: [f64; 4]) -> Result<Self> {
        validate_ids(&ids)?;
        let imu = ImuV1::new(mount)?;
        let identity = bus.read(IMU_ID, 0, 10)?;
        if identity.len() != 10 || identity[0..5] != [1, 0, 0, 0x44, 0x4d] || identity[5] != IMU_ID
        {
            return Err(fail(
                "expected imu_to_dxl firmware 1.0, little-endian model 0x4D44, ID 200",
            ));
        }
        for &id in &ids {
            let model = bus.read(id, 3, 2)?;
            if model != [10, 31] {
                return Err(fail(format!(
                    "device {id}: expected HD1910 model bytes [10,31], got {model:?}"
                )));
            }
            // Single-turn calibration is invalid in wheel/multi-turn mode.
            if !matches!(bus.read(id, 33, 1)?.as_slice(), [0] | [4]) {
                return Err(fail(format!(
                    "servo {id}: requires position mode (register 33 = 0 or 4)"
                )));
            }
        }
        Ok(Self {
            bus,
            ids,
            imu,
            recovery_count: None,
        })
    }
    pub fn read(&mut self) -> Result<Feedback> {
        let result = self.read_checked();
        if result.is_err() {
            self.imu.invalidate();
        }
        result
    }
    fn read_checked(&mut self) -> Result<Feedback> {
        let mut ids = self.ids.clone();
        //Compatible: firmware-1.0.0 must reply after every physical servo.
        ids.push(IMU_ID);
        let blocks = self.bus.sync_read(&ids, 56, 15)?;
        if blocks.len() != ids.len() {
            return Err(fail("missing FT sync-read block"));
        }
        let servos = blocks[..self.ids.len()]
            .iter()
            .map(|raw| ServoFeedback::parse(raw))
            .collect::<Result<Vec<_>>>()?;
        let diagnostics = ImuDiagnostics::parse(&self.bus.read(IMU_ID, 90, 96)?)?;
        if !diagnostics.fresh() {
            return Err(fail("IMU diagnostic reports expired gyro/quaternion"));
        }
        if self
            .recovery_count
            .is_some_and(|count| count != diagnostics.recovery_count)
        {
            self.imu.invalidate();
        }
        self.recovery_count = Some(diagnostics.recovery_count);
        let imu = self.imu.decode(&blocks[self.ids.len()])?;
        Ok(Feedback {
            servos,
            imu,
            diagnostics,
        })
    }
    pub fn set_imu_mount(&mut self, mount: [f64; 4]) -> Result<()> {
        self.imu = ImuV1::new(mount)?;
        Ok(())
    }
    pub fn imu_ready(&self) -> bool {
        self.imu.ready()
    }
    pub fn imu_stale(&self) -> ImuStale {
        self.imu.stale()
    }

    /// Position only. Every target is validated before a broadcast can be sent.
    pub fn write_positions(
        &mut self,
        calibration: &[JointCalibration],
        radians: &[f64],
    ) -> Result<()> {
        if calibration.len() != self.ids.len() || radians.len() != self.ids.len() {
            return Err(fail("target/calibration count does not match servo count"));
        }
        let data = calibration
            .iter()
            .zip(radians)
            .zip(&self.ids)
            .map(|((joint, angle), id)| {
                joint.validate()?;
                if joint.id != *id {
                    return Err(fail("calibration order does not match bus order"));
                }
                Ok(joint.target(*angle)?.to_le_bytes().to_vec())
            })
            .collect::<Result<Vec<_>>>()?;
        // Write only 42..43: do not guess goal speed, time, acceleration or EEPROM gains.
        self.bus.sync_write(&self.ids, 42, &data)
    }
    /// Update position P, preserving the servo's existing persistence setting.
    pub fn set_position_gain(&mut self, gain: u8) -> Result<()> {
        if gain > 254 || self.ids.is_empty() {
            return Err(fail("HD1910 P gain must be 0..254 with at least one servo"));
        }
        //Compatible: leave address 55 untouched; the operator controls persistence.
        self.bus
            .sync_write(&self.ids, 21, &vec![vec![gain]; self.ids.len()])?;
        let replies = self.bus.sync_read(&self.ids, 21, 1)?;
        if replies.len() != self.ids.len() || replies.iter().any(|value| value != &[gain]) {
            return Err(fail(
                "HD1910 P gain readback did not match the requested value",
            ));
        }
        Ok(())
    }

    pub fn set_torque(&mut self, on: bool) -> Result<()> {
        if self.ids.is_empty() {
            return Err(fail("no servos configured"));
        }
        self.bus
            .sync_write(&self.ids, 40, &vec![vec![u8::from(on)]; self.ids.len()])
    }
}
