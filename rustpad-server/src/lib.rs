//! Server backend for the Rustpad collaborative text editor.

#![forbid(unsafe_code)]
#![warn(missing_docs)]

use std::sync::Arc;
use std::time::{Duration, SystemTime};
use std::{io, path::Path};

use dashmap::DashMap;
use log::{error, info};
use rand::Rng;
use serde::Serialize;
use tokio::time::{self, Instant};
use tokio::{fs, io::AsyncWriteExt};
use warp::{
    filters::BoxedFilter, http::StatusCode, hyper::body::Bytes, ws::Ws, Filter, Rejection, Reply,
};

use crate::{database::Database, rustpad::Rustpad};

pub mod database;
mod ot;
mod rustpad;

/// An entry stored in the global server map.
///
/// Each entry corresponds to a single document. This is garbage collected by a
/// background task after one day of inactivity, to avoid server memory usage
/// growing without bound.
struct Document {
    last_accessed: Instant,
    rustpad: Arc<Rustpad>,
}

impl Document {
    fn new(rustpad: Arc<Rustpad>) -> Self {
        Self {
            last_accessed: Instant::now(),
            rustpad,
        }
    }
}

impl Drop for Document {
    fn drop(&mut self) {
        self.rustpad.kill();
    }
}

#[allow(dead_code)]
#[derive(Debug)]
struct CustomReject(anyhow::Error);

impl warp::reject::Reject for CustomReject {}

/// The shared state of the server, accessible from within request handlers.
#[derive(Clone)]
struct ServerState {
    /// Concurrent map storing in-memory documents.
    documents: Arc<DashMap<String, Document>>,
    /// Connection to the database pool, if persistence is enabled.
    database: Option<Database>,
    /// Directory for uploaded images, if uploads are enabled.
    image_dir: Option<std::path::PathBuf>,
}

/// Statistics about the server, returned from an API endpoint.
#[derive(Serialize)]
struct Stats {
    /// System time when the server started, in seconds since Unix epoch.
    start_time: u64,
    /// Number of documents currently tracked by the server.
    num_documents: usize,
    /// Number of documents persisted in the database.
    database_size: usize,
}

/// Server configuration.
#[derive(Clone, Debug)]
pub struct ServerConfig {
    /// Number of days to clean up documents after inactivity.
    pub expiry_days: u32,
    /// Database object, for persistence if desired.
    pub database: Option<Database>,
    /// Directory for uploaded images, if uploads are enabled.
    pub image_dir: Option<std::path::PathBuf>,
}

impl Default for ServerConfig {
    fn default() -> Self {
        Self {
            expiry_days: 1,
            database: None,
            image_dir: None,
        }
    }
}

/// A combined filter handling all server routes.
pub fn server(config: ServerConfig) -> BoxedFilter<(impl Reply,)> {
    warp::path("api")
        .and(backend(config))
        .or(frontend())
        .boxed()
}

/// Construct routes for static files from React.
fn frontend() -> BoxedFilter<(impl Reply,)> {
    warp::fs::dir("dist").boxed()
}

/// Construct backend routes, including WebSocket handlers.
fn backend(config: ServerConfig) -> BoxedFilter<(impl Reply,)> {
    let state = ServerState {
        documents: Default::default(),
        database: config.database,
        image_dir: config.image_dir,
    };
    tokio::spawn(cleaner(state.clone(), config.expiry_days));

    let state_filter = warp::any().map(move || state.clone()).boxed();

    let socket = warp::path!("socket" / String)
        .and(warp::ws())
        .and(state_filter.clone())
        .and_then(socket_handler);

    let text = warp::path!("text" / String)
        .and(state_filter.clone())
        .and_then(text_handler);

    let start_time = SystemTime::now()
        .duration_since(SystemTime::UNIX_EPOCH)
        .expect("SystemTime returned before UNIX_EPOCH")
        .as_secs();
    let stats = warp::path!("stats")
        .and(warp::any().map(move || start_time))
        .and(state_filter.clone())
        .and_then(stats_handler);

    let images = image_routes(state_filter.clone());

    socket.or(text).or(stats).or(images).boxed()
}

const MAX_IMAGE_SIZE: u64 = 10 * 1024 * 1024;
const IMAGE_ID_LENGTH: usize = 32;
const IMAGE_NAME_ATTEMPTS: usize = 32;

#[derive(Debug)]
enum ImageFailure {
    Disabled,
    MissingContentLength,
    TooLarge,
    UnsupportedFormat,
    NotFound,
    Storage,
}

#[derive(Debug)]
struct ImageReject(ImageFailure);

impl warp::reject::Reject for ImageReject {}

#[derive(Serialize)]
struct ImagePath {
    path: String,
}

