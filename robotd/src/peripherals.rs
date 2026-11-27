//! Saved peripheral configuration. Enumeration reads OS metadata without opening hardware.
use super::{Params, RobotState, params, proto};
use std::{path::Path, sync::Mutex};

pub struct Runtime {
    startup_audio: String,
    save: Mutex<()>,
}
impl Runtime {
    pub fn new(params: &Params) -> Self {
        Self {
            startup_audio: serde_json::to_string(&params.audio).unwrap(),
            save: Mutex::new(()),
        }
    }
}

fn option(id: &str, label: &str, available: bool) -> proto::DeviceOption {
    proto::DeviceOption {
        id: id.into(),
        label: label.into(),
        available,
    }
}

fn audio_options(pcm: &str, direction: &str, configured: &str) -> Vec<proto::DeviceOption> {
    let mut devices = vec![
        option("none", "None", true),
        option(
            "default",
            "System default",
            pcm.lines().any(|line| line.contains(direction)),
        ),
    ];
    for line in pcm.lines().filter(|line| line.contains(direction)) {
        let Some((address, description)) = line.split_once(':') else {
            continue;
        };
        let Some((card, device)) = address.trim().split_once('-') else {
            continue;
        };
        let (Ok(card), Ok(device)) = (card.parse::<u32>(), device.parse::<u32>()) else {
            continue;
        };
        let card_id = std::fs::read_to_string(format!("/proc/asound/card{card}/id"))
            .map(|id| id.trim().to_owned())
            .unwrap_or_else(|_| card.to_string());
        let id = format!("plughw:{card_id},{device}");
        devices.push(option(&id, description.trim(), true));
    }
    include_configured(&mut devices, configured);
    devices
}
fn include_configured(devices: &mut Vec<proto::DeviceOption>, configured: &str) {
    if !devices.iter().any(|d| d.id == configured) {
        let available = if configured.starts_with("/dev/") {
            Path::new(configured).exists()
        } else {
            let normalize = |device: &str| {
                device
                    .strip_prefix("plughw:")
                    .or_else(|| device.strip_prefix("hw:"))
                    .map(|value| value.replace("CARD=", "").replace("DEV=", ""))
                    .map(|value| {
                        if value.contains(',') {
                            value
                        } else {
                            format!("{value},0")
                        }
                    })
            };
            normalize(configured).is_some_and(|selected| {
                devices
                    .iter()
                    .any(|d| d.available && normalize(&d.id).as_deref() == Some(&selected))
            })
        };
        devices.push(option(configured, configured, available));
    }
}

// The camera CLI belongs to mediad, so robotd cannot infer it from its own arguments.
fn camera_override() -> Option<String> {
    let entries = std::fs::read_dir("/proc").ok()?;
    for entry in entries.flatten() {
        if !entry
            .file_name()
            .to_string_lossy()
            .bytes()
            .all(|b| b.is_ascii_digit())
        {
            continue;
        }
        let Ok(bytes) = std::fs::read(entry.path().join("cmdline")) else {
            continue;
        };
        let args: Vec<_> = bytes
            .split(|b| *b == 0)
            .filter(|s| !s.is_empty())
            .map(String::from_utf8_lossy)
            .collect();
        if args.first().is_none_or(|arg| {
            Path::new(arg.as_ref())
                .file_name()
                .is_none_or(|n| n != "mediad")
        }) {
            continue;
        }
        for (i, arg) in args.iter().enumerate() {
            if let Some(value) = arg.strip_prefix("--camera-device=") {
                return Some(value.into());
            }
            if arg == "--camera-device" {
                return args.get(i + 1).map(|s| s.to_string());
            }
        }
    }
    None
}

