//! HD1910 commissioning without an IMU or an already-complete calibration.
//Compatible: reuse the same FT-SCS transport; never open another port beside robotd.
use super::{RegisterBus, SerialBus, ServoFeedback};
use crate::{
    NUM_JOINTS,
    io::Result,
    servo_debug::{DeviceOp, JointReading, JointSetting, error},
};

pub fn exchange<B: RegisterBus>(
    bus: &mut B,
    settings: &mut [JointSetting; NUM_JOINTS],
    op: &DeviceOp,
) -> Result<Vec<JointReading>> {
    if let DeviceOp::Configure { joints } = op {
        for (i, j) in joints.iter().enumerate() {
            j.validate()?;
            if j.id != crate::JOINT_IDS[i] {
                return Err(error("joint IDs/order must match robot"));
            }
        }
        *settings = *joints;
        return Ok(vec![]);
    }
    if let DeviceOp::Torque { id, on: false } = op {
        //Compatible: one disconnected joint must not prevent unloading the responding joints.
        let targets = ids(settings, *id)?;
        let mut good = Vec::new();
        let mut failed = Vec::new();
        for id in targets {
            match identify_model(bus, id) {
                Ok(()) => good.push(id),
                Err(e) => failed.push(format!("{id}: {e}")),
            }
        }
        if !good.is_empty() {
            bus.sync_write(&good, 40, &vec![vec![0]; good.len()])?;
            for &id in &good {
                match bus.read(id, 40, 1) {
                    Ok(v) if v == [0] => {}
                    Ok(_) => failed.push(format!("{id}: torque remains on")),
                    Err(e) => failed.push(format!("{id}: {e}")),
                }
            }
        }
        if !failed.is_empty() {
            return Err(error(format!(
                "unload attempted on responding joints; unconfirmed: {}",
                failed.join(", ")
            )));
        }
        return Ok(vec![]);
    }
    let mut write: Option<(Vec<u8>, u8, Vec<Vec<u8>>)> = None;
    match op {
        DeviceOp::Position { id, ticks } => {
            let j = settings
                .iter()
                .find(|j| j.id == *id)
                .ok_or_else(|| error("unknown joint"))?;
            j.checked_target(*ticks)?;
            write = Some((
                vec![*id],
                42,
                vec![
                    super::feedback::encode_position(*ticks)?
                        .to_le_bytes()
                        .to_vec(),
                ],
            ));
        }
        DeviceOp::Torque { id, on } => {
            write = Some((
                ids(settings, *id)?,
                40,
                vec![vec![u8::from(*on)]; if id.is_some() { 1 } else { NUM_JOINTS }],
            ))
        }
        DeviceOp::Gain { id, p } => {
            if *p > 254 {
                return Err(error("P must be 0..254"));
            }
            write = Some((
                ids(settings, *id)?,
                21,
                vec![vec![*p]; if id.is_some() { 1 } else { NUM_JOINTS }],
            ));
        }
        _ => {}
    }
    if let Some((ids, addr, data)) = write {
        // Validate model and position mode before every write, including broadcast torque.
        for &id in &ids {
            identify(bus, id)?;
        }
        bus.sync_write(&ids, addr, &data)?;
        if addr != 42 {
            for (&id, want) in ids.iter().zip(&data) {
                if bus.read(id, addr, want.len() as u8)? != *want {
                    return Err(error(format!("servo {id}: write readback mismatch")));
                }
            }
        }
    }
    if !matches!(op, DeviceOp::Read) {
        return Ok(vec![]);
    }
    Ok(settings
        .iter()
        .map(|j| {
            let reading = (|| {
                identify(bus, j.id)?;
                let s = ServoFeedback::parse(&bus.read(j.id, 56, 15)?)?;
                let torque = bus.read(j.id, 40, 1)?[0] != 0;
                let p = bus.read(j.id, 21, 1)?[0];
                Ok(JointReading {
                    id: j.id,
                    ticks: Some(s.position_ticks),
                    torque: Some(torque),
                    p: Some(p),
                    voltage: Some(s.voltage),
                    temperature: Some(s.temperature_c),
                    current_raw: Some(s.current_raw),
                    error: (s.status != 0).then(|| format!("hardware status {}", s.status)),
                })
            })();
            reading.unwrap_or_else(|e: crate::IoError| JointReading::missing(j.id, e.to_string()))
        })
        .collect())
}
fn ids(settings: &[JointSetting; NUM_JOINTS], id: Option<u8>) -> Result<Vec<u8>> {
    match id {
        Some(id) if settings.iter().any(|j| j.id == id) => Ok(vec![id]),
        None => Ok(settings.iter().map(|j| j.id).collect()),
        _ => Err(error("unknown joint")),
    }
}
fn identify_model<B: RegisterBus>(bus: &mut B, id: u8) -> Result<()> {
    if bus.read(id, 3, 2)? != [10, 31] {
        return Err(error(format!("servo {id}: not HD1910")));
    }
    Ok(())
}
fn identify<B: RegisterBus>(bus: &mut B, id: u8) -> Result<()> {
    if bus.read(id, 3, 2)? != [10, 31] {
        return Err(error(format!("servo {id}: not HD1910")));
    }
    if !matches!(bus.read(id, 33, 1)?.as_slice(), [0] | [4]) {
        return Err(error(format!(
            "servo {id}: unsupported position mode (expected 0 or 4)"
        )));
    }
    Ok(())
}
/// The raw backend refuses normal motion until a complete profile is loaded by a normal restart.
pub struct CommissioningIo {
    bus: SerialBus,
    settings: [JointSetting; NUM_JOINTS],
}
impl CommissioningIo {
    pub fn open(port: &str) -> Result<Self> {
        Ok(Self {
            bus: SerialBus::open(port)?,
            settings: crate::servo_debug::settings(),
        })
    }
}
impl crate::RobotIo for CommissioningIo {
    fn debug_imu(&mut self) -> Result<crate::servo_debug::ImuReading> {
        read_imu(&mut self.bus)
    }
    fn debug_set_imu_mount(&mut self, _mount: [f64; 4]) -> Result<()> {
        Ok(())
    }

