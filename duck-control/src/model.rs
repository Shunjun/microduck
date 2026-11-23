//! Shared joint semantics, training poses and battery model.
//! Servo registers, bus IDs and encoder offsets live in each hardware driver.
//!
//! One variant — **alpha** — because that is the only robot that exists. Every shipped
//! policy is `alpha_*`; v1/v1.5/v1.6 are history. A second revision becomes a second set
//! of tables, which is honest until there is a second robot to generalise from.
//!
//! Shared poses and battery values are lifted from `microduck_runtime`'s `motor.rs`, where they
//! were measured against hardware rather than derived. Re-deriving them from a datasheet
//! is exactly the kind of change that looks right and walks wrong.

/// Left leg (5) · neck/head/mouth (5) · right leg (5).
pub const NUM_JOINTS: usize = 15;

/// Joint names, from the protocol crate — the wire indexes `joints` and `targets`
/// positionally, so that order and this one cannot be allowed to drift apart. The
/// assertion below is what makes "cannot" true.
pub use duck_ipc_proto::JOINT_NAMES;

const _: () = assert!(JOINT_NAMES.len() == NUM_JOINTS);

/// The mouth is absent from every alpha policy — they are all 61-D observation, 14-action,
/// and the action vector skips this index. Named so that omission is deliberate rather
/// than an off-by-one someone has to rediscover.
pub const MOUTH_INDEX: usize = 9;

/// Home pose. The trunk sits ~5 mm further forward than the v1.5 pose so the CoM is over
/// the ankle axis; the old pose biased the robot backwards.
///
/// Must match `HOME_FRAME` in the training env — a policy is trained against these angles
/// and observes joint positions *relative* to them, so a discrepancy here is a constant
/// offset on 14 observation slots.
pub const DEFAULT_POSITION: [f64; NUM_JOINTS] = [
    0.0,     // left_hip_yaw
    -0.0873, // left_hip_roll
    -0.4579, // left_hip_pitch
    -0.0049, // left_knee
    0.4530,  // left_ankle
    0.3491,  // neck_pitch
    0.3491,  // head_pitch
    0.0,     // head_yaw
    0.0,     // head_roll
    0.0,     // mouth
    0.0,     // right_hip_yaw
    0.0873,  // right_hip_roll
    0.4579,  // right_hip_pitch
    0.0049,  // right_knee
    -0.4530, // right_ankle
];

/// Rest pose: where a seated robot settles with its torque off. Recorded on graphite-bang
/// sitting stably untorqued (2026-10-03), averaged over a second of samples.
///
/// The shutdown eases the joints here from the policy's seat before cutting torque. The seat
/// the sitstand network holds is not where the robot comes to rest once nothing holds it, so
/// cutting torque straight from the seat let the robot sag forward. Arriving here first, it
/// is already where it would fall to.
pub const REST_POSITION: [f64; NUM_JOINTS] = [
    0.3129,  // left_hip_yaw
    0.4050,  // left_hip_roll
    -0.2338, // left_hip_pitch
    1.5493,  // left_knee
    0.5522,  // left_ankle
    0.9572,  // neck_pitch
    1.4787,  // head_pitch
    -0.0129, // head_yaw
    -0.0522, // head_roll
    -0.0121, // mouth
    0.0353,  // right_hip_yaw
    -0.5660, // right_hip_roll
    0.2853,  // right_hip_pitch
    -1.4696, // right_knee
    -0.4096, // right_ankle
];

/// Mouth travel, radians: closed and fully open. The alpha reuses the v1.6 range,
/// −5°..+30°, from `microduck_runtime`'s `variant.rs`.
///
/// The mouth is not part of any policy — every alpha network is 14 actions with this joint
/// skipped — so these two numbers and [`mouth_target`] are the whole of mouth control.
pub const MOUTH_CLOSED: f64 = -5.0 * std::f64::consts::PI / 180.0;
pub const MOUTH_OPEN: f64 = 30.0 * std::f64::consts::PI / 180.0;

/// Joint angle for a mouth opening fraction. 0 is closed, 1 is fully open; anything outside
/// is clamped rather than fed to a servo as an out-of-travel target.
pub fn mouth_target(open: f64) -> f64 {
    let open = if open.is_finite() {
        open.clamp(0.0, 1.0)
    } else {
        0.0
    };
    MOUTH_CLOSED + open * (MOUTH_OPEN - MOUTH_CLOSED)
}

