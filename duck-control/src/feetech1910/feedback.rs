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
fn signed_magnitude(raw: u16) -> i32 {
    let magnitude = i32::from(raw & 0x7fff);
    if raw & 0x8000 != 0 {
        -magnitude
    } else {
        magnitude
    }
}
