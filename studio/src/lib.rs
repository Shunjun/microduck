//! Embedded Studio. robotd remains the sole hardware owner.
mod library;
pub mod rpc;
mod session;
use axum::{
    Json, Router,
    extract::{DefaultBodyLimit, State},
    http::{HeaderMap, StatusCode},
    response::{Html, IntoResponse, Response},
    routing::{get, post, put},
};
use serde_json::{Value, json};
use std::{
    path::PathBuf,
    sync::{Arc, Mutex},
};
pub struct AppState {
    pub socket: PathBuf,
    pub library: PathBuf,
    pub library_lock: Mutex<()>,
}
pub fn app(socket: PathBuf) -> Router {
    app_with_library(socket, PathBuf::from("/var/lib/microduck-studio/actions"))
}
pub fn app_with_library(socket: PathBuf, library: PathBuf) -> Router {
    let state = Arc::new(AppState {
        socket,
        library,
        library_lock: Mutex::new(()),
    });
    let mut router = Router::new().route(
        "/",
        get(|| async { Html(include_str!("../web/index.html")) }),
    );
    macro_rules! web {
        ($name:literal,$mime:literal) => {
            router = router.route(
                concat!("/", $name),
                get(|| async {
                    asset($mime, include_bytes!(concat!("../web/", $name)).as_slice())
                }),
            );
        };
    }
    web!("app.js", "text/javascript; charset=utf-8");
    web!("ui.js", "text/javascript; charset=utf-8");
    web!("state.js", "text/javascript; charset=utf-8");
    web!("media.js", "text/javascript; charset=utf-8");
    web!("control.js", "text/javascript; charset=utf-8");
    web!("actions.js", "text/javascript; charset=utf-8");
    web!("debug.js", "text/javascript; charset=utf-8");
    web!("debug.html", "text/html; charset=utf-8");
    web!("preview.js", "text/javascript; charset=utf-8");
    web!("style.css", "text/css; charset=utf-8");
    web!("control.css", "text/css; charset=utf-8");
    web!("actions.css", "text/css; charset=utf-8");
    web!("debug.css", "text/css; charset=utf-8");
    web!("settings.css", "text/css; charset=utf-8");
    router
        .route(
            "/duck.bin",
            get(|| async {
                asset(
                    "application/octet-stream",
                    include_bytes!("../assets/duck.bin").as_slice(),
                )
            }),
        )
        .route("/api/debug", post(debug))
        .route("/api/session", get(session::upgrade))
        .route(
            "/api/actions",
            get(library::list)
                .post(library::upload)
                .layer(DefaultBodyLimit::max(32 * 1024 * 1024 + 65540)),
        )
        .route(
            "/api/actions/{id}/manifest",
            put(library::edit).layer(DefaultBodyLimit::max(65536)),
        )
        .layer(DefaultBodyLimit::max(16384))
        .with_state(state)
}
fn asset(mime: &'static str, bytes: &'static [u8]) -> impl IntoResponse {
    (
        [("content-type", mime), ("cache-control", "no-cache")],
        bytes,
    )
}
pub(crate) fn same_origin(headers: &HeaderMap, request_header: bool) -> Result<(), &'static str> {
    let denied = || "请求必须来自 Studio 同源页面";
    if request_header && headers.get("x-studio").and_then(|v| v.to_str().ok()) != Some("1") {
        return Err(denied());
    }
    let host = headers
        .get("host")
        .and_then(|v| v.to_str().ok())
        .unwrap_or("");
    match headers.get("origin").and_then(|v| v.to_str().ok()) {
        Some(origin)
            if origin == format!("http://{host}") || origin == format!("https://{host}") =>
        {
            Ok(())
        }
        None if request_header => Ok(()),
        _ => Err(denied()),
    }
}
pub(crate) fn forbidden(error: &str) -> Response {
    (StatusCode::FORBIDDEN, Json(json!({"error":error}))).into_response()
}
pub(crate) fn blocking_response(
    result: Result<Result<Value, String>, tokio::task::JoinError>,
) -> Response {
    match result {
        Ok(Ok(value)) => Json(value).into_response(),
        Ok(Err(error)) => (StatusCode::BAD_REQUEST, Json(json!({"error":error}))).into_response(),
        Err(error) => (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(json!({"error":format!("任务失败：{error}")})),
        )
            .into_response(),
    }
}
async fn debug(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Json(params): Json<Value>,
) -> Response {
    if let Err(error) = same_origin(&headers, true) {
        return forbidden(error);
    }
    match rpc::call(&state.socket, params).await {
        Ok(value) => Json(value).into_response(),
        Err(error) => (StatusCode::BAD_GATEWAY, Json(json!({"error":error}))).into_response(),
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn checks_origins_and_required_mutation_header() {
        let mut h = HeaderMap::new();
        h.insert("host", "duck:8080".parse().unwrap());
        h.insert("origin", "http://duck:8080".parse().unwrap());
        assert!(same_origin(&h, false).is_ok());
        assert!(same_origin(&h, true).is_err());
        h.insert("x-studio", "1".parse().unwrap());
        assert!(same_origin(&h, true).is_ok());
        h.insert("origin", "http://evil.example".parse().unwrap());
        assert!(same_origin(&h, true).is_err());
        h.remove("origin");
        assert!(same_origin(&h, false).is_err());
    }
    #[tokio::test]
    async fn serves_assets_bounds_uploads_and_rejects_cross_site_mutations() {
        use axum::{
            body::{Body, to_bytes},
            http::Request,
        };
        use tower::ServiceExt;
        let dir = tempfile::tempdir().unwrap();
        let app = app_with_library(dir.path().join("absent.sock"), dir.path().join("actions"));
        for path in ["/", "/app.js", "/debug.html", "/settings.css", "/duck.bin"] {
            let response = app
                .clone()
                .oneshot(Request::builder().uri(path).body(Body::empty()).unwrap())
                .await
                .unwrap();
            assert_eq!(response.status(), StatusCode::OK, "{path}");
        }
        let response = app
            .clone()
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri("/api/actions")
                    .header("x-studio", "1")
                    .header("host", "duck:8080")
                    .header("origin", "http://evil.example")
                    .body(Body::from("bad"))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::FORBIDDEN);
        let response = app
            .clone()
            .oneshot(
                Request::builder()
                    .uri("/api/actions")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        let value: Value =
            serde_json::from_slice(&to_bytes(response.into_body(), 65536).await.unwrap()).unwrap();
        assert_eq!(value["entries"], json!([]));
        let response = app
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri("/api/actions")
                    .header("x-studio", "1")
                    .body(Body::from(vec![0u8; 32 * 1024 * 1024 + 65541]))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::PAYLOAD_TOO_LARGE);
        assert!(!dir.path().join("actions").exists());
    }
}
