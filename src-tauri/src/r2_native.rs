use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{
    fs::File,
    io::{BufReader, Read},
    path::{Path, PathBuf},
};

const R2_CREDENTIAL_SERVICE: &str = "blue.bluehair.naiblue.r2";
const R2_HASH_METADATA_KEY: &str = "nai-blue-sha256";

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NativeR2Profile {
    pub account_id: String,
    pub jurisdiction: Option<String>,
    pub endpoint: Option<String>,
    pub bucket: String,
    pub prefix: String,
    pub credential_ref: String,
    pub conflict_policy: NativeR2ConflictPolicy,
}

#[derive(Debug, Clone, Copy, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum NativeR2ConflictPolicy {
    Fail,
    SkipSame,
    Overwrite,
    Suffix,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StoreR2CredentialRequest {
    pub credential_ref: String,
    pub access_key_id: String,
    pub secret_access_key: String,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct StoredR2Credential {
    access_key_id: String,
    secret_access_key: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NativeR2CredentialStatus {
    pub credential_ref: String,
    pub available: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NativeR2Error {
    pub code: String,
    pub message: String,
    pub retryable: bool,
    pub status: Option<u16>,
}

impl NativeR2Error {
    fn new(code: &str, message: &str, retryable: bool, status: Option<u16>) -> Self {
        Self {
            code: code.to_string(),
            message: message.to_string(),
            retryable,
            status,
        }
    }

    #[cfg(not(any(target_os = "windows", target_os = "linux", target_os = "macos")))]
    fn unsupported() -> Self {
        Self::new(
            "E_R2_UNSUPPORTED",
            "Native R2 upload is unavailable on this platform build.",
            false,
            None,
        )
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NativeR2ConnectionResult {
    pub ok: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NativeR2TemporaryObjectResult {
    pub put: bool,
    pub head: bool,
    pub deleted: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NativeR2HeadResult {
    pub exists: bool,
    pub size: Option<i64>,
    pub content_sha256: Option<String>,
    pub etag: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NativeR2PutResult {
    pub remote_key: String,
    pub uploaded: bool,
    pub skipped_same: bool,
    pub etag: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NativeR2MultipartStartResult {
    pub remote_key: String,
    pub upload_id: String,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NativeR2CompletedPart {
    pub part_number: i32,
    pub etag: String,
    pub size: u64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NativeR2ScannedArtifact {
    pub artifact_id: String,
    pub local_variant: String,
    pub remote_key: String,
    pub content_sha256: String,
    pub size: u64,
    pub content_type: String,
}

fn validate_identifier(value: &str) -> Result<(), NativeR2Error> {
    if value.is_empty()
        || value.len() > 128
        || !value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b':' | b'_' | b'-' | b'.'))
    {
        return Err(NativeR2Error::new(
            "E_R2_INVALID_PROFILE",
            "Credential reference is invalid.",
            false,
            None,
        ));
    }
    Ok(())
}

fn normalize_key(value: &str) -> Result<String, NativeR2Error> {
    let normalized = value.replace('\\', "/");
    let parts = normalized
        .split('/')
        .filter(|part| !part.is_empty() && *part != ".")
        .collect::<Vec<_>>();
    if parts.is_empty() || parts.iter().any(|part| *part == "..") {
        return Err(NativeR2Error::new(
            "E_R2_INVALID_KEY",
            "Remote object key is invalid.",
            false,
            None,
        ));
    }
    Ok(parts.join("/"))
}

fn prefixed_key(prefix: &str, key: &str) -> Result<String, NativeR2Error> {
    let key = normalize_key(key)?;
    if prefix.trim_matches('/').is_empty() {
        return Ok(key);
    }
    Ok(format!("{}/{}", normalize_key(prefix)?, key))
}

fn deterministic_suffix_key(remote_key: &str, content_sha256: &str) -> String {
    let suffix = content_sha256.trim_start_matches("sha256:");
    let suffix = &suffix[..suffix.len().min(12)];
    match remote_key.rsplit_once('.') {
        Some((stem, extension)) if !stem.is_empty() && !extension.contains('/') => {
            format!("{stem}-{suffix}.{extension}")
        }
        _ => format!("{remote_key}-{suffix}"),
    }
}

fn read_and_hash_file(
    path: &Path,
    capture: Option<(u64, u64)>,
) -> Result<(u64, String, Vec<u8>), NativeR2Error> {
    let file = File::open(path).map_err(|_| {
        NativeR2Error::new(
            "E_R2_LOCAL_FILE",
            "Local upload file could not be opened.",
            false,
            None,
        )
    })?;
    let mut reader = BufReader::new(file);
    let mut hasher = Sha256::new();
    let mut size = 0_u64;
    let mut captured = Vec::new();
    let mut buffer = [0_u8; 1024 * 1024];
    loop {
        let read = reader.read(&mut buffer).map_err(|_| {
            NativeR2Error::new(
                "E_R2_LOCAL_FILE",
                "Local upload file could not be read.",
                false,
                None,
            )
        })?;
        if read == 0 {
            break;
        }
        let next_size = size.checked_add(read as u64).ok_or_else(|| {
            NativeR2Error::new(
                "E_R2_LOCAL_FILE",
                "Local upload file size could not be measured safely.",
                false,
                None,
            )
        })?;
        if let Some((start, end)) = capture {
            let overlap_start = start.max(size);
            let overlap_end = end.min(next_size);
            if overlap_start < overlap_end {
                captured.extend_from_slice(
                    &buffer[(overlap_start - size) as usize..(overlap_end - size) as usize],
                );
            }
        }
        size = next_size;
        hasher.update(&buffer[..read]);
    }
    Ok((size, format!("{:x}", hasher.finalize()), captured))
}

fn measure_and_sha256_file(path: &Path) -> Result<(u64, String), NativeR2Error> {
    read_and_hash_file(path, None).map(|(size, hash, _)| (size, hash))
}

fn sha256_file(path: &Path) -> Result<String, NativeR2Error> {
    measure_and_sha256_file(path).map(|(_, hash)| hash)
}

/// Validates the durable artifact identity before any R2 request can observe
/// caller-supplied metadata. The streaming read keeps memory bounded for large files.
fn validate_upload_file(
    path: &Path,
    expected_size: u64,
    expected_sha256: &str,
) -> Result<(), NativeR2Error> {
    let (actual_size, actual_sha256) = measure_and_sha256_file(path)?;
    if actual_size != expected_size || format!("sha256:{actual_sha256}") != expected_sha256 {
        return Err(NativeR2Error::new(
            "E_R2_LOCAL_INTEGRITY",
            "Local upload file no longer matches the queued artifact identity.",
            false,
            None,
        ));
    }
    Ok(())
}

/// Captures the outgoing range from the same read that validates the full file.
/// SDK retries reuse these bytes even if the source changes after validation.
/// ponytail: each multipart part rehashes the file; add a private immutable spool
/// only if measured large-file throughput warrants the extra lifecycle owner.
fn verified_upload_bytes(
    path: &Path,
    expected_size: u64,
    expected_sha256: &str,
    offset: u64,
    length: u64,
) -> Result<Vec<u8>, NativeR2Error> {
    let end = offset
        .checked_add(length)
        .filter(|end| *end <= expected_size);
    // Current jobs use 8 MiB parts; bound renderer-controlled allocation requests.
    if end.is_none() || length > 64 * 1024 * 1024 {
        return Err(NativeR2Error::new(
            "E_R2_LOCAL_INTEGRITY",
            "Upload range exceeds the artifact or the 64 MiB native body limit.",
            false,
            None,
        ));
    }
    let (size, hash, bytes) = read_and_hash_file(path, Some((offset, end.unwrap())))?;
    if size != expected_size || format!("sha256:{hash}") != expected_sha256 {
        return Err(NativeR2Error::new(
            "E_R2_LOCAL_INTEGRITY",
            "Local upload file no longer matches the queued artifact identity.",
            false,
            None,
        ));
    }
    Ok(bytes)
}

fn content_type(path: &Path) -> &'static str {
    match path
        .extension()
        .and_then(|value| value.to_str())
        .unwrap_or_default()
        .to_ascii_lowercase()
        .as_str()
    {
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "webp" => "image/webp",
        "json" => "application/json",
        _ => "application/octet-stream",
    }
}

fn collect_files(
    root: &Path,
    current: &Path,
    output: &mut Vec<PathBuf>,
) -> Result<(), NativeR2Error> {
    let entries = std::fs::read_dir(current).map_err(|_| {
        NativeR2Error::new(
            "E_R2_LOCAL_ROOT",
            "Local upload directory could not be read.",
            false,
            None,
        )
    })?;
    for entry in entries {
        let entry = entry.map_err(|_| {
            NativeR2Error::new(
                "E_R2_LOCAL_ROOT",
                "Local upload directory could not be read.",
                false,
                None,
            )
        })?;
        let path = entry.path();
        let name = entry.file_name();
        if name.to_string_lossy().starts_with('.') {
            continue;
        }
        let file_type = entry.file_type().map_err(|_| {
            NativeR2Error::new(
                "E_R2_LOCAL_ROOT",
                "Local upload entry could not be inspected.",
                false,
                None,
            )
        })?;
        if file_type.is_symlink() {
            continue;
        }
        if file_type.is_dir() {
            collect_files(root, &path, output)?;
        } else if file_type.is_file() {
            output.push(path);
        }
    }
    let _ = root;
    Ok(())
}

#[tauri::command]
pub async fn r2_scan_local_artifacts(
    local_root: String,
    prefix: String,
) -> Result<Vec<NativeR2ScannedArtifact>, NativeR2Error> {
    let root = PathBuf::from(local_root).canonicalize().map_err(|_| {
        NativeR2Error::new(
            "E_R2_LOCAL_ROOT",
            "Local upload directory is unavailable.",
            false,
            None,
        )
    })?;
    if !root.is_dir() {
        return Err(NativeR2Error::new(
            "E_R2_LOCAL_ROOT",
            "Local upload root must be a directory.",
            false,
            None,
        ));
    }

    let mut paths = Vec::new();
    collect_files(&root, &root, &mut paths)?;
    paths.sort();

    let mut artifacts = Vec::with_capacity(paths.len());
    for path in paths {
        let relative = path.strip_prefix(&root).map_err(|_| {
            NativeR2Error::new(
                "E_R2_LOCAL_ROOT",
                "Local upload path escaped its root.",
                false,
                None,
            )
        })?;
        let relative_key = relative.to_string_lossy().replace('\\', "/");
        let hash = sha256_file(&path)?;
        let size = path
            .metadata()
            .map_err(|_| {
                NativeR2Error::new(
                    "E_R2_LOCAL_FILE",
                    "Local upload file metadata is unavailable.",
                    false,
                    None,
                )
            })?
            .len();
        artifacts.push(NativeR2ScannedArtifact {
            artifact_id: format!("sha256:{hash}"),
            local_variant: path.to_string_lossy().to_string(),
            remote_key: prefixed_key(&prefix, &relative_key)?,
            content_sha256: format!("sha256:{hash}"),
            size,
            content_type: content_type(&path).to_string(),
        });
    }
    Ok(artifacts)
}

#[cfg(any(target_os = "windows", target_os = "linux", target_os = "macos"))]
mod desktop {
    use super::*;
    use aws_sdk_s3::{
        config::{BehaviorVersion, Credentials, Region},
        error::ProvideErrorMetadata,
        primitives::ByteStream,
        types::{CompletedMultipartUpload, CompletedPart},
        Client,
    };
    use std::time::{SystemTime, UNIX_EPOCH};

    fn keyring_entry(credential_ref: &str) -> Result<keyring::Entry, NativeR2Error> {
        validate_identifier(credential_ref)?;
        keyring::Entry::new(R2_CREDENTIAL_SERVICE, credential_ref).map_err(|_| {
            NativeR2Error::new(
                "E_R2_VAULT_UNAVAILABLE",
                "The operating-system credential vault is unavailable.",
                false,
                None,
            )
        })
    }

    pub fn store_credential(
        request: StoreR2CredentialRequest,
    ) -> Result<NativeR2CredentialStatus, NativeR2Error> {
        validate_identifier(&request.credential_ref)?;
        if request.access_key_id.trim().len() < 4 || request.secret_access_key.trim().len() < 8 {
            return Err(NativeR2Error::new(
                "E_R2_INVALID_CREDENTIAL",
                "R2 credential input is invalid.",
                false,
                None,
            ));
        }
        let payload = serde_json::to_vec(&StoredR2Credential {
            access_key_id: request.access_key_id.trim().to_string(),
            secret_access_key: request.secret_access_key.trim().to_string(),
        })
        .map_err(|_| {
            NativeR2Error::new(
                "E_R2_VAULT_WRITE",
                "R2 credential could not be prepared.",
                false,
                None,
            )
        })?;
        let entry = keyring_entry(&request.credential_ref)?;
        entry.set_secret(&payload).map_err(|_| {
            NativeR2Error::new(
                "E_R2_VAULT_WRITE",
                "R2 credential could not be saved to the operating-system vault.",
                false,
                None,
            )
        })?;
        Ok(NativeR2CredentialStatus {
            credential_ref: request.credential_ref,
            available: true,
        })
    }

    pub fn credential_status(
        credential_ref: String,
    ) -> Result<NativeR2CredentialStatus, NativeR2Error> {
        let available = keyring_entry(&credential_ref)?.get_secret().is_ok();
        Ok(NativeR2CredentialStatus {
            credential_ref,
            available,
        })
    }

    pub fn delete_credential(credential_ref: String) -> Result<(), NativeR2Error> {
        let entry = keyring_entry(&credential_ref)?;
        match entry.delete_credential() {
            Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
            Err(_) => Err(NativeR2Error::new(
                "E_R2_VAULT_DELETE",
                "R2 credential could not be removed from the operating-system vault.",
                false,
                None,
            )),
        }
    }

    fn load_credential(credential_ref: &str) -> Result<StoredR2Credential, NativeR2Error> {
        let payload = keyring_entry(credential_ref)?.get_secret().map_err(|_| {
            NativeR2Error::new(
                "E_R2_CREDENTIAL_MISSING",
                "The selected R2 credential is unavailable.",
                false,
                None,
            )
        })?;
        serde_json::from_slice(&payload).map_err(|_| {
            NativeR2Error::new(
                "E_R2_CREDENTIAL_INVALID",
                "The selected R2 credential could not be decoded.",
                false,
                None,
            )
        })
    }

    fn endpoint(profile: &NativeR2Profile) -> Result<String, NativeR2Error> {
        let endpoint = if let Some(endpoint) = profile
            .endpoint
            .as_ref()
            .filter(|value| !value.trim().is_empty())
        {
            endpoint.trim_end_matches('/').to_string()
        } else {
            let jurisdiction = profile
                .jurisdiction
                .as_deref()
                .filter(|value| !value.trim().is_empty())
                .map(|value| format!(".{value}"))
                .unwrap_or_default();
            format!(
                "https://{}{}.r2.cloudflarestorage.com",
                profile.account_id, jurisdiction
            )
        };
        let lower = endpoint.to_ascii_lowercase();
        let secure = lower.starts_with("https://");
        let test_loopback =
            lower.starts_with("http://127.0.0.1:") || lower.starts_with("http://localhost:");
        if (!secure && !test_loopback) || profile.bucket.trim().is_empty() {
            return Err(NativeR2Error::new(
                "E_R2_INVALID_PROFILE",
                "R2 endpoint or bucket is invalid.",
                false,
                None,
            ));
        }
        Ok(endpoint)
    }

    fn client_from_credential(
        profile: &NativeR2Profile,
        credential: StoredR2Credential,
    ) -> Result<Client, NativeR2Error> {
        let config = aws_sdk_s3::config::Builder::new()
            .behavior_version(BehaviorVersion::latest())
            .region(Region::new("auto"))
            .credentials_provider(Credentials::new(
                credential.access_key_id,
                credential.secret_access_key,
                None,
                None,
                "nai-blue-native-r2-vault",
            ))
            .endpoint_url(endpoint(profile)?)
            .force_path_style(true)
            .build();
        Ok(Client::from_conf(config))
    }

    fn client(profile: &NativeR2Profile) -> Result<Client, NativeR2Error> {
        client_from_credential(profile, load_credential(&profile.credential_ref)?)
    }

    fn classify_sdk_error<E>(error: &aws_sdk_s3::error::SdkError<E>) -> NativeR2Error
    where
        E: ProvideErrorMetadata,
    {
        // Do not format the raw SDK response here: it can contain a signed URI
        // or echoed request fields. Provider error codes are the stable,
        // redaction-safe classification boundary across SDK response versions.
        let status = error
            .raw_response()
            .map(|response| response.status().as_u16());
        let provider_code = error.as_service_error().and_then(|service| service.code());
        if matches!(
            provider_code,
            Some("RequestTimeTooSkewed" | "RequestExpired" | "RequestInTheFuture")
        ) {
            return NativeR2Error::new(
                "E_R2_CLOCK_SKEW",
                "The system clock is too far from the R2 service clock.",
                false,
                status,
            );
        }
        if status == Some(412)
            || matches!(
                provider_code,
                Some("PreconditionFailed" | "ConditionalRequestConflict")
            )
        {
            return NativeR2Error::new(
                "E_R2_CONFLICT",
                "The remote object already exists and the selected conflict policy prevented replacement.",
                false,
                status,
            );
        }
        if status == Some(403)
            || matches!(
                provider_code,
                Some("AccessDenied" | "InvalidAccessKeyId" | "SignatureDoesNotMatch")
            )
        {
            return NativeR2Error::new(
                "E_R2_AUTH",
                "R2 rejected the credential or request signature.",
                false,
                status,
            );
        }
        if status == Some(404)
            || matches!(
                provider_code,
                Some("NoSuchBucket" | "NoSuchKey" | "NotFound")
            )
        {
            return NativeR2Error::new(
                "E_R2_NOT_FOUND",
                "The requested R2 bucket or object was not found.",
                false,
                status,
            );
        }
        NativeR2Error::new(
            "E_R2_TRANSPORT",
            "The native R2 request did not complete.",
            true,
            status,
        )
    }

    async fn head_with_client(
        client: &Client,
        profile: &NativeR2Profile,
        remote_key: &str,
    ) -> Result<NativeR2HeadResult, NativeR2Error> {
        match client
            .head_object()
            .bucket(&profile.bucket)
            .key(remote_key)
            .send()
            .await
        {
            Ok(output) => Ok(NativeR2HeadResult {
                exists: true,
                size: output.content_length(),
                content_sha256: output
                    .metadata()
                    .and_then(|metadata| metadata.get(R2_HASH_METADATA_KEY))
                    .cloned(),
                etag: output.e_tag().map(str::to_string),
            }),
            Err(error) => {
                let classified = classify_sdk_error(&error);
                if classified.code == "E_R2_NOT_FOUND" {
                    Ok(NativeR2HeadResult {
                        exists: false,
                        size: None,
                        content_sha256: None,
                        etag: None,
                    })
                } else {
                    Err(classified)
                }
            }
        }
    }

    pub async fn test_connection(
        profile: NativeR2Profile,
    ) -> Result<NativeR2ConnectionResult, NativeR2Error> {
        let client = client(&profile)?;
        client
            .head_bucket()
            .bucket(&profile.bucket)
            .send()
            .await
            .map_err(|error| classify_sdk_error(&error))?;
        Ok(NativeR2ConnectionResult { ok: true })
    }

    pub async fn test_temporary_object(
        profile: NativeR2Profile,
    ) -> Result<NativeR2TemporaryObjectResult, NativeR2Error> {
        let client = client(&profile)?;
        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|duration| duration.as_nanos())
            .unwrap_or_default();
        let key = prefixed_key(
            &profile.prefix,
            &format!(".nai-blue-connection-test/{nonce:x}"),
        )?;
        client
            .put_object()
            .bucket(&profile.bucket)
            .key(&key)
            .if_none_match("*")
            .body(ByteStream::from_static(b"nai-blue-r2-probe"))
            .metadata(R2_HASH_METADATA_KEY, "probe")
            .send()
            .await
            .map_err(|error| classify_sdk_error(&error))?;
        let head = head_with_client(&client, &profile, &key).await?;
        client
            .delete_object()
            .bucket(&profile.bucket)
            .key(&key)
            .send()
            .await
            .map_err(|error| classify_sdk_error(&error))?;
        if !head.exists {
            return Err(NativeR2Error::new(
                "E_R2_PROBE_CLEANUP",
                "The temporary R2 object test did not complete safely.",
                false,
                None,
            ));
        }
        Ok(NativeR2TemporaryObjectResult {
            put: true,
            head: true,
            deleted: true,
        })
    }

    pub async fn head_object(
        profile: NativeR2Profile,
        remote_key: String,
    ) -> Result<NativeR2HeadResult, NativeR2Error> {
        let client = client(&profile)?;
        head_with_client(&client, &profile, &normalize_key(&remote_key)?).await
    }

    pub async fn put_object(
        profile: NativeR2Profile,
        local_path: String,
        remote_key: String,
        content_size: u64,
        content_sha256: String,
        content_type: String,
    ) -> Result<NativeR2PutResult, NativeR2Error> {
        let local_path = PathBuf::from(local_path);
        let bytes =
            verified_upload_bytes(&local_path, content_size, &content_sha256, 0, content_size)?;
        let client = client(&profile)?;
        let original_key = normalize_key(&remote_key)?;
        let mut effective_key = original_key.clone();

        if profile.conflict_policy != NativeR2ConflictPolicy::Overwrite {
            let existing = head_with_client(&client, &profile, &effective_key).await?;
            if existing.exists {
                if profile.conflict_policy == NativeR2ConflictPolicy::SkipSame
                    && existing.content_sha256.as_deref() == Some(content_sha256.as_str())
                {
                    return Ok(NativeR2PutResult {
                        remote_key: effective_key,
                        uploaded: false,
                        skipped_same: true,
                        etag: existing.etag,
                    });
                }
                if profile.conflict_policy == NativeR2ConflictPolicy::Suffix {
                    effective_key = deterministic_suffix_key(&effective_key, &content_sha256);
                    let suffixed = head_with_client(&client, &profile, &effective_key).await?;
                    if suffixed.exists
                        && suffixed.content_sha256.as_deref() == Some(content_sha256.as_str())
                    {
                        return Ok(NativeR2PutResult {
                            remote_key: effective_key,
                            uploaded: false,
                            skipped_same: true,
                            etag: suffixed.etag,
                        });
                    }
                    if suffixed.exists {
                        return Err(NativeR2Error::new(
                            "E_R2_CONFLICT",
                            "The deterministic suffix target already exists with different content.",
                            false,
                            Some(412),
                        ));
                    }
                } else {
                    return Err(NativeR2Error::new(
                        "E_R2_CONFLICT",
                        "The remote object already exists and was not replaced.",
                        false,
                        Some(412),
                    ));
                }
            }
        }

        let body = ByteStream::from(bytes);
        let mut request = client
            .put_object()
            .bucket(&profile.bucket)
            .key(&effective_key)
            .content_type(content_type)
            .metadata(R2_HASH_METADATA_KEY, content_sha256)
            .body(body);
        if profile.conflict_policy != NativeR2ConflictPolicy::Overwrite {
            request = request.if_none_match("*");
        }
        let output = request
            .send()
            .await
            .map_err(|error| classify_sdk_error(&error))?;
        Ok(NativeR2PutResult {
            remote_key: effective_key,
            uploaded: true,
            skipped_same: false,
            etag: output.e_tag().map(str::to_string),
        })
    }

    pub async fn create_multipart(
        profile: NativeR2Profile,
        local_path: String,
        remote_key: String,
        content_size: u64,
        content_sha256: String,
        content_type: String,
    ) -> Result<NativeR2MultipartStartResult, NativeR2Error> {
        validate_upload_file(Path::new(&local_path), content_size, &content_sha256)?;
        let client = client(&profile)?;
        let mut effective_key = normalize_key(&remote_key)?;
        if profile.conflict_policy != NativeR2ConflictPolicy::Overwrite {
            let existing = head_with_client(&client, &profile, &effective_key).await?;
            if existing.exists {
                if profile.conflict_policy == NativeR2ConflictPolicy::SkipSame
                    && existing.content_sha256.as_deref() == Some(content_sha256.as_str())
                {
                    return Err(NativeR2Error::new(
                        "E_R2_ALREADY_COMPLETE",
                        "The same remote object is already complete.",
                        false,
                        None,
                    ));
                }
                if profile.conflict_policy == NativeR2ConflictPolicy::Suffix {
                    effective_key = deterministic_suffix_key(&effective_key, &content_sha256);
                    if head_with_client(&client, &profile, &effective_key)
                        .await?
                        .exists
                    {
                        return Err(NativeR2Error::new(
                            "E_R2_CONFLICT",
                            "The deterministic suffix target already exists.",
                            false,
                            Some(412),
                        ));
                    }
                } else {
                    return Err(NativeR2Error::new(
                        "E_R2_CONFLICT",
                        "The remote object already exists and was not replaced.",
                        false,
                        Some(412),
                    ));
                }
            }
        }
        let output = client
            .create_multipart_upload()
            .bucket(&profile.bucket)
            .key(&effective_key)
            .content_type(content_type)
            .metadata(R2_HASH_METADATA_KEY, content_sha256)
            .send()
            .await
            .map_err(|error| classify_sdk_error(&error))?;
        let upload_id = output.upload_id().ok_or_else(|| {
            NativeR2Error::new(
                "E_R2_MULTIPART",
                "R2 did not return a multipart upload identifier.",
                true,
                None,
            )
        })?;
        Ok(NativeR2MultipartStartResult {
            remote_key: effective_key,
            upload_id: upload_id.to_string(),
        })
    }

    #[allow(clippy::too_many_arguments)]
    pub async fn upload_part(
        profile: NativeR2Profile,
        local_path: String,
        content_size: u64,
        content_sha256: String,
        remote_key: String,
        upload_id: String,
        part_number: i32,
        offset: u64,
        length: u64,
    ) -> Result<NativeR2CompletedPart, NativeR2Error> {
        if !(1..=10_000).contains(&part_number) || length == 0 {
            return Err(NativeR2Error::new(
                "E_R2_MULTIPART",
                "Multipart part bounds are invalid.",
                false,
                None,
            ));
        }
        let bytes = verified_upload_bytes(
            Path::new(&local_path),
            content_size,
            &content_sha256,
            offset,
            length,
        )?;
        let client = client(&profile)?;
        let body = ByteStream::from(bytes);
        let output = client
            .upload_part()
            .bucket(&profile.bucket)
            .key(normalize_key(&remote_key)?)
            .upload_id(upload_id)
            .part_number(part_number)
            .body(body)
            .send()
            .await
            .map_err(|error| classify_sdk_error(&error))?;
        let etag = output.e_tag().ok_or_else(|| {
            NativeR2Error::new(
                "E_R2_MULTIPART",
                "R2 did not return a multipart part ETag.",
                true,
                None,
            )
        })?;
        Ok(NativeR2CompletedPart {
            part_number,
            etag: etag.to_string(),
            size: length,
        })
    }

    pub async fn complete_multipart(
        profile: NativeR2Profile,
        remote_key: String,
        upload_id: String,
        content_sha256: String,
        completed_parts: Vec<NativeR2CompletedPart>,
    ) -> Result<NativeR2PutResult, NativeR2Error> {
        let client = client(&profile)?;
        let key = normalize_key(&remote_key)?;
        let parts = completed_parts
            .iter()
            .map(|part| {
                CompletedPart::builder()
                    .part_number(part.part_number)
                    .e_tag(&part.etag)
                    .build()
            })
            .collect::<Vec<_>>();
        let body = CompletedMultipartUpload::builder()
            .set_parts(Some(parts))
            .build();
        let mut request = client
            .complete_multipart_upload()
            .bucket(&profile.bucket)
            .key(&key)
            .upload_id(&upload_id)
            .multipart_upload(body);
        if profile.conflict_policy != NativeR2ConflictPolicy::Overwrite {
            request = request.if_none_match("*");
        }
        match request.send().await {
            Ok(output) => Ok(NativeR2PutResult {
                remote_key: key,
                uploaded: true,
                skipped_same: false,
                etag: output.e_tag().map(str::to_string),
            }),
            Err(error) => {
                let classified = classify_sdk_error(&error);
                if classified.code == "E_R2_CONFLICT" {
                    client
                        .abort_multipart_upload()
                        .bucket(&profile.bucket)
                        .key(&key)
                        .upload_id(&upload_id)
                        .send()
                        .await
                        .map_err(|_| {
                            NativeR2Error::new(
                                "E_R2_MULTIPART_CLEANUP",
                                "The conflicting multipart upload could not be cleaned up.",
                                true,
                                None,
                            )
                        })?;
                } else if classified.code == "E_R2_NOT_FOUND" {
                    let existing = head_with_client(&client, &profile, &key).await?;
                    if existing.exists
                        && existing.content_sha256.as_deref() == Some(content_sha256.as_str())
                    {
                        return Err(NativeR2Error::new(
                            "E_R2_ALREADY_COMPLETE",
                            "The same remote object is already complete.",
                            false,
                            None,
                        ));
                    }
                }
                Err(classified)
            }
        }
    }

    pub async fn abort_multipart(
        profile: NativeR2Profile,
        remote_key: String,
        upload_id: String,
    ) -> Result<(), NativeR2Error> {
        client(&profile)?
            .abort_multipart_upload()
            .bucket(&profile.bucket)
            .key(normalize_key(&remote_key)?)
            .upload_id(upload_id)
            .send()
            .await
            .map_err(|error| classify_sdk_error(&error))?;
        Ok(())
    }

    #[cfg(test)]
    pub(super) fn test_client(
        endpoint: String,
        access_key_id: String,
        secret_access_key: String,
    ) -> Result<Client, NativeR2Error> {
        client_from_credential(
            &NativeR2Profile {
                account_id: "fixture".to_string(),
                jurisdiction: None,
                endpoint: Some(endpoint),
                bucket: "fixture-bucket".to_string(),
                prefix: String::new(),
                credential_ref: "fixture".to_string(),
                conflict_policy: NativeR2ConflictPolicy::Fail,
            },
            StoredR2Credential {
                access_key_id,
                secret_access_key,
            },
        )
    }

    #[cfg(test)]
    mod tests {
        use super::*;
        use std::sync::{Arc, Mutex};
        use tokio::io::{AsyncReadExt, AsyncWriteExt};
        use tokio::net::TcpListener;

        fn response(status: &str, body: &str, extra_headers: &str) -> String {
            format!(
                "HTTP/1.1 {status}\r\nContent-Type: application/xml\r\nContent-Length: {}\r\nConnection: close\r\n{extra_headers}\r\n{body}",
                body.len()
            )
        }

        async fn scripted_server(
            responses: Vec<String>,
        ) -> (String, Arc<Mutex<Vec<String>>>, tokio::task::JoinHandle<()>) {
            let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
            let endpoint = format!("http://{}", listener.local_addr().unwrap());
            let requests = Arc::new(Mutex::new(Vec::new()));
            let captured = Arc::clone(&requests);
            let handle = tokio::spawn(async move {
                for response in responses {
                    let (mut socket, _) = listener.accept().await.unwrap();
                    let mut bytes = Vec::new();
                    let mut buffer = [0_u8; 8192];
                    loop {
                        let read = socket.read(&mut buffer).await.unwrap();
                        if read == 0 {
                            break;
                        }
                        bytes.extend_from_slice(&buffer[..read]);
                        if bytes.windows(4).any(|window| window == b"\r\n\r\n") {
                            break;
                        }
                    }
                    let header = String::from_utf8_lossy(&bytes).to_string();
                    captured.lock().unwrap().push(header);
                    socket.write_all(response.as_bytes()).await.unwrap();
                    socket.shutdown().await.unwrap();
                }
            });
            (endpoint, requests, handle)
        }

        fn client(endpoint: String) -> Client {
            test_client(
                endpoint,
                "fixture-access-key".to_string(),
                "fixture-secret-key-never-log".to_string(),
            )
            .unwrap()
        }

        #[tokio::test]
        async fn fake_r2_receives_sdk_sigv4_without_exposing_it_in_results() {
            let (endpoint, requests, server) =
                scripted_server(vec![response("200 OK", "", "")]).await;
            client(endpoint)
                .head_bucket()
                .bucket("fixture-bucket")
                .send()
                .await
                .unwrap();
            server.await.unwrap();
            let request = &requests.lock().unwrap()[0];
            assert!(request
                .to_ascii_lowercase()
                .contains("authorization: aws4-hmac-sha256"));
            assert!(request.to_ascii_lowercase().contains("x-amz-date:"));
        }

        #[tokio::test]
        async fn fake_r2_classifies_signature_and_clock_skew_without_provider_body() {
            for (code, expected) in [
                ("SignatureDoesNotMatch", "E_R2_AUTH"),
                ("RequestTimeTooSkewed", "E_R2_CLOCK_SKEW"),
            ] {
                let body =
                    format!("<Error><Code>{code}</Code><Message>fixture detail</Message></Error>");
                let (endpoint, _requests, server) =
                    scripted_server(vec![response("403 Forbidden", &body, "")]).await;
                let error = client(endpoint)
                    .get_object()
                    .bucket("fixture-bucket")
                    .key("fixture.png")
                    .send()
                    .await
                    .unwrap_err();
                let classified = classify_sdk_error(&error);
                assert_eq!(classified.code, expected);
                assert!(!classified.message.contains("fixture detail"));
                server.await.unwrap();
            }
        }

        #[tokio::test]
        async fn fake_r2_404_is_a_missing_head_not_a_transport_fallback() {
            let body = "<Error><Code>NoSuchKey</Code><Message>missing</Message></Error>";
            let (endpoint, _requests, server) =
                scripted_server(vec![response("404 Not Found", body, "")]).await;
            let profile = NativeR2Profile {
                account_id: "fixture".to_string(),
                jurisdiction: None,
                endpoint: None,
                bucket: "fixture-bucket".to_string(),
                prefix: String::new(),
                credential_ref: "fixture".to_string(),
                conflict_policy: NativeR2ConflictPolicy::Fail,
            };
            let result = head_with_client(&client(endpoint), &profile, "missing.png")
                .await
                .unwrap();
            assert!(!result.exists);
            server.await.unwrap();
        }

        #[tokio::test]
        async fn conditional_put_conflict_never_retries_as_overwrite() {
            let body = "<Error><Code>PreconditionFailed</Code><Message>exists</Message></Error>";
            let (endpoint, requests, server) =
                scripted_server(vec![response("412 Precondition Failed", body, "")]).await;
            let error = client(endpoint)
                .put_object()
                .bucket("fixture-bucket")
                .key("existing.png")
                .if_none_match("*")
                .body(ByteStream::from_static(b"fixture"))
                .send()
                .await
                .unwrap_err();
            assert_eq!(classify_sdk_error(&error).code, "E_R2_CONFLICT");
            server.await.unwrap();
            let headers = requests.lock().unwrap()[0].to_ascii_lowercase();
            assert!(headers.contains("if-none-match: *"));
            assert_eq!(requests.lock().unwrap().len(), 1);
        }

        #[tokio::test]
        async fn integrity_mismatch_stops_put_and_multipart_before_r2() {
            let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
            let endpoint = format!("http://{}", listener.local_addr().unwrap());
            let path = std::env::temp_dir().join(format!(
                "nai-blue-r2-integrity-network-{}",
                std::process::id()
            ));
            std::fs::write(&path, b"tampered bytes").unwrap();
            let profile = NativeR2Profile {
                account_id: "fixture".to_string(),
                jurisdiction: None,
                endpoint: Some(endpoint),
                bucket: "fixture-bucket".to_string(),
                prefix: String::new(),
                credential_ref: "fixture".to_string(),
                conflict_policy: NativeR2ConflictPolicy::Fail,
            };
            let expected_sha256 = format!("sha256:{:x}", Sha256::digest(b"original bytes"));

            let put_error = put_object(
                profile.clone(),
                path.to_string_lossy().into_owned(),
                "artifact.bin".to_string(),
                b"original bytes".len() as u64,
                expected_sha256.clone(),
                "application/octet-stream".to_string(),
            )
            .await
            .unwrap_err();
            let multipart_error = create_multipart(
                profile.clone(),
                path.to_string_lossy().into_owned(),
                "artifact.bin".to_string(),
                b"original bytes".len() as u64,
                expected_sha256.clone(),
                "application/octet-stream".to_string(),
            )
            .await
            .unwrap_err();
            let resumed_part_error = upload_part(
                profile,
                path.to_string_lossy().into_owned(),
                b"original bytes".len() as u64,
                expected_sha256,
                "artifact.bin".to_string(),
                "existing-upload".to_string(),
                1,
                0,
                5,
            )
            .await
            .unwrap_err();

            assert_eq!(put_error.code, "E_R2_LOCAL_INTEGRITY");
            assert_eq!(multipart_error.code, "E_R2_LOCAL_INTEGRITY");
            assert_eq!(resumed_part_error.code, "E_R2_LOCAL_INTEGRITY");
            assert!(
                tokio::time::timeout(std::time::Duration::from_millis(50), listener.accept())
                    .await
                    .is_err()
            );
            std::fs::remove_file(path).unwrap();
        }

        #[tokio::test]
        async fn multipart_resume_reuses_upload_id_and_completed_part() {
            let create = "<InitiateMultipartUploadResult><Bucket>fixture-bucket</Bucket><Key>large.bin</Key><UploadId>upload-1</UploadId></InitiateMultipartUploadResult>";
            let complete = "<CompleteMultipartUploadResult><Bucket>fixture-bucket</Bucket><Key>large.bin</Key><ETag>complete</ETag></CompleteMultipartUploadResult>";
            let responses = vec![
                response("200 OK", create, ""),
                response("200 OK", "", "ETag: \"part-1\"\r\n"),
                response("200 OK", "", "ETag: \"part-2\"\r\n"),
                response("200 OK", complete, "ETag: \"complete\"\r\n"),
            ];
            let (endpoint, requests, server) = scripted_server(responses).await;
            let client = client(endpoint);
            let created = client
                .create_multipart_upload()
                .bucket("fixture-bucket")
                .key("large.bin")
                .send()
                .await
                .unwrap();
            let upload_id = created.upload_id().unwrap().to_string();
            let first = client
                .upload_part()
                .bucket("fixture-bucket")
                .key("large.bin")
                .upload_id(&upload_id)
                .part_number(1)
                .body(ByteStream::from_static(b"part-one"))
                .send()
                .await
                .unwrap();
            // A restarted coordinator persists this completed part and issues
            // only the missing part against the same upload identifier.
            let second = client
                .upload_part()
                .bucket("fixture-bucket")
                .key("large.bin")
                .upload_id(&upload_id)
                .part_number(2)
                .body(ByteStream::from_static(b"part-two"))
                .send()
                .await
                .unwrap();
            let completed = CompletedMultipartUpload::builder()
                .parts(
                    CompletedPart::builder()
                        .part_number(1)
                        .e_tag(first.e_tag().unwrap())
                        .build(),
                )
                .parts(
                    CompletedPart::builder()
                        .part_number(2)
                        .e_tag(second.e_tag().unwrap())
                        .build(),
                )
                .build();
            client
                .complete_multipart_upload()
                .bucket("fixture-bucket")
                .key("large.bin")
                .upload_id(&upload_id)
                .if_none_match("*")
                .multipart_upload(completed)
                .send()
                .await
                .unwrap();
            server.await.unwrap();

            let requests = requests.lock().unwrap();
            assert_eq!(
                requests
                    .iter()
                    .filter(|request| request.starts_with("POST /fixture-bucket/large.bin?uploads"))
                    .count(),
                1
            );
            assert_eq!(
                requests
                    .iter()
                    .filter(|request| request.contains("partNumber=1"))
                    .count(),
                1
            );
            assert_eq!(
                requests
                    .iter()
                    .filter(|request| request.contains("partNumber=2"))
                    .count(),
                1
            );
            assert!(requests
                .last()
                .unwrap()
                .to_ascii_lowercase()
                .contains("if-none-match: *"));
        }
    }
}

#[tauri::command]
pub async fn r2_store_credential(
    request: StoreR2CredentialRequest,
) -> Result<NativeR2CredentialStatus, NativeR2Error> {
    #[cfg(any(target_os = "windows", target_os = "linux", target_os = "macos"))]
    {
        return desktop::store_credential(request);
    }
    #[cfg(not(any(target_os = "windows", target_os = "linux", target_os = "macos")))]
    {
        let _ = request;
        Err(NativeR2Error::unsupported())
    }
}

#[tauri::command]
pub async fn r2_credential_status(
    credential_ref: String,
) -> Result<NativeR2CredentialStatus, NativeR2Error> {
    #[cfg(any(target_os = "windows", target_os = "linux", target_os = "macos"))]
    {
        return desktop::credential_status(credential_ref);
    }
    #[cfg(not(any(target_os = "windows", target_os = "linux", target_os = "macos")))]
    {
        let _ = credential_ref;
        Err(NativeR2Error::unsupported())
    }
}

#[tauri::command]
pub async fn r2_delete_credential(credential_ref: String) -> Result<(), NativeR2Error> {
    #[cfg(any(target_os = "windows", target_os = "linux", target_os = "macos"))]
    {
        return desktop::delete_credential(credential_ref);
    }
    #[cfg(not(any(target_os = "windows", target_os = "linux", target_os = "macos")))]
    {
        let _ = credential_ref;
        Err(NativeR2Error::unsupported())
    }
}

#[tauri::command]
pub async fn r2_test_connection(
    profile: NativeR2Profile,
) -> Result<NativeR2ConnectionResult, NativeR2Error> {
    #[cfg(any(target_os = "windows", target_os = "linux", target_os = "macos"))]
    {
        return desktop::test_connection(profile).await;
    }
    #[cfg(not(any(target_os = "windows", target_os = "linux", target_os = "macos")))]
    {
        let _ = profile;
        Err(NativeR2Error::unsupported())
    }
}

#[tauri::command]
pub async fn r2_test_temporary_object(
    profile: NativeR2Profile,
) -> Result<NativeR2TemporaryObjectResult, NativeR2Error> {
    #[cfg(any(target_os = "windows", target_os = "linux", target_os = "macos"))]
    {
        return desktop::test_temporary_object(profile).await;
    }
    #[cfg(not(any(target_os = "windows", target_os = "linux", target_os = "macos")))]
    {
        let _ = profile;
        Err(NativeR2Error::unsupported())
    }
}

#[tauri::command]
pub async fn r2_head_object(
    profile: NativeR2Profile,
    remote_key: String,
) -> Result<NativeR2HeadResult, NativeR2Error> {
    #[cfg(any(target_os = "windows", target_os = "linux", target_os = "macos"))]
    {
        return desktop::head_object(profile, remote_key).await;
    }
    #[cfg(not(any(target_os = "windows", target_os = "linux", target_os = "macos")))]
    {
        let _ = (profile, remote_key);
        Err(NativeR2Error::unsupported())
    }
}

#[tauri::command]
pub async fn r2_put_object(
    profile: NativeR2Profile,
    local_path: String,
    remote_key: String,
    content_size: u64,
    content_sha256: String,
    content_type: String,
) -> Result<NativeR2PutResult, NativeR2Error> {
    #[cfg(any(target_os = "windows", target_os = "linux", target_os = "macos"))]
    {
        return desktop::put_object(
            profile,
            local_path,
            remote_key,
            content_size,
            content_sha256,
            content_type,
        )
        .await;
    }
    #[cfg(not(any(target_os = "windows", target_os = "linux", target_os = "macos")))]
    {
        let _ = (
            profile,
            local_path,
            remote_key,
            content_size,
            content_sha256,
            content_type,
        );
        Err(NativeR2Error::unsupported())
    }
}

#[tauri::command]
pub async fn r2_create_multipart(
    profile: NativeR2Profile,
    local_path: String,
    remote_key: String,
    content_size: u64,
    content_sha256: String,
    content_type: String,
) -> Result<NativeR2MultipartStartResult, NativeR2Error> {
    #[cfg(any(target_os = "windows", target_os = "linux", target_os = "macos"))]
    {
        return desktop::create_multipart(
            profile,
            local_path,
            remote_key,
            content_size,
            content_sha256,
            content_type,
        )
        .await;
    }
    #[cfg(not(any(target_os = "windows", target_os = "linux", target_os = "macos")))]
    {
        let _ = (
            profile,
            local_path,
            remote_key,
            content_size,
            content_sha256,
            content_type,
        );
        Err(NativeR2Error::unsupported())
    }
}

#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub async fn r2_upload_part(
    profile: NativeR2Profile,
    local_path: String,
    content_size: u64,
    content_sha256: String,
    remote_key: String,
    upload_id: String,
    part_number: i32,
    offset: u64,
    length: u64,
) -> Result<NativeR2CompletedPart, NativeR2Error> {
    #[cfg(any(target_os = "windows", target_os = "linux", target_os = "macos"))]
    {
        return desktop::upload_part(
            profile,
            local_path,
            content_size,
            content_sha256,
            remote_key,
            upload_id,
            part_number,
            offset,
            length,
        )
        .await;
    }
    #[cfg(not(any(target_os = "windows", target_os = "linux", target_os = "macos")))]
    {
        let _ = (
            profile,
            local_path,
            content_size,
            content_sha256,
            remote_key,
            upload_id,
            part_number,
            offset,
            length,
        );
        Err(NativeR2Error::unsupported())
    }
}

#[tauri::command]
pub async fn r2_complete_multipart(
    profile: NativeR2Profile,
    remote_key: String,
    upload_id: String,
    content_sha256: String,
    completed_parts: Vec<NativeR2CompletedPart>,
) -> Result<NativeR2PutResult, NativeR2Error> {
    #[cfg(any(target_os = "windows", target_os = "linux", target_os = "macos"))]
    {
        return desktop::complete_multipart(
            profile,
            remote_key,
            upload_id,
            content_sha256,
            completed_parts,
        )
        .await;
    }
    #[cfg(not(any(target_os = "windows", target_os = "linux", target_os = "macos")))]
    {
        let _ = (
            profile,
            remote_key,
            upload_id,
            content_sha256,
            completed_parts,
        );
        Err(NativeR2Error::unsupported())
    }
}

#[tauri::command]
pub async fn r2_abort_multipart(
    profile: NativeR2Profile,
    remote_key: String,
    upload_id: String,
) -> Result<(), NativeR2Error> {
    #[cfg(any(target_os = "windows", target_os = "linux", target_os = "macos"))]
    {
        return desktop::abort_multipart(profile, remote_key, upload_id).await;
    }
    #[cfg(not(any(target_os = "windows", target_os = "linux", target_os = "macos")))]
    {
        let _ = (profile, remote_key, upload_id);
        Err(NativeR2Error::unsupported())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    fn temporary_file(name: &str, bytes: &[u8]) -> PathBuf {
        let path = std::env::temp_dir().join(format!(
            "nai-blue-r2-integrity-{}-{name}",
            std::process::id()
        ));
        fs::write(&path, bytes).unwrap();
        path
    }

    fn sha256_identity(bytes: &[u8]) -> String {
        format!("sha256:{:x}", Sha256::digest(bytes))
    }

    #[test]
    fn deterministic_suffix_keeps_extension() {
        assert_eq!(
            deterministic_suffix_key("nested/image.png", "sha256:abcdef0123456789"),
            "nested/image-abcdef012345.png"
        );
    }

    #[test]
    fn normalized_keys_reject_parent_traversal() {
        assert!(normalize_key("../secret").is_err());
        assert_eq!(
            prefixed_key("exports/", "session/image.png").unwrap(),
            "exports/session/image.png"
        );
    }

    #[test]
    fn upload_integrity_accepts_the_queued_file_identity() {
        let bytes = b"queued artifact";
        let path = temporary_file("valid", bytes);
        assert!(validate_upload_file(&path, bytes.len() as u64, &sha256_identity(bytes)).is_ok());
        fs::remove_file(path).unwrap();
    }

    #[test]
    fn upload_integrity_rejects_same_size_mutation() {
        let queued = b"original bytes";
        let mutated = b"tampered bytes";
        assert_eq!(queued.len(), mutated.len());
        let path = temporary_file("same-size", mutated);
        let error =
            validate_upload_file(&path, queued.len() as u64, &sha256_identity(queued)).unwrap_err();
        assert_eq!(error.code, "E_R2_LOCAL_INTEGRITY");
        assert!(!error.retryable);
        fs::remove_file(path).unwrap();
    }

    #[test]
    fn upload_integrity_rejects_size_mismatch() {
        let bytes = b"short";
        let path = temporary_file("wrong-size", bytes);
        let error = validate_upload_file(&path, (bytes.len() + 1) as u64, &sha256_identity(bytes))
            .unwrap_err();
        assert_eq!(error.code, "E_R2_LOCAL_INTEGRITY");
        fs::remove_file(path).unwrap();
    }

    #[test]
    fn verified_body_keeps_validated_bytes_after_source_changes() {
        let original = b"queued artifact";
        let path = temporary_file("captured-body", original);
        let bytes = verified_upload_bytes(
            &path,
            original.len() as u64,
            &sha256_identity(original),
            0,
            original.len() as u64,
        )
        .unwrap();
        fs::write(&path, b"changed artifact").unwrap();
        assert_eq!(bytes, original);
        fs::remove_file(path).unwrap();
    }

    #[test]
    fn multipart_range_checks_the_entire_file_and_captures_exact_range() {
        let original = b"first-part|second-part";
        let path = temporary_file("captured-part", original);
        assert_eq!(
            verified_upload_bytes(
                &path,
                original.len() as u64,
                &sha256_identity(original),
                11,
                11,
            )
            .unwrap(),
            b"second-part"
        );
        // A change outside this part still invalidates the full queued identity.
        fs::write(&path, b"other-part|second-part").unwrap();
        assert_eq!(
            verified_upload_bytes(
                &path,
                original.len() as u64,
                &sha256_identity(original),
                11,
                11,
            )
            .unwrap_err()
            .code,
            "E_R2_LOCAL_INTEGRITY"
        );
        fs::remove_file(path).unwrap();
    }

    #[test]
    fn verified_body_rejects_invalid_ranges_before_opening_file() {
        let path = Path::new("nonexistent-upload-range-fixture");
        for (size, offset, length) in [
            (10, 9, 2),
            (u64::MAX, u64::MAX, 1),
            (u64::MAX, 0, 64 * 1024 * 1024 + 1),
        ] {
            assert_eq!(
                verified_upload_bytes(path, size, "invalid", offset, length)
                    .unwrap_err()
                    .code,
                "E_R2_LOCAL_INTEGRITY"
            );
        }
    }
}
