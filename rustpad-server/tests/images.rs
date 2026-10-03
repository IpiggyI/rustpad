use std::path::{Path, PathBuf};
use std::sync::Mutex;

use rustpad_server::{server, ServerConfig};
use serde_json::Value;
use warp::{filters::BoxedFilter, Reply};

pub mod common;

const MAX_IMAGE_SIZE: usize = 10 * 1024 * 1024;

struct ErrorLog(Mutex<Vec<String>>);

static ERROR_LOG: ErrorLog = ErrorLog(Mutex::new(Vec::new()));

impl log::Log for ErrorLog {
    fn enabled(&self, metadata: &log::Metadata<'_>) -> bool {
        metadata.level() == log::Level::Error
    }

    fn log(&self, record: &log::Record<'_>) {
        if self.enabled(record.metadata()) {
            self.0.lock().unwrap().push(record.args().to_string());
        }
    }

    fn flush(&self) {}
}

fn config(image_dir: Option<PathBuf>) -> ServerConfig {
    ServerConfig {
        image_dir,
        ..ServerConfig::default()
    }
}

async fn upload<F: Reply + 'static>(
    filter: &BoxedFilter<(F,)>,
    bytes: &[u8],
    content_type: &str,
) -> warp::http::Response<warp::hyper::body::Bytes> {
    upload_at_path(filter, "/api/images", bytes, content_type).await
}

async fn upload_at_path<F: Reply + 'static>(
    filter: &BoxedFilter<(F,)>,
    path: &str,
    bytes: &[u8],
    content_type: &str,
) -> warp::http::Response<warp::hyper::body::Bytes> {
    warp::test::request()
        .method("POST")
        .path(path)
        .header("content-length", bytes.len().to_string())
        .header("content-type", content_type)
        .body(bytes.to_vec())
        .reply(filter)
        .await
}

fn assert_dated_image_path(path: &str, extension: &str, expected_date: Option<&str>) {
    let file_name = path.strip_prefix("api/images/").unwrap();
    let file_name = file_name.strip_suffix(&format!(".{extension}")).unwrap();
    let (date, suffix) = file_name.split_once('-').unwrap();
    assert_eq!(date.len(), 8);
    assert!(date.bytes().all(|byte| byte.is_ascii_digit()));
    assert_eq!(suffix.len(), 4);
    assert!(suffix
        .bytes()
        .all(|byte| byte.is_ascii_lowercase() || byte.is_ascii_digit()));
    if let Some(expected_date) = expected_date {
        assert_eq!(date, expected_date);
    }
}

async fn directory_is_empty(path: &Path) -> bool {
    let mut entries = tokio::fs::read_dir(path).await.unwrap();
    while let Some(entry) = entries.next_entry().await.unwrap() {
        if entry.file_name() != ".image-store.lock" {
            return false;
        }
    }
    true
}

#[tokio::test]
async fn repeated_uploads_reuse_the_same_image_across_dates() {
    let directory = tempfile::tempdir().unwrap();
    let settings = config(Some(directory.path().to_path_buf()));
    let filter = server(settings.clone());
    let bytes = b"\x89PNG\r\n\x1a\nrepeated image";
    let first = upload_at_path(&filter, "/api/images?date=20261003", bytes, "image/png").await;
    assert_eq!(first.status(), 200);
    let second = upload_at_path(&filter, "/api/images?date=20261004", bytes, "image/png").await;
    assert_eq!(second.status(), 200);
    assert_eq!(
        first.body(),
        second.body(),
        "identical bytes must reuse the stored path"
    );
}

#[tokio::test]
async fn startup_cleanup_removes_an_expired_unreferenced_image() {
    let directory = tempfile::tempdir().unwrap();
    let name = "20261003-ab12.png";
    tokio::fs::write(directory.path().join(name), b"\x89PNG\r\n\x1a\nunused")
        .await
        .unwrap();
    tokio::fs::write(
        directory.path().join(".image-state.json"),
        serde_json::to_vec(&serde_json::json!({name: 1})).unwrap(),
    )
    .await
    .unwrap();
    let filter = server(config(Some(directory.path().to_path_buf())));
    tokio::task::yield_now().await;
    for _ in 0..100 {
        if !directory.path().join(name).exists() {
            break;
        }
        tokio::time::sleep(std::time::Duration::from_millis(10)).await;
    }
    assert!(
        !directory.path().join(name).exists(),
        "expired image still occupies disk space"
    );
    let response = warp::test::request()
        .path(&format!("/api/images/{name}"))
        .reply(&filter)
        .await;
    assert_eq!(response.status(), 404);
}

