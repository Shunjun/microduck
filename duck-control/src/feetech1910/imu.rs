//! Host decoder for imu_to_dxl firmware-1.0.0, not the original Protocol 2 board.
use std::time::{Duration, Instant};

use super::fail;
use crate::imu::ImuData;
use crate::io::{ImuStale, Result};
use crate::sflp::{SflpDecoder, half};

pub const IMU_ID: u8 = 200;
pub const MAX_SAMPLE_AGE: Duration = Duration::from_millis(100);

/// The 96-byte diagnostic map in firmware-1.0.0 (address 90, revision 1).
#[derive(Debug, Clone, Copy)]
pub struct ImuDiagnostics {
    pub gyro_age_ms: u32,
    pub quat_age_ms: u32,
    pub recovery_count: u32,
    pub revision: u32,
}

impl ImuDiagnostics {
    pub fn parse(raw: &[u8]) -> Result<Self> {
        if raw.len() != 96 {
            return Err(fail("IMU diagnostics must contain 96 bytes"));
        }
        let word =
            |index: usize| u32::from_le_bytes(raw[index * 4..index * 4 + 4].try_into().unwrap());
        let value = Self {
            gyro_age_ms: word(3),
            quat_age_ms: word(4),
            recovery_count: word(8),
            revision: word(21),
        };
        if value.revision != 1 {
            return Err(fail("unsupported IMU diagnostic revision (expected 1)"));
        }
        Ok(value)
    }

    pub fn fresh(&self) -> bool {
        self.gyro_age_ms <= MAX_SAMPLE_AGE.as_millis() as u32
            && self.quat_age_ms <= MAX_SAMPLE_AGE.as_millis() as u32
    }
}

/// Readiness counts distinct samples. A fault or transport error clears the warm-up.
pub struct ImuV1 {
    decoder: SflpDecoder,
    mount: [f64; 4],
    last: Option<(u8, Instant)>,
    output: ImuData,
    stale: ImuStale,
}

impl ImuV1 {
    pub fn new(mount: [f64; 4]) -> Result<Self> {
        let norm = mount.iter().map(|v| v * v).sum::<f64>();
        if !norm.is_finite() || (norm - 1.0).abs() > 1e-6 {
            return Err(fail("IMU mount must be a unit quaternion [w,x,y,z]"));
        }
        Ok(Self {
            decoder: SflpDecoder::new(mount),
            mount,
            last: None,
            output: ImuData::default(),
            stale: ImuStale::default(),
        })
    }

    pub fn invalidate(&mut self) {
        self.decoder = SflpDecoder::new(self.mount);
        self.last = None;
    }

    pub fn ready(&self) -> bool {
        self.decoder.ready()
            && self
                .last
                .is_some_and(|(_, time)| time.elapsed() <= MAX_SAMPLE_AGE)
    }

    pub fn stale(&self) -> ImuStale {
        self.stale
    }

    pub fn decode(&mut self, raw: &[u8]) -> Result<ImuData> {
        self.decode_at(raw, Instant::now())
    }

    fn decode_at(&mut self, raw: &[u8], now: Instant) -> Result<ImuData> {
        let result = self.decode_checked(raw, now);
        if result.is_err() {
            self.invalidate();
        }
        result
    }

    fn decode_checked(&mut self, raw: &[u8], now: Instant) -> Result<ImuData> {
        if raw.len() != 15 {
            return Err(fail("IMU fast block must contain 15 bytes"));
        }
        //Compatible: FT firmware 1.0.0 uses 68=counter, 69=flags, 70=reserved.
        // Reader-too-slow (bit 3) is diagnostic; bits 0..2 invalidate orientation.
        if raw[13] & 0xf7 != 0 || raw[14] != 0 {
            return Err(fail(
                "IMU reports invalid fusion, sensor failure or unknown flags",
            ));
        }
        let packed: [u16; 3] =
            std::array::from_fn(|i| u16::from_le_bytes([raw[6 + i * 2], raw[7 + i * 2]]));
        let xyz = packed.map(half);
        if packed == [0; 3]
            || !xyz.iter().all(|v| v.is_finite())
            || xyz.iter().map(|v| v * v).sum::<f64>() > 1.02
        {
            return Err(fail("IMU quaternion is uninitialized or invalid"));
        }
        if let Some((counter, changed)) = self.last {
            // Even an advancing counter cannot certify a sample after a long host pause.
            if now.duration_since(changed) > MAX_SAMPLE_AGE {
                self.invalidate();
                return Err(fail("IMU sample expired; waiting for fresh warm-up"));
            }
            if counter == raw[12] {
                self.stale.total += 1;
                self.stale.run += 1;
                return Ok(self.output);
            }
        }
        self.stale.run = 0;
        self.last = Some((raw[12], now));
        self.output = self.decoder.decode(raw[..12].try_into().unwrap());
        Ok(self.output)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn sample(counter: u8) -> [u8; 15] {
        let mut raw = [0; 15];
        // Negative zero encodes identity without the firmware's all-zero sentinel.
        raw[7] = 0x80;
        raw[12] = counter;
        raw
    }
    #[test]
    fn repeated_packets_do_not_warm_up_and_counter_wrap_is_fresh() {
        let mut imu = ImuV1::new([1., 0., 0., 0.]).unwrap();
        let now = Instant::now();
        for _ in 0..30 {
            imu.decode_at(&sample(255), now).unwrap();
        }
        assert!(!imu.decoder.ready());
        assert_eq!(imu.stale.run, 29);
        for n in 0..24 {
            imu.decode_at(&sample(n), now).unwrap();
        }
        assert!(imu.decoder.ready());
        assert_eq!(imu.stale.run, 0);
        let mut bad = sample(24);
        bad[13] = 2;
        assert!(imu.decode_at(&bad, now).is_err());
        assert!(!imu.decoder.ready());
    }
    #[test]
    fn frozen_sensor_expires_and_recovery_needs_warmup() {
        let mut imu = ImuV1::new([1., 0., 0., 0.]).unwrap();
        let now = Instant::now();
        imu.decode_at(&sample(1), now).unwrap();
        assert!(
            imu.decode_at(&sample(1), now + Duration::from_millis(101))
                .is_err()
        );
        imu.decode_at(&sample(2), now + Duration::from_millis(102))
            .unwrap();
        assert!(!imu.decoder.ready());
    }
    #[test]
    fn reject_nan_zero_unknown_flags_and_wrong_diagnostic_map() {
        for fault in 0..4 {
            let mut raw = sample(1);
            match fault {
                0 => raw[7] = 0,
                1 => {
                    raw[6] = 1;
                    raw[7] = 0x7c;
                }
                2 => raw[13] = 0x10,
                _ => raw[14] = 1,
            }
            assert!(ImuV1::new([1., 0., 0., 0.]).unwrap().decode(&raw).is_err());
        }
        let mut diag = [0; 96];
        assert!(ImuDiagnostics::parse(&diag).is_err());
        diag[84] = 1;
        diag[12..16].copy_from_slice(&101u32.to_le_bytes());
        assert!(!ImuDiagnostics::parse(&diag).unwrap().fresh());
    }
}
