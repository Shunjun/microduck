use super::*;

/// One silent servo is the only case a swap can be inferred from. With two silent there is
/// no telling which the fresh servo replaces, and guessing would flash a leg joint as a neck
/// joint; with none silent a stray fresh servo is nobody's replacement.
#[test]
fn a_replacement_is_inferred_only_from_exactly_one_missing_servo() {
    assert_eq!(replacement_target(&[]), None);
    assert_eq!(replacement_target(&[23]), Some(23));
    assert_eq!(replacement_target(&[23, 31]), None);
    assert_eq!(replacement_target(&JOINT_IDS), None);
}

/// The block parsed per servo must cover current, velocity and position without
/// overrunning. If `READ_LEN` and the offsets below ever disagree, joints get each
/// other's values — which reads as a wiring fault, not a code bug.
#[test]
fn read_block_is_long_enough_for_every_field() {
    assert_eq!(READ_LEN as usize, IMU_BLOCK_LEN);
    // Highest offset touched by the parser below is position at 8..12.
    const { assert!(READ_LEN >= 12) };
}

/// The conversion must agree with rustypot's own `AnglePosition`, which is what
/// `sync_write_goal_position` uses on the way out. A mismatch would mean the loop
/// commands a different angle than it believes it read back.
#[test]
fn position_conversion_round_trips_through_rustypot() {
    for raw in [0i32, 1024, 2048, 3072, 4095] {
        let ours = (2.0 * PI * raw as f64 / 4096.0) - PI;
        let theirs = (4096.0 * (PI + ours) / (2.0 * PI)) as i32;
        assert_eq!(theirs, raw, "raw {raw} did not survive the round trip");
    }
}

/// 0.229 rev/min per count. Getting this wrong scales every joint velocity in the
/// observation vector by a constant, which a policy tolerates just well enough to walk
/// badly.
#[test]
fn velocity_scale_matches_the_datasheet_figure() {
    let one_count = RAD_PER_SEC_PER_COUNT;
    let expected_rpm = 0.229;
    assert!((one_count * 60.0 / (2.0 * PI) - expected_rpm).abs() < 1e-12);
}

fn block(n: u8) -> [u8; IMU_BLOCK_LEN] {
    [n; IMU_BLOCK_LEN]
}

/// The first block has no predecessor, so it cannot be a repeat of one. This is not a
/// hypothetical: the natural initial value is all zeros, and an all-zero block is what a
/// board sends before SFLP has written its table — which used to score a stale read on the
/// very first tick of every boot, and put a permanent 1 in a counter rendered as an alarm.
#[test]
fn the_first_block_is_never_stale() {
    let mut t = StaleImuTracker::default();
    assert_eq!(t.observe(&block(0)), 0);
    assert_eq!(t.stale.total, 0);
}

/// Fresh blocks must leave both counters alone. The whole point of the run is that it means
/// "right now", so anything that does not repeat has to clear it.
#[test]
fn fresh_blocks_count_for_nothing() {
    let mut t = StaleImuTracker::default();
    for n in 0..10 {
        assert_eq!(t.observe(&block(n)), 0);
    }
    assert_eq!(t.stale, ImuStale { total: 0, run: 0 });
}

/// A hiccup: two identical blocks, then the board recovers. The total remembers it — that
/// is what makes "9 over 40 minutes" sayable — while the run goes back to zero, because
/// orientation is live again and nothing should be shouting.
#[test]
fn a_hiccup_is_remembered_in_the_total_but_not_the_run() {
    let mut t = StaleImuTracker::default();
    t.observe(&block(1));
    assert_eq!(t.observe(&block(1)), 1, "the repeat is the first of a run");
    assert_eq!(t.observe(&block(2)), 0, "a fresh block ends the run");
    assert_eq!(t.stale, ImuStale { total: 1, run: 0 });
}

/// A board that has stopped refreshing repeats forever, and the run is what separates that
/// from the hiccup above. It has to reach the threshold the journal and the health report
/// both key off, or a genuinely dead IMU is never reported at all.
#[test]
fn a_dead_board_runs_past_the_warning_threshold() {
    let mut t = StaleImuTracker::default();
    t.observe(&block(7));
    for _ in 0..STALE_RUN_WARN {
        t.observe(&block(7));
    }
    assert_eq!(t.stale.run, STALE_RUN_WARN);
    assert_eq!(t.stale.total, STALE_RUN_WARN);
}

/// Runs accumulate into the same total across separate episodes: the total is "how often
/// has this ever happened", not "how bad is it now".
#[test]
fn separate_episodes_add_up() {
    let mut t = StaleImuTracker::default();
    for n in 0..3u8 {
        t.observe(&block(n));
        t.observe(&block(n));
        t.observe(&block(n));
    }
    assert_eq!(t.stale.total, 6, "two repeats in each of three episodes");
    assert_eq!(t.stale.run, 2, "the last episode was still going");
}
