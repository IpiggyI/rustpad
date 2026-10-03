use std::collections::{BTreeMap, HashMap, HashSet};
use std::io;
use std::path::PathBuf;
use std::time::{Duration, SystemTime};

use log::info;
use sha2::{Digest, Sha256};
use tokio::{fs, io::AsyncWriteExt, sync::Mutex};

use crate::{database::Database, parse_image_name, store_image};

#[cfg(test)]
#[path = "image_store_tests.rs"]
mod tests;

const RETENTION: Duration = Duration::from_secs(30 * 24 * 3600);
const STATE_FILE: &str = ".image-state.json";
const STATE_TEMP: &str = ".image-state.tmp";
const LOCK_FILE: &str = ".image-store.lock";

#[derive(Default)]
struct Index {
    owner: Option<std::fs::File>,
    loaded: bool,
    dirty: bool,
    unreferenced: BTreeMap<String, Option<u64>>,
    hashes: HashMap<String, [u8; 32]>,
    block_images: HashMap<String, HashSet<String>>,
}

pub(crate) struct ImageStore {
    directory: PathBuf,
    database: Option<Database>,
    // Uploads, text edits, document loading and collection share this gate.
    pub(crate) gate: Mutex<()>,
    index: Mutex<Index>,
}

impl ImageStore {
    pub(crate) fn new(directory: PathBuf, database: Option<Database>) -> Self {
        Self {
            directory,
            database,
            gate: Mutex::new(()),
            index: Mutex::new(Index::default()),
        }
    }

    async fn load(&self, index: &mut Index) -> io::Result<()> {
        if index.loaded {
            return Ok(());
        }
        match fs::metadata(&self.directory).await {
            Ok(_) => {}
            Err(err) if err.kind() == io::ErrorKind::NotFound => return Ok(()),
            Err(err) => return Err(err),
        }
        if index.owner.is_none() {
            let owner = std::fs::OpenOptions::new()
                .write(true)
                .create(true)
                .truncate(false)
                .open(self.directory.join(LOCK_FILE))?;
            owner.try_lock().map_err(io::Error::other)?;
            index.owner = Some(owner);
        }
        match fs::read(self.directory.join(STATE_FILE)).await {
            Ok(bytes) => index.unreferenced = serde_json::from_slice(&bytes)?,
            Err(err) if err.kind() == io::ErrorKind::NotFound => {}
            Err(err) => return Err(err),
        }
        index.loaded = true;
        Ok(())
    }

    async fn save(&self, index: &mut Index) -> io::Result<()> {
        if !index.dirty {
            return Ok(());
        }
        let temporary = self.directory.join(STATE_TEMP);
        let mut file = fs::File::create(&temporary).await?;
        file.write_all(&serde_json::to_vec(&index.unreferenced)?)
            .await?;
        file.sync_all().await?;
        drop(file);
        fs::rename(temporary, self.directory.join(STATE_FILE)).await?;
        index.dirty = false;
        Ok(())
    }

    async fn scan(&self, index: &mut Index) -> io::Result<BTreeMap<String, u64>> {
        self.load(index).await?;
        let mut files = BTreeMap::new();
        let mut entries = match fs::read_dir(&self.directory).await {
            Ok(entries) => entries,
            Err(err) if err.kind() == io::ErrorKind::NotFound => return Ok(files),
            Err(err) => return Err(err),
        };
        while let Some(entry) = entries.next_entry().await? {
            let name = entry.file_name().to_string_lossy().into_owned();
            if (parse_image_name(&name).is_some() || is_upload_temporary(&name))
                && entry.file_type().await?.is_file()
            {
                files.insert(name, entry.metadata().await?.len());
            }
        }
        index.hashes.retain(|name, _| files.contains_key(name));
        let previous_len = index.unreferenced.len();
        index
            .unreferenced
            .retain(|name, _| files.contains_key(name));
        index.dirty |= previous_len != index.unreferenced.len();
        for name in files.keys() {
            index.unreferenced.entry(name.clone()).or_insert(None);
        }
        Ok(files)
    }