pub fn report(state: &RobotState) -> Result<proto::PeripheralsResult, String> {
    let saved = Params::load(&state.config_path, false).map_err(|e| e.to_string())?;
    let microphone_device = if !saved.audio.capture_enabled() {
        "none".into()
    } else {
        saved.audio.microphone_device.clone().unwrap_or_else(|| {
            saved
                .audio
                .resolve_devices(&params::alsa_card_ids(
                    &std::fs::read_to_string("/proc/asound/cards").unwrap_or_default(),
                ))
                .capture
        })
    };
    let speaker_device = if !saved.audio.playback_enabled() {
        "none".into()
    } else {
        saved.audio.speaker_device.clone().unwrap_or_else(|| {
            saved
                .audio
                .resolve_devices(&params::alsa_card_ids(
                    &std::fs::read_to_string("/proc/asound/cards").unwrap_or_default(),
                ))
                .playback
        })
    };
    let camera_device = saved
        .media
        .camera_device
        .clone()
        .unwrap_or_else(|| "/dev/video0".into());
    let pcm = std::fs::read_to_string("/proc/asound/pcm").unwrap_or_default();
    let mut cameras = vec![option("none", "None", true)];
    if let Ok(entries) = std::fs::read_dir("/sys/class/video4linux") {
        for entry in entries.flatten() {
            let id = format!("/dev/{}", entry.file_name().to_string_lossy());
            let label =
                std::fs::read_to_string(entry.path().join("name")).unwrap_or_else(|_| id.clone());
            cameras.push(option(&id, label.trim(), Path::new(&id).exists()));
        }
    }
    include_configured(&mut cameras, &camera_device);
    let mut notices = vec!["已保存配置；设备可见不代表录放可用。摄像头修改后需要重启 mediad，当前无法查询其实际运行配置。".into()];
    if pcm.is_empty() {
        notices.push("系统尚未提供 ALSA 录放设备，请先配置声卡驱动和系统音频路由。".into());
    }
    if saved.media.source == params::MediaSource::Test {
        notices.push("当前 media.source=test，系统使用测试图；重新选择摄像头并保存后将切换为硬件摄像头。选择「无」仍会停止所有画面。".into());
    }
    if saved.audio.playback_enabled()
        && saved
            .audio
            .speaker_mixer(&params::alsa_card_ids(
                &std::fs::read_to_string("/proc/asound/cards").unwrap_or_default(),
            ))
            .is_none()
    {
        notices.push("音量已保存；所选 PCM 没有受支持的硬件混音器，实际播放音量可能不变。".into());
    }
    let override_device = camera_override();
    if let Some(device) = &override_device {
        notices.push(format!(
            "mediad 启动参数 --camera-device={device} 已覆盖并锁定保存的摄像头选择。"
        ));
    }
    let mut restart_units = Vec::new();
    if serde_json::to_string(&saved.audio).unwrap() != state.peripherals.startup_audio {
        restart_units.push("robotd".into());
    }
    Ok(proto::PeripheralsResult {
        speaker_volume_applies: saved
            .audio
            .speaker_mixer(&params::alsa_card_ids(
                &std::fs::read_to_string("/proc/asound/cards").unwrap_or_default(),
            ))
            .is_some(),
        microphones: audio_options(&pcm, "capture", &microphone_device),
        speakers: audio_options(&pcm, "playback", &speaker_device),
        microphone_device,
        speaker_device,
        camera_device,
        speaker_volume: saved.audio.volume,
        camera_quality: saved.media.quality.label().into(),
        cameras,
        camera_port_override: override_device.is_some(),
        restart_units,
        notices,
    })
}

fn save_file(config: &Path, p: &proto::PeripheralsParams, locked: bool) -> Result<(), String> {
    if locked && p.camera_device.is_some() {
        return Err("mediad --camera-device locks the camera selector".into());
    }
    for (value, camera) in [
        (&p.microphone_device, false),
        (&p.speaker_device, false),
        (&p.camera_device, true),
    ] {
        if let Some(value) = value
            && !params::valid_peripheral_device(value, camera)
        {
            return Err("invalid peripheral device identifier".into());
        }
    }
    if p.speaker_volume.is_some_and(|volume| volume > 100) {
        return Err("speaker_volume must be 0..100".into());
    }
    if let Some(quality) = &p.camera_quality
        && !params::QUALITY_LABELS.contains(&quality.as_str())
    {
        return Err("unknown camera_quality".into());
    }
    let mut model = params::edit::Model::load(config)?;
    for (key, value) in [
        ("audio.microphone_device", p.microphone_device.clone()),
        ("audio.speaker_device", p.speaker_device.clone()),
        ("media.camera_device", p.camera_device.clone()),
        // A deliberate hardware selection exits the legacy test source in the same transaction.
        (
            "media.source",
            p.camera_device
                .as_ref()
                .filter(|device| device.as_str() != "none")
                .map(|_| "camera".to_owned()),
        ),
        ("audio.volume", p.speaker_volume.map(|v| v.to_string())),
        ("media.quality", p.camera_quality.clone()),
    ] {
        if let Some(value) = value {
            let entry = params::registry::REGISTRY
                .iter()
                .find(|e| e.key == key)
                .expect("registered peripheral key");
            model.edit(entry, &value)?;
        }
    }
    model.save()
}

