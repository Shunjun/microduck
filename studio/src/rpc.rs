//! Every device request is executed by robotd; this service has no serial dependency.
use serde_json::{Value, json};
use std::{path::Path, time::Duration};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
pub async fn call(socket: &Path, params: Value) -> Result<Value, String> {
    tokio::time::timeout(Duration::from_secs(12),async {
        let mut stream=tokio::net::UnixStream::connect(socket).await.map_err(|e|format!("无法连接 robotd：{e}"))?;
        let mut data=serde_json::to_vec(&json!({"jsonrpc":"2.0","id":1,"method":duck_ipc_proto::method::ROBOT_SERVO_DEBUG,"params":params})).map_err(|e|e.to_string())?;
        data.push(b'\n');stream.write_all(&data).await.map_err(|e|e.to_string())?;
        use tokio::io::AsyncReadExt;
        let mut reader=BufReader::new(stream).take(262145);let mut line=String::new();reader.read_line(&mut line).await.map_err(|e|e.to_string())?;
        if line.len()>262144{return Err("robotd 回包过大".into());}
        let reply:Value=serde_json::from_str(&line).map_err(|e|format!("robotd 回包无效：{e}"))?;
        if let Some(error)=reply.get("error"){return Err(error["message"].as_str().unwrap_or("robotd 拒绝请求").to_owned());}
        reply.get("result").cloned().ok_or_else(||"robotd 回包缺少 result".into())
    }).await.map_err(|_|"robotd 响应超时".to_owned())?
}

#[cfg(test)]
mod tests {
    use super::*;
    async fn reply(socket: &Path, response: Value) -> tokio::task::JoinHandle<()> {
        let listener = tokio::net::UnixListener::bind(socket).unwrap();
        tokio::spawn(async move {
            let (mut stream, _) = listener.accept().await.unwrap();
            let mut line = String::new();
            BufReader::new(&mut stream)
                .read_line(&mut line)
                .await
                .unwrap();
            let r: Value = serde_json::from_str(&line).unwrap();
            assert_eq!(r["method"], duck_ipc_proto::method::ROBOT_SERVO_DEBUG);
            assert_eq!(r["params"]["op"], "status");
            stream
                .write_all(format!("{response}\n").as_bytes())
                .await
                .unwrap();
        })
    }
    #[tokio::test]
    async fn forwards_only_the_debug_method_and_reports_robotd_errors() {
        let dir = tempfile::tempdir().unwrap();
        let socket = dir.path().join("robot.sock");
        let task = reply(
            &socket,
            json!({"jsonrpc":"2.0","id":1,"result":{"active":true}}),
        )
        .await;
        assert_eq!(
            call(&socket, json!({"op":"status"})).await.unwrap()["active"],
            true
        );
        task.await.unwrap();
        std::fs::remove_file(&socket).unwrap();
        let task = reply(
            &socket,
            json!({"jsonrpc":"2.0","id":1,"error":{"code":-32602,"message":"limits missing"}}),
        )
        .await;
        assert_eq!(
            call(&socket, json!({"op":"status"})).await.unwrap_err(),
            "limits missing"
        );
        task.await.unwrap();
    }
}
