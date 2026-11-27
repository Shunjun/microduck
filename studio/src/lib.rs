//! Embedded Studio. robotd remains the sole hardware owner.
mod library;
pub mod rpc;
mod session;
mod video;
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
pub use video::MediaSignallingUrl;
pub struct AppState {
    pub socket: PathBuf,
    pub library: PathBuf,
    pub media_signalling_url: MediaSignallingUrl,
    pub library_lock: Mutex<()>,
}
pub fn app(socket: PathBuf) -> Router {
    app_with_library(socket, PathBuf::from("/var/lib/microduck-studio/actions"))
}
pub fn app_with_library(socket: PathBuf, library: PathBuf) -> Router {
    app_with_options(socket, library, MediaSignallingUrl::default())
}
pub fn app_with_options(
    socket: PathBuf,
    library: PathBuf,
    media_signalling_url: MediaSignallingUrl,
) -> Router {
    let state = Arc::new(AppState {
        socket,
        library,
        media_signalling_url,
        library_lock: Mutex::new(()),
    });
    let router = Router::new().route(
        "/",
        get(|| async { Html(include_str!("../web-dist/index.html")) }),
    );
    router
        .route(
            "/assets/studio.js",
            get(|| async {
                asset(
                    "text/javascript; charset=utf-8",
                    include_bytes!("../web-dist/assets/studio.js"),
                )
            }),
        )
        .route(
            "/assets/studio.css",
            get(|| async {
                asset(
                    "text/css; charset=utf-8",
                    include_bytes!("../web-dist/assets/studio.css"),
                )
            }),
        )
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
        .route("/api/video", get(video::upgrade))
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
        .route(
            "/api/actions/{id}/favorite",
            put(library::favorite).layer(DefaultBodyLimit::max(1024)),
        )
        .route(
            "/api/actions/{id}/alias",
            put(library::alias).layer(DefaultBodyLimit::max(1024)),
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
    #[tokio::test]
    async fn serves_react_bundle_instead_of_legacy_dom_pages() {
        use axum::{
            body::{Body, to_bytes},
            http::Request,
        };
        use tower::ServiceExt;
        let app = app(PathBuf::from("/test/missing.sock"));
        let response = app
            .clone()
            .oneshot(Request::builder().uri("/").body(Body::empty()).unwrap())
            .await
            .unwrap();
        let html = String::from_utf8(
            to_bytes(response.into_body(), 65536)
                .await
                .unwrap()
                .to_vec(),
        )
        .unwrap();
        assert!(html.contains("/assets/studio.js"));
        assert!(!html.contains("/app.js"));
        for (path, content_type) in [
            ("/assets/studio.js", "text/javascript"),
            ("/assets/studio.css", "text/css"),
        ] {
            let response = app
                .clone()
                .oneshot(Request::builder().uri(path).body(Body::empty()).unwrap())
                .await
                .unwrap();
            assert_eq!(response.status(), StatusCode::OK, "{path}");
            assert!(
                response.headers()["content-type"]
                    .to_str()
                    .unwrap()
                    .starts_with(content_type)
            );
        }
        let legacy = app
            .oneshot(
                Request::builder()
                    .uri("/debug.html")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(legacy.status(), StatusCode::NOT_FOUND);
    }
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
    async fn favorite_route_persists_and_rejects_cross_site_changes() {
        use axum::{
            body::{Body, to_bytes},
            http::Request,
        };
        use tower::ServiceExt;
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().join("actions");
        let id = "a".repeat(64);
        let model = root.join(&id);
        std::fs::create_dir_all(&model).unwrap();
        std::fs::write(model.join("policy.onnx"), b"test model").unwrap();
        std::fs::write(
            model.join("manifest.json"),
            br#"{"name":"wave","kind":"episodic"}"#,
        )
        .unwrap();
        let app = app_with_library(dir.path().join("absent.sock"), root);
        for (origin, expected) in [
            ("https://other.example", StatusCode::FORBIDDEN),
            ("http://localhost", StatusCode::OK),
        ] {
            let response = app
                .clone()
                .oneshot(
                    Request::builder()
                        .method("PUT")
                        .uri(format!("/api/actions/{id}/favorite"))
                        .header("origin", origin)
                        .header("host", "localhost")
                        .header("x-studio", "1")
                        .header("content-type", "application/json")
                        .body(Body::from(r#"{"favorite":true}"#))
                        .unwrap(),
                )
                .await
                .unwrap();
            assert_eq!(response.status(), expected);
            if expected == StatusCode::FORBIDDEN {
                assert!(!model.join("studio.json").exists());
            }
        }
        let response = app
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
        assert_eq!(value["entries"][0]["favorite"], true);
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
        for path in ["/", "/assets/studio.js", "/assets/studio.css", "/duck.bin"] {
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