#[tokio::test]
async fn restored_then_removed_reference_resets_cleanup_through_real_edits() {
    let directory = tempfile::tempdir().unwrap();
    let name = "20261003-ab12.png";
    tokio::fs::write(directory.path().join(name), b"\x89PNG\r\n\x1a\nimage")
        .await
        .unwrap();
    let recently_orphaned = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_secs();
    tokio::fs::write(
        directory.path().join(".image-state.json"),
        serde_json::to_vec(&serde_json::json!({name: recently_orphaned})).unwrap(),
    )
    .await
    .unwrap();
    let filter = server(config(Some(directory.path().to_path_buf())));
    let mut client = common::connect(&filter, "restore").await.unwrap();
    common::expect_empty_initial(&mut client, 0).await.unwrap();
    let text = format!("![image](api/images/{name})");
    client
        .send(&serde_json::json!({"Edit": {"revision": 0, "operation": [text]}}))
        .await;
    assert!(client.recv().await.unwrap().get("History").is_some());
    client
        .send(&serde_json::json!({"Edit": {"revision": 1, "operation": [-(text.len() as i64)]}}))
        .await;
    assert!(client.recv().await.unwrap().get("History").is_some());
    common::expect_text(&filter, "restore", "").await;
    let metadata: Value = serde_json::from_slice(
        &tokio::fs::read(directory.path().join(".image-state.json"))
            .await
            .unwrap(),
    )
    .unwrap();
    assert_eq!(metadata.get(name), Some(&Value::Null));
    assert!(directory.path().join(name).exists());
}

#[tokio::test]
async fn restoring_a_persisted_block_protects_images_without_editing_its_body() {
    use rustpad_server::database::{Database, PersistedDocument};
    let directory = tempfile::tempdir().unwrap();
    let name = "20261003-ab12.png";
    tokio::fs::write(directory.path().join(name), b"\x89PNG\r\n\x1a\nimage")
        .await
        .unwrap();
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_secs();
    tokio::fs::write(
        directory.path().join(".image-state.json"),
        serde_json::to_vec(&serde_json::json!({name: now})).unwrap(),
    )
    .await
    .unwrap();
    let db = Database::new(&format!(
        "sqlite://{}",
        directory.path().join("docs.db").display()
    ))
    .await
    .unwrap();
    let empty = r#"{"version":1,"blocks":[]}"#;
    let restored = r#"{"version":1,"blocks":[{"id":"abc123"}]}"#;
    for (id, text) in [
        ("page:example:manifest", empty.to_owned()),
        (
            "page:example:block:abc123",
            format!("![image](api/images/{name})"),
        ),
    ] {
        db.store(
            id,
            &PersistedDocument {
                text,
                language: None,
                title: None,
            },
        )
        .await
        .unwrap();
    }
    let filter = server(ServerConfig {
        database: Some(db),
        ..config(Some(directory.path().to_owned()))
    });
    let mut client = common::connect(&filter, "page:example:manifest")
        .await
        .unwrap();
    common::expect_identity(&mut client, 0).await.unwrap();
    assert!(client.recv().await.unwrap().get("History").is_some());
    client.send(&serde_json::json!({"Edit": {"revision": 1, "operation": [-(empty.len() as i64), restored]}})).await;
    assert!(client.recv().await.unwrap().get("History").is_some());
    client.send(&serde_json::json!({"Edit": {"revision": 2, "operation": [-(restored.len() as i64), empty]}})).await;
    assert!(client.recv().await.unwrap().get("History").is_some());
    let metadata: Value = serde_json::from_slice(
        &tokio::fs::read(directory.path().join(".image-state.json"))
            .await
            .unwrap(),
    )
    .unwrap();
    assert_eq!(metadata.get(name), Some(&Value::Null));
}

#[tokio::test]
async fn uploads_are_disabled_without_image_directory() {
    let filter = server(ServerConfig::default());
    let png = b"\x89PNG\r\n\x1a\nbytes";

    let upload_response = upload(&filter, png, "image/png").await;
    assert_eq!(upload_response.status(), 503);
    assert_eq!(
        std::str::from_utf8(upload_response.body()).unwrap(),
        "Image uploads are disabled."
    );
    assert_eq!(
        upload_response.headers()["content-type"],
        "text/plain; charset=utf-8"
    );

    let image_response = warp::test::request()
        .path("/api/images/abc.png")
        .reply(&filter)
        .await;
    assert_eq!(image_response.status(), 404);
}

