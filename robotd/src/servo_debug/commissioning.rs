//! Reference-first commissioning. All motion remains on the robotd control thread.
use super::*;

pub(super) struct JointEvidence {
    pub id: u8,
    pub positive_ticks: i32,
    pub negative_ticks: i32,
    pub min_ticks: i32,
    pub max_ticks: i32,
    pub mirror: bool,
}

impl Controller {
    fn stable_reference(&self) -> Result<[i32; NUM_JOINTS], String> {
        self.positions()?;
        if self.status.moving
            || self.samples.len() < 8
            || self.samples.front().unwrap().0.elapsed() < Duration::from_millis(750)
        {
            return Err("keep the standard pose still for at least one second".into());
        }
        let mut pose = [0; NUM_JOINTS];
        for (i, ticks) in pose.iter_mut().enumerate() {
            let low = self.samples.iter().map(|(_, p)| p[i]).min().unwrap();
            let high = self.samples.iter().map(|(_, p)| p[i]).max().unwrap();
            if high - low > 8 {
                return Err(format!(
                    "servo {} is moving; hold the reference pose still",
                    JOINT_IDS[i]
                ));
            }
            *ticks = (self
                .samples
                .iter()
                .map(|(_, p)| i64::from(p[i]))
                .sum::<i64>()
                / self.samples.len() as i64) as i32;
            if !duck_control::servo_debug::valid_position(*ticks) {
                return Err("reference exceeds the position register range".into());
            }
        }
        Ok(pose)
    }
    pub(super) fn capture_reference<T: duck_control::RobotIo>(
        &mut self,
        path: &Path,
        io: &mut duck_control::safety::Safety<T>,
    ) -> Result<(), String> {
        if !self.status.calibration_required {
            return Err("reference-first capture is for commissioning only".into());
        }
        let pose = self.stable_reference()?;
        // Do not invent a sign or an axis-zero before observing direction. Saving a
        // new reference invalidates previous directions and endpoint measurements.
        let joints = duck_control::servo_debug::settings();
        self.save_guided(
            path,
            io,
            joints,
            pose,
            [false; NUM_JOINTS],
            [false; NUM_JOINTS],
        )
    }
    pub(super) fn calibrate_joint<T: duck_control::RobotIo>(
        &mut self,
        path: &Path,
        io: &mut duck_control::safety::Safety<T>,
        evidence: JointEvidence,
    ) -> Result<(), String> {
        let JointEvidence {
            id,
            positive_ticks,
            negative_ticks,
            min_ticks,
            max_ticks,
            mirror,
        } = evidence;
        if !self.status.calibration_required {
            return Err("guided joint calibration is for commissioning only".into());
        }
        let pose = self
            .status
            .reference_ticks
            .ok_or("save the standard pose first")?;
        let i = JOINT_IDS
            .iter()
            .position(|j| *j == id)
            .ok_or("unknown joint")?;
        let positive = i64::from(positive_ticks) - i64::from(pose[i]);
        let negative = i64::from(negative_ticks) - i64::from(pose[i]);
        let demonstration = if i == 9 { 5. } else { 10. };
        let minimum = demonstration * 0.4 * 4096. / 360.;
        let maximum = demonstration * 2. * 4096. / 360.;
        if positive.signum() == negative.signum()
            || !(minimum..=maximum).contains(&(positive.abs() as f64))
            || !(minimum..=maximum).contains(&(negative.abs() as f64))
        {
            return Err(format!(
                "servo {id}: record opposite rotations matching the model demonstration"
            ));
        }
        if [positive_ticks, negative_ticks, min_ticks, max_ticks]
            .iter()
            .any(|v| !duck_control::servo_debug::valid_position(*v))
            || min_ticks >= max_ticks
            || [pose[i], positive_ticks, negative_ticks]
                .iter()
                .any(|v| !(min_ticks..=max_ticks).contains(v))
        {
            return Err(format!(
                "servo {id}: endpoints must contain the reference and both direction samples"
            ));
        }
        let direction = positive.signum() as i8;
        let mut joints = self.status.settings;
        joints[i] = JointSetting {
            id,
            direction: Some(direction),
            zero_ticks: Some(
                zero_for_pose(pose[i], direction, DEFAULT_POSITION[i])
                    .map_err(|e| e.to_string())?,
            ),
            min_ticks: Some(min_ticks),
            max_ticks: Some(max_ticks),
        };
        reference_target(joints[i], DEFAULT_POSITION[i])?;
        let mut done = self.status.joint_calibrated;
        let mut mirrored = self.status.mirrored;
        done[i] = true;
        mirrored[i] = false;
        if mirror {
            if i >= 5 {
                return Err("only left-leg joints have an automatic right-leg pair".into());
            }
            let peer = i + 10;
            //Compatible: the supplied symmetric CAD uses the same local encoder-axis
            // convention on both legs, with opposite model angles. Infer the peer
            // direction, but keep its measured reference and mark it as inferred.
            joints[peer] = JointSetting {
                id: JOINT_IDS[peer],
                direction: Some(direction),
                zero_ticks: Some(
                    zero_for_pose(pose[peer], direction, DEFAULT_POSITION[peer])
                        .map_err(|e| e.to_string())?,
                ),
                min_ticks: Some(pose[peer] - (max_ticks - pose[i])),
                max_ticks: Some(pose[peer] - (min_ticks - pose[i])),
            };
            reference_target(joints[peer], DEFAULT_POSITION[peer])?;
            done[peer] = true;
            mirrored[peer] = true;
        }
        self.save_guided(path, io, joints, pose, done, mirrored)
    }
    fn save_guided<T: duck_control::RobotIo>(
        &mut self,
        path: &Path,
        io: &mut duck_control::safety::Safety<T>,
        joints: [JointSetting; NUM_JOINTS],
        pose: [i32; NUM_JOINTS],
        done: [bool; NUM_JOINTS],
        mirrored: [bool; NUM_JOINTS],
    ) -> Result<(), String> {
        let mut document = settings_document(path, &joints)?;
        document["commissioning_reference_ticks"] = json!(pose);
        document["commissioning_joint_calibrated"] = json!(done);
        document["commissioning_mirrored"] = json!(mirrored);
        self.device(io, DeviceOp::Configure { joints })?;
        if let Err(error) = save_step(path, document, true) {
            self.device(
                io,
                DeviceOp::Configure {
                    joints: self.status.settings,
                },
            )
            .map_err(|rollback| {
                format!("{error}; restoring session settings failed: {rollback}")
            })?;
            return Err(error);
        }
        self.status.reference_ticks = Some(pose);
        self.status.joint_calibrated = done;
        self.status.mirrored = mirrored;
        self.status.settings = joints;
        self.status.candidate = None;
        self.status.saved = Some(path.display().to_string());
        Ok(())
    }
    pub(super) fn set_follow_limit<T: duck_control::RobotIo>(
        &mut self,
        io: &mut duck_control::safety::Safety<T>,
        limit: u16,
    ) -> Result<(), String> {
        if limit > 1000 {
            return Err("follow output limit must be 0..1000".into());
        }
        if limit == 0 && self.status.mode == Mode::Follow {
            self.target = None;
            self.status.moving = false;
            self.device(
                io,
                DeviceOp::Torque {
                    id: None,
                    on: false,
                },
            )?;
            self.status.mode = Mode::Off;
        } else if self.status.mode == Mode::Follow {
            for (i, &id) in JOINT_IDS.iter().enumerate() {
                let original = self.output_limits[i]
                    .ok_or_else(|| format!("servo {id}: original output limit unavailable"))?;
                self.device(
                    io,
                    DeviceOp::OutputLimit {
                        id,
                        limit: original.min(limit),
                    },
                )?;
            }
        }
        self.status.follow_output_limit = limit;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use duck_control::{
        FakeIo,
        safety::{Safety, SafetyConfig},
    };
    fn prepare() -> (tempfile::TempDir, Hub, Controller, Safety<FakeIo>) {
        let dir = tempfile::tempdir().unwrap();
        let hub = Hub::new(dir.path().join("profile.json"), true, true);
        let mut c = Controller::new(&hub);
        let mut io = Safety::new(FakeIo::new(), SafetyConfig::default());
        c.execute(&hub.path, &mut io, Request::Enter).unwrap();
        (dir, hub, c, io)
    }
    #[test]
    fn first_pose_can_be_followed_and_saved_before_any_direction_or_limit() {
        let (_dir, h, mut c, mut io) = prepare();
        c.execute(
            &h.path,
            &mut io,
            Request::Mode {
                mode: Mode::Follow,
                p: 6,
            },
        )
        .unwrap();
        let pose = c.positions().unwrap();
        for n in 0..10 {
            c.samples
                .push_back((Instant::now() - Duration::from_millis(1500 - n * 100), pose));
        }
        c.execute(&h.path, &mut io, Request::ReferenceCapture)
            .unwrap();
        assert_eq!(c.status.reference_ticks, Some(pose));
        assert!(
            c.status
                .settings
                .iter()
                .all(|j| j.direction.is_none() && j.min_ticks.is_none())
        );
        let rebooted = Status::from_profile(&h.path, true, true);
        assert_eq!(rebooted.reference_ticks, Some(pose));
        assert_eq!(rebooted.joint_calibrated, [false; NUM_JOINTS]);
        assert!(c.execute(&h.path, &mut io, Request::Home).is_err());
    }
    #[test]
    fn mirrored_leg_uses_its_own_reference_and_flips_the_angle_interval() {
        let (_dir, h, mut c, mut io) = prepare();
        let mut pose = [2000; NUM_JOINTS];
        pose[10] = 1000;
        c.status.reference_ticks = Some(pose);
        c.execute(
            &h.path,
            &mut io,
            Request::JointCalibration {
                id: JOINT_IDS[0],
                positive_ticks: 2114,
                negative_ticks: 1886,
                min_ticks: 1800,
                max_ticks: 2300,
                mirror: true,
            },
        )
        .unwrap();
        assert_eq!(c.status.settings[0].direction, Some(1));
        let right = c.status.settings[10];
        assert_eq!(right.min_ticks, Some(700));
        assert_eq!(right.max_ticks, Some(1200));
        assert_eq!(right.zero_ticks, Some(1000));
        assert!(c.status.mirrored[10]);
        assert!(c.status.joint_calibrated[0] && c.status.joint_calibrated[10]);
    }
    #[test]
    fn model_axis_zero_may_lie_outside_a_measured_safe_interval() {
        let (_dir, h, mut c, mut io) = prepare();
        c.status.reference_ticks = Some([2000; NUM_JOINTS]);
        c.execute(
            &h.path,
            &mut io,
            Request::JointCalibration {
                id: JOINT_IDS[2],
                positive_ticks: 2090,
                negative_ticks: 1910,
                min_ticks: 1850,
                max_ticks: 2150,
                mirror: true,
            },
        )
        .unwrap();
        assert!(c.status.settings[2].zero_ticks.unwrap() > 2150);
        assert!(reference_target(c.status.settings[2], DEFAULT_POSITION[2]).is_ok());
        assert!(c.status.settings[2].checked_target(2200).is_err());
    }
    #[test]
    fn invalid_direction_evidence_does_not_write_a_profile() {
        let (_dir, h, mut c, mut io) = prepare();
        c.status.reference_ticks = Some([2000; NUM_JOINTS]);
        assert!(
            c.execute(
                &h.path,
                &mut io,
                Request::JointCalibration {
                    id: JOINT_IDS[0],
                    positive_ticks: 2114,
                    negative_ticks: 2130,
                    min_ticks: 1700,
                    max_ticks: 2400,
                    mirror: false,
                }
            )
            .is_err()
        );
        assert!(!h.path.exists());
    }
    #[test]
    fn zero_follow_output_means_verified_unload_not_an_ambiguous_zero_register() {
        let (_dir, h, mut c, mut io) = prepare();
        c.execute(
            &h.path,
            &mut io,
            Request::Mode {
                mode: Mode::Follow,
                p: 6,
            },
        )
        .unwrap();
        c.execute(&h.path, &mut io, Request::FollowLimit { limit: 0 })
            .unwrap();
        c.device(&mut io, DeviceOp::Read).unwrap();
        assert_eq!(c.status.mode, Mode::Off);
        assert!(c.status.readings.iter().all(|r| r.torque == Some(false)));
        assert!(
            c.execute(
                &h.path,
                &mut io,
                Request::Mode {
                    mode: Mode::Follow,
                    p: 6
                }
            )
            .is_err()
        );
    }
    #[test]
    fn live_follow_output_slider_keeps_the_snapshot_for_exit() {
        let (_dir, h, mut c, mut io) = prepare();
        c.execute(
            &h.path,
            &mut io,
            Request::Mode {
                mode: Mode::Follow,
                p: 6,
            },
        )
        .unwrap();
        c.execute(&h.path, &mut io, Request::FollowLimit { limit: 150 })
            .unwrap();
        c.device(&mut io, DeviceOp::Read).unwrap();
        assert_eq!(c.status.follow_output_limit, 150);
        assert!(
            c.status
                .readings
                .iter()
                .all(|r| r.output_limit == Some(150))
        );
        c.execute(&h.path, &mut io, Request::Exit).unwrap();
        c.device(&mut io, DeviceOp::Read).unwrap();
        assert!(
            c.status
                .readings
                .iter()
                .all(|r| r.output_limit == Some(1000))
        );
    }
}
