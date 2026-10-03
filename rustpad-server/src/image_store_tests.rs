use super::*;
use crate::{
    clean_images,
    database::{Database, PersistedDocument},
    rustpad::Rustpad,
    Document, ServerState,
};
use std::sync::Arc;

const NAME: &str = "20261003-ab12.png";
const PNG: &[u8] = b"\x89PNG\r\n\x1a\nimage";

fn at(seconds: u64) -> SystemTime {
    SystemTime::UNIX_EPOCH + Duration::from_secs(seconds)
}

fn document(text: &str) -> PersistedDocument {
    PersistedDocument {
        text: text.to_owned(),
        language: None,
        title: None,
    }
}

fn reference() -> String {
    format!("![image](api/images/{NAME})")
}

async fn fixture() -> (tempfile::TempDir, ImageStore) {
    let directory = tempfile::tempdir().unwrap();
    fs::write(directory.path().join(NAME), PNG).await.unwrap();
    let images = ImageStore::new(directory.path().to_owned(), None);
    (directory, images)
}

#[tokio::test]
async fn another_store_cannot_mutate_the_same_directory_until_the_owner_exits() {
    let (directory, images) = fixture().await;
    let first = images.upload("png", PNG, "20261003").await.unwrap();
    let another = ImageStore::new(directory.path().to_owned(), None);
    assert!(another.upload("png", PNG, "20261004").await.is_err());
    assert!(another
        .clean(&HashSet::new(), at(u32::MAX as u64))
        .await
        .is_err());
    assert!(directory.path().join(NAME).exists());
    drop(images);
    assert_eq!(another.upload("png", PNG, "20261004").await.unwrap(), first);
}

#[tokio::test]
async fn orphan_grace_period_survives_restart_and_expires_at_thirty_days() {
    let (directory, images) = fixture().await;
    images.clean(&HashSet::new(), at(100)).await.unwrap();
    drop(images);
    let restarted = ImageStore::new(directory.path().to_owned(), None);
    restarted
        .clean(&HashSet::new(), at(100 + RETENTION.as_secs() - 1))
        .await
        .unwrap();
    assert!(directory.path().join(NAME).exists());
    restarted
        .clean(&HashSet::new(), at(100 + RETENTION.as_secs()))
        .await
        .unwrap();
    assert!(!directory.path().join(NAME).exists());
    let state: BTreeMap<String, Option<u64>> =
        serde_json::from_slice(&fs::read(directory.path().join(STATE_FILE)).await.unwrap())
            .unwrap();
    assert!(state.is_empty());
}

#[tokio::test]
async fn referenced_images_survive_and_removal_starts_a_new_grace_period() {
    let (directory, images) = fixture().await;
    let refs = HashSet::from([NAME.to_owned()]);
    images.clean(&HashSet::new(), at(100)).await.unwrap();
    images
        .clean(&refs, at(100 + RETENTION.as_secs()))
        .await
        .unwrap();
    images
        .clean(&HashSet::new(), at(200 + RETENTION.as_secs()))
        .await
        .unwrap();
    assert!(directory.path().join(NAME).exists());
    images
        .clean(&HashSet::new(), at(200 + 2 * RETENTION.as_secs()))
        .await
        .unwrap();
    assert!(!directory.path().join(NAME).exists());
}

#[tokio::test]
async fn brief_references_between_sweeps_reset_the_persisted_timer() {
    let (directory, images) = fixture().await;
    images.clean(&HashSet::new(), at(100)).await.unwrap();
    images.protect(&reference()).await.unwrap();
    images.protect("").await.unwrap();
    drop(images);
    let restarted = ImageStore::new(directory.path().to_owned(), None);
    restarted
        .clean(&HashSet::new(), at(100 + RETENTION.as_secs()))
        .await
        .unwrap();
    assert!(directory.path().join(NAME).exists());
}

