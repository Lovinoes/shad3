//! All S3 work. Nothing in here knows about Tauri, so it can be tested on its own.

use std::collections::HashSet;
use std::path::{Component, Path, PathBuf};
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::time::{Duration, Instant};

use aws_sdk_s3::Client;
use aws_sdk_s3::config::timeout::TimeoutConfig;
use aws_sdk_s3::config::{
    BehaviorVersion, Credentials, Region, RequestChecksumCalculation, ResponseChecksumValidation,
};
use aws_sdk_s3::error::{DisplayErrorContext, ProvideErrorMetadata, SdkError};
use aws_sdk_s3::primitives::{ByteStream, Length};
use aws_sdk_s3::types::{
    BucketLocationConstraint, CompletedMultipartUpload, CompletedPart, CreateBucketConfiguration,
};
use futures::{StreamExt, TryStreamExt, stream};
use serde::{Deserialize, Serialize};
use tokio::io::AsyncWriteExt;

const MULTIPART_THRESHOLD: u64 = 32 * 1024 * 1024;
const MIN_PART: u64 = 16 * 1024 * 1024;
const PARALLEL: usize = 4;

#[derive(Clone, Serialize, Deserialize, Debug, Default, PartialEq)]
#[serde(rename_all = "camelCase", default)]
pub struct Profile {
    pub id: String,
    pub provider: String,
    pub bucket: String,
    pub endpoint: String,
    pub region: String,
    pub access_key: String,
    /// Lives in the system keyring; never written to disk or sent to the UI.
    #[serde(skip_serializing)]
    pub secret_key: String,
    pub path_style: bool,
}

impl Profile {
    /// Forgives what people paste: bucket URLs as endpoint, "s3://" names, stray spaces.
    pub fn normalized(&self) -> Profile {
        let mut p = self.clone();
        p.bucket = p.bucket.trim().trim_start_matches("s3://").trim_end_matches('/').to_owned();
        p.region = p.region.trim().to_owned();
        p.access_key = p.access_key.trim().to_owned();
        p.secret_key = p.secret_key.trim().to_owned();
        let ep = normalize_endpoint(&p.endpoint);
        let (scheme, rest) = ep.split_once("://").unwrap_or(("https", &ep));
        let (mut host, mut path) = rest.split_once('/').map_or((rest, ""), |(h, p)| (h, p));
        if !p.bucket.is_empty() {
            // "https://bucket.host.tld" -> "https://host.tld" (keeps at least "x.y.z" so "s3.amazonaws.com" survives a bucket named "s3")
            if let Some(h) = host.strip_prefix(&format!("{}.", p.bucket)).filter(|h| h.matches('.').count() >= 2) {
                host = h;
            }
            // "https://host/bucket/some/folder" -> "https://host"
            if path.split('/').next() == Some(p.bucket.as_str()) {
                path = "";
            }
        }
        p.endpoint = if path.is_empty() { format!("{scheme}://{host}") } else { format!("{scheme}://{host}/{path}") };
        p
    }

    pub fn validate(&self) -> Result<(), String> {
        let missing = [
            ("id", &self.id),
            ("Bucket name", &self.bucket),
            ("Endpoint", &self.endpoint),
            ("Access key", &self.access_key),
            ("Secret key", &self.secret_key),
        ]
        .into_iter()
        .find(|(_, v)| v.trim().is_empty());
        if let Some((name, _)) = missing {
            return Err(format!("{name} is required"));
        }
        if self.bucket.contains(|c: char| c == '/' || c.is_whitespace()) {
            return Err("Bucket name cannot contain spaces or \"/\". Put only the bucket name here, folders are browsed in the app.".into());
        }
        let ep = normalize_endpoint(&self.endpoint);
        let host = ep.split_once("://").map_or("", |(_, r)| r.split('/').next().unwrap_or(""));
        if !(ep.starts_with("http://") || ep.starts_with("https://")) || host.is_empty() || ep.contains(char::is_whitespace) {
            return Err("Endpoint must look like https://s3.example.com".into());
        }
        Ok(())
    }

    pub fn client(&self) -> Client {
        let region = match self.region.trim() {
            "" => "us-east-1",
            r => r,
        };
        let conf = aws_sdk_s3::Config::builder()
            .behavior_version(BehaviorVersion::latest())
            .region(Region::new(region.to_owned()))
            .endpoint_url(normalize_endpoint(&self.endpoint))
            .force_path_style(self.path_style)
            .credentials_provider(Credentials::new(
                self.access_key.trim(),
                self.secret_key.trim(),
                None,
                None,
                "shad3",
            ))
            // The SDK's default CRC checksums are rejected by many S3-compatible servers.
            .request_checksum_calculation(RequestChecksumCalculation::WhenRequired)
            .response_checksum_validation(ResponseChecksumValidation::WhenRequired)
            .timeout_config(TimeoutConfig::builder().connect_timeout(Duration::from_secs(10)).build())
            .build();
        Client::from_conf(conf)
    }
}

pub fn normalize_endpoint(e: &str) -> String {
    let e = e.trim().trim_end_matches('/');
    if e.contains("://") { e.to_owned() } else { format!("https://{e}") }
}