pub fn save(
    state: &RobotState,
    p: &proto::PeripheralsParams,
) -> Result<proto::PeripheralsResult, String> {
    let _guard = state.peripherals.save.lock().unwrap();
    save_file(&state.config_path, p, camera_override().is_some())?;
    report(state)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn enumeration_keeps_missing_selection_and_separates_directions() {
        let pcm = "00-00: codec : playback 1\n01-02: mic : capture 1\n";
        let capture = audio_options(pcm, "capture", "custom");
        assert!(capture.iter().any(|d| d.id == "plughw:1,2" && d.available));
        assert!(!capture.iter().any(|d| d.id == "plughw:0,0"));
        assert!(capture.iter().any(|d| d.id == "custom" && !d.available));
        let capture = audio_options("00-00: codec : playback 1\n", "capture", "default");
        assert!(capture.iter().any(|d| d.id == "default" && !d.available));
        let alias = audio_options(pcm, "capture", "hw:CARD=1,DEV=2");
        assert!(
            alias
                .iter()
                .any(|d| d.id == "hw:CARD=1,DEV=2" && d.available)
        );
    }
    #[test]
    fn report_resolves_legacy_disabled_paths_to_none_and_selection_enables_only_one() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("robotd.toml");
        std::fs::write(&path, "[audio]\nenabled = false\n").unwrap();
        let params = Params::load(&path, true).unwrap();
        let state = RobotState::new(&params, &path, false, false);
        let initial = report(&state).unwrap();
        assert_eq!(initial.microphone_device, "none");
        assert_eq!(initial.speaker_device, "none");
        assert!(initial.restart_units.is_empty());
        let update = proto::PeripheralsParams {
            microphone_device: Some("default".into()),
            ..Default::default()
        };
        let changed = save(&state, &update).unwrap();
        assert_eq!(changed.microphone_device, "default");
        assert_eq!(changed.speaker_device, "none");
        assert_eq!(changed.restart_units, ["robotd"]);
        let before = std::fs::read_to_string(&path).unwrap();
        assert!(
            save(
                &state,
                &proto::PeripheralsParams {
                    microphone_device: Some("unset".into()),
                    ..Default::default()
                }
            )
            .is_err()
        );
        assert_eq!(std::fs::read_to_string(&path).unwrap(), before);
    }

    #[test]
    fn only_an_explicit_camera_selection_exits_the_legacy_test_source() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("robotd.toml");
        let original = "[media]\nsource = \"test\"\n";
        std::fs::write(&path, original).unwrap();
        save_file(
            &path,
            &proto::PeripheralsParams {
                speaker_device: Some("none".into()),
                ..Default::default()
            },
            false,
        )
        .unwrap();
        assert_eq!(
            Params::load(&path, true).unwrap().media.source,
            params::MediaSource::Test
        );
        save_file(
            &path,
            &proto::PeripheralsParams {
                camera_device: Some("none".into()),
                ..Default::default()
            },
            false,
        )
        .unwrap();
        let disabled = Params::load(&path, true).unwrap();
        assert_eq!(disabled.media.source, params::MediaSource::Test);
        assert_eq!(disabled.media.camera_device.as_deref(), Some("none"));
        save_file(
            &path,
            &proto::PeripheralsParams {
                camera_device: Some("/dev/video0".into()),
                ..Default::default()
            },
            false,
        )
        .unwrap();
        let selected = Params::load(&path, true).unwrap();
        assert_eq!(selected.media.source, params::MediaSource::Camera);
        assert_eq!(selected.media.camera_device.as_deref(), Some("/dev/video0"));
    }

    #[test]
    fn peripheral_save_is_atomic_and_keeps_comments() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("robotd.toml");
        let original = "# preserved\n[audio]\nenabled = false\nvolume = 30\n";
        std::fs::write(&path, original).unwrap();
        let invalid = proto::PeripheralsParams {
            speaker_device: Some("none".into()),
            camera_quality: Some("bad".into()),
            ..Default::default()
        };
        assert!(save_file(&path, &invalid, false).is_err());
        assert_eq!(std::fs::read_to_string(&path).unwrap(), original);
        let valid = proto::PeripheralsParams {
            microphone_device: Some("plughw:1,0".into()),
            speaker_device: Some("none".into()),
            camera_device: Some("none".into()),
            speaker_volume: Some(42),
            camera_quality: Some("360p30".into()),
        };
        save_file(&path, &valid, false).unwrap();
        let saved = Params::load(&path, true).unwrap();
        assert!(saved.audio.capture_enabled());
        assert!(!saved.audio.playback_enabled());
        assert_eq!(saved.media.camera_device.as_deref(), Some("none"));
        assert_eq!(saved.audio.volume, 42);
        assert!(
            std::fs::read_to_string(&path)
                .unwrap()
                .contains("# preserved")
        );
        assert!(save_file(&path, &valid, true).is_err());
    }
}
