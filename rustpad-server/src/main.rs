use std::{
    fs,
    io::{self, IsTerminal, Write},
    net::{Ipv4Addr, SocketAddr, UdpSocket},
    path::{Path, PathBuf},
    time::{SystemTime, UNIX_EPOCH},
};

use rustpad_server::{database::Database, server, ServerConfig};

#[tokio::main]
async fn main() {
    if Path::new(".env").is_file() {
        if let Err(error) = load_env_file(Path::new(".env")) {
            eprintln!("无法加载配置文件 .env：{error}");
        }
    } else if let Err(error) = dotenv::dotenv() {
        if !matches!(&error, dotenv::Error::Io(cause) if cause.kind() == io::ErrorKind::NotFound) {
            eprintln!("无法加载配置文件 .env：{error}");
        }
    }
    pretty_env_logger::init();

    if let Err(message) = start().await {
        eprintln!("启动失败：{message}");
        if io::stdin().is_terminal() {
            println!("按 Enter 键退出。");
            if let Err(error) = io::stdin().read_line(&mut String::new()) {
                eprintln!("无法读取键盘输入：{error}。程序即将退出。");
            }
        }
        std::process::exit(1);
    }
}

fn load_env_file(path: &Path) -> Result<(), String> {
    let contents = fs::read(path).map_err(|error| error.to_string())?;
    let Some(stripped) = contents.strip_prefix(&[0xef, 0xbb, 0xbf]) else {
        return dotenv::from_path(path).map_err(|error| error.to_string());
    };

    let stamp = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(|error| error.to_string())?
        .as_nanos();
    let normalized =
        path.with_file_name(format!(".rustpad-env-{}-{stamp}.tmp", std::process::id()));
    let mut file = fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&normalized)
        .map_err(|error| error.to_string())?;
    let write_result = file.write_all(stripped);
    drop(file);
    let result = write_result
        .map_err(|error| error.to_string())
        .and_then(|_| dotenv::from_path(&normalized).map_err(|error| error.to_string()));
    fs::remove_file(&normalized).map_err(|error| error.to_string())?;
    result
}

fn read_config() -> Result<(u16, u32, Option<String>), String> {
    let port = std::env::var("PORT")
        .unwrap_or_else(|_| String::from("3030"))
        .parse::<u16>()
        .map_err(|error| {
            format!(
                "PORT 无法解析：{error}。请修改程序旁 .env 中的 PORT，填写 0 到 65535 的端口号。"
            )
        })?;
    let expiry_days = std::env::var("EXPIRY_DAYS")
        .unwrap_or_else(|_| String::from("1"))
        .parse::<u32>()
        .map_err(|error| {
            format!(
                "EXPIRY_DAYS 无法解析：{error}。请修改程序旁 .env 中的 EXPIRY_DAYS，填写非负整数。"
            )
        })?;
    Ok((port, expiry_days, std::env::var("SQLITE_URI").ok()))
}

async fn start() -> Result<(), String> {
    let (port, expiry_days, sqlite_uri) = read_config()?;
    let database = match sqlite_uri.as_deref() {
        Some(uri) => Some(Database::new(uri).await.map_err(|error| {
            format!("无法打开 SQLITE_URI 指定的数据文件 {uri}：{error}。请检查程序旁 .env 中的 SQLITE_URI、文件路径及写入权限。")
        })?),
        None => None,
    };

    let image_dir = std::env::var_os("IMAGE_DIR").map(PathBuf::from);
    let config = ServerConfig {
        expiry_days,
        database,
        image_dir: image_dir.clone(),
    };
    let (bound_address, serve) = warp::serve(server(config))
        .try_bind_ephemeral(([0, 0, 0, 0], port))
        .map_err(|error| format!("端口 {port} 监听失败：{error}。请关闭占用该端口的程序，或修改程序旁 .env 中的 PORT。"))?;

    let working_dir = std::env::current_dir()
        .map_err(|error| format!("无法读取当前工作目录：{error}。请从可访问的文件夹启动程序。"))?;
    let ip = lan_ip();
    let url = access_url(bound_address.port(), ip);
    println!(
        "{}",
        startup_banner(
            bound_address.port(),
            ip,
            sqlite_uri.as_deref(),
            image_dir.as_deref(),
            &working_dir
        )
    );
    open_browser(&url);
    serve.await;
    Ok(())
}

fn lan_ip() -> Option<Ipv4Addr> {
    let socket = UdpSocket::bind((Ipv4Addr::UNSPECIFIED, 0)).ok()?;
    socket.connect((Ipv4Addr::new(1, 1, 1, 1), 80)).ok()?;
    usable_lan_ip(socket.local_addr().ok()?)
}

fn usable_lan_ip(address: SocketAddr) -> Option<Ipv4Addr> {
    match address {
        SocketAddr::V4(address)
            if !address.ip().is_loopback()
                && !address.ip().is_unspecified()
                && !address.ip().is_link_local() =>
        {
            Some(*address.ip())
        }
        _ => None,
    }
}

fn access_url(port: u16, ip: Option<Ipv4Addr>) -> String {
    format!(
        "http://{}:{port}/",
        ip.map_or("localhost".to_string(), |ip| ip.to_string())
    )
}

