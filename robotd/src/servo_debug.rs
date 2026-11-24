//! Exclusive commissioning on the control thread. The HTTP service never touches serial IO.
use duck_control::{
    JOINT_IDS, JOINT_NAMES, NUM_JOINTS,
    model::DEFAULT_POSITION,
    servo_debug::{DeviceOp, JointReading, JointSetting, zero_for_pose},
};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::{
    collections::VecDeque,
    path::{Path, PathBuf},
    sync::{
        Mutex,
        atomic::{AtomicBool, Ordering},
    },
    time::{Duration, Instant},
};
use tokio::sync::oneshot;

type Reply = Result<Status, String>;
#[derive(Debug, Clone, Deserialize)]
#[serde(tag = "op", rename_all = "snake_case", deny_unknown_fields)]
pub enum Request {
    ImuCapture { mount: Option<[f64; 4]> },
    ImuSave,
    Status,
    Enter,
    Exit,
    Scan,
    Mode { mode: Mode, p: u8 },
    Position { id: u8, ticks: u16 },
    Torque { id: Option<u8>, on: bool },
    Gain { id: Option<u8>, p: u8 },
    Settings { joints: [JointSetting; NUM_JOINTS] },
    Home,
    Capture,
    Save,
}
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum Mode {
    Off,
    Hold,
    Follow,
}
#[derive(Clone, Serialize)]
pub struct Status {
    pub imu: Option<duck_control::servo_debug::ImuReading>,
    pub imu_error: Option<String>,
    pub imu_mount: Option<[f64; 4]>,
    pub imu_candidate: Option<[f64; 4]>,
    pub active: bool,
    pub simulated: bool,
    pub mode: Mode,
    pub p: u8,
    pub names: Vec<String>,
    pub reference: [f64; NUM_JOINTS],
    pub settings: [JointSetting; NUM_JOINTS],
    pub readings: Vec<JointReading>,
    pub candidate: Option<[JointSetting; NUM_JOINTS]>,
    pub sampled_ms: u64,
    pub error: Option<String>,
    pub saved: Option<String>,
    pub moving: bool,
}
struct Pending {
    request: Request,
    reply: oneshot::Sender<Reply>,
    until: Instant,
}
pub struct Hub {
    pub active: AtomicBool,
    pub bootstrap: bool,
    pub path: PathBuf,
    queue: Mutex<VecDeque<Pending>>,
    latest: Mutex<Status>,
}
impl Hub {
    pub fn new(path: PathBuf, simulated: bool, bootstrap: bool) -> Self {
        let settings = load_settings(&path).unwrap_or_else(|_| {
            if simulated {
                duck_control::servo_debug::SimDevice::default().joints
            } else {
                duck_control::servo_debug::settings()
            }
        });
        Self {
            active: AtomicBool::new(false),
            bootstrap,
            path: path.clone(),
            queue: Mutex::new(VecDeque::new()),
            latest: Mutex::new(Status {
                imu: None,
                imu_error: None,
                imu_mount: std::fs::read(&path)
                    .ok()
                    .and_then(|b| serde_json::from_slice::<Value>(&b).ok())
                    .and_then(|v| serde_json::from_value(v["imu_mount"].clone()).ok()),
                imu_candidate: None,
                active: false,
                simulated,
                mode: Mode::Off,
                p: 20,
                names: JOINT_NAMES.iter().map(|s| s.to_string()).collect(),
                reference: DEFAULT_POSITION,
                settings,
                readings: vec![],
                candidate: None,
                sampled_ms: 0,
                error: None,
                saved: None,
                moving: false,
            }),
        }
    }
    pub fn status(&self) -> Status {
        self.latest.lock().unwrap().clone()
    }
    pub async fn request(&self, request: Request) -> Reply {
        if matches!(request, Request::Status) {
            return Ok(self.status());
        }
        let (reply, receive) = oneshot::channel();
        {
            let mut queue = self.queue.lock().unwrap();
            if queue.len() >= 8 {
                return Err("debug request queue is busy".into());
            }
            queue.push_back(Pending {
                request,
                reply,
                until: Instant::now() + Duration::from_secs(8),
            });
        }
        tokio::time::timeout(Duration::from_secs(9), receive)
            .await
            .map_err(|_| "robotd debug request timed out".to_owned())?
            .map_err(|_| "control thread stopped".to_owned())?
    }
}
fn load_settings(path: &Path) -> Result<[JointSetting; NUM_JOINTS], String> {
    let v: Value = serde_json::from_slice(&std::fs::read(path).map_err(|e| e.to_string())?)
        .map_err(|e| e.to_string())?;
    let joints: [JointSetting; NUM_JOINTS] =
        serde_json::from_value(v["joints"].clone()).map_err(|e| e.to_string())?;
    check_settings(&joints)?;
    Ok(joints)
}
fn check_settings(joints: &[JointSetting; NUM_JOINTS]) -> Result<(), String> {
    for (i, j) in joints.iter().enumerate() {
        j.validate().map_err(|e| e.to_string())?;
        if j.id != JOINT_IDS[i] {
            return Err("joint ID order does not match robot".into());
        }
    }
    Ok(())
}
pub struct Controller {
    status: Status,
    started: Instant,
    last_read: Option<Instant>,
    samples: VecDeque<(Instant, [u16; NUM_JOINTS])>,
    imu_samples: VecDeque<(Instant, duck_control::servo_debug::ImuReading)>,
    target: Option<[f64; NUM_JOINTS]>,
    follow_counts: [u8; NUM_JOINTS],
}
impl Controller {
    pub fn new(hub: &Hub) -> Self {
        Self {
            status: hub.status(),
            started: Instant::now(),
            last_read: None,
            samples: VecDeque::new(),
            imu_samples: VecDeque::new(),
            target: None,
            follow_counts: [0; NUM_JOINTS],
        }
    }
    fn device<T: duck_control::RobotIo>(
        &mut self,
        io: &mut duck_control::safety::Safety<T>,
        op: DeviceOp,
    ) -> Result<(), String> {
        let readings = io.servo_debug(&op).map_err(|e| e.to_string())?;
        if matches!(op, DeviceOp::Read) {
            self.status.readings = readings;
            self.status.sampled_ms = self.started.elapsed().as_millis() as u64;
            self.last_read = Some(Instant::now());
        }
        Ok(())
    }
    fn positions(&self) -> Result<[u16; NUM_JOINTS], String> {
        if self
            .last_read
            .is_none_or(|t| t.elapsed() > Duration::from_secs(1))
        {
            return Err("feedback is stale".into());
        }
        let mut a = [0; NUM_JOINTS];
        for (i, id) in JOINT_IDS.iter().enumerate() {
            let r = self
                .status
                .readings
                .iter()
                .find(|r| r.id == *id)
                .ok_or("missing joint feedback")?;
            if r.error.is_some() {
                return Err(format!("servo {id}: {:?}", r.error));
            }
            a[i] = r.ticks.ok_or("missing position")?;
        }
        Ok(a)
    }
    pub fn tick<T: duck_control::RobotIo>(
        &mut self,
        hub: &Hub,
        io: &mut duck_control::safety::Safety<T>,
        allow_enter: bool,
    ) -> bool {
        let pending = hub.queue.lock().unwrap().pop_front();
        if let Some(pending) = pending {
            if !pending.reply.is_closed() && Instant::now() < pending.until {
                let result = if !allow_enter && matches!(pending.request, Request::Enter) {
                    Err("cannot enter debug during shutdown/rest".into())
                } else {
                    self.execute(&hub.path, io, pending.request)
                };
                if let Err(e) = &result {
                    self.status.error = Some(e.clone());
                }
                hub.active.store(self.status.active, Ordering::Relaxed);
                *hub.latest.lock().unwrap() = self.status.clone();
                let _ = pending.reply.send(result.map(|_| self.status.clone()));
            }
        }
        if self.status.active
            && self
                .last_read
                .is_none_or(|t| t.elapsed() >= Duration::from_millis(100))
        {
            let result = (|| {
                self.device(io, DeviceOp::Read)?;
                match io.debug_imu() {
                    Ok(sample) => {
                        let now = Instant::now();
                        if self
                            .imu_samples
                            .back()
                            .is_none_or(|(_, s)| s.counter != sample.counter)
                        {
                            self.imu_samples.push_back((now, sample.clone()));
                            while self
                                .imu_samples
                                .front()
                                .is_some_and(|(t, _)| t.elapsed() > Duration::from_secs(2))
                            {
                                self.imu_samples.pop_front();
                            }
                            self.status.imu_error = None;
                        } else if self
                            .imu_samples
                            .back()
                            .is_some_and(|(t, _)| t.elapsed() > Duration::from_millis(500))
                        {
                            self.imu_samples.clear();
                            self.status.imu_error = Some("body IMU sample counter stopped".into());
                        }
                        self.status.imu = Some(sample);
                    }
                    Err(e) => {
                        self.imu_samples.clear();
                        self.status.imu = None;
                        self.status.imu_error = Some(e.to_string());
                    }
                }

                let measured = self.positions()?;
                self.samples.push_back((Instant::now(), measured));
                while self
                    .samples
                    .front()
                    .is_some_and(|(t, _)| t.elapsed() > Duration::from_secs(2))
                {
                    self.samples.pop_front();
                }
                if let Some(mut target) = self.target {
                    if self.status.mode == Mode::Follow && !self.status.moving {
                        for i in 0..NUM_JOINTS {
                            let delta = f64::from(measured[i]) - target[i];
                            self.follow_counts[i] = if delta.abs() > 24. {
                                self.follow_counts[i].saturating_add(1)
                            } else {
                                0
                            };
                            if self.follow_counts[i] >= 3 {
                                target[i] += delta * 0.25;
                            }
                        }
                        self.target = Some(target);
                    }
                    if self.status.mode != Mode::Off {
                        // Prevalidate the entire pose before any joint is written.
                        let next: Vec<u16> = target
                            .iter()
                            .enumerate()
                            .map(|(i, t)| {
                                let at = f64::from(measured[i]);
                                (at + (*t - at).clamp(-12., 12.)).round() as u16
                            })
                            .collect();
                        for (j, t) in self.status.settings.iter().zip(&next) {
                            j.checked_target(*t).map_err(|e| e.to_string())?;
                        }
                        let mut reached = true;
                        for (i, &t) in next.iter().enumerate() {
                            if self.status.readings.get(i).and_then(|r| r.torque) != Some(true) {
                                continue;
                            }
                            if (target[i] - f64::from(measured[i])).abs() > 8. {
                                reached = false;
                            }
                            self.device(
                                io,
                                DeviceOp::Position {
                                    id: JOINT_IDS[i],
                                    ticks: t,
                                },
                            )?;
                        }
                        if reached {
                            self.status.moving = false;
                        }
                    }
                }
                Ok::<(), String>(())
            })();
            if let Err(e) = result {
                self.status.error = Some(e);
                self.samples.clear();
                self.target = None;
                self.status.moving = false;
                // Stop target updates on bad feedback; do not infer that a failed torque write unloaded the robot.
            }
            *hub.latest.lock().unwrap() = self.status.clone();
        }
        self.status.active
    }
    fn execute<T: duck_control::RobotIo>(
        &mut self,
        path: &Path,
        io: &mut duck_control::safety::Safety<T>,
        r: Request,
    ) -> Result<(), String> {
        self.status.error = None;
        if matches!(r, Request::Enter) {
            self.target = None;
            self.status.moving = false;
            self.device(io, DeviceOp::Read)?;
            self.status.active = true;
            // Pause normal output even if entry subsequently reports a bus error.
            self.device(
                io,
                DeviceOp::Torque {
                    id: None,
                    on: false,
                },
            )?;
            self.device(
                io,
                DeviceOp::Configure {
                    joints: self.status.settings,
                },
            )?;
            self.status.active = true;
            self.status.mode = Mode::Off;
            self.target = None;
            self.samples.clear();
            return Ok(());
        }
        if !self.status.active {
            return Err("enter servo debug mode first".into());
        }
        match r {
            Request::ImuCapture { mount } => {
                if self.imu_samples.len() < 10
                    || self
                        .imu_samples
                        .front()
                        .is_none_or(|(t, _)| t.elapsed() < Duration::from_secs(1))
                    || self
                        .imu_samples
                        .back()
                        .is_none_or(|(t, _)| t.elapsed() > Duration::from_millis(500))
                {
                    return Err("stand the duck upright on the table and wait two seconds for fresh IMU samples".into());
                }
                let base=mount.or(self.status.imu_mount).ok_or("mounting forward direction is unknown; configure the installation quaternion first")?;
                let g = duck_control::servo_debug::rotate(
                    base,
                    duck_control::servo_debug::gravity(self.imu_samples.back().unwrap().1.quat),
                );
                if g[2] > -0.9 {
                    return Err("not upright with the declared installation direction; verify mounting before leveling".into());
                }
                let first =
                    duck_control::servo_debug::gravity(self.imu_samples.front().unwrap().1.quat);
                for (_, sample) in &self.imu_samples {
                    let g = duck_control::servo_debug::gravity(sample.quat);
                    if sample.gyro.iter().any(|v| v.abs() > 0.05)
                        || g.iter().zip(first).any(|(a, b)| (a - b).abs() > 0.025)
                    {
                        return Err("body IMU is moving; keep the duck upright and still".into());
                    }
                }
                // Static gravity can correct tilt, but cannot discover the mounting yaw.
                self.status.imu_candidate = Some(
                    duck_control::servo_debug::level_mount(
                        base,
                        self.imu_samples.back().unwrap().1.quat,
                    )
                    .map_err(|e| e.to_string())?,
                );
            }
            Request::ImuSave => {
                let mount = self
                    .status
                    .imu_candidate
                    .ok_or("capture body IMU calibration first")?;
                let mut v: Value = match std::fs::read(path) {
                    Ok(b) => serde_json::from_slice(&b).map_err(|e| e.to_string())?,
                    Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
                        json!({"joints":self.status.settings})
                    }
                    Err(e) => return Err(e.to_string()),
                };
                v["imu_mount"] = json!(mount);
                write_document(path, &v)?;
                io.debug_set_imu_mount(mount).map_err(|e| e.to_string())?;
                self.status.imu_mount = Some(mount);
                self.status.imu_candidate = None;
                self.status.saved = Some(path.display().to_string());
            }
            Request::Exit => {
                self.target = None;
                self.status.moving = false;
                self.device(
                    io,
                    DeviceOp::Torque {
                        id: None,
                        on: false,
                    },
                )?;
                self.status.active = false;
                self.status.mode = Mode::Off;
                self.target = None;
                self.status.moving = false;
            }
            Request::Scan => self.device(io, DeviceOp::Read)?,
            Request::Settings { joints } => {
                if self.status.mode != Mode::Off {
                    return Err("unload before changing mechanical settings".into());
                }
                check_settings(&joints)?;
                self.device(io, DeviceOp::Configure { joints })?;
                self.status.settings = joints;
                self.status.candidate = None;
                self.samples.clear();
                self.target = None;
            }
            Request::Mode { mode, p } => {
                if p == 255 {
                    return Err("P must be 0..254".into());
                }
                if mode == Mode::Off {
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
                    return Ok(());
                }
                self.device(io, DeviceOp::Read)?;
                let pose = self.positions()?;
                if mode != Mode::Off {
                    for (j, &t) in self.status.settings.iter().zip(&pose) {
                        j.checked_target(t).map_err(|e| e.to_string())?;
                    }
                    for (i, &ticks) in pose.iter().enumerate() {
                        self.device(
                            io,
                            DeviceOp::Position {
                                id: JOINT_IDS[i],
                                ticks,
                            },
                        )?;
                    }
                    self.device(io, DeviceOp::Gain { id: None, p })?;
                    self.device(io, DeviceOp::Torque { id: None, on: true })?;
                    self.target = Some(pose.map(f64::from));
                } else {
                    self.device(
                        io,
                        DeviceOp::Torque {
                            id: None,
                            on: false,
                        },
                    )?;
                    self.target = None;
                }
                self.status.mode = mode;
                self.status.p = p;
                self.status.moving = false;
            }
            Request::Torque { id, on } => {
                let previous_target = self.target.take();
                self.status.moving = false;
                if on {
                    return Err(
                        "use hold/follow to establish measured targets before enabling torque"
                            .into(),
                    );
                }
                self.device(io, DeviceOp::Torque { id, on })?;
                if id.is_some() {
                    self.target = previous_target;
                } else {
                    self.status.mode = Mode::Off;
                }
                self.status.moving = false;
            }
            Request::Gain { id, p } => {
                self.device(io, DeviceOp::Gain { id, p })?;
            }
            Request::Position { id, ticks } => {
                if self.status.mode == Mode::Off {
                    return Err("enable hold/follow first".into());
                }
                let i = JOINT_IDS
                    .iter()
                    .position(|v| *v == id)
                    .ok_or("unknown joint")?;
                self.status.settings[i]
                    .checked_target(ticks)
                    .map_err(|e| e.to_string())?;
                let mut pose = self.positions()?.map(f64::from);
                pose[i] = f64::from(ticks);
                self.target = Some(pose);
                self.status.moving = true;
                self.samples.clear();
            }
            Request::Home => {
                if self.status.mode == Mode::Off {
                    return Err("enable hold/follow before returning to zero".into());
                }
                let mut pose = [0.; NUM_JOINTS];
                for (i, j) in self.status.settings.iter().enumerate() {
                    let ticks = f64::from(j.zero_ticks.ok_or("zero not calibrated")?)
                        + DEFAULT_POSITION[i]
                            * f64::from(j.direction.ok_or("direction not configured")?)
                            * 4096.
                            / std::f64::consts::TAU;
                    if !(0.0..=4095.0).contains(&ticks) {
                        return Err("home outside encoder range".into());
                    }
                    j.checked_target(ticks.round() as u16)
                        .map_err(|e| e.to_string())?;
                    pose[i] = ticks;
                }
                self.target = Some(pose);
                self.status.moving = true;
                self.samples.clear();
            }
            Request::Capture => {
                self.positions()?;
                if self.status.moving
                    || self.samples.len() < 8
                    || self.samples.front().unwrap().0.elapsed() < Duration::from_millis(750)
                {
                    return Err("hold the reference pose still for at least one second".into());
                }
                let mut joints = self.status.settings;
                for i in 0..NUM_JOINTS {
                    let lo = self.samples.iter().map(|(_, p)| p[i]).min().unwrap();
                    let hi = self.samples.iter().map(|(_, p)| p[i]).max().unwrap();
                    if hi - lo > 8 {
                        return Err(format!("servo {} is moving; hold still", JOINT_IDS[i]));
                    }
                    let ticks = (self
                        .samples
                        .iter()
                        .map(|(_, p)| u32::from(p[i]))
                        .sum::<u32>()
                        / self.samples.len() as u32) as u16;
                    joints[i].zero_ticks = Some(
                        zero_for_pose(
                            ticks,
                            joints[i]
                                .direction
                                .ok_or("configure joint directions first")?,
                            DEFAULT_POSITION[i],
                        )
                        .map_err(|e| e.to_string())?,
                    );
                    joints[i].validate().map_err(|e| e.to_string())?;
                }
                self.status.candidate = Some(joints);
            }
            Request::Save => {
                let joints = self
                    .status
                    .candidate
                    .ok_or("capture the standard pose first")?;
                save_settings(path, &joints)?;
                self.device(io, DeviceOp::Configure { joints })?;
                self.status.settings = joints;
                self.status.candidate = None;
                self.status.saved = Some(path.display().to_string());
            }
            Request::Enter | Request::Status => {}
        }
        Ok(())
    }
}
fn save_settings(path: &Path, joints: &[JointSetting; NUM_JOINTS]) -> Result<(), String> {
    check_settings(joints)?;
    let original = match std::fs::read(path) {
        Ok(v) => Some(v),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => None,
        Err(e) => return Err(e.to_string()),
    };
    let mut v: Value = match &original {
        Some(bytes) => serde_json::from_slice(bytes).map_err(|e| e.to_string())?,
        None => json!({"joints":joints}),
    };
    if !v.is_object() {
        return Err("calibration root must be an object".into());
    }
    if let Some(old) = v.get_mut("joints").and_then(Value::as_array_mut) {
        if old.len() != NUM_JOINTS {
            return Err("existing calibration joint count mismatch".into());
        }
        for (i, j) in joints.iter().enumerate() {
            if old[i]["id"] != json!(j.id) {
                return Err("existing calibration joint order mismatch".into());
            }
            for key in ["zero_ticks", "direction", "min_ticks", "max_ticks"] {
                old[i][key] = serde_json::to_value(j).unwrap()[key].clone();
            }
        }
    } else {
        return Err("existing calibration has no joints".into());
    }
    write_document(path, &v)
}
fn write_document(path: &Path, v: &Value) -> Result<(), String> {
    use std::io::Write;
    let original = match std::fs::read(path) {
        Ok(v) => Some(v),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => None,
        Err(e) => return Err(e.to_string()),
    };
    let parent = path.parent().ok_or("calibration has no parent")?;
    std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    if let Some(bytes) = original {
        let backup = path.with_extension(format!(
            "json.{}.bak",
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap_or_default()
                .as_nanos()
        ));
        let mut f = std::fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(backup)
            .map_err(|e| e.to_string())?;
        f.write_all(&bytes)
            .and_then(|_| f.sync_all())
            .map_err(|e| e.to_string())?;
    }
    let temporary = path.with_extension(format!("json.{}.tmp", std::process::id()));
    let result = (|| {
        let mut f = std::fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&temporary)?;
        f.write_all(&serde_json::to_vec_pretty(&v)?)?;
        f.sync_all()?;
        std::fs::rename(&temporary, path)?;
        std::fs::File::open(parent)?.sync_all()
    })()
    .map_err(|e: std::io::Error| e.to_string());
    if result.is_err() {
        let _ = std::fs::remove_file(temporary);
    }
    result
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn save_preserves_imu_units_unknown_keys_and_backs_up() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("profile.json");
        let mut joints = duck_control::servo_debug::SimDevice::default().joints;
        let v = json!({"joints":joints,"imu_mount":[1,0,0,0],"speed_rad_s_per_unit":0.1,"future":{"keep":true}});
        std::fs::write(&path, v.to_string()).unwrap();
        joints[0].zero_ticks = Some(2100);
        save_settings(&path, &joints).unwrap();
        let saved: Value = serde_json::from_slice(&std::fs::read(&path).unwrap()).unwrap();
        assert_eq!(saved["future"], v["future"]);
        assert_eq!(saved["imu_mount"], v["imu_mount"]);
        assert_eq!(saved["joints"][0]["zero_ticks"], 2100);
        assert_eq!(std::fs::read_dir(dir.path()).unwrap().count(), 2);
    }
    #[test]
    fn settings_reject_wrong_ids_and_invalid_limits() {
        let mut s = duck_control::servo_debug::settings();
        s[0].id = 1;
        assert!(check_settings(&s).is_err());
        s[0].id = JOINT_IDS[0];
        s[0].min_ticks = Some(3000);
        s[0].max_ticks = Some(2000);
        assert!(check_settings(&s).is_err());
    }
}

