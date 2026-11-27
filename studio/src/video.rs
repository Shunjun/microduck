//! Same-origin signalling bridge to mediad on this device. Media itself uses WebRTC.
use crate::AppState;
use axum::{
    Json,
    extract::{
        State, WebSocketUpgrade,
        ws::{CloseFrame, Message, WebSocket},
    },
    http::{HeaderMap, StatusCode, Uri},
    response::{IntoResponse, Response},
};
use futures_util::{SinkExt, StreamExt};
use std::{net::SocketAddr, str::FromStr, sync::Arc, time::Duration};
use tokio::{net::TcpStream, time::timeout};
use tokio_tungstenite::{
    MaybeTlsStream, WebSocketStream, connect_async_with_config,
    tungstenite::{Message as UpstreamMessage, protocol::WebSocketConfig},
};

const MAX_FRAME: usize = 64 * 1024;
const IO_TIMEOUT: Duration = Duration::from_secs(3);

/// Administrative configuration only: literal loopback addresses avoid DNS rebinding.
#[derive(Clone, Debug)]
pub struct MediaSignallingUrl(String);
impl Default for MediaSignallingUrl {
    fn default() -> Self {
        Self("ws://127.0.0.1:8443".into())
    }
}
impl FromStr for MediaSignallingUrl {
    type Err = String;
    fn from_str(value: &str) -> Result<Self, Self::Err> {
        let denied = || {
            "media signalling URL must be ws:// with an explicit loopback IP and port".to_string()
        };
        let uri: Uri = value.parse().map_err(|_| denied())?;
        let address: SocketAddr = uri
            .authority()
            .ok_or_else(denied)?
            .as_str()
            .parse()
            .map_err(|_| denied())?;
        if uri.scheme_str() != Some("ws") || !address.ip().is_loopback() || address.port() == 0 {
            return Err(denied());
        }
        Ok(Self(value.into()))
    }
}

pub async fn upgrade(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    ws: WebSocketUpgrade,
) -> Response {
    if let Err(error) = crate::same_origin(&headers, false) {
        return crate::forbidden(error);
    }
    let config = WebSocketConfig::default()
        .max_message_size(Some(MAX_FRAME))
        .max_frame_size(Some(MAX_FRAME));
    // Connect before upgrading so a stopped media daemon produces an actionable HTTP failure.
    let upstream = match timeout(
        IO_TIMEOUT,
        connect_async_with_config(state.media_signalling_url.0.as_str(), Some(config), false),
    )
    .await
    {
        Ok(Ok((socket, _))) => socket,
        _ => {
            return (
                StatusCode::BAD_GATEWAY,
                Json(serde_json::json!({"error":"无法连接本机 mediad 视频服务"})),
            )
                .into_response();
        }
    };
    ws.max_message_size(MAX_FRAME)
        .max_frame_size(MAX_FRAME)
        .on_upgrade(move |browser| bridge(browser, upstream))
}