#[tokio::test]
async fn image_routes_preserve_non_image_fallback_responses() {
    let filter = server(ServerConfig::default());
    let frontend = warp::fs::dir("dist");

    let path = "/api/not-an-image";
    let expected = warp::test::request().path(path).reply(&frontend).await;
    let actual = warp::test::request().path(path).reply(&filter).await;

    assert_eq!(actual.status(), expected.status());
    assert_eq!(actual.body(), expected.body());
}

#[tokio::test]
async fn upload_and_read_supported_formats_preserve_bytes_and_headers() {
    let temporary_directory = tempfile::tempdir().unwrap();
    let image_dir = temporary_directory.path().join("images");
    let filter = server(config(Some(image_dir.clone())));
    assert!(!image_dir.exists());
    let fixtures: &[(&[u8], &str, &str)] = &[
        (b"\x89PNG\r\n\x1a\nPNG data", "png", "image/png"),
        (b"\xff\xd8\xffJPEG data", "jpg", "image/jpeg"),
        (b"GIF87aGIF data", "gif", "image/gif"),
        (b"GIF89aGIF data", "gif", "image/gif"),
        (b"RIFF\x04\x00\x00\x00WEBPWEBP data", "webp", "image/webp"),
    ];

    for (bytes, extension, response_type) in fixtures {
        let upload_response = upload(&filter, bytes, "text/plain").await;
        assert_eq!(upload_response.status(), 200);
        let value: Value = serde_json::from_slice(upload_response.body()).unwrap();
        let path = value["path"].as_str().unwrap();
        assert_eq!(value.as_object().unwrap().len(), 1);
        assert!(path.starts_with("api/images/"));
        assert!(path.ends_with(&format!(".{}", extension)));
        assert_dated_image_path(path, extension, None);

        let image_response = warp::test::request()
            .path(&format!("/{}", path))
            .reply(&filter)
            .await;
        assert_eq!(image_response.status(), 200);
        assert_eq!(image_response.body().as_ref(), *bytes);
        assert_eq!(image_response.headers()["content-type"], *response_type);
        assert_eq!(
            image_response.headers()["x-content-type-options"],
            "nosniff"
        );
        assert_eq!(
            image_response.headers()["cache-control"],
            "public, max-age=31536000, immutable"
        );
    }

    assert!(image_dir.is_dir());
    let mut entries = tokio::fs::read_dir(&image_dir).await.unwrap();
    let mut count = 0;
    while let Some(entry) = entries.next_entry().await.unwrap() {
        if entry.file_name() == ".image-state.json" || entry.file_name() == ".image-store.lock" {
            continue;
        }
        assert!(!entry.file_name().to_str().unwrap().starts_with('.'));
        count += 1;
    }
    assert_eq!(count, fixtures.len());
}

#[tokio::test]
async fn concurrent_uploads_reuse_one_file_but_different_bytes_do_not() {
    let directory = tempfile::tempdir().unwrap();
    let filter = server(config(Some(directory.path().to_path_buf())));
    let bytes = b"\x89PNG\r\n\x1a\nshared";
    let (first, second) = tokio::join!(
        upload(&filter, bytes, "image/png"),
        upload(&filter, bytes, "image/png")
    );
    assert_eq!(first.status(), 200);
    assert_eq!(second.status(), 200);
    assert_eq!(first.body(), second.body());
    let other = upload(&filter, b"\x89PNG\r\n\x1a\nunique", "image/png").await;
    assert_eq!(other.status(), 200);
    assert_ne!(first.body(), other.body());
    let mut entries = tokio::fs::read_dir(directory.path()).await.unwrap();
    let mut count = 0;
    while let Some(entry) = entries.next_entry().await.unwrap() {
        if entry.path().extension().is_some_and(|ext| ext == "png") {
            count += 1;
        }
    }
    assert_eq!(count, 2);
}

