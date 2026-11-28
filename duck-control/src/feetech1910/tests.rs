use super::*;
use crate::{
    io::{Result, RobotIo},
    model::NUM_JOINTS,
};
use std::collections::VecDeque;
#[derive(Debug, PartialEq)]
enum Request {
    Read(u8, u8, u8),
    SyncRead(Vec<u8>, u8, u8),
    Write(Vec<u8>, u8, Vec<Vec<u8>>),
}
#[derive(Default)]
struct MockBus {
    expected: VecDeque<(Request, Result<Vec<Vec<u8>>>)>,
}
impl MockBus {
    fn push(&mut self, request: Request, response: Result<Vec<Vec<u8>>>) {
        self.expected.push_back((request, response));
    }
    fn handle(&mut self, request: Request) -> Result<Vec<Vec<u8>>> {
        let (expected, response) = self.expected.pop_front().expect("unexpected bus access");
        assert_eq!(request, expected);
        response
    }
    fn identified(ids: &[u8]) -> Self {
        let mut bus = Self::default();
        bus.push(
            Request::Read(200, 0, 10),
            Ok(vec![vec![1, 0, 0, 0x44, 0x4d, 200, 0, 0, 1, 0]]),
        );
        for &id in ids {
            bus.push(Request::Read(id, 3, 2), Ok(vec![vec![10, 31]]));
            bus.push(Request::Read(id, 33, 1), Ok(vec![vec![0]]));
        }
        bus
    }
    fn feedback(&mut self, ids: &[u8], block: Vec<u8>, imu: Vec<u8>) {
        let mut read_ids = ids.to_vec();
        read_ids.push(200);
        let mut blocks = vec![block; ids.len()];
        blocks.push(imu);
        self.push(Request::SyncRead(read_ids, 56, 15), Ok(blocks));
        let mut diag = vec![0; 96];
        diag[84] = 1;
        self.push(Request::Read(200, 90, 96), Ok(vec![diag]));
    }
}
impl RegisterBus for MockBus {
    fn read(&mut self, id: u8, address: u8, length: u8) -> Result<Vec<u8>> {
        Ok(self.handle(Request::Read(id, address, length))?.remove(0))
    }
    fn sync_read(&mut self, ids: &[u8], address: u8, length: u8) -> Result<Vec<Vec<u8>>> {
        self.handle(Request::SyncRead(ids.to_vec(), address, length))
    }
    fn sync_write(&mut self, ids: &[u8], address: u8, data: &[Vec<u8>]) -> Result<()> {
        self.handle(Request::Write(ids.to_vec(), address, data.to_vec()))
            .map(|_| ())
    }
}
fn joint(id: u8) -> JointCalibration {
    JointCalibration {
        id,
        zero_ticks: 2048,
        direction: 1,
        min_ticks: 1024,
        max_ticks: 3072,
    }
}

#[test]
fn signed_targets_preserve_turns_and_encode_negative_direction_before_writing() {
    let ids = [3, 8];
    let mut mock = MockBus::identified(&ids);
    mock.push(
        Request::Write(ids.to_vec(), 42, vec![vec![0x44, 0x80], vec![0x62, 0x10]]),
        Ok(vec![]),
    );
    let mut bus = FeetechBus::new(mock, ids.to_vec(), [1., 0., 0., 0.]).unwrap();
    let calibration = [
        JointCalibration {
            id: 3,
            zero_ticks: -68,
            direction: 1,
            min_ticks: -32767,
            max_ticks: 32767,
        },
        JointCalibration {
            id: 8,
            zero_ticks: 4194,
            direction: -1,
            min_ticks: -32767,
            max_ticks: 32767,
        },
    ];
    // Reject the whole pose before any write; no clamp or modulo-4096 fallback.
    assert!(bus.write_positions(&calibration, &[f64::NAN, 0.]).is_err());
    assert!(bus.write_positions(&calibration, &[0., 100.]).is_err());
    bus.write_positions(&calibration, &[0., 0.]).unwrap();
    assert!(bus.bus.expected.is_empty());
    let data = serde_json::to_value(&calibration[0]).unwrap();
    let restored: JointCalibration = serde_json::from_value(data).unwrap();
    assert_eq!(restored.zero_ticks, -68);
}