    pub(crate) async fn upload(
        &self,
        extension: &str,
        bytes: &[u8],
        date: &str,
    ) -> io::Result<String> {
        fs::create_dir_all(&self.directory).await?;
        let mut index = self.index.lock().await;
        let files = self.scan(&mut index).await?;
        let hash: [u8; 32] = Sha256::digest(bytes).into();
        for (name, size) in files {
            if size != bytes.len() as u64 || !name.ends_with(&format!(".{extension}")) {
                continue;
            }
            let stored_hash = match index.hashes.get(&name) {
                Some(hash) => *hash,
                None => {
                    let stored_hash =
                        Sha256::digest(fs::read(self.directory.join(&name)).await?).into();
                    index.hashes.insert(name.clone(), stored_hash);
                    stored_hash
                }
            };
            if stored_hash == hash && fs::read(self.directory.join(&name)).await? == bytes {
                self.renew(&mut index, &name).await?;
                return Ok(format!("api/images/{name}"));
            }
        }
        let path = store_image(&self.directory, extension, bytes, date).await?;
        let name = path.strip_prefix("api/images/").expect("stored image path");
        index.hashes.insert(name.to_owned(), hash);
        self.renew(&mut index, name).await?;
        Ok(path)
    }

    async fn renew(&self, index: &mut Index, name: &str) -> io::Result<()> {
        index
            .unreferenced
            .insert(name.to_owned(), Some(unix_seconds(SystemTime::now())?));
        index.dirty = true;
        self.save(index).await
    }

    pub(crate) async fn protect(&self, text: &str) -> io::Result<()> {
        self.protect_names(image_names(text)).await
    }

    async fn protect_names(&self, names: HashSet<String>) -> io::Result<()> {
        if names.is_empty() {
            return Ok(());
        }
        let mut index = self.index.lock().await;
        self.load(&mut index).await?;
        for name in names {
            if let Some(since) = index.unreferenced.get_mut(&name) {
                if since.take().is_some() {
                    index.dirty = true;
                }
            }
        }
        self.save(&mut index).await
    }

    pub(crate) async fn protect_document(&self, id: &str, text: &str) -> anyhow::Result<()> {
        self.protect(text).await?;
        if id.starts_with("page:") && id.contains(":block:") {
            self.index
                .lock()
                .await
                .block_images
                .insert(id.to_owned(), image_names(text));
        }
        let Some(page) = id
            .strip_prefix("page:")
            .and_then(|id| id.strip_suffix(":manifest"))
        else {
            return Ok(());
        };
        let Some(blocks) = manifest_blocks(text).filter(|blocks| !blocks.is_empty()) else {
            return Ok(());
        };
        let ids: HashSet<String> = blocks
            .iter()
            .map(|block| format!("page:{page}:block:{block}"))
            .collect();
        let mut names = HashSet::new();
        if let Some(db) = &self.database {
            for (id, text) in db.texts().await? {
                if ids.contains(&id) {
                    names.extend(image_names(&text));
                }
            }
        }
        {
            let index = self.index.lock().await;
            for id in ids {
                if let Some(images) = index.block_images.get(&id) {
                    names.extend(images.iter().cloned());
                }
            }
        }
        self.protect_names(names).await?;
        Ok(())
    }

    pub(crate) async fn remember_blocks(&self, texts: &[(String, String)]) {
        let mut index = self.index.lock().await;
        index.block_images.clear();
        for (id, text) in texts
            .iter()
            .filter(|(id, _)| id.starts_with("page:") && id.contains(":block:"))
        {
            index
                .block_images
                .entry(id.clone())
                .or_default()
                .extend(image_names(text));
        }
    }