#[tokio::test]
async fn identical_upload_reuses_a_legacy_image_without_rewriting_it() {
    let directory = tempfile::tempdir().unwrap();
    let name = format!("{}.png", "a".repeat(32));
    let bytes = b"\x89PNG\r\n\x1a\nlegacy";
    tokio::fs::write(directory.path().join(&name), bytes)
        .await
        .unwrap();
    let filter = server(config(Some(directory.path().to_path_buf())));
    let response = upload(&filter, bytes, "image/png").await;
    assert_eq!(response.status(), 200);
    let result: Value = serde_json::from_slice(response.body()).unwrap();
    assert_eq!(result["path"], format!("api/images/{name}"));
    assert_eq!(
        tokio::fs::read(directory.path().join(name)).await.unwrap(),
        bytes
    );
}

#[tokio::test]
async fn valid_upload_date_is_used_in_the_image_name() {
    let temporary_directory = tempfile::tempdir().unwrap();
    let filter = server(config(Some(temporary_directory.path().to_path_buf())));
    let response = upload_at_path(
        &filter,
        "/api/images?date=20240229",
        b"\x89PNG\r\n\x1a\nPNG data",
        "image/png",
    )
    .await;

    assert_eq!(response.status(), 200);
    let value: Value = serde_json::from_slice(response.body()).unwrap();
    assert_dated_image_path(value["path"].as_str().unwrap(), "png", Some("20240229"));
}

#[tokio::test]
async fn absent_or_invalid_upload_dates_fall_back_to_a_dated_image_name() {
    let temporary_directory = tempfile::tempdir().unwrap();
    let filter = server(config(Some(temporary_directory.path().to_path_buf())));
    let dates = [
        None,
        Some("2024022"),
        Some("20240x29"),
        Some("20261301"),
        Some("20260230"),
        Some("20250229"),
    ];

    for date in dates {
        let path = date.map_or_else(
            || "/api/images".to_owned(),
            |date| format!("/api/images?date={date}"),
        );
        let response =
            upload_at_path(&filter, &path, b"\x89PNG\r\n\x1a\nPNG data", "image/png").await;
        assert_eq!(response.status(), 200);
        let value: Value = serde_json::from_slice(response.body()).unwrap();
        assert_dated_image_path(value["path"].as_str().unwrap(), "png", None);
    }
}

#[tokio::test]
async fn format_uses_image_signature_instead_of_declared_content_type() {
    let temporary_directory = tempfile::tempdir().unwrap();
    let image_dir = temporary_directory.path().join("images");
    tokio::fs::create_dir(&image_dir).await.unwrap();
    let filter = server(config(Some(image_dir.clone())));
    let unsupported: &[&[u8]] = &[
        b"<svg xmlns='http://www.w3.org/2000/svg'></svg>",
        b"plain text",
        b"\x00\x01\x02\x03",
        b"RIFF\x04\x00\x00\x00WAVE",
        b"\x89PNG",
        b"",
    ];

    for bytes in unsupported {
        let response = upload(&filter, bytes, "image/png").await;
        assert_eq!(response.status(), 415);
        assert_eq!(
            std::str::from_utf8(response.body()).unwrap(),
            "Unsupported image format."
        );
        assert_eq!(
            response.headers()["content-type"],
            "text/plain; charset=utf-8"
        );
    }

    assert!(directory_is_empty(&image_dir).await);
}

#[tokio::test]
async fn declared_oversized_upload_is_rejected_before_reading_body() {
    let temporary_directory = tempfile::tempdir().unwrap();
    let image_dir = temporary_directory.path().join("images");
    let filter = server(config(Some(image_dir.clone())));
    let response = warp::test::request()
        .method("POST")
        .path("/api/images")
        .header("content-length", (MAX_IMAGE_SIZE + 1).to_string())
        .reply(&filter)
        .await;

    assert_eq!(response.status(), 413);
    assert_eq!(response.body(), "Image exceeds the 10 MiB size limit.");
    assert!(!image_dir.exists());
}

#[tokio::test]
async fn upload_at_size_limit_succeeds() {
    let temporary_directory = tempfile::tempdir().unwrap();
    let filter = server(config(Some(temporary_directory.path().to_path_buf())));
    let mut bytes = vec![0; MAX_IMAGE_SIZE];
    bytes[..8].copy_from_slice(b"\x89PNG\r\n\x1a\n");

    let response = upload(&filter, &bytes, "image/png").await;
    assert_eq!(response.status(), 200);
    let value: Value = serde_json::from_slice(response.body()).unwrap();
    let image = warp::test::request()
        .path(&format!("/{}", value["path"].as_str().unwrap()))
        .reply(&filter)
        .await;
    assert_eq!(image.status(), 200);
    assert_eq!(image.body().as_ref(), bytes.as_slice());
}