    fn servo_debug(&mut self, op: &DeviceOp) -> Result<Vec<JointReading>> {
        exchange(&mut self.bus, &mut self.settings, op)
    }
    fn read(&mut self) -> Result<crate::Sensors> {
        Err(error("commissioning: normal control unavailable"))
    }
    fn write(&mut self, _: &crate::JointTargets) -> Result<()> {
        Err(error("commissioning: use debug interface"))
    }
    fn set_gain(&mut self, _: u16) -> Result<()> {
        Err(error("commissioning: use debug interface"))
    }
    fn set_torque(&mut self, on: bool) -> Result<()> {
        exchange(
            &mut self.bus,
            &mut self.settings,
            &DeviceOp::Torque { id: None, on },
        )?;
        Ok(())
    }
    fn reboot(&mut self, _: u8) -> Result<()> {
        Err(error("commissioning reboot unsupported"))
    }
    fn slow_sensors(&mut self) -> Result<crate::SlowSensors> {
        Err(error("commissioning: use debug readback"))
    }
    fn imu_ready(&self) -> bool {
        false
    }
}

pub fn read_imu<B: RegisterBus>(bus: &mut B) -> Result<crate::servo_debug::ImuReading> {
    let id = super::imu::IMU_ID;
    if bus.read(id, 0, 10)?.get(..6) != Some(&[1, 0, 0, 0x44, 0x4d, id]) {
        return Err(error("IMU firmware 1.0 identity mismatch"));
    }
    let raw = bus.read(id, 56, 15)?;
    let diag = super::imu::ImuDiagnostics::parse(&bus.read(id, 90, 96)?)?;
    if !diag.fresh() {
        return Err(error("body IMU samples expired"));
    }
    let mut decoder = super::imu::ImuV1::new([1., 0., 0., 0.])?;
    let data = decoder.decode(&raw)?;
    let gyro = std::array::from_fn(|i| {
        f64::from(i16::from_le_bytes([raw[2 * i], raw[2 * i + 1]])) * 0.0175 * std::f64::consts::PI
            / 180.
    });
    Ok(crate::servo_debug::ImuReading {
        quat: data.quat,
        gyro,
        counter: raw[12],
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    struct Bus {
        writes: Vec<(Vec<u8>, u8)>,
        missing: Option<u8>,
        position: u16,
    }
    impl RegisterBus for Bus {
        fn read(&mut self, id: u8, addr: u8, len: u8) -> Result<Vec<u8>> {
            assert_ne!(id, 200, "servo read must not require IMU");
            if self.missing == Some(id) {
                return Err(error("timeout"));
            }
            Ok(match addr {
                3 => vec![10, 31],
                33 => vec![0],
                56 => {
                    let mut b = vec![0; 15];
                    b[0..2].copy_from_slice(&self.position.to_le_bytes());
                    b[6] = 74;
                    b[7] = 30;
                    b
                }
                40 => vec![0],
                21 => vec![20],
                _ => vec![0; len as usize],
            })
        }
        fn sync_read(&mut self, _: &[u8], _: u8, _: u8) -> Result<Vec<Vec<u8>>> {
            unreachable!()
        }
        fn sync_write(&mut self, ids: &[u8], addr: u8, _: &[Vec<u8>]) -> Result<()> {
            self.writes.push((ids.to_vec(), addr));
            Ok(())
        }
    }
    #[test]
    fn raw_read_reports_missing_joint_and_needs_no_imu() {
        let mut b = Bus {
            writes: vec![],
            missing: Some(crate::JOINT_IDS[0]),
            position: 2048,
        };
        let mut s = crate::servo_debug::settings();
        let r = exchange(&mut b, &mut s, &DeviceOp::Read).unwrap();
        assert_eq!(r.len(), 15);
        assert!(r[0].error.is_some());
        assert_eq!(r[1].ticks, Some(2048));
        assert!(b.writes.is_empty());
    }
    #[test]
    fn invalid_position_is_rejected_before_bus_write() {
        let mut b = Bus {
            writes: vec![],
            missing: None,
            position: 2048,
        };
        let mut s = crate::servo_debug::SimDevice::default().joints;
        s[0].max_ticks = Some(3000);
        assert!(
            exchange(
                &mut b,
                &mut s,
                &DeviceOp::Position {
                    id: crate::JOINT_IDS[0],
                    ticks: 3500
                }
            )
            .is_err()
        );
        assert!(b.writes.is_empty());
    }

    #[test]
    fn signed_and_multiturn_readback_does_not_require_single_turn_positions() {
        for (raw, ticks) in [
            (0x8044, -68),
            (0x1062, 4194),
            (0x8069, -105),
            (0x7fff, 32767),
            (0xffff, -32767),
        ] {
            let mut bus = Bus {
                writes: vec![],
                missing: None,
                position: raw,
            };
            let readings = exchange(
                &mut bus,
                &mut crate::servo_debug::settings(),
                &DeviceOp::Read,
            )
            .unwrap();
            assert!(
                readings[0].error.is_none(),
                "{raw:#06x}: {:?}",
                readings[0].error
            );
            assert_eq!(readings[0].ticks.unwrap(), ticks);
            assert!(bus.writes.is_empty());
        }
    }
}
