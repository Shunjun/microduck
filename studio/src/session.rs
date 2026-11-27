//! Per-browser persistent robotd connection: one source of expiring motion intents.
use crate::AppState;
use axum::{
    extract::{
        State, WebSocketUpgrade,
        ws::{Message, WebSocket},
    },
    http::HeaderMap,
    response::Response,
};
use serde_json::{Value, json};
use std::{sync::Arc, time::Duration};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};

pub async fn upgrade(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    ws: WebSocketUpgrade,
) -> Response {
    if let Err(error) = crate::same_origin(&headers, false) {
        return crate::forbidden(error);
    }
    ws.max_message_size(16384)
        .max_frame_size(16384)
        .on_upgrade(move |ws| bridge(ws, state))
}
pub(crate) fn allowed(value: &Value) -> bool {
    value["jsonrpc"] == "2.0"
        && matches!(
            value["method"].as_str(),
            Some(
                "hello"
                    | "robot.subscribe"
                    | "robot.health"
                    | "robot.move"
                    | "robot.stop"
                    | "robot.enable"
                    | "robot.init"
                    | "robot.relax"
                    | "robot.do"
                    | "robot.policies"
                    | "robot.skills"
                    | "robot.loadPolicy"
                    | "robot.setSkill"
                    | "robot.removeSkill"
                    | "robot.hardware"
                    | "robot.setHardware"
                    | "robot.peripherals"
                    | "robot.setPeripherals"
            )
        )
}
async fn bridge(mut ws: WebSocket, state: Arc<AppState>) {
    let stream = match tokio::net::UnixStream::connect(&state.socket).await {
        Ok(stream) => stream,
        Err(error) => {
            let _ = ws.send(Message::Text(json!({"method":"studio.error","params":{"message":format!("无法连接 robotd：{error}")}}).to_string().into())).await;
            return;
        }
    };
    let (read, mut write) = stream.into_split();
    let mut reader = BufReader::new(read).lines();
    let mut last_message = tokio::time::Instant::now();
    let mut watchdog = tokio::time::interval(Duration::from_secs(1));
    loop {
        tokio::select! {
            message = ws.recv() => match message {
                Some(Ok(Message::Text(text))) => {
                    last_message = tokio::time::Instant::now();
                    match serde_json::from_str::<Value>(&text) {
                        Ok(value) if allowed(&value) => {
                            if write.write_all(format!("{value}\n").as_bytes()).await.is_err() { break; }
                        }
                        _ => {
                            let id = serde_json::from_str::<Value>(&text).ok().and_then(|v| v.get("id").cloned());
                            let error = json!({"jsonrpc":"2.0","id":id,"error":{"code":-32601,"message":"Studio 不支持此方法或请求格式"}});
                            if ws.send(Message::Text(error.to_string().into())).await.is_err() { break; }
                        }
                    }
                }
                Some(Ok(Message::Ping(bytes))) => { if ws.send(Message::Pong(bytes)).await.is_err() { break; } }
                Some(Ok(Message::Pong(_))) => {}
                _ => break,
            },
            result = reader.next_line() => match result {
                Ok(Some(line)) if line.len() <= 262144 => {
                    match tokio::time::timeout(Duration::from_secs(2), ws.send(Message::Text(line.trim_end().to_owned().into()))).await {
                        Ok(Ok(())) => {},
                        _ => break,
                    }
                }
                _ => break,
            },
            _ = watchdog.tick() => { if last_message.elapsed() > Duration::from_secs(10) { break; } }
        }
    }
    // Stop forwarding on EOF; robotd expires the last twist through its deadman.
    // Do not send a global stop that could interrupt another operator.
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn bridge_has_a_control_only_allowlist() {
        for method in [
            "robot.move",
            "robot.subscribe",
            "robot.skills",
            "robot.stop",
            "robot.peripherals",
            "robot.setPeripherals",
        ] {
            assert!(allowed(&json!({"jsonrpc":"2.0", "method":method})));
        }
        for method in [
            "update.apply",
            "robot.autonomous",
            "robot.servoDebug",
            "config.reboot",
        ] {
            assert!(!allowed(&json!({"jsonrpc":"2.0", "method":method})));
        }
        assert!(!allowed(&json!({"method":"robot.move"})));
    }
}
