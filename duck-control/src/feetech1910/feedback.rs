//! HD1910 register feedback decoding.
//Compatible: HD1910 little-endian, sign-magnitude feedback.
use super::fail;
use crate::io::Result;

/// Raw feedback. Units other than voltage/temperature require HD1910 calibration.
#[derive(Debug, Clone, Copy)]
pub struct ServoFeedback {
    pub position_ticks: i32,
    pub speed_raw: i32,
    pub load_raw: u16,
    pub voltage: f64,
    pub temperature_c: u8,
    pub status: u8,
    pub moving: bool,
    pub current_raw: u16,
}
impl ServoFeedback {
    pub fn parse(raw: &[u8]) -> Result<Self> {
        if raw.len() != 15 {
            return Err(fail("servo feedback must contain 15 bytes"));
        }
        let word = |i| u16::from_le_bytes([raw[i], raw[i + 1]]);
        Ok(Self {
            position_ticks: signed_magnitude(word(0)),
            speed_raw: signed_magnitude(word(2)),
            load_raw: word(4),
            voltage: f64::from(raw[6]) * 0.1,
            temperature_c: raw[7],
            status: raw[9],
            moving: raw[10] != 0,
            current_raw: word(13),
        })
    }
}
/// Encode direction bit + 15-bit magnitude, never cast negative ticks to u16.
pub(super) fn encode_position(ticks: i32) -> Result<u16> {
    if !crate::servo_debug::valid_position(ticks) {
        return Err(fail("position outside signed register range -32767..32767"));
    }
    let magnitude = ticks.unsigned_abs() as u16;
    Ok(magnitude | if ticks < 0 { 0x8000 } else { 0 })
}

fn signed_magnitude(raw: u16) -> i32 {
    let magnitude = i32::from(raw & 0x7fff);
    if raw & 0x8000 != 0 {
        -magnitude
    } else {
        magnitude
    }
}

#[cfg(test)]
mod position_tests {
    use super::*;

    #[test]
    fn position_encoding_uses_sign_magnitude_and_rejects_two_complement_minimum() {
        for (ticks, word) in [
            (-32767, 0xffff),
            (-105, 0x8069),
            (-68, 0x8044),
            (0, 0),
            (4194, 0x1062),
            (32767, 0x7fff),
        ] {
            assert_eq!(encode_position(ticks).unwrap(), word);
            assert_eq!(signed_magnitude(word), ticks);
        }
        assert_eq!(signed_magnitude(0x8000), 0);
        for ticks in [-32768, 32768, i32::MIN, i32::MAX] {
            assert!(encode_position(ticks).is_err());
        }
    }
}