fn image_routes(state_filter: BoxedFilter<(ServerState,)>) -> BoxedFilter<(impl Reply,)> {
    let get = warp::path::tail()
        .and(warp::get())
        .and(state_filter.clone())
        .and_then(get_image_handler);

    let upload = warp::path::tail()
        .and(warp::post())
        .and(warp::header::optional::<u64>("content-length"))
        .and(state_filter)
        .and_then(check_upload)
        .and(warp::body::bytes())
        .and_then(upload_image_handler);

    warp::path("images")
        .and(get.or(upload).recover(image_rejection))
        .boxed()
}

async fn check_upload(
    tail: warp::path::Tail,
    content_length: Option<u64>,
    state: ServerState,
) -> Result<std::path::PathBuf, Rejection> {
    if !tail.as_str().is_empty() {
        return Err(warp::reject::custom(ImageReject(ImageFailure::NotFound)));
    }
    let directory = state
        .image_dir
        .ok_or_else(|| warp::reject::custom(ImageReject(ImageFailure::Disabled)))?;
    let content_length = content_length
        .ok_or_else(|| warp::reject::custom(ImageReject(ImageFailure::MissingContentLength)))?;
    if content_length > MAX_IMAGE_SIZE {
        return Err(warp::reject::custom(ImageReject(ImageFailure::TooLarge)));
    }
    Ok(directory)
}

async fn upload_image_handler(
    directory: std::path::PathBuf,
    body: Bytes,
) -> Result<impl Reply, Rejection> {
    if body.len() as u64 > MAX_IMAGE_SIZE {
        return Err(warp::reject::custom(ImageReject(ImageFailure::TooLarge)));
    }
    let Some(extension) = image_extension(&body) else {
        return Err(warp::reject::custom(ImageReject(
            ImageFailure::UnsupportedFormat,
        )));
    };
    let path = match store_image(&directory, extension, &body).await {
        Ok(path) => path,
        Err(err) => {
            error!("failed to store uploaded image: {}", err);
            return Err(warp::reject::custom(ImageReject(ImageFailure::Storage)));
        }
    };
    Ok(warp::reply::json(&ImagePath { path }))
}

async fn get_image_handler(
    tail: warp::path::Tail,
    state: ServerState,
) -> Result<impl Reply, Rejection> {
    let Some((id, extension)) = parse_image_name(tail.as_str()) else {
        return Err(warp::reject::custom(ImageReject(ImageFailure::NotFound)));
    };
    let Some(directory) = state.image_dir else {
        return Err(warp::reject::custom(ImageReject(ImageFailure::NotFound)));
    };
    let bytes = match fs::read(directory.join(format!("{}.{}", id, extension))).await {
        Ok(bytes) => bytes,
        Err(_) => return Err(warp::reject::custom(ImageReject(ImageFailure::NotFound))),
    };

    let mut response = warp::reply::Response::new(warp::hyper::Body::from(bytes));
    let content_type = match extension {
        "png" => "image/png",
        "jpg" => "image/jpeg",
        "gif" => "image/gif",
        "webp" => "image/webp",
        _ => unreachable!(),
    };
    response.headers_mut().insert(
        warp::http::header::CONTENT_TYPE,
        content_type.parse().expect("valid image content type"),
    );
    response.headers_mut().insert(
        "x-content-type-options",
        "nosniff".parse().expect("valid header value"),
    );
    response.headers_mut().insert(
        "cache-control",
        "public, max-age=31536000, immutable"
            .parse()
            .expect("valid header value"),
    );
    Ok(response)
}

async fn image_rejection(rejection: Rejection) -> Result<impl Reply, Rejection> {
    let (status, message) = match rejection.find::<ImageReject>() {
        Some(ImageReject(ImageFailure::Disabled)) => (
            StatusCode::SERVICE_UNAVAILABLE,
            "Image uploads are disabled.",
        ),
        Some(ImageReject(ImageFailure::MissingContentLength)) => {
            (StatusCode::LENGTH_REQUIRED, "Content-Length is required.")
        }
        Some(ImageReject(ImageFailure::TooLarge)) => (
            StatusCode::PAYLOAD_TOO_LARGE,
            "Image exceeds the 10 MiB size limit.",
        ),
        Some(ImageReject(ImageFailure::UnsupportedFormat)) => (
            StatusCode::UNSUPPORTED_MEDIA_TYPE,
            "Unsupported image format.",
        ),
        Some(ImageReject(ImageFailure::NotFound)) => (StatusCode::NOT_FOUND, "Image not found."),
        Some(ImageReject(ImageFailure::Storage)) => {
            (StatusCode::INTERNAL_SERVER_ERROR, "Failed to store image.")
        }
        None if rejection.is_not_found()
            || rejection.find::<warp::reject::MethodNotAllowed>().is_some() =>
        {
            (StatusCode::NOT_FOUND, "Image not found.")
        }
        None => {
            error!("image request failed: {:?}", rejection);
            (
                StatusCode::INTERNAL_SERVER_ERROR,
                "Failed to process image request.",
            )
        }
    };
    Ok(warp::reply::with_status(message, status))
}

