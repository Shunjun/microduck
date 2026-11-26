//! Persisted settings and the control thread's view of the serial connection.
use super::{Params, RobotState, params, proto};
use std::{
    collections::BTreeSet,
    ffi::CString,
    os::unix::ffi::OsStrExt,
    path::{Component, Path},
    sync::{Mutex, atomic::Ordering},
};

#[derive(Clone, PartialEq)]
struct Settings {
    port: String,
    normal_p: u16,
    limp_p: u16,
}
impl Settings {
    fn from_params(params: &Params) -> Self {
        Self {
            port: params.bus.port.clone(),
            normal_p: params.policy.gain,
            limp_p: params.safety.gain_limp,
        }
    }
}
pub struct Runtime {
    pub port_override: Option<String>,
    pub remote_sim: bool,
    // Serializes saves and publication of their effective values to the control thread.
    settings: Mutex<Settings>,
    link: Mutex<Link>,
}
#[derive(Clone)]
struct Link {
    effective_port: String,
    status: &'static str,
    error: Option<String>,
}
impl Runtime {
    pub fn new(params: &Params) -> Self {
        Self {
            port_override: None,
            remote_sim: false,
            settings: Mutex::new(Settings::from_params(params)),
            link: Mutex::new(Link {
                effective_port: params.bus.port.clone(),
                status: "waiting",
                error: None,
            }),
        }
    }
    pub fn apply(&self, params: &mut Params) {
        let settings = self.settings.lock().unwrap();
        params.bus.port = self
            .port_override
            .as_ref()
            .unwrap_or(&settings.port)
            .clone();
        *self.link.lock().unwrap() = Link {
            effective_port: params.bus.port.clone(),
            status: "waiting",
            error: None,
        };
        params.policy.gain = settings.normal_p;
        params.safety.gain_limp = settings.limp_p;
    }
    pub fn publish(&self, status: &'static str, reason: Option<String>) {
        let mut link = self.link.lock().unwrap();
        link.status = status;
        link.error = reason;
    }
}

fn serial_ports(configured: &str, effective: &str) -> Vec<proto::SerialPortInfo> {
    let mut paths = BTreeSet::from([configured.to_owned(), effective.to_owned()]);
    for directory in ["/dev", "/dev/serial/by-id", "/dev/serial/by-path"] {
        let Ok(entries) = std::fs::read_dir(directory) else {
            continue;
        };
        for entry in entries.flatten() {
            let name = entry.file_name();
            let name = name.to_string_lossy();
            if directory != "/dev"
                || [
                    "ttyS", "ttyAMA", "ttyACM", "ttyUSB", "ttyTHS", "ttymxc", "rfcomm",
                ]
                .iter()
                .any(|prefix| {
                    name.strip_prefix(prefix)
                        .is_some_and(|n| !n.is_empty() && n.bytes().all(|c| c.is_ascii_digit()))
                })
                || name.starts_with("cu.")
                || name.starts_with("tty.")
            {
                paths.insert(entry.path().to_string_lossy().into_owned());
            }
        }
    }
    paths
        .into_iter()
        .map(|path| {
            let accessible = CString::new(Path::new(&path).as_os_str().as_bytes()).is_ok_and(|p| {
                // access(2) checks permissions without opening a tty or toggling its control lines.
                unsafe { libc::access(p.as_ptr(), libc::R_OK | libc::W_OK) == 0 }
            });
            proto::SerialPortInfo { path, accessible }
        })
        .collect()
}

pub fn hardware_report(state: &RobotState) -> Result<proto::HardwareResult, String> {
    let params = Params::load(&state.config_path, false).map_err(|e| e.to_string())?;
    let Link {
        effective_port,
        status: mut link,
        mut error,
    } = state.hardware.link.lock().unwrap().clone();
    let effective_port = state
        .hardware
        .port_override
        .clone()
        .unwrap_or(effective_port);
    let status = state.servo_debug.status();
    if link == "unload_failed" {
        link = "error";
    } else if state.servo_debug.reopen.load(Ordering::Acquire) {
        link = "reconfiguring";
        error = None;
    } else if link != "error"
        && state.servo_debug.available()
        && status.active
        && !status.readings.is_empty()
    {
        if let Some(failed) = status.readings.iter().find(|r| r.error.is_some()) {
            link = "error";
            error = Some(format!(
                "servo {}: {}",
                failed.id,
                failed.error.as_deref().unwrap()
            ));
        } else {
            link = "ready";
        }
    } else if state.consecutive_errors.load(Ordering::Relaxed) >= state.max_consecutive_errors {
        link = "error";
        error = Some("motor bus reads are failing".into());
    }
    Ok(proto::HardwareResult {
        active_driver: state.servo_driver.as_str().into(),
        configured_driver: params.bus.driver.as_str().into(),
        restart_required: params.bus.driver != state.servo_driver,
        ports: serial_ports(&params.bus.port, &effective_port),
        effective_port,
        configured_port: params.bus.port,
        port_override: state.hardware.port_override.is_some(),
        normal_p: params.policy.gain,
        limp_p: params.safety.gain_limp,
        calibration_required: status.calibration_required,
        calibration_error: status.calibration_error,
        bus_status: link.into(),
        bus_error: error,
    })
}

pub fn set_hardware(
    state: &RobotState,
    p: &proto::HardwareParams,
) -> Result<proto::HardwareResult, String> {
    if !matches!(p.servo_driver.as_str(), "xl330" | "feetech1910") {
        return Err("servo_driver must be xl330 or feetech1910".into());
    }
    if let Some(port) = &p.port {
        if state.hardware.port_override.is_some() {
            return Err("the service --port override locks the configured port".into());
        }
        if port.trim() != port
            || !Path::new(port).starts_with("/dev")
            || Path::new(port).file_name().is_none()
            || port == "/dev"
            || port.chars().any(char::is_control)
            || Path::new(port)
                .components()
                .any(|c| c == Component::ParentDir)
        {
            return Err("port must be an absolute device path under /dev".into());
        }
    }
    let max_gain = if p.servo_driver == "feetech1910" {
        254
    } else {
        16383
    };
    {
        let mut live = state.hardware.settings.lock().unwrap();
        let current = Params::load(&state.config_path, false).map_err(|e| e.to_string())?;
        if [
            p.normal_p.unwrap_or(current.policy.gain),
            p.limp_p.unwrap_or(current.safety.gain_limp),
        ]
        .into_iter()
        .any(|gain| gain > max_gain)
        {
            return Err(format!("normal and limp P must be 0..{max_gain}"));
        }
        let mut model = params::edit::Model::load(&state.config_path)?;
        for (key, value) in [
            ("bus.driver", Some(p.servo_driver.clone())),
            ("bus.port", p.port.clone()),
            ("policy.gain", p.normal_p.map(|p| p.to_string())),
            ("safety.gain_limp", p.limp_p.map(|p| p.to_string())),
        ] {
            if let Some(value) = value {
                let entry = params::registry::REGISTRY
                    .iter()
                    .find(|e| e.key == key)
                    .expect("registered hardware key");
                model.edit(entry, &value)?;
            }
        }
        model.save()?;
        let saved = Params::load(&state.config_path, false).map_err(|e| e.to_string())?;
        let next = Settings::from_params(&saved);
        if saved.bus.driver == state.servo_driver && *live != next {
            *live = next;
            state.servo_debug.request_reopen();
        }
    }
    hardware_report(state)
}