#[tokio::test]
async fn oversized_upload_returns_413_without_creating_a_file() {
    let temporary_directory = tempfile::tempdir().unwrap();
    let image_dir = temporary_directory.path().join("images");
    tokio::fs::create_dir(&image_dir).await.unwrap();
    let filter = server(config(Some(image_dir.clone())));
    let bytes = vec![0; MAX_IMAGE_SIZE + 1];

    let response = upload(&filter, &bytes, "image/png").await;

    assert_eq!(response.status(), 413);
    assert_eq!(
        std::str::from_utf8(response.body()).unwrap(),
        "Image exceeds the 10 MiB size limit."
    );
    assert!(directory_is_empty(&image_dir).await);
}

#[tokio::test]
async fn content_length_is_required() {
    let temporary_directory = tempfile::tempdir().unwrap();
    let filter = server(config(Some(temporary_directory.path().to_path_buf())));
    let response = warp::test::request()
        .method("POST")
        .path("/api/images")
        .reply(&filter)
        .await;

    assert_eq!(response.status(), 411);
    assert_eq!(
        std::str::from_utf8(response.body()).unwrap(),
        "Content-Length is required."
    );
}

#[tokio::test]
async fn invalid_image_names_return_404() {
    let temporary_directory = tempfile::tempdir().unwrap();
    let image_dir = temporary_directory.path().join("images");
    tokio::fs::create_dir(&image_dir).await.unwrap();
    tokio::fs::write(temporary_directory.path().join("secret.png"), b"secret")
        .await
        .unwrap();
    tokio::fs::write(image_dir.join(".upload.tmp"), b"partial bytes")
        .await
        .unwrap();
    tokio::fs::write(image_dir.join("notes.png"), b"unmanaged image")
        .await
        .unwrap();
    let filter = server(config(Some(image_dir)));
    for name in [
        "",
        "UPPER.png",
        "a.PNG",
        ".png",
        "a.b.png",
        "../secret.png",
        "a.png/secret",
        "a%2Fsecret.png",
        "a.svg",
        "a-b.png",
        "a_b.png",
        "-20261003-ab12.png",
        "20261003-ab12-.png",
        "20261003--ab12.png",
        "20261003-abc.png",
        "20261003-AB12.png",
        "20261003-ab12-extra.png",
        ".upload.tmp",
        "%2e%2e%2fsecret.png",
        "..%5csecret.png",
        "missing.png",
        "notes.png",
    ] {
        let response = warp::test::request()
            .path(&format!("/api/images/{}", name))
            .reply(&filter)
            .await;
        assert_eq!(response.status(), 404, "unexpected response for {name:?}");
        assert_eq!(response.body(), "Image not found.");
    }
}

#[tokio::test]
async fn legacy_32_character_image_ids_remain_readable() {
    let temporary_directory = tempfile::tempdir().unwrap();
    let image_dir = temporary_directory.path().join("images");
    tokio::fs::create_dir(&image_dir).await.unwrap();
    let legacy_id = "a".repeat(32);
    tokio::fs::write(image_dir.join(format!("{legacy_id}.png")), b"legacy image")
        .await
        .unwrap();
    let filter = server(config(Some(image_dir)));

    let response = warp::test::request()
        .path(&format!("/api/images/{legacy_id}.png"))
        .reply(&filter)
        .await;
    assert_eq!(response.status(), 200);
    assert_eq!(response.body(), "legacy image");
}

#[tokio::test]
async fn write_failure_returns_500_and_logs_cause() {
    log::set_logger(&ERROR_LOG).unwrap();
    log::set_max_level(log::LevelFilter::Error);
    let temporary_directory = tempfile::tempdir().unwrap();
    let image_dir = temporary_directory.path().join("not-a-directory");
    tokio::fs::write(&image_dir, b"file").await.unwrap();
    let cause = tokio::fs::create_dir_all(&image_dir).await.unwrap_err();
    let filter = server(config(Some(image_dir)));

    let response = upload(&filter, b"\x89PNG\r\n\x1a\nPNG data", "image/png").await;

    assert_eq!(response.status(), 500);
    assert_eq!(
        std::str::from_utf8(response.body()).unwrap(),
        "Failed to store image."
    );
    assert!(ERROR_LOG
        .0
        .lock()
        .unwrap()
        .iter()
        .any(|message| { message == &format!("failed to store uploaded image: {}", cause) }));
}
