use clap::Parser;
#[derive(Parser)]
#[command(about = "Microduck Servo Studio — all device access goes through robotd")]
struct Args {
    #[arg(long, default_value = "0.0.0.0:8081")]
    listen: std::net::SocketAddr,
    #[arg(long, default_value = "/run/robotd.sock")]
    robot_socket: std::path::PathBuf,
}
#[tokio::main]
async fn main() -> std::io::Result<()> {
    let args = Args::parse();
    let listener = tokio::net::TcpListener::bind(args.listen).await?;
    eprintln!(
        "Servo Studio: http://{} · robotd {}",
        listener.local_addr()?,
        args.robot_socket.display()
    );
    axum::serve(listener, studio::app(args.robot_socket))
        .with_graceful_shutdown(async {
            let _ = tokio::signal::ctrl_c().await;
        })
        .await
}