    pub(crate) async fn clean(
        &self,
        referenced: &HashSet<String>,
        now: SystemTime,
    ) -> io::Result<()> {
        let mut index = self.index.lock().await;
        let files = self.scan(&mut index).await?;
        if files.is_empty() {
            return self.save(&mut index).await;
        }
        let now = unix_seconds(now)?;
        let mut expired = Vec::new();
        for name in files.keys() {
            let since = index.unreferenced.get_mut(name).expect("scanned file");
            if referenced.contains(name) {
                *since = None;
            } else {
                let since = since.get_or_insert(now);
                if now.saturating_sub(*since) >= RETENTION.as_secs() {
                    expired.push(name.clone());
                }
            }
        }
        // Persist renewed references before deleting anything. Failure aborts this sweep.
        index.dirty = true;
        self.save(&mut index).await?;
        for name in expired {
            match fs::remove_file(self.directory.join(&name)).await {
                Ok(()) => info!("removed unreferenced image file {name}"),
                Err(err) if err.kind() == io::ErrorKind::NotFound => {}
                Err(err) => return Err(err),
            }
            index.unreferenced.remove(&name);
            index.hashes.remove(&name);
        }
        index.dirty = true;
        self.save(&mut index).await
    }
}

fn unix_seconds(now: SystemTime) -> io::Result<u64> {
    now.duration_since(SystemTime::UNIX_EPOCH)
        .map(|duration| duration.as_secs())
        .map_err(io::Error::other)
}

fn is_upload_temporary(name: &str) -> bool {
    name.strip_prefix('.')
        .and_then(|name| name.strip_suffix(".tmp"))
        .is_some_and(|id| {
            id.len() == 32
                && id
                    .bytes()
                    .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit())
        })
}

fn image_names(text: &str) -> HashSet<String> {
    text.split("api/images/")
        .skip(1)
        .filter_map(|tail| {
            let length = tail
                .find(|c: char| !c.is_ascii_alphanumeric() && c != '-' && c != '.')
                .unwrap_or(tail.len());
            let name = &tail[..length];
            parse_image_name(name).map(|_| name.to_owned())
        })
        .collect()
}

pub(crate) fn referenced_images(texts: &[(String, String)]) -> HashSet<String> {
    let mut manifests: HashMap<&str, Option<HashSet<String>>> = HashMap::new();
    for (id, text) in texts
        .iter()
        .filter(|(id, _)| id.starts_with("page:") && id.ends_with(":manifest"))
    {
        let blocks = manifest_blocks(text);
        manifests
            .entry(id)
            .and_modify(|previous| match (previous.as_mut(), blocks.as_ref()) {
                (Some(previous), Some(blocks)) => previous.extend(blocks.iter().cloned()),
                _ => *previous = None,
            })
            .or_insert(blocks);
    }
    let mut references = HashSet::new();
    for (id, text) in texts {
        if is_removed_block(id, &manifests) {
            continue;
        }
        references.extend(image_names(text));
    }
    references
}

fn is_removed_block(id: &str, manifests: &HashMap<&str, Option<HashSet<String>>>) -> bool {
    let Some((page, block)) = id
        .strip_prefix("page:")
        .and_then(|id| id.rsplit_once(":block:"))
    else {
        return false;
    };
    if block.len() != 6
        || !block
            .bytes()
            .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit())
    {
        return false;
    }
    let manifest_id = format!("page:{page}:manifest");
    // Missing, malformed or conflicting manifests must not make a live block collectible.
    matches!(manifests.get(manifest_id.as_str()), Some(Some(blocks)) if !blocks.contains(block))
}

fn manifest_blocks(text: &str) -> Option<HashSet<String>> {
    let manifest = serde_json::from_str::<serde_json::Value>(text).ok()?;
    manifest
        .get("blocks")?
        .as_array()?
        .iter()
        .map(|entry| {
            let id = entry.get("id")?.as_str()?;
            (id.len() == 6
                && id
                    .bytes()
                    .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit()))
            .then(|| id.to_owned())
        })
        .collect()
}
