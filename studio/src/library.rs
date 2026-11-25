//! Studio-owned model files; importing and editing never activates a policy.
use crate::AppState;
use axum::{
    Json,
    body::Bytes,
    extract::{Path, State},
    http::HeaderMap,
    response::Response,
};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::{fs, io::Write, path::Path as FsPath, sync::Arc};
const MANIFEST_MAX: usize = 65536;
const MODEL_MAX: usize = 32 * 1024 * 1024;

pub fn validate_manifest(m: &Value) -> Result<(), String> {
    if !m.is_object() {
        return Err("manifest 必须是 JSON 对象".into());
    }
    let name = m["name"].as_str().unwrap_or("");
    if name.is_empty()
        || name.len() > 64
        || !name
            .bytes()
            .all(|c| c.is_ascii_alphanumeric() || c == b'-' || c == b'_')
    {
        return Err("动作名称需为 1–64 个英文字母、数字、下划线或连字符".into());
    }
    if m["robot"]["model"] != "microduck" || m["obs_len"] != 61 || m["action_len"] != 14 {
        return Err("模型说明需声明 microduck、obs_len=61、action_len=14".into());
    }
    if !matches!(m["model_api"].as_u64(), Some(1 | 2)) {
        return Err("不支持该 model_api（支持 1、2）".into());
    }
    if m["command"]["encoding"] != "constant" {
        return Err(
            "第一版导入支持 constant 指令编码；phase/posture_flag 不可作为通用动作导入".into(),
        );
    }
    match m["kind"].as_str() {
        Some("episodic") => {
            bounded_number(&m["duration_s"], "duration_s", 0.0, 600.0)?;
        }
        Some("perpetual") => {
            if !m["duration_s"].is_null() {
                return Err("持续策略不应声明 duration_s".into());
            }
            if !matches!(m["slot"].as_str(), Some("walk" | "stand")) {
                return Err("第一版持续策略需指定 walk 或 stand 槽位".into());
            }
        }
        _ => return Err("kind 必须为 episodic 或 perpetual".into()),
    }
    let v = m["command"]["idle"]
        .as_array()
        .ok_or("command.idle 需为三个数值")?;
    if v.len() != 3
        || v.iter()
            .any(|n| n.as_f64().is_none_or(|n| !n.is_finite() || n.abs() > 10.0))
    {
        return Err("command.idle 需为三个有效数值，绝对值不大于 10".into());
    }
    if let Some(v) = m.get("action_scale") {
        bounded_number(v, "action_scale", 0.0, 2.0)?;
    }
    if let Some(v) = m.get("unwind_s") {
        bounded_number(v, "unwind_s", 0.0, 60.0)?;
    }
    if let Some(v) = m.get("chain")
        && !v.is_boolean()
    {
        return Err("chain 必须为布尔值".into());
    }
    if m["kind"] == "perpetual" && m["chain"] == true {
        return Err("持续策略不能设置 chain=true".into());
    }
    for key in ["description", "entry_pose"] {
        if let Some(v) = m.get(key)
            && !v.is_string()
        {
            return Err(format!("{key} 必须为文本"));
        }
    }
    if serde_json::to_vec(m).map_err(|e| e.to_string())?.len() > MANIFEST_MAX {
        return Err("manifest 超过 64 KiB".into());
    }
    Ok(())
}
fn bounded_number(v: &Value, name: &str, min: f64, max: f64) -> Result<(), String> {
    match v.as_f64() {
        Some(n) if n.is_finite() && n > min && n <= max => Ok(()),
        _ => Err(format!("{name} 必须大于 {min} 且不超过 {max}")),
    }
}
fn valid_id(id: &str) -> Result<(), String> {
    if id.len() == 64
        && id
            .bytes()
            .all(|c| c.is_ascii_hexdigit() && !c.is_ascii_uppercase())
    {
        Ok(())
    } else {
        Err("无效的动作 ID".into())
    }
}
fn entry(root: &FsPath, id: &str) -> Result<Value, String> {
    valid_id(id)?;
    let dir = root.join(id);
    let manifest: Value =
        serde_json::from_slice(&fs::read(dir.join("manifest.json")).map_err(|e| e.to_string())?)
            .map_err(|e| e.to_string())?;
    Ok(
        json!({"id":id,"manifest":manifest,"path":dir.join("policy.onnx"),"bytes":fs::metadata(dir.join("policy.onnx")).map_err(|e|e.to_string())?.len()}),
    )
}
fn nonce() -> String {
    use std::sync::atomic::{AtomicU64, Ordering};
    static NEXT: AtomicU64 = AtomicU64::new(0);
    format!(
        "{}-{}-{}",
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap_or_default()
            .as_nanos(),
        NEXT.fetch_add(1, Ordering::Relaxed)
    )
}
fn atomic_json(path: &FsPath, value: &Value) -> Result<(), String> {
    let temp = path.with_extension(format!("json.{}.tmp", nonce()));
    let mut file = fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&temp)
        .map_err(|e| e.to_string())?;
    let result = (|| {
        file.write_all(&serde_json::to_vec_pretty(value).map_err(|e| e.to_string())?)
            .map_err(|e| e.to_string())?;
        file.sync_all().map_err(|e| e.to_string())?;
        fs::rename(&temp, path).map_err(|e| e.to_string())
    })();
    if result.is_err() {
        let _ = fs::remove_file(temp);
    }
    result
}
fn import(
    root: &FsPath,
    body: &[u8],
    validate_model: impl FnOnce(&FsPath) -> Result<(), String>,
) -> Result<Value, String> {
    // Binary envelope: four-byte big-endian JSON byte count, manifest JSON, then the ONNX bytes.
    if body.len() < 5 {
        return Err("需要同时上传 ONNX 和 manifest".into());
    }
    let len = u32::from_be_bytes(body[..4].try_into().unwrap()) as usize;
    if len == 0 || len > MANIFEST_MAX || body.len() <= 4 + len {
        return Err("manifest 长度无效或模型为空".into());
    }
    let model = &body[4 + len..];
    if model.len() > MODEL_MAX {
        return Err("模型不能超过 32 MiB".into());
    }
    let manifest: Value = serde_json::from_slice(&body[4..4 + len])
        .map_err(|e| format!("manifest JSON 无效：{e}"))?;
    validate_manifest(&manifest)?;
    let id: String = Sha256::digest(model)
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect();
    fs::create_dir_all(root).map_err(|e| e.to_string())?;
    let dir = root.join(&id);
    if dir.exists() {
        return Err("同一模型已经在动作库中，请编辑已有动作的 manifest".into());
    }
    let staging = root.join(format!(".{id}.{}.upload", nonce()));
    fs::create_dir(&staging).map_err(|e| format!("创建导入目录失败：{e}"))?;
    let result = (|| {
        let model_path = staging.join("policy.onnx");
        let mut file = fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&model_path)
            .map_err(|e| e.to_string())?;
        file.write_all(model)
            .and_then(|_| file.sync_all())
            .map_err(|e| e.to_string())?;
        validate_model(&model_path)?;
        atomic_json(&staging.join("manifest.json"), &manifest)?;
        fs::rename(&staging, &dir).map_err(|e| e.to_string())?;
        entry(root, &id)
    })();
    if result.is_err() {
        let _ = fs::remove_dir_all(staging);
    }
    result
}

