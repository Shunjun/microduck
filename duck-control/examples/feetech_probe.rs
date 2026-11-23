//! Read-only FT-SCS probe. No torque, motion, EEPROM writes, or ID scans.
use duck_control::feetech1910::FeetechBus;
use std::time::{Duration, Instant};
fn main() -> Result<(), Box<dyn std::error::Error>> {
    let args: Vec<_> = std::env::args().collect();
    if args.len() != 4 {
        return Err("usage: feetech_probe PORT SERVO_IDS_CSV|- MOUNT_W,X,Y,Z\nuse '-' for IMU only; mount is sensor-to-trunk".into());
    }
    let ids = if args[2] == "-" {
        vec![]
    } else {
        args[2]
            .split(',')
            .map(str::parse)
            .collect::<Result<Vec<u8>, _>>()?
    };
    let mount: [f64; 4] = args[3]
        .split(',')
        .map(str::parse)
        .collect::<Result<Vec<f64>, _>>()?
        .try_into()
        .map_err(|_| "mount needs 4 numbers")?;
    let mut bus = FeetechBus::open(&args[1], ids, mount)?;
    for tick in 0..250 {
        let started = Instant::now();
        let frame = bus.read()?;
        if tick % 25 == 0 {
            println!(
                "ready={} stale={:?} gyro={:?} gravity={:?} diag={:?}",
                bus.imu_ready(),
                bus.imu_stale(),
                frame.imu.gyro,
                frame.imu.gravity,
                frame.diagnostics
            );
            for (index, servo) in frame.servos.iter().enumerate() {
                println!("joint[{index}] {servo:?}");
            }
        }
        std::thread::sleep(Duration::from_millis(20).saturating_sub(started.elapsed()));
    }
    if !bus.imu_ready() {
        return Err("IMU did not complete fresh-sample warm-up".into());
    }
    Ok(())
}