#[cfg(test)]
mod workflow_tests {
    use super::*;
    use duck_control::{
        FakeIo,
        safety::{Safety, SafetyConfig},
    };
    fn setup() -> (tempfile::TempDir, Hub, Controller, Safety<FakeIo>) {
        let dir = tempfile::tempdir().unwrap();
        let hub = Hub::new(dir.path().join("profile.json"), true, false);
        let c = Controller::new(&hub);
        let io = Safety::new(FakeIo::new(), SafetyConfig::default());
        (dir, hub, c, io)
    }
    #[test]
    fn mode_and_motion_require_entry_and_limits() {
        let (_d, h, mut c, mut io) = setup();
        assert!(c.execute(&h.path, &mut io, Request::Home).is_err());
        c.execute(&h.path, &mut io, Request::Enter).unwrap();
        assert_eq!(c.status.mode, Mode::Off);
        c.execute(
            &h.path,
            &mut io,
            Request::Mode {
                mode: Mode::Follow,
                p: 20,
            },
        )
        .unwrap();
        c.execute(
            &h.path,
            &mut io,
            Request::Mode {
                mode: Mode::Off,
                p: 20,
            },
        )
        .unwrap();
        let mut joints = c.status.settings;
        joints[0].min_ticks = None;
        c.execute(&h.path, &mut io, Request::Settings { joints })
            .unwrap();
        assert!(
            c.execute(
                &h.path,
                &mut io,
                Request::Position {
                    id: JOINT_IDS[0],
                    ticks: 2000
                }
            )
            .is_err()
        );
        c.execute(&h.path, &mut io, Request::Exit).unwrap();
        assert!(!c.status.active);
        assert_eq!(c.status.mode, Mode::Off);
    }
    #[test]
    fn capture_rejects_moving_data_and_maps_reference_pose_correctly() {
        let (_d, h, mut c, mut io) = setup();
        c.execute(&h.path, &mut io, Request::Enter).unwrap();
        c.device(&mut io, DeviceOp::Read).unwrap();
        let p = c.positions().unwrap();
        for i in 0..10 {
            c.samples
                .push_back((Instant::now() - Duration::from_millis(1500 - i * 100), p));
        }
        c.execute(&h.path, &mut io, Request::Capture).unwrap();
        assert!(
            c.status
                .candidate
                .unwrap()
                .iter()
                .all(|j| j.zero_ticks == Some(2048))
        );
        c.samples.back_mut().unwrap().1[0] += 30;
        assert!(c.execute(&h.path, &mut io, Request::Capture).is_err());
    }
    #[test]
    fn imu_calibration_is_independent_and_requires_fresh_stationary_samples() {
        let (_d, h, mut c, mut io) = setup();
        c.execute(&h.path, &mut io, Request::Enter).unwrap();
        assert!(
            c.execute(
                &h.path,
                &mut io,
                Request::ImuCapture {
                    mount: Some([1., 0., 0., 0.])
                }
            )
            .is_err()
        );
        for i in 0..15 {
            c.imu_samples.push_back((
                Instant::now() - Duration::from_millis(1500 - i * 100),
                duck_control::servo_debug::ImuReading {
                    quat: [1., 0., 0., 0.],
                    gyro: [0.; 3],
                    counter: i as u8,
                },
            ));
        }
        c.execute(
            &h.path,
            &mut io,
            Request::ImuCapture {
                mount: Some([1., 0., 0., 0.]),
            },
        )
        .unwrap();
        assert_eq!(c.status.imu_candidate, Some([1., 0., 0., 0.]));
        assert!(c.status.candidate.is_none());
        c.imu_samples.back_mut().unwrap().1.gyro[0] = 1.;
        assert!(
            c.execute(
                &h.path,
                &mut io,
                Request::ImuCapture {
                    mount: Some([1., 0., 0., 0.])
                }
            )
            .is_err()
        );
    }
}