/// Turns SDK errors into something a person can act on.
pub fn fmt_err<E>(e: SdkError<E, aws_sdk_s3::config::http::HttpResponse>) -> String
where
    E: ProvideErrorMetadata + std::error::Error + Send + Sync + 'static,
{
    let status = e.raw_response().map(|r| r.status().as_u16());
    let bucket_region = e
        .raw_response()
        .and_then(|r| r.headers().get("x-amz-bucket-region"))
        .map(str::to_owned);
    match (e.code(), status) {
        (_, Some(301)) => match bucket_region {
            Some(r) => format!("Wrong region: this bucket lives in \"{r}\""),
            None => "Wrong endpoint or region (server sent a redirect)".into(),
        },
        (Some("InvalidAccessKeyId"), _) => "Access key not recognized by the server".into(),
        (Some("SignatureDoesNotMatch"), _) => "Secret key is wrong (signature mismatch)".into(),
        (Some("NoSuchBucket"), _) | (None, Some(404)) => "Bucket does not exist".into(),
        (Some("NoSuchKey"), _) => "File not found (it may have been deleted or renamed)".into(),
        (Some("AccessDenied"), _) | (None, Some(403)) => {
            "Access denied: check the keys and the bucket permissions".into()
        }
        (Some(code), _) => match e.message().filter(|m| !m.trim().is_empty()) {
            Some(m) => format!("{code}: {m}"),
            None => code.to_owned(),
        },
        (None, Some(s)) => format!("Server answered HTTP {s}"),
        (None, None) => match e {
            SdkError::TimeoutError(_) => "Timed out reaching the endpoint".into(),
            SdkError::DispatchFailure(_) => {
                format!("Could not connect: {}", DisplayErrorContext(&e))
            }
            _ => DisplayErrorContext(&e).to_string(),
        },
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TestResult {
    pub ok: bool,
    pub message: String,
    pub bucket_missing: bool,
    /// The settings that worked, when they differ from what was entered.
    pub fixed: Option<Profile>,
}

type ListErr = SdkError<aws_sdk_s3::operation::list_objects_v2::ListObjectsV2Error, aws_sdk_s3::config::http::HttpResponse>;

/// Ok(elapsed) or Err(None) on timeout.
async fn try_list(p: &Profile) -> Result<Duration, Option<ListErr>> {
    let start = Instant::now();
    let req = p.client().list_objects_v2().bucket(&p.bucket).max_keys(1).send();
    match tokio::time::timeout(Duration::from_secs(20), req).await {
        Err(_) => Err(None),
        Ok(r) => r.map(|_| start.elapsed()).map_err(Some),
    }
}

/// Tests the connection. When it fails in a way the settings could explain (bucket in the
/// endpoint, path vs virtual-host style, wrong region), it retries with those adjusted and
/// reports what worked, like rclone being forgiving.
pub async fn test(input: &Profile) -> TestResult {
    let fail = |message: String, bucket_missing| TestResult { ok: false, message, bucket_missing, fixed: None };
    let p = input.normalized();
    if let Err(m) = p.validate() {
        return fail(m, false);
    }
    let e = match try_list(&p).await {
        Ok(t) => return success(input, &p, t),
        Err(None) => return fail("Timed out after 20 s. Is the endpoint right and reachable?".into(), false),
        Err(Some(e)) => e,
    };
    let status = e.raw_response().map(|r| r.status().as_u16());
    let region = e.raw_response().and_then(|r| r.headers().get("x-amz-bucket-region")).map(str::to_owned);
    let code = e.code().map(str::to_owned);
    let fixable = matches!(code.as_deref(), Some("NoSuchKey" | "NoSuchBucket" | "PermanentRedirect" | "AuthorizationHeaderMalformed" | "InvalidRequest" | "SecondLevelDomainForbidden"))
        || matches!(status, Some(301 | 400 | 404))
        // A bucket subdomain that does not resolve; path-style avoids it.
        || (matches!(e, SdkError::DispatchFailure(_)) && !p.path_style);
    if fixable {
        let mut tries = vec![Profile { path_style: !p.path_style, ..p.clone() }];
        if let Some(r) = region.filter(|r| *r != p.region) {
            let endpoint = if p.region.is_empty() { p.endpoint.clone() } else { p.endpoint.replace(&p.region, &r) };
            let moved = Profile { region: r, endpoint, ..p.clone() };
            tries.insert(0, Profile { path_style: !p.path_style, ..moved.clone() });
            tries.insert(0, moved);
        }
        for alt in tries {
            if let Ok(t) = try_list(&alt).await {
                return success(input, &alt, t);
            }
        }
    }
    let message = match code.as_deref() {
        Some("NoSuchKey") => "The server read the bucket name as a file name (NoSuchKey). The endpoint probably \
            contains the bucket already, or points to a sub-path. Use the plain endpoint, e.g. https://fsn1.your-objectstorage.com"
            .to_owned(),
        _ => fmt_err(e),
    };
    fail(message, code.as_deref() == Some("NoSuchBucket"))
}

fn success(input: &Profile, used: &Profile, t: Duration) -> TestResult {
    let mut notes = Vec::new();
    if used.endpoint != normalize_endpoint(&input.endpoint) {
        notes.push(format!("endpoint set to {}", used.endpoint));
    }
    if used.bucket != input.bucket {
        notes.push(format!("bucket name set to {}", used.bucket));
    }
    if used.region != input.region.trim() {
        notes.push(format!("region set to {}", used.region));
    }
    if used.path_style != input.path_style {
        notes.push(format!("path-style URLs turned {}", if used.path_style { "on" } else { "off" }));
    }
    let ms = t.as_millis();
    TestResult {
        ok: true,
        message: if notes.is_empty() { format!("Connected in {ms} ms") } else { format!("Connected in {ms} ms after fixing the settings: {}. Save to keep them.", notes.join(", ")) },
        bucket_missing: false,
        fixed: (!notes.is_empty()).then(|| used.clone()),
    }
}

pub async fn create_bucket(p: &Profile) -> Result<(), String> {
    let p = &p.normalized();
    p.validate()?;
    let mut req = p.client().create_bucket().bucket(&p.bucket);
    // us-east-1 must not be sent as a constraint; "auto" is R2's pseudo-region.
    let region = p.region.trim();
    if !matches!(region, "" | "us-east-1" | "auto") {
        req = req.create_bucket_configuration(
            CreateBucketConfiguration::builder()
                .location_constraint(BucketLocationConstraint::from(region))
                .build(),
        );
    }
    req.send().await.map_err(fmt_err)?;
    Ok(())
}

#[derive(Serialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Entry {
    pub key: String,
    pub name: String,
    pub is_dir: bool,
    pub size: i64,
    pub modified: Option<i64>,
}

/// One folder level, like a file manager shows it.
pub async fn list(c: &Client, bucket: &str, prefix: &str) -> Result<Vec<Entry>, String> {
    let mut out = Vec::new();
    let mut pages = c
        .list_objects_v2()
        .bucket(bucket)
        .prefix(prefix)
        .delimiter("/")
        .into_paginator()
        .send();
    while let Some(page) = pages.next().await {
        let page = page.map_err(fmt_err)?;
        for p in page.common_prefixes().iter().filter_map(|p| p.prefix()) {
            out.push(Entry {
                key: p.to_owned(),
                name: p[prefix.len()..].trim_end_matches('/').to_owned(),
                is_dir: true,
                size: 0,
                modified: None,
            });
        }
        for o in page.contents() {
            let key = o.key().unwrap_or_default();
            if key == prefix {
                continue; // the folder's own marker object
            }
            out.push(Entry {
                key: key.to_owned(),
                name: key[prefix.len()..].to_owned(),
                is_dir: false,
                size: o.size().unwrap_or(0),
                modified: o.last_modified().and_then(|d| d.to_millis().ok()),
            });
        }
    }
    Ok(out)
}

/// Every object under a prefix (recursive), as (key, size).
pub async fn list_all(c: &Client, bucket: &str, prefix: &str) -> Result<Vec<(String, u64)>, String> {
    let mut out = Vec::new();
    let mut pages = c.list_objects_v2().bucket(bucket).prefix(prefix).into_paginator().send();
    while let Some(page) = pages.next().await {
        for o in page.map_err(fmt_err)?.contents() {
            if let Some(k) = o.key() {
                out.push((k.to_owned(), o.size().unwrap_or(0).max(0) as u64));
            }
        }
    }
    Ok(out)
}

/// Expands folder keys (ending in '/') into every object under them.
async fn expand(c: &Client, bucket: &str, keys: &[String]) -> Result<Vec<(String, u64)>, String> {
    let mut out = Vec::new();
    for k in keys {
        if k.is_empty() {
            return Err("Refusing to act on the whole bucket".into());
        }
        if k.ends_with('/') {
            out.extend(list_all(c, bucket, k).await?);
        } else {
            out.push((k.clone(), 0));
        }
    }
    Ok(out)
}

pub async fn create_folder(c: &Client, bucket: &str, key: &str) -> Result<(), String> {
    if !key.ends_with('/') || key == "/" {
        return Err("Invalid folder name".into());
    }
    c.put_object().bucket(bucket).key(key).send().await.map_err(fmt_err)?;
    Ok(())
}

// shortcut: one DELETE per object, because many S3-compatible servers reject the
// checksum header the SDK puts on batch DeleteObjects; switch to batches if deletes of 100k+ objects get slow.
async fn delete_keys(c: &Client, bucket: &str, keys: Vec<String>) -> Result<usize, String> {
    let n = keys.len();
    stream::iter(keys)
        .map(|k| async move { c.delete_object().bucket(bucket).key(k).send().await.map_err(fmt_err) })
        .buffer_unordered(16)
        .try_collect::<Vec<_>>()
        .await?;
    Ok(n)
}

pub async fn delete(c: &Client, bucket: &str, keys: &[String]) -> Result<usize, String> {
    let all = expand(c, bucket, keys).await?;
    delete_keys(c, bucket, all.into_iter().map(|(k, _)| k).collect()).await
}

/// Percent-encodes "bucket/key" for the x-amz-copy-source header.
pub fn copy_source(bucket: &str, key: &str) -> String {
    let mut s = String::new();
    for b in format!("{bucket}/{key}").bytes() {
        match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' | b'/' => s.push(b as char),
            _ => s.push_str(&format!("%{b:02X}")),
        }
    }
    s
}