fn image_extension(bytes: &[u8]) -> Option<&'static str> {
    if bytes.starts_with(b"\x89PNG\r\n\x1a\n") {
        Some("png")
    } else if bytes.starts_with(b"\xff\xd8\xff") {
        Some("jpg")
    } else if bytes.starts_with(b"GIF87a") || bytes.starts_with(b"GIF89a") {
        Some("gif")
    } else if bytes.len() >= 12 && &bytes[..4] == b"RIFF" && &bytes[8..12] == b"WEBP" {
        Some("webp")
    } else {
        None
    }
}

fn parse_image_name(name: &str) -> Option<(&str, &str)> {
    let (id, extension) = name.split_once('.')?;
    if id.is_empty()
        || !id
            .bytes()
            .all(|byte| byte.is_ascii_lowercase() || byte.is_ascii_digit())
        || !matches!(extension, "png" | "jpg" | "gif" | "webp")
    {
        return None;
    }
    Some((id, extension))
}

fn random_image_id() -> String {
    const ALPHABET: &[u8] = b"abcdefghijklmnopqrstuvwxyz0123456789";
    let mut rng = rand::thread_rng();
    (0..IMAGE_ID_LENGTH)
        .map(|_| ALPHABET[rng.gen_range(0..ALPHABET.len())] as char)
        .collect()
}

// shortcut: retain images indefinitely to avoid deleting referenced files; ceiling: disk use grows without bound; replace when: image cleanup by reference becomes a requirement.
async fn store_image(directory: &Path, extension: &str, bytes: &[u8]) -> io::Result<String> {
    fs::create_dir_all(directory).await?;

    let mut temporary_file = None;
    for _ in 0..IMAGE_NAME_ATTEMPTS {
        let path = directory.join(format!(".{}.tmp", random_image_id()));
        match fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&path)
            .await
        {
            Ok(file) => {
                temporary_file = Some((path, file));
                break;
            }
            Err(err) if err.kind() == io::ErrorKind::AlreadyExists => continue,
            Err(err) => return Err(err),
        }
    }
    let Some((temporary_path, mut temporary_file)) = temporary_file else {
        return Err(io::Error::new(
            io::ErrorKind::AlreadyExists,
            "could not allocate a unique temporary image file after repeated collisions",
        ));
    };

    if let Err(err) = temporary_file.write_all(bytes).await {
        drop(temporary_file);
        remove_temporary_file(&temporary_path).await;
        return Err(err);
    }
    if let Err(err) = temporary_file.flush().await {
        drop(temporary_file);
        remove_temporary_file(&temporary_path).await;
        return Err(err);
    }
    drop(temporary_file);

    let result = publish_image_with(directory, &temporary_path, extension, random_image_id).await;
    remove_temporary_file(&temporary_path).await;
    result
}

async fn publish_image_with(
    directory: &Path,
    temporary_path: &Path,
    extension: &str,
    mut next_id: impl FnMut() -> String,
) -> io::Result<String> {
    for _ in 0..IMAGE_NAME_ATTEMPTS {
        let id = next_id();
        let final_path = directory.join(format!("{}.{}", id, extension));
        // A hard link publishes the completed file without replacing an existing name.
        match fs::hard_link(temporary_path, &final_path).await {
            Ok(()) => return Ok(format!("api/images/{}.{}", id, extension)),
            Err(err) if err.kind() == io::ErrorKind::AlreadyExists => continue,
            Err(err) => return Err(err),
        }
    }
    Err(io::Error::new(
        io::ErrorKind::AlreadyExists,
        "could not allocate a unique image name after repeated collisions",
    ))
}

async fn remove_temporary_file(path: &Path) {
    if let Err(err) = fs::remove_file(path).await {
        if err.kind() != io::ErrorKind::NotFound {
            error!("failed to remove temporary image file {:?}: {}", path, err);
        }
    }
}

#[cfg(test)]
mod image_store_tests {
    use super::*;