type Upstream = WebSocketStream<MaybeTlsStream<TcpStream>>;
async fn bridge(mut browser: WebSocket, mut upstream: Upstream) {
    loop {
        tokio::select! {
            message = browser.recv() => match message {
                Some(Ok(message)) => {
                    let closing = matches!(message, Message::Close(_));
                    let message = match message {
                        Message::Text(text) => UpstreamMessage::Text(text.to_string().into()),
                        Message::Binary(bytes) => UpstreamMessage::Binary(bytes),
                        // Each connection handles its own transport heartbeats.
                        Message::Ping(_) | Message::Pong(_) => continue,
                        Message::Close(frame) => UpstreamMessage::Close(frame.map(|frame| tokio_tungstenite::tungstenite::protocol::CloseFrame {
                            code: frame.code.into(), reason: frame.reason.to_string().into(),
                        })),
                    };
                    if !matches!(timeout(IO_TIMEOUT, upstream.send(message)).await, Ok(Ok(()))) { break; }
                    if closing {
                        let _ = timeout(IO_TIMEOUT, browser.flush()).await;
                        return;
                    }
                }
                _ => break,
            },
            message = upstream.next() => match message {
                Some(Ok(message)) => {
                    let closing = matches!(message, UpstreamMessage::Close(_));
                    let message = match message {
                        UpstreamMessage::Text(text) => Message::Text(text.to_string().into()),
                        UpstreamMessage::Binary(bytes) => Message::Binary(bytes),
                        UpstreamMessage::Close(frame) => Message::Close(frame.map(|frame| CloseFrame {
                            code: frame.code.into(), reason: frame.reason.to_string().into(),
                        })),
                        UpstreamMessage::Ping(_) | UpstreamMessage::Pong(_) | UpstreamMessage::Frame(_) => continue,
                    };
                    if !matches!(timeout(IO_TIMEOUT, browser.send(message)).await, Ok(Ok(()))) { break; }
                    if closing {
                        let _ = timeout(IO_TIMEOUT, upstream.flush()).await;
                        return;
                    }
                }
                _ => break,
            },
        }
    }
    let _ = timeout(
        IO_TIMEOUT,
        browser.send(Message::Close(Some(CloseFrame {
            code: 1011,
            reason: "视频信令连接已断开".into(),
        }))),
    )
    .await;
    let _ = timeout(IO_TIMEOUT, upstream.close(None)).await;
}

#[cfg(test)]
mod tests {
    use axum::http::StatusCode;
    use tokio_tungstenite::{connect_async, tungstenite::client::IntoClientRequest};

    #[tokio::test]
    async fn refuses_cross_origin_video_before_contacting_media() {
        // Without the origin gate, any website could establish a robot media session.
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let server = tokio::spawn(async move {
            axum::serve(listener, crate::app("/missing.sock".into()))
                .await
                .unwrap();
        });
        let mut request = format!("ws://{address}/api/video")
            .into_client_request()
            .unwrap();
        request
            .headers_mut()
            .insert("origin", "https://evil.example".parse().unwrap());
        let error = connect_async(request).await.unwrap_err();
        match error {
            tokio_tungstenite::tungstenite::Error::Http(response) => {
                assert_eq!(response.status(), StatusCode::FORBIDDEN)
            }
            other => panic!("expected HTTP refusal, got {other}"),
        }
        server.abort();
    }
    #[test]
    fn accepts_only_explicit_loopback_signalling_addresses() {
        // An administrator can move mediad locally, but cannot turn the route into an SSRF proxy.
        for url in ["ws://127.0.0.1:8443", "ws://[::1]:8443/signal"] {
            assert!(url.parse::<super::MediaSignallingUrl>().is_ok(), "{url}");
        }
        for url in [
            "ws://example.com:8443",
            "ws://192.168.1.2:8443",
            "http://127.0.0.1:8443",
            "ws://user@127.0.0.1:8443",
            "ws://localhost:8443",
        ] {
            assert!(url.parse::<super::MediaSignallingUrl>().is_err(), "{url}");
        }
    }

    async fn local_studio(media: String) -> (String, tokio::task::JoinHandle<()>) {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let server = tokio::spawn(async move {
            let app = crate::app_with_options(
                "/missing.sock".into(),
                "/unused/actions".into(),
                media.parse().unwrap(),
            );
            axum::serve(listener, app).await.unwrap();
        });
        (format!("ws://{address}/api/video"), server)
    }

    fn browser_request(url: &str) -> tokio_tungstenite::tungstenite::http::Request<()> {
        let mut request = url.into_client_request().unwrap();
        let origin = url.replace("ws://", "http://").replace("/api/video", "");
        request
            .headers_mut()
            .insert("origin", origin.parse().unwrap());
        request
    }