/// S3 has no rename: copy everything, and only delete the originals once every copy worked.
// shortcut: CopyObject is limited to 5 GB per object; use multipart copy if bigger files must be renamed.
pub async fn rename(c: &Client, bucket: &str, from: &str, to: &str) -> Result<(), String> {
    if from.is_empty() || to.is_empty() || from == to || from.ends_with('/') != to.ends_with('/') {
        return Err("Invalid name".into());
    }
    if from.ends_with('/') && to.starts_with(from) {
        return Err("Cannot move a folder into itself".into());
    }
    let exists = if to.ends_with('/') {
        !list_all(c, bucket, to).await?.is_empty()
    } else {
        c.head_object().bucket(bucket).key(to).send().await.is_ok()
    };
    if exists {
        return Err("Something with that name already exists".into());
    }
    let src: Vec<String> = expand(c, bucket, &[from.to_owned()]).await?.into_iter().map(|(k, _)| k).collect();
    stream::iter(src.clone())
        .map(|k| async move {
            let dest = format!("{to}{}", &k[from.len()..]);
            c.copy_object()
                .bucket(bucket)
                .copy_source(copy_source(bucket, &k))
                .key(dest)
                .send()
                .await
                .map_err(fmt_err)
        })
        .buffer_unordered(16)
        .try_collect::<Vec<_>>()
        .await?;
    delete_keys(c, bucket, src).await?;
    Ok(())
}