#[tokio::test]
async fn restoring_then_removing_a_block_between_sweeps_renews_its_images() {
    for persisted in [false, true] {
        let (directory, mut images) = fixture().await;
        let block_id = "page:example:block:abc123";
        if persisted {
            let db = Database::new(&format!(
                "sqlite://{}",
                directory.path().join("docs.db").display()
            ))
            .await
            .unwrap();
            db.store(block_id, &document(&reference())).await.unwrap();
            images.database = Some(db);
        } else {
            images
                .protect_document(block_id, &reference())
                .await
                .unwrap();
        }
        images.clean(&HashSet::new(), at(100)).await.unwrap();
        images
            .protect_document("page:example:manifest", r#"{"blocks":[{"id":"abc123"}]}"#)
            .await
            .unwrap();
        images
            .protect_document("page:example:manifest", r#"{"blocks":[]}"#)
            .await
            .unwrap();
        drop(images);
        let restarted = ImageStore::new(directory.path().to_owned(), None);
        restarted
            .clean(&HashSet::new(), at(100 + RETENTION.as_secs()))
            .await
            .unwrap();
        assert!(
            directory.path().join(NAME).exists(),
            "persisted={persisted}"
        );
    }
}

#[tokio::test]
async fn duplicate_upload_renews_the_grace_period_before_reference_insertion() {
    let (directory, images) = fixture().await;
    images.clean(&HashSet::new(), at(1)).await.unwrap();
    assert_eq!(
        images.upload("png", PNG, "20261004").await.unwrap(),
        format!("api/images/{NAME}")
    );
    images
        .clean(&HashSet::new(), SystemTime::now())
        .await
        .unwrap();
    assert!(directory.path().join(NAME).exists());
}

#[tokio::test]
async fn abandoned_upload_temporary_files_expire_but_unmanaged_files_do_not() {
    let (directory, images) = fixture().await;
    let temporary = format!(".{}.tmp", "b".repeat(32));
    for name in [&temporary, "notes.txt", "notes.png", ".user.tmp"] {
        fs::write(directory.path().join(name), b"data")
            .await
            .unwrap();
    }
    images.clean(&HashSet::new(), at(100)).await.unwrap();
    images
        .clean(&HashSet::new(), at(100 + RETENTION.as_secs()))
        .await
        .unwrap();
    assert!(!directory.path().join(&temporary).exists());
    assert!(directory.path().join("notes.txt").exists());
    assert!(directory.path().join("notes.png").exists());
    assert!(directory.path().join(".user.tmp").exists());
}

#[tokio::test]
async fn invalid_metadata_and_failed_state_writes_do_not_delete_images() {
    let (directory, images) = fixture().await;
    fs::write(directory.path().join(STATE_FILE), b"invalid")
        .await
        .unwrap();
    assert!(images.clean(&HashSet::new(), at(100)).await.is_err());
    assert!(directory.path().join(NAME).exists());
    fs::write(
        directory.path().join(STATE_FILE),
        format!("{{\"{NAME}\":1}}"),
    )
    .await
    .unwrap();
    fs::create_dir(directory.path().join(STATE_TEMP))
        .await
        .unwrap();
    assert!(images
        .clean(&HashSet::new(), at(100 + RETENTION.as_secs()))
        .await
        .is_err());
    assert!(directory.path().join(NAME).exists());
}

#[tokio::test]
async fn all_persisted_and_unpersisted_documents_protect_shared_images() {
    let (directory, images) = fixture().await;
    let db_file = directory.path().join("documents.db");
    let db = Database::new(&format!("sqlite://{}", db_file.display()))
        .await
        .unwrap();
    let state = ServerState {
        documents: Default::default(),
        database: Some(db.clone()),
        image_dir: Some(directory.path().to_owned()),
        images: Some(Arc::new(images)),
    };
    clean_images(&state, at(100)).await.unwrap();
    db.store("unopened-document", &document(&reference()))
        .await
        .unwrap();
    db.store("other-document", &document(&reference()))
        .await
        .unwrap();
    clean_images(&state, at(100 + RETENTION.as_secs()))
        .await
        .unwrap();
    db.store("unopened-document", &document("")).await.unwrap();
    clean_images(&state, at(100 + 2 * RETENTION.as_secs()))
        .await
        .unwrap();
    assert!(directory.path().join(NAME).exists());
    db.store("other-document", &document("")).await.unwrap();
    state.documents.insert(
        "unsaved".into(),
        Document::new(Arc::new(Rustpad::from(document(&reference())))),
    );
    clean_images(&state, at(100 + 3 * RETENTION.as_secs()))
        .await
        .unwrap();
    assert!(directory.path().join(NAME).exists());
    state.documents.clear();
    clean_images(&state, at(100 + 4 * RETENTION.as_secs()))
        .await
        .unwrap();
    assert!(directory.path().join(NAME).exists());
    clean_images(&state, at(100 + 5 * RETENTION.as_secs()))
        .await
        .unwrap();
    assert!(!directory.path().join(NAME).exists());
}

#[tokio::test]
async fn database_scan_failure_prevents_collection() {
    let (directory, images) = fixture().await;
    images.clean(&HashSet::new(), at(1)).await.unwrap();
    let db_file = directory.path().join("documents.db");
    let uri = format!("sqlite://{}", db_file.display());
    let db = Database::new(&uri).await.unwrap();
    let pool = sqlx::SqlitePool::connect(&uri).await.unwrap();
    sqlx::query("DROP TABLE document")
        .execute(&pool)
        .await
        .unwrap();
    let state = ServerState {
        documents: Default::default(),
        database: Some(db),
        image_dir: Some(directory.path().to_owned()),
        images: Some(Arc::new(images)),
    };
    assert!(clean_images(&state, at(100 + RETENTION.as_secs()))
        .await
        .is_err());
    assert!(directory.path().join(NAME).exists());
}

#[test]
fn removed_blocks_do_not_pin_images_but_live_shared_references_do() {
    let mut texts = vec![
        (
            "page:example:manifest".into(),
            r#"{"version":1,"blocks":[]}"#.into(),
        ),
        ("page:example:block:abc123".into(), reference()),
    ];
    assert!(referenced_images(&texts).is_empty());
    texts.push(("single-document".into(), reference()));
    assert!(referenced_images(&texts).contains(NAME));
}

#[test]
fn missing_malformed_and_conflicting_manifests_preserve_block_references() {
    let block = ("page:example:block:abc123".into(), reference());
    assert!(referenced_images(std::slice::from_ref(&block)).contains(NAME));
    for manifest in [
        "",
        "{",
        "{}",
        r#"{"blocks":[{}]}"#,
        r#"{"blocks":[{"id":"abc123"}]}"#,
    ] {
        assert!(referenced_images(&[
            ("page:example:manifest".into(), manifest.into()),
            block.clone()
        ])
        .contains(NAME));
    }
    assert!(referenced_images(&[
        ("page:example:manifest".into(), r#"{"blocks":[]}"#.into()),
        (
            "page:example:manifest".into(),
            r#"{"blocks":[{"id":"abc123"}]}"#.into()
        ),
        block
    ])
    .contains(NAME));
}

#[test]
fn paths_in_supported_references_and_plain_text_are_protected_without_sidecar_names() {
    let names = image_names(&format!(
        "{0}\n<{0}>\napi/images/{1}?download=1\n\"{1}\"",
        reference(),
        NAME
    ));
    assert_eq!(names, HashSet::from([NAME.to_owned()]));
    assert!(image_names(&format!(r#"{{"collapsedImages":["{NAME}"]}}"#)).is_empty());
}
