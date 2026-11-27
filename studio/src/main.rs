use clap::Parser;
#[derive(Parser)]
#[command(about = "Microduck Studio — all device access goes through robotd")]
struct Args {
    #[arg(long, default_value = "0.0.0.0:8080")]
    listen: std::net::SocketAddr,
    #[arg(long, default_value = "/run/robotd.sock")]
    robot_socket: std::path::PathBuf,
    #[arg(long, default_value = "/var/lib/microduck-studio/actions")]
    library_dir: std::path::PathBuf,
    /// Local mediad signalling endpoint (literal loopback IP and port only).
    #[arg(long, default_value = "ws://127.0.0.1:8443")]
    media_signalling_url: studio::MediaSignallingUrl,
}
#[tokio::main]
async fn main() -> std::io::Result<()> {
    let args = Args::parse();
    let listener = tokio::net::TcpListener::bind(args.listen).await?;
    eprintln!(
        "Microduck Studio: http://{} · robotd {}",
        listener.local_addr()?,
        args.robot_socket.display()
    );
    axum::serve(
        listener,
        studio::app_with_options(
            args.robot_socket,
            std::path::absolute(args.library_dir)?,
            args.media_signalling_url,
        ),
    )
    .with_graceful_shutdown(async {
        let _ = tokio::signal::ctrl_c().await;
    })
    .await
}