/// Shared byte/file counters for one transfer; the caller reports them to the UI.
#[derive(Default)]
pub struct Progress {
    pub bytes: AtomicU64,
    pub total: AtomicU64,
    pub files: AtomicU64,
    pub files_total: AtomicU64,
    /// Set by the cancel button; transfers stop at the next file, part or chunk.
    pub cancelled: AtomicBool,
}

pub const CANCELLED: &str = "Cancelled";

impl Progress {
    fn check(&self) -> Result<(), String> {
        if self.cancelled.load(Ordering::Relaxed) { Err(CANCELLED.into()) } else { Ok(()) }
    }
}

/// Local files/folders -> list of (local path, object key, size). Folders keep their name and
/// structure; an empty folder becomes a folder marker (key ending in "/") so it exists in S3 too.
pub fn collect_uploads(paths: &[PathBuf], prefix: &str) -> Result<Vec<(PathBuf, String, u64)>, String> {
    fn walk(p: &Path, key: String, out: &mut Vec<(PathBuf, String, u64)>) -> std::io::Result<()> {
        let meta = std::fs::metadata(p)?;
        if meta.is_dir() {
            let mut empty = true;
            for e in std::fs::read_dir(p)? {
                let e = e?;
                empty = false;
                walk(&e.path(), format!("{key}/{}", e.file_name().to_string_lossy()), out)?;
            }
            if empty {
                out.push((p.to_owned(), format!("{key}/"), 0));
            }
        } else if meta.is_file() {
            out.push((p.to_owned(), key, meta.len()));
        }
        Ok(())
    }
    let mut out = Vec::new();
    for p in paths {
        let name = p.file_name().ok_or("Invalid path")?.to_string_lossy();
        walk(p, format!("{prefix}{name}"), &mut out).map_err(|e| format!("{}: {e}", p.display()))?;
    }
    Ok(out)
}

/// Uploads one entry from `collect_uploads`: a file, or a folder marker for an empty folder.
pub async fn upload_entry(c: &Client, bucket: &str, path: &Path, key: &str, size: u64, prog: &Progress) -> Result<(), String> {
    if key.ends_with('/') { create_folder(c, bucket, key).await } else { upload_file(c, bucket, path, key, size, prog).await }
}

pub async fn upload_file(c: &Client, bucket: &str, path: &Path, key: &str, size: u64, prog: &Progress) -> Result<(), String> {
    let mime = mime_guess::from_path(path).first_or_octet_stream().to_string();
    prog.check()?;
    if size < MULTIPART_THRESHOLD {
        let body = ByteStream::from_path(path).await.map_err(|e| e.to_string())?;
        c.put_object().bucket(bucket).key(key).content_type(mime).body(body).send().await.map_err(fmt_err)?;
        prog.bytes.fetch_add(size, Ordering::Relaxed);
        return Ok(());
    }
    // S3 allows at most 10,000 parts.
    let part = MIN_PART.max(size.div_ceil(10_000));
    let up = c.create_multipart_upload().bucket(bucket).key(key).content_type(mime).send().await.map_err(fmt_err)?;
    let upload_id = up.upload_id().ok_or("Server returned no upload id")?;
    let result = stream::iter(0..size.div_ceil(part))
        .map(|i| async move {
            prog.check()?; // a cancel aborts the multipart upload below, so no parts linger
            let len = part.min(size - i * part);
            let body = ByteStream::read_from()
                .path(path)
                .offset(i * part)
                .length(Length::Exact(len))
                .build()
                .await
                .map_err(|e| e.to_string())?;
            let n = i as i32 + 1;
            let r = c.upload_part().bucket(bucket).key(key).upload_id(upload_id).part_number(n).body(body).send().await.map_err(fmt_err)?;
            prog.bytes.fetch_add(len, Ordering::Relaxed);
            Ok::<_, String>(CompletedPart::builder().part_number(n).set_e_tag(r.e_tag().map(str::to_owned)).build())
        })
        .buffered(PARALLEL)
        .try_collect::<Vec<_>>()
        .await;
    let done = match result {
        Ok(parts) => c
            .complete_multipart_upload()
            .bucket(bucket)
            .key(key)
            .upload_id(upload_id)
            .multipart_upload(CompletedMultipartUpload::builder().set_parts(Some(parts)).build())
            .send()
            .await
            .map(|_| ())
            .map_err(fmt_err),
        Err(e) => Err(e),
    };
    if done.is_err() {
        // Orphaned parts cost money on most providers.
        let _ = c.abort_multipart_upload().bucket(bucket).key(key).upload_id(upload_id).send().await;
    }
    done
}

pub async fn exists(c: &Client, bucket: &str, key: &str) -> Result<bool, String> {
    match c.head_object().bucket(bucket).key(key).send().await {
        Ok(_) => Ok(true),
        Err(e) if e.raw_response().map(|r| r.status().as_u16()) == Some(404) => Ok(false),
        Err(e) => Err(fmt_err(e)),
    }
}