    #[tokio::test]
    async fn forwards_signalling_both_ways_and_upstream_close() {
        use futures_util::{SinkExt, StreamExt};
        use tokio_tungstenite::tungstenite::{
            Message, protocol::CloseFrame, protocol::frame::coding::CloseCode,
        };
        // SDP/ICE must travel unchanged and a completed media session must close the browser socket.
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let upstream = tokio::spawn(async move {
            let (stream, _) = listener.accept().await.unwrap();
            let mut socket = tokio_tungstenite::accept_async(stream).await.unwrap();
            socket.send(Message::Text("offer".into())).await.unwrap();
            assert_eq!(
                socket.next().await.unwrap().unwrap(),
                Message::Text("answer".into())
            );
            socket
                .send(Message::Binary(vec![1, 2, 3].into()))
                .await
                .unwrap();
            socket
                .close(Some(CloseFrame {
                    code: CloseCode::Normal,
                    reason: "done".into(),
                }))
                .await
                .unwrap();
        });
        let (url, server) = local_studio(format!("ws://{address}")).await;
        tokio::time::timeout(std::time::Duration::from_secs(5), async {
            let (mut socket, _) = connect_async(browser_request(&url)).await.unwrap();
            assert_eq!(
                socket.next().await.unwrap().unwrap(),
                Message::Text("offer".into())
            );
            socket.send(Message::Text("answer".into())).await.unwrap();
            assert_eq!(
                socket.next().await.unwrap().unwrap(),
                Message::Binary(vec![1, 2, 3].into())
            );
            let Message::Close(Some(close)) = socket.next().await.unwrap().unwrap() else {
                panic!("missing forwarded close")
            };
            assert_eq!(close.code, CloseCode::Normal);
            assert_eq!(close.reason.as_str(), "done");
            upstream.await.unwrap();
        })
        .await
        .unwrap();
        server.abort();
    }

    #[tokio::test]
    async fn browser_close_reaches_media_daemon() {
        use futures_util::{SinkExt, StreamExt};
        use tokio_tungstenite::tungstenite::{
            Message, protocol::CloseFrame, protocol::frame::coding::CloseCode,
        };
        // Leaving the page must release the mediad session, including its close reason.
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let upstream = tokio::spawn(async move {
            let (stream, _) = listener.accept().await.unwrap();
            let mut socket = tokio_tungstenite::accept_async(stream).await.unwrap();
            let Message::Close(Some(close)) = socket.next().await.unwrap().unwrap() else {
                panic!("missing browser close")
            };
            assert_eq!(close.code, CloseCode::Away);
            assert_eq!(close.reason.as_str(), "page left");
        });
        let (url, server) = local_studio(format!("ws://{address}")).await;
        tokio::time::timeout(std::time::Duration::from_secs(5), async {
            let (mut socket, _) = connect_async(browser_request(&url)).await.unwrap();
            socket
                .send(Message::Close(Some(CloseFrame {
                    code: CloseCode::Away,
                    reason: "page left".into(),
                })))
                .await
                .unwrap();
            upstream.await.unwrap();
        })
        .await
        .unwrap();
        server.abort();
    }

    #[tokio::test]
    async fn unavailable_media_returns_bad_gateway_without_upgrading() {
        // A stopped mediad should fail visibly instead of leaving a connected, silent video socket.
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        drop(listener);
        let (url, server) = local_studio(format!("ws://{address}")).await;
        let error = tokio::time::timeout(
            std::time::Duration::from_secs(5),
            connect_async(browser_request(&url)),
        )
        .await
        .unwrap()
        .unwrap_err();
        match error {
            tokio_tungstenite::tungstenite::Error::Http(response) => {
                assert_eq!(response.status(), StatusCode::BAD_GATEWAY);
                assert!(
                    String::from_utf8_lossy(response.body().as_ref().unwrap()).contains("mediad")
                );
            }
            other => panic!("expected unavailable media response, got {other}"),
        }
        server.abort();
    }
}