pub async fn list(State(state): State<Arc<AppState>>) -> Response {
    let result = tokio::task::spawn_blocking(move || {
        let _guard = state.library_lock.lock().map_err(|e| e.to_string())?;
        let mut entries = Vec::new();
        if state.library.exists() {
            for item in fs::read_dir(&state.library).map_err(|e| e.to_string())? {
                let item = item.map_err(|e| e.to_string())?;
                let id = item.file_name().to_string_lossy().into_owned();
                if valid_id(&id).is_ok() && item.file_type().map_err(|e| e.to_string())?.is_dir() {
                    entries.push(entry(&state.library, &id)?);
                }
            }
        }
        Ok(json!({"entries":entries}))
    })
    .await;
    crate::blocking_response(result)
}
pub async fn upload(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    if let Err(error) = crate::same_origin(&headers, true) {
        return crate::forbidden(error);
    }
    crate::blocking_response(
        tokio::task::spawn_blocking(move || {
            let _guard = state.library_lock.lock().map_err(|e| e.to_string())?;
            import(&state.library, &body, |path| {
                duck_control::policy::validate(path).map_err(|e| e.to_string())
            })
        })
        .await,
    )
}
pub async fn edit(
    State(state): State<Arc<AppState>>,
    Path(id): Path<String>,
    headers: HeaderMap,
    Json(manifest): Json<Value>,
) -> Response {
    if let Err(error) = crate::same_origin(&headers, true) {
        return crate::forbidden(error);
    }
    crate::blocking_response(
        tokio::task::spawn_blocking(move || {
            let _guard = state.library_lock.lock().map_err(|e| e.to_string())?;
            valid_id(&id)?;
            validate_manifest(&manifest)?;
            let dir = state.library.join(&id);
            if !dir.join("policy.onnx").is_file() {
                return Err("找不到动作模型".into());
            }
            let path = dir.join("manifest.json");
            fs::copy(&path, dir.join("manifest.json.bak")).map_err(|e| e.to_string())?;
            atomic_json(&path, &manifest)?;
            entry(&state.library, &id)
        })
        .await,
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    fn manifest() -> Value {
        json!({"name":"bow","model_api":1,"obs_len":61,"action_len":14,"robot":{"model":"microduck","servos":"hd1910"},"kind":"episodic","duration_s":4,"command":{"encoding":"constant","idle":[0,0,0]},"custom":{"keep":true}})
    }
    fn envelope(m: &Value, model: &[u8]) -> Vec<u8> {
        let json = serde_json::to_vec(m).unwrap();
        let mut data = (json.len() as u32).to_be_bytes().to_vec();
        data.extend(json);
        data.extend(model);
        data
    }
    #[test]
    fn rejects_incompatible_metadata_and_unsafe_names() {
        assert!(validate_manifest(&manifest()).is_ok());
        for (key, value) in [
            ("name", json!("../bad")),
            ("duration_s", json!(0)),
            ("obs_len", json!(60)),
            ("model_api", json!(99)),
            ("chain", json!("yes")),
        ] {
            let mut m = manifest();
            m[key] = value;
            assert!(validate_manifest(&m).is_err());
        }
        assert!(valid_id("../../etc/robot").is_err());
    }
    #[test]
    fn import_is_atomic_and_preserves_unknown_manifest_fields() {
        let dir = tempfile::tempdir().unwrap();
        let data = envelope(&manifest(), b"model");
        assert!(import(dir.path(), &data, |_| Err("bad ONNX".into())).is_err());
        assert_eq!(fs::read_dir(dir.path()).unwrap().count(), 0);
        let result = import(dir.path(), &data, |_| Ok(())).unwrap();
        assert_eq!(result["manifest"]["custom"]["keep"], true);
        assert!(import(dir.path(), &data, |_| Ok(())).is_err());
        assert_eq!(fs::read_dir(dir.path()).unwrap().count(), 1);
        assert!(import(dir.path(), &[255, 255, 255, 255, 0], |_| Ok(())).is_err());
    }
}