/// Which keys an upload of `paths` into `prefix` would overwrite. One listing per uploaded
/// folder, one HEAD per uploaded file.
pub async fn existing(c: &Client, bucket: &str, paths: &[PathBuf], prefix: &str) -> Result<HashSet<String>, String> {
    let lists: Vec<Vec<String>> = stream::iter(paths.to_vec())
        .map(|p| async move {
            let name = p.file_name().ok_or_else(|| "Invalid path".to_string())?.to_string_lossy().into_owned();
            if p.is_dir() {
                Ok::<Vec<String>, String>(list_all(c, bucket, &format!("{prefix}{name}/")).await?.into_iter().map(|(k, _)| k).collect())
            } else {
                let key = format!("{prefix}{name}");
                Ok(if exists(c, bucket, &key).await? { vec![key] } else { vec![] })
            }
        })
        .buffer_unordered(16)
        .try_collect::<Vec<_>>()
        .await?;
    Ok(lists.into_iter().flatten().collect())
}

/// "dir/photo.jpg" -> "dir/photo (2).jpg", like file managers name copies.
pub fn numbered(key: &str, n: u32) -> String {
    let (dir, name) = match key.rsplit_once('/') {
        Some((d, f)) => (format!("{d}/"), f),
        None => (String::new(), key),
    };
    match name.rfind('.') {
        Some(i) if i > 0 => format!("{dir}{} ({n}){}", &name[..i], &name[i..]),
        _ => format!("{dir}{name} ({n})"),
    }
}

/// Creates an empty file; never overwrites an existing one.
pub async fn create_file(c: &Client, bucket: &str, key: &str) -> Result<(), String> {
    if key.is_empty() || key.ends_with('/') {
        return Err("Invalid file name".into());
    }
    if exists(c, bucket, key).await? {
        return Err("A file with that name already exists".into());
    }
    let mime = mime_guess::from_path(key).first_or_octet_stream().to_string();
    c.put_object().bucket(bucket).key(key).content_type(mime).send().await.map_err(fmt_err)?;
    Ok(())
}

/// Everything S3 knows about an object (Properties), or totals for a folder.
#[derive(Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct ObjectInfo {
    pub key: String,
    pub is_dir: bool,
    pub size: i64,
    pub modified: Option<i64>,
    pub files: u64,
    pub folders: u64,
    pub content_type: Option<String>,
    pub etag: Option<String>,
    pub storage_class: Option<String>,
    pub cache_control: Option<String>,
    pub content_disposition: Option<String>,
    pub content_encoding: Option<String>,
    pub content_language: Option<String>,
    pub version_id: Option<String>,
    pub encryption: Option<String>,
    pub metadata: std::collections::BTreeMap<String, String>,
}

pub async fn info(c: &Client, bucket: &str, key: &str) -> Result<ObjectInfo, String> {
    if key.ends_with('/') {
        // Folder: count everything below it (subfolders come from the keys' paths).
        let all = list_all(c, bucket, key).await?;
        let mut folders = HashSet::new();
        for (k, _) in &all {
            let rest = &k[key.len()..];
            for (i, _) in rest.match_indices('/') {
                folders.insert(&rest[..i]);
            }
        }
        return Ok(ObjectInfo {
            key: key.into(),
            is_dir: true,
            size: all.iter().map(|(_, s)| *s as i64).sum(),
            files: all.iter().filter(|(k, _)| !k.ends_with('/')).count() as u64,
            folders: folders.len() as u64,
            ..Default::default()
        });
    }
    let h = c.head_object().bucket(bucket).key(key).send().await.map_err(fmt_err)?;
    let s = |v: Option<&str>| v.map(str::to_owned);
    Ok(ObjectInfo {
        key: key.into(),
        size: h.content_length().unwrap_or(0),
        modified: h.last_modified().and_then(|d| d.to_millis().ok()),
        files: 1,
        content_type: s(h.content_type()),
        etag: s(h.e_tag()),
        storage_class: h.storage_class().map(|c| c.as_str().to_owned()),
        cache_control: s(h.cache_control()),
        content_disposition: s(h.content_disposition()),
        content_encoding: s(h.content_encoding()),
        content_language: s(h.content_language()),
        version_id: s(h.version_id()),
        encryption: h.server_side_encryption().map(|e| e.as_str().to_owned()),
        metadata: h.metadata().map(|m| m.iter().map(|(k, v)| (k.clone(), v.clone())).collect()).unwrap_or_default(),
        ..Default::default()
    })
}

/// Largest file the built-in editor opens.
pub const MAX_EDIT: i64 = 5 * 1024 * 1024;
/// Error text for "the object changed on the server since it was opened".
pub const CONFLICT: &str = "CONFLICT";

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TextFile {
    pub text: String,
    pub etag: Option<String>,
}

/// The object as UTF-8 text, or None when it is binary or bigger than MAX_EDIT.
pub async fn read_text(c: &Client, bucket: &str, key: &str) -> Result<Option<TextFile>, String> {
    let o = c.get_object().bucket(bucket).key(key).send().await.map_err(fmt_err)?;
    if o.content_length().unwrap_or(0) > MAX_EDIT {
        return Ok(None);
    }
    let etag = o.e_tag().map(str::to_owned);
    let bytes = o.body.collect().await.map_err(|e| format!("Download interrupted: {e}"))?.to_vec();
    if bytes.len() as i64 > MAX_EDIT || bytes[..bytes.len().min(8000)].contains(&0) {
        return Ok(None);
    }
    Ok(String::from_utf8(bytes).ok().map(|text| TextFile { text, etag }))
}