#[cfg(test)]
mod transition_tests {
    use super::*;
    use duck_control::{
        FakeIo, JointTargets, RobotIo, Sensors, SlowSensors,
        io::Result,
        safety::{Safety, SafetyConfig},
    };
    struct Trace {
        fake: FakeIo,
        log: Vec<DeviceOp>,
        fail_unload: bool,
    }
    impl RobotIo for Trace {
        fn servo_debug(&mut self, op: &DeviceOp) -> Result<Vec<JointReading>> {
            self.log.push(op.clone());
            if self.fail_unload && matches!(op, DeviceOp::Torque { on: false, .. }) {
                return Err(duck_control::servo_debug::error("unload failed"));
            }
            self.fake.servo_debug(op)
        }
        fn read(&mut self) -> Result<Sensors> {
            self.fake.read()
        }
        fn write(&mut self, t: &JointTargets) -> Result<()> {
            self.fake.write(t)
        }
        fn set_gain(&mut self, p: u16) -> Result<()> {
            self.fake.set_gain(p)
        }
        fn set_torque(&mut self, on: bool) -> Result<()> {
            self.fake.set_torque(on)
        }
        fn reboot(&mut self, id: u8) -> Result<()> {
            self.fake.reboot(id)
        }
        fn slow_sensors(&mut self) -> Result<SlowSensors> {
            self.fake.slow_sensors()
        }
    }
    #[test]
    fn every_failed_unload_path_cancels_the_old_target() {
        for req in [
            Request::Enter,
            Request::Exit,
            Request::Mode {
                mode: Mode::Off,
                p: 20,
            },
            Request::Torque {
                id: None,
                on: false,
            },
        ] {
            let dir = tempfile::tempdir().unwrap();
            let h = Hub::new(dir.path().join("profile.json"), true, false);
            let mut c = Controller::new(&h);
            c.status.active = true;
            c.status.mode = Mode::Follow;
            c.target = Some([2500.; NUM_JOINTS]);
            c.status.moving = true;
            let mut io = Safety::new(
                Trace {
                    fake: FakeIo::new(),
                    log: vec![],
                    fail_unload: true,
                },
                SafetyConfig::default(),
            );
            assert!(c.execute(&h.path, &mut io, req).is_err());
            assert!(c.target.is_none());
            assert!(!c.status.moving);
            assert!(c.status.active);
        }
    }
    #[test]
    fn unload_mode_does_not_require_fresh_position_feedback() {
        let dir = tempfile::tempdir().unwrap();
        let h = Hub::new(dir.path().join("profile.json"), true, false);
        let mut c = Controller::new(&h);
        c.status.active = true;
        c.last_read = None;
        let mut io = Safety::new(FakeIo::new(), SafetyConfig::default());
        c.execute(
            &h.path,
            &mut io,
            Request::Mode {
                mode: Mode::Off,
                p: 20,
            },
        )
        .unwrap();
        assert_eq!(c.status.mode, Mode::Off);
    }
}

#[cfg(test)]
mod capability_tests {
    use super::*;
    use duck_control::safety::{Safety, SafetyConfig};
    #[test]
    fn unsupported_backend_does_not_get_trapped_in_debug() {
        let d = tempfile::tempdir().unwrap();
        let h = Hub::new(d.path().join("profile.json"), true, false);
        let mut c = Controller::new(&h);
        let mut io = Safety::new(
            duck_control::sim::RemoteIo::at("127.0.0.1:9"),
            SafetyConfig::default(),
        );
        assert!(c.execute(&h.path, &mut io, Request::Enter).is_err());
        assert!(!c.status.active);
    }
}