#[test]
fn normal_control_reads_signed_and_multiturn_coordinates_without_wrapping() {
    for (raw, zero, delta) in [(0x8044_u16, -68, 0), (0x1062, 4090, 104), (0x8069, 0, -105)] {
        let ids: Vec<_> = (1..=NUM_JOINTS as u8).collect();
        let mut mock = MockBus::identified(&ids);
        let mut block = vec![0; 15];
        block[..2].copy_from_slice(&raw.to_le_bytes());
        mock.feedback(&ids, block, imu_sample(1));
        let config = Config {
            joints: std::array::from_fn(|i| JointCalibration {
                id: ids[i],
                zero_ticks: zero,
                direction: 1,
                min_ticks: -32767,
                max_ticks: 32767,
            }),
            imu_mount: [1., 0., 0., 0.],
            speed_rad_s_per_unit: 0.1,
            current_ma_per_unit: 2.,
        };
        let mut io = FeetechIo::new(mock, config).unwrap();
        let positions = io.read().unwrap().positions;
        assert!((positions[0] - f64::from(delta) * std::f64::consts::TAU / 4096.).abs() < 1e-12);
        assert!(io.bus.bus.expected.is_empty());
    }
}
fn imu_sample(n: u8) -> Vec<u8> {
    let mut bytes = vec![0; 15];
    bytes[7] = 0x80;
    bytes[12] = n;
    bytes
}
#[test]
fn mixed_bus_order_and_v1_registers_are_not_dynamixel_registers() {
    let ids = [8, 3];
    let mut mock = MockBus::identified(&ids);
    let mut block = vec![0; 15];
    block[0..2].copy_from_slice(&2048u16.to_le_bytes());
    block[2..4].copy_from_slice(&0x8002u16.to_le_bytes());
    block[6] = 74;
    block[7] = 35;
    block[13..15].copy_from_slice(&123u16.to_le_bytes());
    mock.feedback(&ids, block, imu_sample(255));
    let mut bus = FeetechBus::new(mock, ids.to_vec(), [1., 0., 0., 0.]).unwrap();
    let frame = bus.read().unwrap();
    assert_eq!(frame.servos[0].position_ticks, 2048);
    assert_eq!(frame.servos[0].speed_raw, -2);
    assert_eq!(frame.servos[0].current_raw, 123);
    assert!((frame.servos[0].voltage - 7.4).abs() < 1e-10);
    assert!(!bus.imu_ready());
    assert!(bus.bus.expected.is_empty());
}
#[test]
fn invalid_ids_and_identity_never_write() {
    for ids in [vec![200], vec![1, 1], vec![254], vec![0]] {
        assert!(FeetechBus::new(MockBus::default(), ids, [1., 0., 0., 0.]).is_err());
    }
    let mut mock = MockBus::default();
    mock.push(Request::Read(200, 0, 10), Ok(vec![vec![0; 10]]));
    assert!(FeetechBus::new(mock, vec![1], [1., 0., 0., 0.]).is_err());
    let mut mock = MockBus::identified(&[1]);
    mock.expected[1].1 = Ok(vec![vec![9, 3]]);
    assert!(FeetechBus::new(mock, vec![1], [1., 0., 0., 0.]).is_err());
}
#[test]
fn target_packet_is_little_endian_ordered_and_atomic() {
    let ids = [3, 8];
    let mut mock = MockBus::identified(&ids);
    mock.push(
        Request::Write(ids.to_vec(), 42, vec![vec![0, 12], vec![0, 4]]),
        Ok(vec![]),
    );
    let mut bus = FeetechBus::new(mock, ids.to_vec(), [1., 0., 0., 0.]).unwrap();
    let calibration = [joint(3), joint(8)];
    assert!(bus.write_positions(&calibration, &[0., f64::NAN]).is_err());
    assert!(bus.write_positions(&calibration, &[0., 10.]).is_err());
    bus.write_positions(
        &calibration,
        &[std::f64::consts::FRAC_PI_2, -std::f64::consts::FRAC_PI_2],
    )
    .unwrap();
    assert!(bus.bus.expected.is_empty());
}
#[test]
fn calibrated_robotio_matches_training_units_without_eeprom_writes() {
    let ids: Vec<_> = (1..=NUM_JOINTS as u8).collect();
    let mut mock = MockBus::identified(&ids);
    let mut block = vec![0; 15];
    block[0..2].copy_from_slice(&3072u16.to_le_bytes());
    block[2..4].copy_from_slice(&0x8002u16.to_le_bytes());
    block[6] = 80;
    block[7] = 42;
    block[13] = 3;
    mock.feedback(&ids, block, imu_sample(1));
    mock.push(
        Request::Write(ids.clone(), 40, vec![vec![0]; NUM_JOINTS]),
        Ok(vec![]),
    );
    let config = Config {
        joints: std::array::from_fn(|i| {
            let mut j = joint(ids[i]);
            j.direction = -1;
            j
        }),
        imu_mount: [1., 0., 0., 0.],
        speed_rad_s_per_unit: 0.1,
        current_ma_per_unit: 2.,
    };
    let mut io = FeetechIo::new(mock, config).unwrap();
    let sensors = io.read().unwrap();
    assert!((sensors.positions[0] + std::f64::consts::FRAC_PI_2).abs() < 1e-10);
    assert_eq!(sensors.velocities[0], 0.2);
    assert_eq!(sensors.currents_ma[0], 6.);
    assert_eq!(io.slow_sensors().unwrap().temps_c[0], 42.);
    assert!(io.reboot(1).is_err());
    io.set_torque(false).unwrap();
    assert!(io.bus.bus.expected.is_empty());
}
#[test]
fn transport_failure_clears_imu_readiness() {
    let ids = [1];
    let mut mock = MockBus::identified(&ids);
    for n in 0..25 {
        mock.feedback(&ids, vec![0; 15], imu_sample(n));
    }
    mock.push(
        Request::SyncRead(vec![1, 200], 56, 15),
        Err(fail("timeout")),
    );
    let mut bus = FeetechBus::new(mock, ids.to_vec(), [1., 0., 0., 0.]).unwrap();
    for _ in 0..25 {
        bus.read().unwrap();
    }
    assert!(bus.imu_ready());
    assert!(bus.read().is_err());
    assert!(!bus.imu_ready());
}