/// Replaces an object's content but keeps its content type, caching headers and metadata.
/// With `expected_etag`, refuses (Err(CONFLICT)) if someone changed or deleted it meanwhile.
/// Returns the new ETag.
pub async fn put_preserving(c: &Client, bucket: &str, key: &str, body: ByteStream, expected_etag: Option<&str>) -> Result<Option<String>, String> {
    let mut req = c.put_object().bucket(bucket).key(key).body(body);
    match c.head_object().bucket(bucket).key(key).send().await {
        Ok(h) => {
            if expected_etag.is_some_and(|e| h.e_tag() != Some(e)) {
                return Err(CONFLICT.into());
            }
            req = req
                .set_content_type(h.content_type().map(str::to_owned))
                .set_cache_control(h.cache_control().map(str::to_owned))
                .set_content_disposition(h.content_disposition().map(str::to_owned))
                .set_content_language(h.content_language().map(str::to_owned))
                .set_metadata(h.metadata().cloned());
        }
        Err(e) if e.raw_response().map(|r| r.status().as_u16()) == Some(404) => {
            if expected_etag.is_some() {
                return Err(CONFLICT.into());
            }
            req = req.content_type(mime_guess::from_path(key).first_or_octet_stream().to_string());
        }
        Err(e) => return Err(fmt_err(e)),
    }
    Ok(req.send().await.map_err(fmt_err)?.e_tag().map(str::to_owned))
}

/// Joins an object key onto a local folder, refusing anything that would escape it.
pub fn safe_join(base: &Path, rel: &str) -> Result<PathBuf, String> {
    let mut out = base.to_owned();
    for part in rel.split('/').filter(|p| !p.is_empty() && *p != ".") {
        let mut comps = Path::new(part).components();
        match (comps.next(), comps.next()) {
            (Some(Component::Normal(c)), None) => out.push(c),
            _ => return Err(format!("Unsafe object name: {rel}")),
        }
    }
    if out == base { Err(format!("Unsafe object name: {rel}")) } else { Ok(out) }
}

/// "name", "name (1)", "name (2)", ... whichever does not exist yet.
pub fn unique_path(p: PathBuf) -> PathBuf {
    if !p.exists() {
        return p;
    }
    let stem = p.file_stem().unwrap_or_default().to_string_lossy().into_owned();
    let ext = p.extension().map(|e| format!(".{}", e.to_string_lossy())).unwrap_or_default();
    (1..)
        .map(|i| p.with_file_name(format!("{stem} ({i}){ext}")))
        .find(|c| !c.exists())
        .unwrap()
}

/// Plans a download: each selected item lands in `dest` under a name that does not clash.
pub async fn plan_download(c: &Client, bucket: &str, keys: &[String], dest: &Path) -> Result<Vec<(String, PathBuf, u64)>, String> {
    let mut out = Vec::new();
    for k in keys {
        let parent = k.trim_end_matches('/').rfind('/').map_or(0, |i| i + 1);
        let top = unique_path(safe_join(dest, k[parent..].trim_end_matches('/'))?);
        if k.ends_with('/') {
            // The folder itself, so an empty one is still created.
            out.push((k.clone(), top.clone(), 0));
            for (key, size) in list_all(c, bucket, k).await? {
                if key != *k {
                    out.push((key.clone(), safe_join(&top, &key[k.len()..])?, size));
                }
            }
        } else {
            let size = c.head_object().bucket(bucket).key(k).send().await.map_err(fmt_err)?.content_length().unwrap_or(0);
            out.push((k.clone(), top, size.max(0) as u64));
        }
    }
    Ok(out)
}

/// Downloads one entry from `plan_download`: a file, or (key ending in "/") a folder to create.
pub async fn download_entry(c: &Client, bucket: &str, key: &str, dest: &Path, prog: &Progress) -> Result<(), String> {
    if key.ends_with('/') {
        tokio::fs::create_dir_all(dest).await.map_err(|e| format!("{}: {e}", dest.display()))
    } else {
        download_file(c, bucket, key, dest, prog).await
    }
}

/// Streams to "<file>.part" and renames at the end, so a failed download never looks complete.
pub async fn download_file(c: &Client, bucket: &str, key: &str, dest: &Path, prog: &Progress) -> Result<(), String> {
    if let Some(dir) = dest.parent() {
        tokio::fs::create_dir_all(dir).await.map_err(|e| format!("{}: {e}", dir.display()))?;
    }
    let tmp = dest.with_file_name(format!("{}.part", dest.file_name().unwrap_or_default().to_string_lossy()));
    let res = async {
        let mut body = c.get_object().bucket(bucket).key(key).send().await.map_err(fmt_err)?.body;
        let mut f = tokio::fs::File::create(&tmp).await.map_err(|e| e.to_string())?;
        while let Some(chunk) = body.next().await {
            prog.check()?; // removes the .part file below
            let chunk = chunk.map_err(|e| format!("Download interrupted: {e}"))?;
            f.write_all(&chunk).await.map_err(|e| e.to_string())?;
            prog.bytes.fetch_add(chunk.len() as u64, Ordering::Relaxed);
        }
        f.flush().await.map_err(|e| e.to_string())?;
        tokio::fs::rename(&tmp, dest).await.map_err(|e| e.to_string())
    }
    .await;
    if res.is_err() {
        let _ = tokio::fs::remove_file(&tmp).await;
    }
    res
}

