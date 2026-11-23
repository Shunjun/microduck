//! IMU protocol details specific to the original Dynamixel bus.
use crate::io::ImuStale;

pub const IMU_DXL_ID: u8 = 200;
pub const IMU_BLOCK_LEN: usize = crate::sflp::BLOCK_LEN;

/// The `zero3` robot's mount: the board is mounted so that trunk = `[+raw_z, +raw_y, −raw_x]`,
/// a +90° rotation about Y.
pub const DEFAULT_MOUNT: [f64; 4] = [
    std::f64::consts::FRAC_1_SQRT_2,
    0.0,
    std::f64::consts::FRAC_1_SQRT_2,
    0.0,
];

/// The `beta` robot's mount: the power board lies flat, its axes already the trunk's
/// (`x` forward, `y` left, `z` up). Read off a beta standing straight (2026-10-06): under
/// [`DEFAULT_MOUNT`] its trunk read `x` up, a 90° rotation about Y away from this.
pub const BETA_MOUNT: [f64; 4] = [1.0, 0.0, 0.0, 0.0];

/// Run of consecutive stale reads at which the journal says something.
///
/// 25 reads is half a second at 50 Hz — the same span [`crate::sflp::SflpDecoder::ready`] waits for before
/// it will call the chip's output a measurement, and far longer than any ordinary hiccup. Below
/// it the tracker stays quiet on purpose: warning on the very first repeated block is what
/// taught everyone to ignore this message. Kept in step with `ImuHealth::FROZEN_RUN`, which is
/// where the same threshold is applied to the health report — this crate is the hardware layer
/// and deliberately does not depend on the IPC vocabulary, so the number lives in both places.
pub(super) const STALE_RUN_WARN: u64 = 25;

/// Detects an IMU board that answers without refreshing, by remembering the last block.
///
/// Split out from the read path so it can be tested without a serial port: the fault it
/// describes is one nothing else on the robot reports, and it would otherwise be verifiable
/// only against broken hardware.
#[derive(Debug, Default)]
pub(super) struct StaleImuTracker {
    /// `None` until the first block. A fixed initial value cannot work here: it would have to
    /// be all zeros, and an all-zero block is exactly what a board whose SFLP table is still
    /// empty sends — scoring a stale read against a predecessor that never existed.
    last: Option<[u8; IMU_BLOCK_LEN]>,
    pub(super) stale: ImuStale,
}

impl StaleImuTracker {
    /// Records one block and returns the length of the run it belongs to — 0 when the block is
    /// fresh, which is the overwhelmingly common answer.
    pub(super) fn observe(&mut self, block: &[u8; IMU_BLOCK_LEN]) -> u64 {
        if self.last.replace(*block) == Some(*block) {
            self.stale.total = self.stale.total.saturating_add(1);
            self.stale.run = self.stale.run.saturating_add(1);
        } else {
            self.stale.run = 0;
        }
        self.stale.run
    }
}
