//! Embedded Servo Studio, independently extensible from the original media console.
pub mod rpc;
use axum::{
    Json, Router,
    extract::{DefaultBodyLimit, State},
    http::{HeaderMap, StatusCode},
    response::{Html, IntoResponse, Response},
    routing::{get, post},
};
use serde_json::{Value, json};
use std::{path::PathBuf, sync::Arc};
pub fn app(socket: PathBuf) -> Router {
    Router::new()
        .route(
            "/",
            get(|| async { Html(include_str!("../web/index.html")) }),
        )
        .route(
            "/app.js",
            get(|| async {
                asset(
                    "text/javascript; charset=utf-8",
                    include_bytes!("../web/app.js").as_slice(),
                )
            }),
        )
        .route(
            "/preview.js",
            get(|| async {
                asset(
                    "text/javascript; charset=utf-8",
                    include_bytes!("../web/preview.js").as_slice(),
                )
            }),
        )
        .route(
            "/style.css",
            get(|| async {
                asset(
                    "text/css; charset=utf-8",
                    include_bytes!("../web/style.css").as_slice(),
                )
            }),
        )
        //Compatible: share the upstream baked mesh; geometry is not copied or fetched from a CDN.
        .route(
            "/duck.bin",
            get(|| async {
                asset(
                    "application/octet-stream",
                    include_bytes!("../../robotctl/assets/duck.bin").as_slice(),
                )
            }),
        )
        .route("/api/debug", post(debug))
        .layer(DefaultBodyLimit::max(16384))
        .with_state(Arc::new(socket))
}
fn asset(mime: &'static str, bytes: &'static [u8]) -> impl IntoResponse {
    (
        [("content-type", mime), ("cache-control", "no-cache")],
        bytes,
    )
}
async fn debug(
    State(socket): State<Arc<PathBuf>>,
    headers: HeaderMap,
    Json(params): Json<Value>,
) -> Response {
    if headers.get("x-studio").and_then(|v| v.to_str().ok()) != Some("1") {
        return (
            StatusCode::FORBIDDEN,
            Json(json!({"error":"missing studio request header"})),
        )
            .into_response();
    }
    if let Some(origin) = headers.get("origin").and_then(|v| v.to_str().ok()) {
        let host = headers
            .get("host")
            .and_then(|v| v.to_str().ok())
            .unwrap_or("");
        if origin != format!("http://{host}") && origin != format!("https://{host}") {
            return (
                StatusCode::FORBIDDEN,
                Json(json!({"error":"origin mismatch"})),
            )
                .into_response();
        }
    }
    match rpc::call(&socket, params).await {
        Ok(value) => Json(value).into_response(),
        Err(error) => (StatusCode::BAD_GATEWAY, Json(json!({"error":error}))).into_response(),
    }
}