/// Runs jobs a few at a time, keeps going past failures, and returns the failures.
pub async fn run_parallel<T, F, Fut>(items: Vec<T>, prog: Arc<Progress>, f: F) -> Vec<String>
where
    F: Fn(T) -> Fut,
    Fut: Future<Output = Result<(), String>>,
{
    stream::iter(items)
        .map(|it| {
            let fut = f(it);
            let prog = prog.clone();
            async move {
                if prog.cancelled.load(Ordering::Relaxed) {
                    return None; // not started; the caller reports the cancel once
                }
                let r = fut.await;
                prog.files.fetch_add(1, Ordering::Relaxed);
                r.err().filter(|e| e != CANCELLED)
            }
        })
        .buffer_unordered(PARALLEL)
        .filter_map(|e| async move { e })
        .collect()
        .await
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn helpers() {
        assert_eq!(normalize_endpoint(" minio.local:9000/ "), "https://minio.local:9000");
        assert_eq!(normalize_endpoint("http://x"), "http://x");
        assert_eq!(copy_source("b", "a b/ä+.txt"), "b/a%20b/%C3%A4%2B.txt");
        let base = Path::new("/tmp/dl");
        assert_eq!(safe_join(base, "a//b/./c.txt").unwrap(), Path::new("/tmp/dl/a/b/c.txt"));
        assert!(safe_join(base, "a/../../etc/passwd").is_err());
        assert!(safe_join(base, "..").is_err());
        assert!(safe_join(base, "/").is_err());
        let tmp = std::env::temp_dir().join(format!("s3b-collect-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&tmp);
        for d in ["up/empty", "up/sub/emptier", "lonely"] {
            std::fs::create_dir_all(tmp.join(d)).unwrap();
        }
        std::fs::write(tmp.join("up/a.txt"), "a").unwrap();
        std::fs::write(tmp.join("up/sub/b.txt"), "bb").unwrap();
        let mut got: Vec<(String, u64)> = collect_uploads(&[tmp.join("up"), tmp.join("lonely")], "p/").unwrap().into_iter().map(|(_, k, s)| (k, s)).collect();
        got.sort();
        let want = [("p/lonely/", 0), ("p/up/a.txt", 1), ("p/up/empty/", 0), ("p/up/sub/b.txt", 2), ("p/up/sub/emptier/", 0)];
        assert_eq!(got, want.map(|(k, s)| (k.to_string(), s)));
        std::fs::remove_dir_all(&tmp).unwrap();
        assert_eq!(numbered("a/photo.jpg", 1), "a/photo (1).jpg");
        assert_eq!(numbered("archive.tar.gz", 2), "archive.tar (2).gz");
        assert_eq!(numbered("x/Makefile", 1), "x/Makefile (1)");
        assert_eq!(numbered(".env", 1), ".env (1)");

        let n = |bucket: &str, endpoint: &str| Profile { bucket: bucket.into(), endpoint: endpoint.into(), ..Default::default() }.normalized();
        assert_eq!(n("data", "https://data.fsn1.your-objectstorage.com/").endpoint, "https://fsn1.your-objectstorage.com");
        assert_eq!(n("data", "https://acc.r2.cloudflarestorage.com/data/some/folder").endpoint, "https://acc.r2.cloudflarestorage.com");
        assert_eq!(n("s3", "s3.amazonaws.com").endpoint, "https://s3.amazonaws.com");
        assert_eq!(n("minio", "http://minio.lan:9000").endpoint, "http://minio.lan:9000");
        assert_eq!(n("data", "https://proxy.example.com/s3").endpoint, "https://proxy.example.com/s3");
        assert_eq!(n(" s3://data/ ", "x.y.z").bucket, "data");
        let v = |bucket: &str, endpoint: &str| Profile { id: "i".into(), bucket: bucket.into(), endpoint: endpoint.into(), access_key: "a".into(), secret_key: "s".into(), ..Default::default() }.validate();
        assert!(v("data", "https://s3.example.com").is_ok());
        assert!(v("da ta", "https://s3.example.com").is_err());
        assert!(v("data/x", "https://s3.example.com").is_err());
        assert!(v("data", "ftp://s3.example.com").is_err());
        assert!(v("data", "https:// s3.example.com").is_err());
    }

    /// After a cancel, unstarted jobs are skipped and "Cancelled" isn't reported as a failure.
    #[tokio::test]
    async fn cancel() {
        let prog = Arc::new(Progress::default());
        let started = Arc::new(AtomicU64::new(0));
        let job = |n: u32| {
            let (prog, started) = (prog.clone(), started.clone());
            async move {
                started.fetch_add(1, Ordering::Relaxed);
                if n == 2 {
                    prog.cancelled.store(true, Ordering::Relaxed); // the user clicks cancel mid-way
                    return Err(CANCELLED.to_string());
                }
                if n == 1 { Err("real failure".to_string()) } else { prog.check() }
            }
        };
        let failed = run_parallel((1..=40).collect(), prog.clone(), job).await;
        assert_eq!(failed, ["real failure"]);
        assert!(started.load(Ordering::Relaxed) < 40, "jobs kept starting after the cancel");
        assert!(prog.check().is_err());
    }

    /// Runs against a real server when S3_TEST_ENDPOINT is set, e.g. a local MinIO:
    /// S3_TEST_ENDPOINT=http://127.0.0.1:9000 S3_TEST_KEY=minioadmin S3_TEST_SECRET=minioadmin cargo test
    #[tokio::test]
    async fn against_server() {
        let Ok(endpoint) = std::env::var("S3_TEST_ENDPOINT") else { return };
        let p = Profile {
            id: "t".into(),
            bucket: format!("s3b-test-{}", std::process::id()),
            endpoint,
            access_key: std::env::var("S3_TEST_KEY").unwrap(),
            secret_key: std::env::var("S3_TEST_SECRET").unwrap(),
            path_style: true,
            ..Default::default()
        };
        let t = test(&p).await;
        assert!(!t.ok && t.bucket_missing, "{}", t.message);
        create_bucket(&p).await.unwrap();
        assert!(test(&p).await.ok);
        let pasted = Profile { endpoint: format!("{}/{}/folder", p.endpoint, p.bucket), path_style: false, ..p.clone() };
        let t = test(&pasted).await;
        assert!(t.ok, "{}", t.message);
        assert_eq!(t.fixed.as_ref().map(|f| (f.endpoint.as_str(), f.path_style)), Some((p.endpoint.as_str(), true)), "{}", t.message);
        let bad = Profile { secret_key: "wrong".into(), ..p.clone() };
        assert!(test(&bad).await.message.contains("Secret key"), "{}", test(&bad).await.message);

        let c = p.client();
        let b = p.bucket.as_str();
        let dir = std::env::temp_dir().join(format!("s3b-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(dir.join("up/sub")).unwrap();
        let big: Vec<u8> = (0..40 * 1024 * 1024u32).map(|i| (i % 251) as u8).collect();
        std::fs::write(dir.join("up/sub/big.bin"), &big).unwrap();
        std::fs::write(dir.join("up/a b.txt"), "hello").unwrap();
        std::fs::create_dir_all(dir.join("up/empty")).unwrap();

        create_folder(&c, b, "docs/").await.unwrap();
        let prog = Progress::default();
        for (path, key, size) in collect_uploads(&[dir.join("up")], "docs/").unwrap() {
            upload_entry(&c, b, &path, &key, size, &prog).await.unwrap();
        }
        assert_eq!(prog.bytes.load(Ordering::Relaxed), big.len() as u64 + 5);

        let names = |v: Vec<Entry>| v.into_iter().map(|e| (e.name, e.is_dir)).collect::<Vec<_>>();
        assert_eq!(names(list(&c, b, "").await.unwrap()), [("docs".into(), true)]);
        assert_eq!(names(list(&c, b, "docs/").await.unwrap()), [("up".into(), true)]);
        let mut l = names(list(&c, b, "docs/up/").await.unwrap());
        l.sort();
        assert_eq!(l, [("a b.txt".into(), false), ("empty".into(), true), ("sub".into(), true)]);

        let again = existing(&c, b, &[dir.join("up")], "docs/").await.unwrap();
        assert_eq!(again, HashSet::from(["docs/up/a b.txt".to_string(), "docs/up/sub/big.bin".to_string()]));
        assert!(existing(&c, b, &[dir.join("up/a b.txt")], "docs/").await.unwrap().is_empty());
        rename(&c, b, "docs/up/", "docs/moved/").await.unwrap();
        assert!(rename(&c, b, "docs/moved/", "docs/moved/x/").await.is_err());
        rename(&c, b, "docs/moved/a b.txt", "docs/moved/c.txt").await.unwrap();
        assert!(list_all(&c, b, "docs/up/").await.unwrap().is_empty());

        let out = dir.join("down");
        std::fs::create_dir_all(out.join("moved")).unwrap(); // forces a "moved (1)" folder
        let plan = plan_download(&c, b, &["docs/moved/".into()], &out).await.unwrap();
        for (key, path, _) in &plan {
            download_entry(&c, b, key, path, &prog).await.unwrap();
        }
        assert_eq!(std::fs::read(out.join("moved (1)/sub/big.bin")).unwrap(), big);
        assert_eq!(std::fs::read_to_string(out.join("moved (1)/c.txt")).unwrap(), "hello");
        assert!(out.join("moved (1)/empty").is_dir());

        create_file(&c, b, "docs/new.md").await.unwrap();
        assert_eq!(read_text(&c, b, "docs/new.md").await.unwrap().unwrap().text, "");
        assert!(create_file(&c, b, "docs/new.md").await.is_err()); // never overwrites
        delete(&c, b, &["docs/new.md".into()]).await.unwrap();
        let t = read_text(&c, b, "docs/moved/c.txt").await.unwrap().unwrap();
        assert_eq!(t.text, "hello");
        assert!(read_text(&c, b, "docs/moved/sub/big.bin").await.unwrap().is_none()); // > 5 MB
        let e2 = put_preserving(&c, b, "docs/moved/c.txt", ByteStream::from_static(b"hi"), t.etag.as_deref()).await.unwrap();
        assert_eq!(read_text(&c, b, "docs/moved/c.txt").await.unwrap().unwrap().text, "hi");
        assert_eq!(put_preserving(&c, b, "docs/moved/c.txt", ByteStream::from_static(b"x"), t.etag.as_deref()).await, Err(CONFLICT.into()));
        put_preserving(&c, b, "docs/moved/c.txt", ByteStream::from_static(b"hello"), e2.as_deref()).await.unwrap();
        assert_eq!(delete(&c, b, &["docs/".into()]).await.unwrap(), 4); // 2 markers + 2 files
        assert!(list(&c, b, "").await.unwrap().is_empty());
        assert!(delete(&c, b, &["".into()]).await.is_err());
        c.delete_bucket().bucket(b).send().await.unwrap();
        std::fs::remove_dir_all(&dir).unwrap();
    }
}