/// Index of a joint by name. Linear scan over 15 entries, used at startup and in tests.
pub fn joint_index(name: &str) -> Option<usize> {
    JOINT_NAMES.iter().position(|n| *n == name)
}

// ── battery ──────────────────────────────────────────────────────────────────
//
// There is no fuel gauge and no ADC. The only measurement available is what the servos
// report as their own supply through bus feedback, which is the pack
// seen through the bus — so it sags under load and recovers when the robot stands still.
// That is why the span below is *usable-under-load*, not the cell chemistry's range.
//
// The span is a statement about the *rail*, and it holds because that rail is the pack: the
// servos are fed the 2S battery, not a regulated 5 V. A servo on a bench supply reads its own
// supply voltage like any other, so 5 V lands under `BATTERY_EMPTY_V` and maps to 0% — the
// mapping working as defined rather than a fault to chase. Anything that regulates the servo
// rail has to move these two constants with it.

/// Off a full charge, under load. NP-F550, 2S Li-ion.
pub const BATTERY_FULL_V: f64 = 8.2;

/// The sag floor: below this the robot starts struggling, well before the pack's own
/// protection trips. Empty for our purposes, not empty for the cells'.
pub const BATTERY_EMPTY_V: f64 = 6.6;

/// Fraction of a pack, 0–100, for a bus voltage.
///
/// Linear, and the numbers come from `microduck_runtime`'s `check_battery`, where they were
/// arrived at by running a duck flat. It lives here rather than in `robotd` so there is one
/// mapping: the prototype had it in a CLI *and* re-derived in the app, which is how two
/// screens end up disagreeing about the same pack.
///
/// A non-finite or non-positive reading is 0 — those mean "no answer from the bus", and the
/// caller is expected to report that as unknown rather than to display this number.
pub fn battery_percent(volts: f64) -> f64 {
    if !volts.is_finite() || volts <= 0.0 {
        return 0.0;
    }
    ((volts - BATTERY_EMPTY_V) / (BATTERY_FULL_V - BATTERY_EMPTY_V)).clamp(0.0, 1.0) * 100.0
}

// ── voltage-compensated PWM ──────────────────────────────────────────────────
//
// The servos drive their motor with PWM straight off the pack, so a full 8.2 V pack puts
// 8.2 V across the motor at 100 % duty, where a nearly flat one puts 6.2 V. Capping Goal PWM
// at `MOTOR_MAX_V / pack` keeps the most the motor ever sees at about 6 V whatever the charge:
// the robot behaves the same at the top of the pack as near the bottom, and the gears are not
// asked for the extra torque a fresh pack would otherwise hand them.
//
// Goal PWM (100, RAM) rather than PWM Limit (36, EEPROM): PWM Limit only reaches Goal PWM at
// boot, so changing it would need a reboot per servo. Goal PWM takes effect at once and is
// itself capped by PWM Limit, which nothing here writes and so stays at its factory 885.

/// Goal PWM at 100 % duty: the XL330's factory PWM Limit.
pub const GOAL_PWM_MAX: u16 = 885;

/// The most the motor should see, in volts. Goal PWM is set to this fraction of the pack.
pub const MOTOR_MAX_V: f64 = 6.0;