    #[tokio::test]
    async fn publishing_retries_collisions_without_overwriting_existing_images() {
        let directory = tempfile::tempdir().unwrap();
        let temporary_path = directory.path().join("upload.tmp");
        let existing_path = directory.path().join("existing.png");
        let new_path = directory.path().join("new.png");
        fs::write(&temporary_path, b"complete image bytes")
            .await
            .unwrap();
        fs::write(&existing_path, b"existing image bytes")
            .await
            .unwrap();
        let mut ids = ["existing", "new"].into_iter();

        let published = publish_image_with(directory.path(), &temporary_path, "png", || {
            ids.next().unwrap().to_owned()
        })
        .await
        .unwrap();

        assert_eq!(published, "api/images/new.png");
        assert_eq!(
            fs::read(&existing_path).await.unwrap(),
            b"existing image bytes"
        );
        assert_eq!(fs::read(&new_path).await.unwrap(), b"complete image bytes");
    }

    #[tokio::test]
    async fn repeated_collisions_fail_without_overwriting_existing_images() {
        let directory = tempfile::tempdir().unwrap();
        let temporary_path = directory.path().join("upload.tmp");
        let existing_path = directory.path().join("existing.png");
        fs::write(&temporary_path, b"new image bytes")
            .await
            .unwrap();
        fs::write(&existing_path, b"existing image bytes")
            .await
            .unwrap();

        let error = publish_image_with(directory.path(), &temporary_path, "png", || {
            "existing".to_owned()
        })
        .await
        .unwrap_err();

        assert_eq!(error.kind(), io::ErrorKind::AlreadyExists);
        assert_eq!(
            fs::read(&existing_path).await.unwrap(),
            b"existing image bytes"
        );
    }
}

/// Handler for the `/api/socket/{id}` endpoint.
async fn socket_handler(id: String, ws: Ws, state: ServerState) -> Result<impl Reply, Rejection> {
    use dashmap::mapref::entry::Entry;

    let mut entry = match state.documents.entry(id.clone()) {
        Entry::Occupied(e) => e.into_ref(),
        Entry::Vacant(e) => {
            let rustpad = Arc::new(match &state.database {
                Some(db) => db.load(&id).await.map(Rustpad::from).unwrap_or_default(),
                None => Rustpad::default(),
            });
            if let Some(db) = &state.database {
                tokio::spawn(persister(id, Arc::clone(&rustpad), db.clone()));
            }
            e.insert(Document::new(rustpad))
        }
    };

    let value = entry.value_mut();
    value.last_accessed = Instant::now();
    let rustpad = Arc::clone(&value.rustpad);
    Ok(ws.on_upgrade(|socket| async move { rustpad.on_connection(socket).await }))
}

/// Handler for the `/api/text/{id}` endpoint.
async fn text_handler(id: String, state: ServerState) -> Result<impl Reply, Rejection> {
    Ok(match state.documents.get(&id) {
        Some(value) => value.rustpad.text(),
        None => {
            if let Some(db) = &state.database {
                db.load(&id)
                    .await
                    .map(|document| document.text)
                    .unwrap_or_default()
            } else {
                String::new()
            }
        }
    })
}

/// Handler for the `/api/stats` endpoint.
async fn stats_handler(start_time: u64, state: ServerState) -> Result<impl Reply, Rejection> {
    let num_documents = state.documents.len();
    let database_size = match state.database {
        None => 0,
        Some(db) => match db.count().await {
            Ok(size) => size,
            Err(e) => return Err(warp::reject::custom(CustomReject(e))),
        },
    };
    Ok(warp::reply::json(&Stats {
        start_time,
        num_documents,
        database_size,
    }))
}

const HOUR: Duration = Duration::from_secs(3600);

/// Reclaims memory for documents.
async fn cleaner(state: ServerState, expiry_days: u32) {
    loop {
        time::sleep(HOUR).await;
        let mut keys = Vec::new();
        for entry in &*state.documents {
            if entry.last_accessed.elapsed() > HOUR * 24 * expiry_days {
                keys.push(entry.key().clone());
            }
        }
        info!("cleaner removing keys: {:?}", keys);
        for key in keys {
            state.documents.remove(&key);
        }
    }
}

const PERSIST_INTERVAL: Duration = Duration::from_secs(3);
const PERSIST_INTERVAL_JITTER: Duration = Duration::from_secs(1);

/// Persists changed documents after a fixed time interval.
async fn persister(id: String, rustpad: Arc<Rustpad>, db: Database) {
    let mut last_persist_version = 0;
    while !rustpad.killed() {
        let interval = PERSIST_INTERVAL
            + rand::thread_rng().gen_range(Duration::ZERO..=PERSIST_INTERVAL_JITTER);
        time::sleep(interval).await;
        let persist_version = rustpad.persist_version();
        if persist_version > last_persist_version {
            info!("persisting version {} for id = {}", persist_version, id);
            if let Err(e) = db.store(&id, &rustpad.snapshot()).await {
                error!("when persisting document {}: {}", id, e);
            } else {
                last_persist_version = persist_version;
            }
        }
    }
}