fn startup_banner(
    port: u16,
    ip: Option<Ipv4Addr>,
    sqlite_uri: Option<&str>,
    image_dir: Option<&Path>,
    working_dir: &Path,
) -> String {
    let mut lines = vec![format!(
        "Rustpad 已启动。访问地址：{}",
        access_url(port, ip)
    )];
    if ip.is_none() {
        lines.push("未找到可用的局域网 IP；其他设备请使用主机的 IP 地址访问。".into());
    }
    match sqlite_uri {
        Some(uri) => lines.push(format!("数据位置（SQLITE_URI）：{uri}")),
        None => lines.push("警告：未开启持久化，关闭窗口后数据丢失。".into()),
    }
    match image_dir {
        Some(path) => lines.push(format!("图片位置（IMAGE_DIR）：{}", path.display())),
        None => lines.push("图片上传未开启：未设置 IMAGE_DIR。".into()),
    }
    if !working_dir.join("dist/index.html").is_file() {
        lines.push(format!(
            "警告：当前工作目录 {} 下找不到 dist/index.html；前端页面可能无法打开。",
            working_dir.display()
        ));
    }
    lines.join("\n")
}

#[cfg(windows)]
fn open_browser(url: &str) {
    match std::process::Command::new("cmd")
        .args(["/C", "start", "", url])
        .status()
    {
        Ok(status) if status.success() => {}
        Ok(status) => eprintln!("无法自动打开浏览器（退出状态 {status}）。请手动访问 {url}"),
        Err(error) => eprintln!("无法自动打开浏览器：{error}。请手动访问 {url}"),
    }
}

#[cfg(not(windows))]
fn open_browser(_url: &str) {}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn selects_usable_ipv4_address() {
        let address = |ip| SocketAddr::from((ip, 1234));
        assert_eq!(
            usable_lan_ip(address([192, 168, 1, 42])),
            Some(Ipv4Addr::new(192, 168, 1, 42))
        );
        assert_eq!(usable_lan_ip(address([127, 0, 0, 1])), None);
        assert_eq!(usable_lan_ip(address([0, 0, 0, 0])), None);
        assert_eq!(usable_lan_ip(address([169, 254, 1, 2])), None);
    }

    #[test]
    fn banner_shows_url_database_and_missing_dist_warning() {
        let dir = tempfile::tempdir().unwrap();
        let banner = startup_banner(
            3030,
            Some(Ipv4Addr::new(192, 168, 1, 42)),
            Some("sqlite://rustpad.db"),
            None,
            dir.path(),
        );
        assert!(banner.contains("http://192.168.1.42:3030/"));
        assert!(banner.contains("数据位置（SQLITE_URI）：sqlite://rustpad.db"));
        assert!(banner.contains(&dir.path().display().to_string()));
        assert!(banner.contains("找不到 dist/index.html"));
    }

    #[test]
    fn banner_shows_localhost_and_memory_storage_without_false_warning() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::create_dir(dir.path().join("dist")).unwrap();
        std::fs::write(dir.path().join("dist/index.html"), "").unwrap();
        let banner = startup_banner(3030, None, None, None, dir.path());
        assert!(banner.contains("http://localhost:3030/"));
        assert!(banner.contains("其他设备请使用主机的 IP 地址访问"));
        assert!(banner.contains("未开启持久化，关闭窗口后数据丢失"));
        assert!(!banner.contains("找不到 dist/index.html"));
    }

    #[test]
    fn banner_shows_configured_image_directory() {
        let dir = tempfile::tempdir().unwrap();
        let banner = startup_banner(3030, None, None, Some(Path::new("images")), dir.path());
        assert!(banner.contains("图片位置（IMAGE_DIR）：images"));
        assert!(!banner.contains("图片上传未开启"));
    }

    #[test]
    fn banner_shows_image_uploads_disabled_without_directory() {
        let dir = tempfile::tempdir().unwrap();
        let banner = startup_banner(3030, None, None, None, dir.path());
        assert!(banner.contains("图片上传未开启：未设置 IMAGE_DIR。"));
        assert!(!banner.contains("图片位置（IMAGE_DIR）"));
    }

    #[test]
    fn loads_bom_and_crlf_env_with_dotenv_rules() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join(".env");
        let previous = std::env::var_os("SQLITE_URI");
        std::env::remove_var("SQLITE_URI");
        fs::write(
            &path,
            b"\xef\xbb\xbf# config\r\nSQLITE_URI=sqlite://bom-test.db\r\nRUSTPAD_BOM_TEST=loaded\r\n",
        )
        .unwrap();
        load_env_file(&path).unwrap();
        assert_eq!(
            read_config().unwrap().2.as_deref(),
            Some("sqlite://bom-test.db")
        );
        assert_eq!(std::env::var("RUSTPAD_BOM_TEST").unwrap(), "loaded");
        std::env::remove_var("RUSTPAD_BOM_TEST");
        if let Some(value) = previous {
            std::env::set_var("SQLITE_URI", value);
        } else {
            std::env::remove_var("SQLITE_URI");
        }
    }
}