/// Goal PWM that puts at most [`MOTOR_MAX_V`] across the motor on a pack at `volts`.
///
/// 8.2 V (full) gives 648, 73 %; 6.2 V gives 856, 97 %; at or below 6 V, 885. `None` for a
/// non-finite or non-positive reading — "no answer from the bus", the same meaning
/// [`battery_percent`] gives it — so the caller leaves the servos where they are rather than
/// guessing a pack.
pub fn goal_pwm_for(volts: f64) -> Option<u16> {
    if !volts.is_finite() || volts <= 0.0 {
        return None;
    }
    let fraction = (MOTOR_MAX_V / volts).min(1.0);
    Some((fraction * GOAL_PWM_MAX as f64).round() as u16)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The three tables are indexed by the same integer everywhere in the crate. If they
    /// ever diverge in length, every lookup silently reads the wrong joint.
    #[test]
    fn tables_agree_on_length() {
        assert_eq!(JOINT_NAMES.len(), NUM_JOINTS);
        assert_eq!(DEFAULT_POSITION.len(), NUM_JOINTS);
    }

    #[test]
    fn mouth_index_names_the_mouth() {
        assert_eq!(JOINT_NAMES[MOUTH_INDEX], "mouth");
        assert_eq!(joint_index("mouth"), Some(MOUTH_INDEX));
    }

    /// The ends of the span and the middle of it. Getting the direction wrong here would
    /// report a full pack as flat, which is the kind of thing nobody double-checks.
    #[test]
    fn battery_percent_spans_the_usable_range() {
        assert_eq!(battery_percent(BATTERY_FULL_V), 100.0);
        assert_eq!(battery_percent(BATTERY_EMPTY_V), 0.0);
        assert!((battery_percent(7.4) - 50.0).abs() < 0.001);
    }

    /// Voltages outside the span are ordinary — a fresh pack reads over 8.2 V off the
    /// charger, and a robot being run into the ground reads under 6.6 V. Neither may
    /// produce a percentage outside 0–100 for a caller to display.
    #[test]
    fn battery_percent_clamps_rather_than_extrapolating() {
        assert_eq!(battery_percent(9.5), 100.0);
        assert_eq!(battery_percent(5.0), 0.0);
    }

    /// A bus that did not answer arrives here as 0.0, and NaN is what a mean over an empty
    /// set produces. Both must be 0 rather than a wild number a caller might print.
    #[test]
    fn goal_pwm_holds_the_motor_at_six_volts() {
        assert_eq!(goal_pwm_for(BATTERY_FULL_V), Some(648));
        assert_eq!(goal_pwm_for(6.2), Some(856));
        assert_eq!(goal_pwm_for(MOTOR_MAX_V), Some(GOAL_PWM_MAX));
        // A pack below the motor's voltage cannot be compensated for: full duty, never more.
        assert_eq!(goal_pwm_for(5.0), Some(GOAL_PWM_MAX));
        for v in [6.5, 7.0, 7.4, 8.0, 8.4] {
            let pwm = goal_pwm_for(v).unwrap();
            let motor_v = v * pwm as f64 / GOAL_PWM_MAX as f64;
            assert!(
                (motor_v - MOTOR_MAX_V).abs() < 0.01,
                "{v} V → {pwm} → {motor_v} V"
            );
        }
    }

    #[test]
    fn goal_pwm_is_not_guessed_without_a_reading() {
        assert_eq!(goal_pwm_for(0.0), None);
        assert_eq!(goal_pwm_for(-1.0), None);
        assert_eq!(goal_pwm_for(f64::NAN), None);
    }

    #[test]
    fn battery_percent_treats_no_reading_as_zero() {
        assert_eq!(battery_percent(0.0), 0.0);
        assert_eq!(battery_percent(f64::NAN), 0.0);
        assert_eq!(battery_percent(-1.0), 0.0);
    }

    /// The mouth range is the prototype's: −5° closed, +30° open. A fraction outside 0..1
    /// (or a NaN from a broken client) must clamp rather than command a servo past travel.
    #[test]
    fn mouth_target_spans_the_prototype_range() {
        assert!((mouth_target(0.0) - (-5.0f64.to_radians())).abs() < 1e-12);
        assert!((mouth_target(1.0) - 30.0f64.to_radians()).abs() < 1e-12);
        assert_eq!(mouth_target(-3.0), mouth_target(0.0));
        assert_eq!(mouth_target(7.0), mouth_target(1.0));
        assert_eq!(mouth_target(f64::NAN), mouth_target(0.0));
    }

    /// The legs are mirrored: the roll/pitch/ankle pairs are equal and opposite. A sign
    /// typo in the home pose is invisible by inspection and makes the robot stand crooked.
    #[test]
    fn home_pose_legs_are_mirrored() {
        for (left, right) in [
            ("left_hip_roll", "right_hip_roll"),
            ("left_hip_pitch", "right_hip_pitch"),
            ("left_knee", "right_knee"),
            ("left_ankle", "right_ankle"),
        ] {
            let l = DEFAULT_POSITION[joint_index(left).unwrap()];
            let r = DEFAULT_POSITION[joint_index(right).unwrap()];
            assert!(
                (l + r).abs() < 1e-9,
                "{left} ({l}) and {right} ({r}) should be equal and opposite"
            );
        }
    }
}
