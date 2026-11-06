use std::{
    fs,
    io::{Read, Write},
    net::{TcpListener, TcpStream},
    process::{Child, Command, Stdio},
    time::{Duration, Instant},
};

struct Server {
    child: Child,
    port: u16,
    directory: std::path::PathBuf,
}
impl Server {
    fn start() -> Self {
        let port = TcpListener::bind("127.0.0.1:0")
            .unwrap()
            .local_addr()
            .unwrap()
            .port();
        let directory =
            std::env::temp_dir().join(format!("otium-rust-http-{}-{port}", std::process::id()));
        fs::create_dir_all(&directory).unwrap();
        fs::write(
            directory.join("index.html"),
            "<!doctype html><title>Rust host</title>",
        )
        .unwrap();
        fs::write(directory.join("test.wasm"), b"\0asm\x01\0\0\0").unwrap();
        let child = Command::new(env!("CARGO_BIN_EXE_otium-server"))
            .env("PORT", port.to_string())
            .env("OTIUM_PUBLIC", &directory)
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .unwrap();
        let server = Self {
            child,
            port,
            directory,
        };
        let deadline = Instant::now() + Duration::from_secs(10);
        while TcpStream::connect(("127.0.0.1", port)).is_err() {
            assert!(Instant::now() < deadline, "Rust HTTP host failed to start");
            std::thread::sleep(Duration::from_millis(20));
        }
        server
    }
    fn request(&self, target: &str) -> String {
        let mut socket = TcpStream::connect(("127.0.0.1", self.port)).unwrap();
        socket
            .set_read_timeout(Some(Duration::from_secs(5)))
            .unwrap();
        write!(
            socket,
            "GET {target} HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n"
        )
        .unwrap();
        let mut bytes = Vec::new();
        socket.read_to_end(&mut bytes).unwrap();
        String::from_utf8_lossy(&bytes).into_owned()
    }
}
impl Drop for Server {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
        let _ = fs::remove_dir_all(&self.directory);
    }
}

#[test]
fn rust_host_serves_health_and_wasm_without_node() {
    let server = Server::start();
    let health = server.request("/api/health");
    assert!(health.starts_with("HTTP/1.1 200"));
    assert!(health.contains("\"engine\":\"rust\""));
    let wasm = server.request("/test.wasm");
    assert!(wasm.contains("Content-Type: application/wasm"));
    assert!(wasm.contains("Content-Length: 8"));
    let html = server.request("/");
    assert!(html.contains("<title>Rust host</title>"));
}
#[test]
fn rust_host_rejects_arbitrary_upstreams_before_network_io() {
    let server = Server::start();
    for target in [
        "/api/series/detail?url=https%3A%2F%2Flocalhost%2Fadmin",
        "/api/episode/detail?url=https%3A%2F%2Fkrmzi.org.attacker.test%2Fepisode%2F1",
        "/api/cinemana?path=..%2Fadmin",
    ] {
        let result = server.request(target);
        assert!(result.starts_with("HTTP/1.1 400"), "{target}: {result}");
        assert!(result.contains("\"isSuccess\":false"));
    }
    assert!(server.request("/api/unknown").starts_with("HTTP/1.1 404"));
    assert!(server
        .request("/api/media?url=https%3A%2F%2F127.0.0.1%2Fsecret")
        .starts_with("HTTP/1.1 502"));
}