#[test]
fn imu_recovery_forces_a_new_warmup() {
    let ids = [1];
    let mut mock = MockBus::identified(&ids);
    for n in 0..26 {
        mock.feedback(&ids, vec![0; 15], imu_sample(n));
    }
    // A recovery can complete between two host reads; status flags may already be clear.
    let (_, reply) = mock.expected.back_mut().unwrap();
    reply.as_mut().unwrap()[0][32..36].copy_from_slice(&1u32.to_le_bytes());
    let mut bus = FeetechBus::new(mock, ids.to_vec(), [1., 0., 0., 0.]).unwrap();
    for _ in 0..25 {
        bus.read().unwrap();
    }
    assert!(bus.imu_ready());
    bus.read().unwrap();
    assert!(!bus.imu_ready());
}

#[cfg(unix)]
#[test]
fn serial_adapter_checks_wire_checksum_id_and_device_error() {
    use rustypot::DynamixelProtocolHandler;
    use serialport::SerialPort;
    use std::io::{Read, Write};
    use std::time::Duration;
    for fault in 0..4 {
        let (mut master, mut slave) = serialport::TTYPort::pair().unwrap();
        master.set_timeout(Duration::from_secs(1)).unwrap();
        slave.set_timeout(Duration::from_millis(100)).unwrap();
        let (done_tx, done_rx) = std::sync::mpsc::channel();
        let peer = std::thread::spawn(move || {
            let mut instruction = [0; 8];
            master.read_exact(&mut instruction).unwrap();
            // Firmware's FT-SCS READ(200, address=0, length=10), including checksum.
            assert_eq!(instruction, [255, 255, 200, 4, 2, 0, 10, 39]);
            let mut reply = vec![255, 255, 200, 12, 0, 1, 0, 0, 0x44, 0x4d, 200, 0, 0, 1, 0];
            if fault == 1 {
                reply[4] = 4;
            }
            if fault == 2 {
                reply[2] = 199;
            }
            let checksum = !reply[2..].iter().fold(0u8, |a, b| a.wrapping_add(*b));
            reply.push(if fault == 3 { checksum ^ 1 } else { checksum });
            master.write_all(&reply).unwrap();
            master.flush().unwrap();
            let _ = done_rx.recv_timeout(Duration::from_secs(1));
        });
        let mut bus = SerialBus {
            port: Box::new(slave),
            protocol: DynamixelProtocolHandler::v1(),
        };
        let result = bus.read(200, 0, 10);
        assert_eq!(
            result.is_ok(),
            fault == 0,
            "fault={fault}, result={result:?}"
        );
        done_tx.send(()).unwrap();
        peer.join().unwrap();
    }
}

#[test]
fn gain_write_preserves_the_servo_lock_setting() {
    let ids = [3, 8];
    let mut mock = MockBus::identified(&ids);
    mock.push(
        Request::Write(ids.to_vec(), 21, vec![vec![32]; 2]),
        Ok(vec![]),
    );
    mock.push(
        Request::SyncRead(ids.to_vec(), 21, 1),
        Ok(vec![vec![32]; 2]),
    );
    let mut bus = FeetechBus::new(mock, ids.to_vec(), [1., 0., 0., 0.]).unwrap();
    assert!(bus.set_position_gain(255).is_err());
    bus.set_position_gain(32).unwrap();
    assert!(bus.bus.expected.is_empty()); // no address 55 read/write, nor I/D write
}

#[test]
fn mismatched_gain_readback_and_write_failure_are_reported() {
    let ids = [3];
    let mut mock = MockBus::identified(&ids);
    mock.push(Request::Write(ids.to_vec(), 21, vec![vec![32]]), Ok(vec![]));
    mock.push(Request::SyncRead(ids.to_vec(), 21, 1), Ok(vec![vec![31]]));
    let mut bus = FeetechBus::new(mock, ids.to_vec(), [1., 0., 0., 0.]).unwrap();
    assert!(
        bus.set_position_gain(32)
            .unwrap_err()
            .to_string()
            .contains("readback")
    );
    let mut mock = MockBus::identified(&ids);
    mock.push(
        Request::Write(ids.to_vec(), 21, vec![vec![32]]),
        Err(fail("timeout")),
    );
    let mut bus = FeetechBus::new(mock, ids.to_vec(), [1., 0., 0., 0.]).unwrap();
    assert!(
        bus.set_position_gain(32)
            .unwrap_err()
            .to_string()
            .contains("timeout")
    );
    assert!(bus.bus.expected.is_empty());
}

#[test]
fn robotio_gain_writes_direct_p_and_rejects_overflow_without_io() {
    let ids = JOINT_IDS_FOR_TEST;
    let mut mock = MockBus::identified(&ids);
    mock.push(
        Request::Write(ids.to_vec(), 21, vec![vec![180]; NUM_JOINTS]),
        Ok(vec![]),
    );
    mock.push(
        Request::SyncRead(ids.to_vec(), 21, 1),
        Ok(vec![vec![180]; NUM_JOINTS]),
    );
    let config = Config {
        joints: std::array::from_fn(|i| joint(ids[i])),
        imu_mount: [1., 0., 0., 0.],
        speed_rad_s_per_unit: 0.1,
        current_ma_per_unit: 2.,
    };
    let mut io = FeetechIo::new(mock, config).unwrap();
    assert!(io.set_gain(u16::MAX).is_err());
    assert!(io.set_gain(255).is_err());
    io.set_gain(180).unwrap();
    assert!(io.bus.bus.expected.is_empty());
}
const JOINT_IDS_FOR_TEST: [u8; NUM_JOINTS] = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15];

#[test]
fn debug_output_limit_uses_ram_and_verifies_readback() {
    use crate::servo_debug::{DeviceOp, SimDevice};
    let mut settings = SimDevice::default().joints;
    let mut mock = MockBus::default();
    mock.push(Request::Read(20, 3, 2), Ok(vec![vec![10, 31]]));
    mock.push(Request::Read(20, 33, 1), Ok(vec![vec![4]]));
    mock.push(Request::Write(vec![20], 48, vec![vec![50, 0]]), Ok(vec![]));
    mock.push(Request::Read(20, 48, 2), Ok(vec![vec![50, 0]]));
    super::debug::exchange(
        &mut mock,
        &mut settings,
        &DeviceOp::OutputLimit { id: 20, limit: 50 },
    )
    .unwrap();
    assert!(mock.expected.is_empty());
    assert!(
        super::debug::exchange(
            &mut mock,
            &mut settings,
            &DeviceOp::OutputLimit {
                id: 20,
                limit: 1001
            }
        )
        .is_err()
    );
}

#[test]
fn debug_output_limit_rejects_mismatched_readback() {
    use crate::servo_debug::{DeviceOp, SimDevice};
    let mut mock = MockBus::default();
    mock.push(Request::Read(20, 3, 2), Ok(vec![vec![10, 31]]));
    mock.push(Request::Read(20, 33, 1), Ok(vec![vec![4]]));
    mock.push(Request::Write(vec![20], 48, vec![vec![250, 0]]), Ok(vec![]));
    mock.push(Request::Read(20, 48, 2), Ok(vec![vec![232, 3]]));
    let result = super::debug::exchange(
        &mut mock,
        &mut SimDevice::default().joints,
        &DeviceOp::OutputLimit { id: 20, limit: 250 },
    );
    assert!(
        result
            .unwrap_err()
            .to_string()
            .contains("readback mismatch")
    );
    assert!(mock.expected.is_empty());
}
