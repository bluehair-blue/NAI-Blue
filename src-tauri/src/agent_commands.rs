//! Phase 9 native inbox boundary. Only this module knows vault secrets and fixed
//! filesystem locations; the application dispatcher owns receipts and execution.
use serde::{Deserialize, Serialize};

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AgentClient {
    pub client_id: String,
    pub key_id: String,
    pub label: String,
    pub actor_kind: String,
    pub created_at: String,
    pub revoked_at: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentInitialization {
    available: bool,
    workspace_id: String,
    clients: Vec<AgentClient>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentIdentity {
    client_id: String,
    actor: AgentActor,
}

#[derive(Serialize)]
struct AgentActor {
    kind: String,
    id: String,
}

// Errors intentionally carry no rejected payload, credential, or native path.
type Result<T> = std::result::Result<T, String>;
fn fail(code: &str) -> String {
    code.to_owned()
}

#[cfg(target_os = "windows")]
mod native {
    use super::*;
    use hmac::{Hmac, Mac};
    use sha2::{Digest, Sha256};
    use std::{
        collections::HashMap,
        fs::{File, OpenOptions},
        io::{Read, Write},
        os::windows::{ffi::OsStrExt, fs::OpenOptionsExt, io::AsRawHandle},
        path::{Path, PathBuf},
        ptr,
        sync::{Mutex, OnceLock},
    };
    use tauri::Manager;
    use windows_sys::Win32::{
        Foundation::*,
        Security::{Authorization::*, *},
        Storage::FileSystem::*,
        System::Threading::*,
    };
    use zeroize::Zeroizing;

    #[cfg(not(test))]
    const SERVICE: &str = "blue.bluehair.naiblue.agent-commands";
    #[cfg(test)]
    const SERVICE: &str = "blue.bluehair.naiblue.agent-commands.test";
    const LIMIT: usize = 65_536;
    // TS bounds the public result, not its receipt wrapper. Bounded identifiers
    // and fixed receipt metadata fit within this separate 4 KiB headroom.
    const RECEIPT_LIMIT: usize = LIMIT + 4096;
    const CONTROL_LIMIT: usize = 1024 * 1024;

    #[derive(Serialize, Deserialize)]
    #[serde(rename_all = "camelCase", deny_unknown_fields)]
    struct Registry {
        schema_version: u8,
        workspace_id: String,
        clients: Vec<AgentClient>,
    }

    struct Owner {
        token: String,
        _lock: File,
        // Keep all directory components pinned until release/process exit.
        _directories: Vec<File>,
        read_tickets: HashMap<String, ReadTicket>,
    }
    enum ReadTicket {
        Digest([u8; 32]),
        // Oversized input is never allocated or hashed. Its exclusive handle
        // pins the exact file until rejection publication and retirement.
        Oversized(File),
    }
    #[derive(Default)]
    struct State {
        root: Option<PathBuf>,
        owner: Option<Owner>,
    }
    static STATE: OnceLock<Mutex<State>> = OnceLock::new();

    fn state() -> Result<std::sync::MutexGuard<'static, State>> {
        STATE
            .get_or_init(|| Mutex::new(State::default()))
            .lock()
            .map_err(|_| fail("AGENT_NATIVE_UNAVAILABLE"))
    }
    fn random_id(prefix: &str) -> Result<String> {
        let mut bytes = [0; 16];
        rustls::crypto::aws_lc_rs::default_provider()
            .secure_random
            .fill(&mut bytes)
            .map_err(|_| fail("AGENT_RANDOM_UNAVAILABLE"))?;
        Ok(format!("{prefix}{}", hex(&bytes)))
    }
    fn hex(bytes: &[u8]) -> String {
        bytes.iter().map(|byte| format!("{byte:02x}")).collect()
    }
    fn timestamp() -> Result<String> {
        time::OffsetDateTime::now_utc()
            .format(
                &time::format_description::parse_borrowed::<2>(
                    "[year]-[month]-[day]T[hour]:[minute]:[second].[subsecond digits:3]Z",
                )
                .map_err(|_| fail("AGENT_CLOCK_UNAVAILABLE"))?,
            )
            .map_err(|_| fail("AGENT_CLOCK_UNAVAILABLE"))
    }
    fn safe_id(id: &str) -> bool {
        let upper = id.to_ascii_uppercase();
        !id.is_empty()
            && id.len() <= 100
            && id
                .bytes()
                .all(|c| c.is_ascii_alphanumeric() || c == b'_' || c == b'-')
            && !matches!(upper.as_str(), "CON" | "PRN" | "AUX" | "NUL")
            && !(upper.len() == 4
                && (upper.starts_with("COM") || upper.starts_with("LPT"))
                && upper.as_bytes()[3].is_ascii_digit())
    }
    fn wide(path: &Path) -> Vec<u16> {
        path.as_os_str().encode_wide().chain(Some(0)).collect()
    }

    /// LocalAlloc descriptors own all SID/ACL pointers returned by Win32.
    struct LocalMemory(*mut std::ffi::c_void);
    impl Drop for LocalMemory {
        fn drop(&mut self) {
            unsafe {
                LocalFree(self.0);
            }
        }
    }
    struct UserSid {
        storage: Vec<usize>,
    }
    impl UserSid {
        fn get() -> Result<Self> {
            unsafe {
                let mut token = ptr::null_mut();
                if OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &mut token) == 0 {
                    return Err(fail("AGENT_ACL_UNAVAILABLE"));
                }
                let mut size = 0;
                GetTokenInformation(token, TokenUser, ptr::null_mut(), 0, &mut size);
                let mut storage =
                    vec![0usize; (size as usize).div_ceil(std::mem::size_of::<usize>())];
                let ok = GetTokenInformation(
                    token,
                    TokenUser,
                    storage.as_mut_ptr().cast(),
                    size,
                    &mut size,
                );
                CloseHandle(token);
                if ok == 0 {
                    return Err(fail("AGENT_ACL_UNAVAILABLE"));
                }
                Ok(Self { storage })
            }
        }
        fn ptr(&self) -> PSID {
            unsafe { (*(self.storage.as_ptr().cast::<TOKEN_USER>())).User.Sid }
        }
        fn descriptor(&self) -> Result<LocalMemory> {
            unsafe {
                let mut sid_text = ptr::null_mut();
                if ConvertSidToStringSidW(self.ptr(), &mut sid_text) == 0 {
                    return Err(fail("AGENT_ACL_UNAVAILABLE"));
                }
                let _sid_text = LocalMemory(sid_text.cast());
                let mut len = 0;
                while *sid_text.add(len) != 0 {
                    len += 1;
                }
                let sid = String::from_utf16(std::slice::from_raw_parts(sid_text, len))
                    .map_err(|_| fail("AGENT_ACL_UNAVAILABLE"))?;
                let sddl: Vec<u16> = format!("O:{sid}D:P(A;OICI;FA;;;{sid})(A;OICI;FA;;;SY)")
                    .encode_utf16()
                    .chain(Some(0))
                    .collect();
                let mut descriptor = ptr::null_mut();
                if ConvertStringSecurityDescriptorToSecurityDescriptorW(
                    sddl.as_ptr(),
                    1,
                    &mut descriptor,
                    ptr::null_mut(),
                ) == 0
                {
                    return Err(fail("AGENT_ACL_UNAVAILABLE"));
                }
                Ok(LocalMemory(descriptor))
            }
        }
    }

    /// Reject every reparse point and hard link, then check the ACL on the open
    /// object (not a race-prone second path lookup). Only user/SYSTEM can allow access.
    fn validate_handle(file: &File, directory: bool, private: bool, user: &UserSid) -> Result<()> {
        unsafe {
            let mut info: BY_HANDLE_FILE_INFORMATION = std::mem::zeroed();
            if GetFileInformationByHandle(file.as_raw_handle(), &mut info) == 0
                || info.dwFileAttributes & FILE_ATTRIBUTE_REPARSE_POINT != 0
                || (info.dwFileAttributes & FILE_ATTRIBUTE_DIRECTORY != 0) != directory
                || (!directory && info.nNumberOfLinks != 1)
            {
                return Err(fail("AGENT_UNSAFE_FILE"));
            }
            if !private {
                return Ok(());
            }
            let mut owner = ptr::null_mut();
            let mut dacl = ptr::null_mut();
            let mut descriptor = ptr::null_mut();
            if GetSecurityInfo(
                file.as_raw_handle(),
                SE_FILE_OBJECT,
                OWNER_SECURITY_INFORMATION | DACL_SECURITY_INFORMATION,
                &mut owner,
                ptr::null_mut(),
                &mut dacl,
                ptr::null_mut(),
                &mut descriptor,
            ) != 0
            {
                return Err(fail("AGENT_UNSAFE_ACL"));
            }
            let _descriptor = LocalMemory(descriptor);
            let mut control = 0;
            let mut revision = 0;
            if GetSecurityDescriptorControl(descriptor, &mut control, &mut revision) == 0
                || (directory && control & SE_DACL_PROTECTED == 0)
            {
                return Err(fail("AGENT_UNSAFE_ACL"));
            }
            if owner.is_null()
                || dacl.is_null()
                || EqualSid(owner, user.ptr()) == 0
                || (*dacl).AceCount == 0
            {
                return Err(fail("AGENT_UNSAFE_ACL"));
            }
            let mut user_allowed = false;
            for index in 0..(*dacl).AceCount {
                let mut ace = ptr::null_mut();
                if GetAce(dacl, index as u32, &mut ace) == 0 {
                    return Err(fail("AGENT_UNSAFE_ACL"));
                }
                let header = &*(ace.cast::<ACE_HEADER>());
                // ACCESS_ALLOWED_ACE_TYPE is 0; reject object/callback/unknown ACEs.
                if header.AceType != 0 {
                    return Err(fail("AGENT_UNSAFE_ACL"));
                }
                let allowed = &*(ace.cast::<ACCESS_ALLOWED_ACE>());
                let sid = ptr::addr_of!(allowed.SidStart).cast_mut().cast();
                let is_user = EqualSid(sid, user.ptr()) != 0;
                if !is_user && IsWellKnownSid(sid, WinLocalSystemSid) == 0 {
                    return Err(fail("AGENT_UNSAFE_ACL"));
                }
                user_allowed |= is_user && header.AceFlags & INHERIT_ONLY_ACE as u8 == 0;
            }
            if !user_allowed {
                return Err(fail("AGENT_UNSAFE_ACL"));
            }
            Ok(())
        }
    }

    fn directory(path: &Path, private: bool, user: &UserSid) -> Result<File> {
        let file = OpenOptions::new()
            .read(true)
            .access_mode(FILE_READ_ATTRIBUTES | READ_CONTROL)
            .share_mode(FILE_SHARE_READ | FILE_SHARE_WRITE)
            .custom_flags(FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OPEN_REPARSE_POINT)
            .open(path)
            .map_err(|_| fail("AGENT_UNSAFE_DIRECTORY"))?;
        validate_handle(&file, true, private, user)?;
        Ok(file)
    }
    fn private_directory(path: &Path, user: &UserSid) -> Result<File> {
        if !path
            .try_exists()
            .map_err(|_| fail("AGENT_UNSAFE_DIRECTORY"))?
        {
            let descriptor = user.descriptor()?;
            let attributes = SECURITY_ATTRIBUTES {
                nLength: std::mem::size_of::<SECURITY_ATTRIBUTES>() as u32,
                lpSecurityDescriptor: descriptor.0,
                bInheritHandle: 0,
            };
            unsafe {
                if CreateDirectoryW(wide(path).as_ptr(), &attributes) == 0
                    && GetLastError() != ERROR_ALREADY_EXISTS
                {
                    return Err(fail("AGENT_DIRECTORY_CREATE_FAILED"));
                }
            }
        }
        directory(path, true, user)
    }
    fn pin_ancestors(path: &Path, user: &UserSid) -> Result<Vec<File>> {
        let mut ancestors: Vec<_> = path.ancestors().collect();
        ancestors.reverse();
        let mut handles = Vec::new();
        // Parent handles deny delete-sharing, so junction replacement cannot move
        // a checked directory out from under subsequent child opens.
        for ancestor in ancestors {
            handles.push(directory(ancestor, false, user)?);
        }
        Ok(handles)
    }
    fn layout(root: &Path, user: &UserSid) -> Result<Vec<File>> {
        let parent = root
            .parent()
            .ok_or_else(|| fail("AGENT_UNSAFE_DIRECTORY"))?;
        let mut handles = pin_ancestors(parent, user)?;
        handles.push(private_directory(root, user)?);
        for name in ["control", "inbox", "results", "rejections"] {
            handles.push(private_directory(&root.join(name), user)?);
        }
        Ok(handles)
    }
    fn open_private(path: &Path, write: bool, create: bool, user: &UserSid) -> Result<File> {
        let file = OpenOptions::new()
            .read(true)
            .write(write)
            .create(create)
            .share_mode(0)
            .custom_flags(FILE_FLAG_OPEN_REPARSE_POINT)
            .open(path)
            .map_err(|_| fail("AGENT_FILE_UNAVAILABLE"))?;
        validate_handle(&file, false, true, user)?;
        Ok(file)
    }
    fn read_bounded(mut file: &File, max: usize) -> Result<Vec<u8>> {
        if file
            .metadata()
            .map_err(|_| fail("AGENT_FILE_UNAVAILABLE"))?
            .len()
            > max as u64
        {
            return Err(fail("E_AGENT_REQUEST_TOO_LARGE"));
        }
        let mut bytes = Vec::new();
        (&mut file)
            .take(max as u64 + 1)
            .read_to_end(&mut bytes)
            .map_err(|_| fail("AGENT_FILE_UNAVAILABLE"))?;
        if bytes.len() > max {
            return Err(fail("E_AGENT_REQUEST_TOO_LARGE"));
        }
        Ok(bytes)
    }
    fn atomic_write(path: &Path, bytes: &[u8], replace: bool, user: &UserSid) -> Result<()> {
        if path
            .try_exists()
            .map_err(|_| fail("AGENT_FILE_UNAVAILABLE"))?
        {
            let existing = open_private(path, false, false, user)?;
            if !replace {
                return if read_bounded(&existing, CONTROL_LIMIT)? == bytes {
                    Ok(())
                } else {
                    Err(fail("AGENT_EVIDENCE_CONFLICT"))
                };
            }
        }
        let temp = path.with_file_name(format!("{}.tmp", random_id("write-")?));
        let mut file = OpenOptions::new()
            .read(true)
            .write(true)
            .access_mode(FILE_GENERIC_READ | FILE_GENERIC_WRITE | DELETE)
            .create_new(true)
            .share_mode(0)
            .custom_flags(FILE_FLAG_OPEN_REPARSE_POINT)
            .open(&temp)
            .map_err(|_| fail("AGENT_WRITE_FAILED"))?;
        let result = (|| {
            validate_handle(&file, false, true, user)?;
            file.write_all(bytes)
                .and_then(|_| file.sync_all())
                .map_err(|_| fail("AGENT_WRITE_FAILED"))?;
            // Rename the still-exclusive source handle, so a producer cannot
            // replace the temporary name between validation and publication.
            let name: Vec<u16> = path.as_os_str().encode_wide().collect();
            // Win32's DOS-path conversion also consumes a trailing NUL even
            // though FileNameLength excludes it; keep that storage explicit.
            let size = std::mem::offset_of!(FILE_RENAME_INFO, FileName) + (name.len() + 1) * 2;
            let mut storage = vec![0usize; size.div_ceil(std::mem::size_of::<usize>())];
            unsafe {
                let rename = storage.as_mut_ptr().cast::<FILE_RENAME_INFO>();
                (*rename).Anonymous.ReplaceIfExists = replace;
                (*rename).FileNameLength = (name.len() * 2) as u32;
                ptr::copy_nonoverlapping(
                    name.as_ptr(),
                    ptr::addr_of_mut!((*rename).FileName).cast(),
                    name.len(),
                );
                if SetFileInformationByHandle(
                    file.as_raw_handle(),
                    FileRenameInfo,
                    rename.cast(),
                    size as u32,
                ) == 0
                {
                    return Err(fail("AGENT_WRITE_FAILED"));
                }
            }
            Ok(())
        })();
        if result.is_err() {
            let disposition = FILE_DISPOSITION_INFO { DeleteFile: true };
            unsafe {
                SetFileInformationByHandle(
                    file.as_raw_handle(),
                    FileDispositionInfo,
                    (&disposition as *const FILE_DISPOSITION_INFO).cast(),
                    std::mem::size_of::<FILE_DISPOSITION_INFO>() as u32,
                );
            }
        }
        result
    }
    fn registry(root: &Path, user: &UserSid) -> Result<Registry> {
        let path = root.join("control/clients.json");
        if !path
            .try_exists()
            .map_err(|_| fail("AGENT_CONTROL_UNAVAILABLE"))?
        {
            let registry = Registry {
                schema_version: 1,
                workspace_id: random_id("workspace-")?,
                clients: Vec::new(),
            };
            save_registry(root, &registry, user)?;
            return Ok(registry);
        }
        let file = open_private(&path, false, false, user)?;
        let registry: Registry = serde_json::from_slice(&read_bounded(&file, CONTROL_LIMIT)?)
            .map_err(|_| fail("AGENT_CONTROL_INVALID"))?;
        if registry.schema_version != 1
            || !safe_id(&registry.workspace_id)
            || registry.clients.len() > 1000
            || registry.clients.iter().any(|c| {
                !safe_id(&c.client_id)
                    || !safe_id(&c.key_id)
                    || !matches!(c.actor_kind.as_str(), "agent" | "service")
            })
        {
            return Err(fail("AGENT_CONTROL_INVALID"));
        }
        Ok(registry)
    }
    fn save_registry(root: &Path, registry: &Registry, user: &UserSid) -> Result<()> {
        let bytes = serde_json::to_vec(registry).map_err(|_| fail("AGENT_CONTROL_INVALID"))?;
        if bytes.len() > CONTROL_LIMIT {
            return Err(fail("AGENT_CLIENT_LIMIT"));
        }
        atomic_write(&root.join("control/clients.json"), &bytes, true, user)
    }
    fn entry(workspace: &str, client: &AgentClient) -> Result<keyring::Entry> {
        keyring::Entry::new(
            SERVICE,
            &format!("{workspace}:{}:{}", client.client_id, client.key_id),
        )
        .map_err(|_| fail("AGENT_VAULT_UNAVAILABLE"))
    }
    fn store_key(workspace: &str, client: &AgentClient) -> Result<()> {
        let mut secret = Zeroizing::new([0; 32]);
        rustls::crypto::aws_lc_rs::default_provider()
            .secure_random
            .fill(secret.as_mut())
            .map_err(|_| fail("AGENT_RANDOM_UNAVAILABLE"))?;
        entry(workspace, client)?
            .set_secret(secret.as_ref())
            .map_err(|_| fail("AGENT_VAULT_UNAVAILABLE"))
    }
    fn delete_key(workspace: &str, client: &AgentClient) -> Result<()> {
        match entry(workspace, client)?.delete_credential() {
            Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
            Err(_) => Err(fail("AGENT_VAULT_UNAVAILABLE")),
        }
    }

    pub fn initialize(app: tauri::AppHandle) -> Result<AgentInitialization> {
        let mut state = state()?;
        let app_data = app
            .path()
            .app_data_dir()
            .map_err(|_| fail("AGENT_NATIVE_UNAVAILABLE"))?;
        let user = UserSid::get()?;
        // Pin/check the OS app-data ancestors before even creating the app's
        // ordinary directory; never create recursively through a junction.
        let _app_parents = pin_ancestors(
            app_data
                .parent()
                .ok_or_else(|| fail("AGENT_NATIVE_UNAVAILABLE"))?,
            &user,
        )?;
        if !app_data
            .try_exists()
            .map_err(|_| fail("AGENT_NATIVE_UNAVAILABLE"))?
        {
            std::fs::create_dir(&app_data).map_err(|_| fail("AGENT_NATIVE_UNAVAILABLE"))?;
        }
        let root = app_data.join("agent-commands");
        let _directories = layout(&root, &user)?;
        let _control = open_private(&root.join("control/registry.lock"), true, true, &user)?;
        let registry = registry(&root, &user)?;
        state.root = Some(root);
        Ok(AgentInitialization {
            available: true,
            workspace_id: registry.workspace_id,
            clients: registry.clients,
        })
    }
    pub fn change_client(
        client_id: Option<String>,
        label: Option<String>,
        actor_kind: Option<String>,
        revoke: bool,
    ) -> Result<AgentClient> {
        let state = state()?;
        let root = state
            .root
            .as_ref()
            .ok_or_else(|| fail("AGENT_NOT_INITIALIZED"))?;
        let user = UserSid::get()?;
        let _directories = layout(root, &user)?;
        let _control = open_private(&root.join("control/registry.lock"), true, true, &user)?;
        let mut registry = registry(root, &user)?;
        if let Some(client_id) = client_id {
            let index = registry
                .clients
                .iter()
                .position(|client| client.client_id == client_id)
                .ok_or_else(|| fail("AGENT_CLIENT_UNKNOWN"))?;
            let old = registry.clients[index].clone();
            if old.revoked_at.is_some() && !revoke {
                return Err(fail("AGENT_CLIENT_REVOKED"));
            }
            let mut client = old.clone();
            if revoke {
                client.revoked_at = Some(timestamp()?);
            } else {
                client.key_id = random_id("key-")?;
                store_key(&registry.workspace_id, &client)?;
            }
            registry.clients[index] = client.clone();
            if let Err(error) = save_registry(root, &registry, &user) {
                if !revoke {
                    let _ = delete_key(&registry.workspace_id, &client);
                }
                return Err(error);
            }
            // Revocation/key replacement is already durable before old-vault cleanup.
            delete_key(&registry.workspace_id, &old)?;
            Ok(client)
        } else {
            let label = label.ok_or_else(|| fail("AGENT_CLIENT_INVALID"))?;
            let kind = actor_kind.ok_or_else(|| fail("AGENT_CLIENT_INVALID"))?;
            if label.trim().is_empty()
                || label.chars().count() > 100
                || label.chars().any(char::is_control)
                || !matches!(kind.as_str(), "agent" | "service")
            {
                return Err(fail("AGENT_CLIENT_INVALID"));
            }
            if registry.clients.len() >= 1000 {
                return Err(fail("AGENT_CLIENT_LIMIT"));
            }
            let client = AgentClient {
                client_id: random_id("client-")?,
                key_id: random_id("key-")?,
                label,
                actor_kind: kind,
                created_at: timestamp()?,
                revoked_at: None,
            };
            store_key(&registry.workspace_id, &client)?;
            registry.clients.push(client.clone());
            if let Err(error) = save_registry(root, &registry, &user) {
                let _ = delete_key(&registry.workspace_id, &client);
                return Err(error);
            }
            Ok(client)
        }
    }
    pub fn acquire_owner() -> Result<Option<String>> {
        let mut state = state()?;
        if state.owner.is_some() {
            return Ok(None);
        }
        let root = state
            .root
            .as_ref()
            .ok_or_else(|| fail("AGENT_NOT_INITIALIZED"))?;
        let user = UserSid::get()?;
        let directories = layout(root, &user)?;
        let lock = match OpenOptions::new()
            .read(true)
            .write(true)
            .create(true)
            .share_mode(0)
            .custom_flags(FILE_FLAG_OPEN_REPARSE_POINT)
            .open(root.join("control/owner.lock"))
        {
            Ok(file) => file,
            Err(error) if error.raw_os_error() == Some(ERROR_SHARING_VIOLATION as i32) => {
                return Ok(None)
            }
            Err(_) => return Err(fail("AGENT_OWNER_UNAVAILABLE")),
        };
        validate_handle(&lock, false, true, &user)?;
        let token = random_id("owner-")?;
        state.owner = Some(Owner {
            token: token.clone(),
            _lock: lock,
            _directories: directories,
            read_tickets: HashMap::new(),
        });
        Ok(Some(token))
    }
    fn authorized<'a>(state: &'a mut State, token: &str) -> Result<&'a mut Owner> {
        state
            .owner
            .as_mut()
            .filter(|owner| owner.token == token)
            .ok_or_else(|| fail("AGENT_OWNER_REQUIRED"))
    }
    pub fn release_owner(token: &str) -> Result<()> {
        let mut state = state()?;
        authorized(&mut state, token)?;
        state.owner = None;
        Ok(())
    }
    pub fn list_ready(token: &str) -> Result<Vec<String>> {
        let mut state = state()?;
        authorized(&mut state, token)?;
        let root = state
            .root
            .as_ref()
            .ok_or_else(|| fail("AGENT_NOT_INITIALIZED"))?;
        let user = UserSid::get()?;
        let _directories = layout(root, &user)?;
        let mut names = Vec::new();
        for item in
            std::fs::read_dir(root.join("inbox")).map_err(|_| fail("AGENT_INBOX_UNAVAILABLE"))?
        {
            let item = item.map_err(|_| fail("AGENT_INBOX_UNAVAILABLE"))?;
            if let Some(name) = item.file_name().to_str() {
                if name.strip_suffix(".ready.json").is_some_and(safe_id) {
                    names.push(name.to_owned());
                    if names.len() == 100 {
                        break;
                    }
                }
            }
        }
        names.sort();
        Ok(names)
    }
    pub fn read_ready(token: &str, request_id: &str, max_bytes: usize) -> Result<String> {
        if !safe_id(request_id) || max_bytes == 0 || max_bytes > LIMIT {
            return Err(fail("AGENT_FILE_INVALID"));
        }
        let mut state = state()?;
        let owner = authorized(&mut state, token)?;
        owner.read_tickets.remove(request_id);
        if owner.read_tickets.len() >= 100 {
            return Err(fail("AGENT_READ_LIMIT"));
        }
        let root = state
            .root
            .as_ref()
            .ok_or_else(|| fail("AGENT_NOT_INITIALIZED"))?;
        let user = UserSid::get()?;
        let _directories = layout(root, &user)?;
        let file = OpenOptions::new()
            .read(true)
            .access_mode(FILE_GENERIC_READ | DELETE)
            .share_mode(0)
            .custom_flags(FILE_FLAG_OPEN_REPARSE_POINT)
            .open(root.join("inbox").join(format!("{request_id}.ready.json")))
            .map_err(|_| fail("AGENT_FILE_UNAVAILABLE"))?;
        validate_handle(&file, false, true, &user)?;
        let bytes = match read_bounded(&file, max_bytes) {
            Ok(bytes) => bytes,
            Err(error) if error == "E_AGENT_REQUEST_TOO_LARGE" => {
                authorized(&mut state, token)?
                    .read_tickets
                    .insert(request_id.to_owned(), ReadTicket::Oversized(file));
                return Err(error);
            }
            Err(error) => return Err(error),
        };
        let hash = Sha256::digest(&bytes).into();
        authorized(&mut state, token)?
            .read_tickets
            .insert(request_id.to_owned(), ReadTicket::Digest(hash));
        String::from_utf8(bytes).map_err(|_| fail("E_AGENT_INVALID_ENVELOPE"))
    }
    pub fn publish(token: &str, request_id: &str, serialized: &str, rejection: bool) -> Result<()> {
        if !safe_id(request_id) || serialized.len() > if rejection { LIMIT } else { RECEIPT_LIMIT }
        {
            return Err(fail("AGENT_FILE_INVALID"));
        }
        let _: serde_json::Value =
            serde_json::from_str(serialized).map_err(|_| fail("AGENT_FILE_INVALID"))?;
        let mut state = state()?;
        authorized(&mut state, token)?;
        let root = state
            .root
            .as_ref()
            .ok_or_else(|| fail("AGENT_NOT_INITIALIZED"))?;
        let user = UserSid::get()?;
        let _directories = layout(root, &user)?;
        atomic_write(
            &root
                .join(if rejection { "rejections" } else { "results" })
                .join(format!("{request_id}.json")),
            serialized.as_bytes(),
            !rejection,
            &user,
        )
    }
    pub fn retire_ready(token: &str, request_id: &str) -> Result<()> {
        if !safe_id(request_id) {
            return Err(fail("AGENT_FILE_INVALID"));
        }
        let mut state = state()?;
        let ticket = authorized(&mut state, token)?
            .read_tickets
            .remove(request_id)
            .ok_or_else(|| fail("AGENT_FILE_NOT_READ"))?;
        let root = state
            .root
            .as_ref()
            .ok_or_else(|| fail("AGENT_NOT_INITIALIZED"))?;
        let user = UserSid::get()?;
        let _directories = layout(root, &user)?;
        let file = match ticket {
            ReadTicket::Oversized(file) => file,
            ReadTicket::Digest(expected) => {
                let file = OpenOptions::new()
                    .read(true)
                    .access_mode(FILE_GENERIC_READ | DELETE)
                    .share_mode(0)
                    .custom_flags(FILE_FLAG_OPEN_REPARSE_POINT)
                    .open(root.join("inbox").join(format!("{request_id}.ready.json")))
                    .map_err(|_| fail("AGENT_FILE_UNAVAILABLE"))?;
                validate_handle(&file, false, true, &user)?;
                let observed: [u8; 32] = Sha256::digest(read_bounded(&file, LIMIT)?).into();
                if expected != observed {
                    return Err(fail("AGENT_READY_CHANGED"));
                }
                file
            }
        };
        validate_handle(&file, false, true, &user)?;
        let disposition = FILE_DISPOSITION_INFO { DeleteFile: true };
        if unsafe {
            SetFileInformationByHandle(
                file.as_raw_handle(),
                FileDispositionInfo,
                (&disposition as *const FILE_DISPOSITION_INFO).cast(),
                std::mem::size_of::<FILE_DISPOSITION_INFO>() as u32,
            )
        } == 0
        {
            return Err(fail("AGENT_RETIRE_FAILED"));
        }
        Ok(())
    }

    #[derive(Deserialize)]
    #[serde(rename_all = "camelCase", deny_unknown_fields)]
    struct SignedEnvelope {
        schema_version: u8,
        request_id: String,
        request_hash: String,
        submitted_at: String,
        expires_at: Option<String>,
        context: SignedContext,
        command: SignedCommand,
        authentication: SignedAuthentication,
    }
    #[derive(Deserialize)]
    #[serde(rename_all = "camelCase", deny_unknown_fields)]
    struct SignedContext {
        api_version: String,
        workspace_id: String,
        client_id: String,
        actor: SignedActor,
        idempotency_key: String,
        correlation_id: Option<String>,
        approval_token: Option<String>,
    }
    #[derive(Deserialize)]
    #[serde(rename_all = "camelCase", deny_unknown_fields)]
    struct SignedActor {
        kind: String,
        display_name: Option<String>,
    }
    #[derive(Deserialize)]
    #[serde(deny_unknown_fields)]
    struct SignedCommand {
        name: String,
        input: serde_json::Map<String, serde_json::Value>,
    }
    #[derive(Deserialize)]
    #[serde(rename_all = "camelCase", deny_unknown_fields)]
    struct SignedAuthentication {
        scheme: String,
        key_id: String,
    }

    fn parse_signed(payload: &str, registry: &Registry) -> Result<(SignedEnvelope, AgentClient)> {
        if payload.len() > LIMIT {
            return Err(fail("E_AGENT_AUTHENTICATION_FAILED"));
        }
        let envelope: SignedEnvelope =
            serde_json::from_str(payload).map_err(|_| fail("E_AGENT_AUTHENTICATION_FAILED"))?;
        let context = &envelope.context;
        let identifier = |value: &str| {
            !value.is_empty()
                && value.len() <= 200
                && value.as_bytes()[0].is_ascii_alphanumeric()
                && value
                    .bytes()
                    .all(|c| c.is_ascii_alphanumeric() || b"_.:-".contains(&c))
        };
        if envelope.schema_version != 1
            || !safe_id(&envelope.request_id)
            || !envelope
                .request_hash
                .strip_prefix("sha256:")
                .is_some_and(|v| {
                    v.len() == 64
                        && v.bytes()
                            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
                })
            || envelope.submitted_at.len() != 24
            || envelope.expires_at.as_ref().is_some_and(|v| v.len() != 24)
            || context.api_version != "nai-blue.agent/v1alpha1"
            || context.workspace_id != registry.workspace_id
            || !identifier(&context.idempotency_key)
            || context
                .correlation_id
                .as_ref()
                .is_some_and(|v| !identifier(v))
            || context
                .approval_token
                .as_ref()
                .is_some_and(|v| !identifier(v))
            || context
                .actor
                .display_name
                .as_ref()
                .is_some_and(|v| v.is_empty() || v.encode_utf16().count() > 100)
            || !matches!(
                envelope.command.name.as_str(),
                "system.describe_capabilities"
                    | "workspace.get_snapshot"
                    | "generation.plan"
                    | "generation.enqueue"
                    | "generation.get_run"
                    | "generation.cancel"
                    | "generation.retry_storage"
                    | "scene.retry_link"
                    | "output.abandon_reservation"
                    | "scene.resolve_many"
                    | "scene.patch_many"
                    | "folder.plan_changes"
                    | "r2.get_readiness"
            )
            || envelope.authentication.scheme != "hmac-sha256"
        {
            return Err(fail("E_AGENT_AUTHENTICATION_FAILED"));
        }
        // Input bytes are already bounded and signed. Public-material/expiry/hash
        // semantics remain the application's shared envelope parser authority.
        let _ = &envelope.command.input;
        let client = registry
            .clients
            .iter()
            .find(|client| client.client_id == context.client_id)
            .ok_or_else(|| fail("E_AGENT_AUTHENTICATION_FAILED"))?;
        if client.revoked_at.is_some()
            || client.key_id != envelope.authentication.key_id
            || client.actor_kind != context.actor.kind
        {
            return Err(fail("E_AGENT_AUTHENTICATION_FAILED"));
        }
        Ok((envelope, client.clone()))
    }
    fn verify_hmac(payload: &str, signature: &str, secret: &[u8]) -> Result<()> {
        let signature = signature
            .strip_prefix("hmac-sha256:")
            .filter(|s| s.len() == 64)
            .ok_or_else(|| fail("E_AGENT_AUTHENTICATION_FAILED"))?;
        let mut expected = [0u8; 32];
        for (index, pair) in signature.as_bytes().chunks_exact(2).enumerate() {
            let digit = |b| match b {
                b'0'..=b'9' => Ok(b - b'0'),
                b'a'..=b'f' => Ok(b - b'a' + 10),
                _ => Err(fail("E_AGENT_AUTHENTICATION_FAILED")),
            };
            expected[index] = digit(pair[0])? * 16 + digit(pair[1])?;
        }
        if secret.len() != 32 {
            return Err(fail("AGENT_VAULT_INVALID"));
        }
        let mut mac = Hmac::<Sha256>::new_from_slice(secret)
            .map_err(|_| fail("E_AGENT_AUTHENTICATION_FAILED"))?;
        mac.update(payload.as_bytes());
        mac.verify_slice(&expected)
            .map_err(|_| fail("E_AGENT_AUTHENTICATION_FAILED"))
    }
    pub fn authenticate(token: &str, payload: &str, signature: &str) -> Result<AgentIdentity> {
        let mut state = state()?;
        authorized(&mut state, token)?;
        let root = state
            .root
            .as_ref()
            .ok_or_else(|| fail("AGENT_NOT_INITIALIZED"))?;
        let user = UserSid::get()?;
        let _directories = layout(root, &user)?;
        let _control = open_private(&root.join("control/registry.lock"), true, true, &user)?;
        let registry = registry(root, &user)?;
        // Identity comes from the same byte string MAC verifies, eliminating
        // any envelope/signing-payload substitution at the native boundary.
        let (_, client) = parse_signed(payload, &registry)?;
        let secret = Zeroizing::new(
            entry(&registry.workspace_id, &client)?
                .get_secret()
                .map_err(|_| fail("E_AGENT_AUTHENTICATION_FAILED"))?,
        );
        verify_hmac(payload, signature, &secret)?;
        Ok(AgentIdentity {
            client_id: client.client_id.clone(),
            actor: AgentActor {
                kind: client.actor_kind,
                id: format!("client:{}", client.client_id),
            },
        })
    }

    #[cfg(test)]
    mod tests {
        use super::*;
        use serde_json::json;

        fn external_signer_roundtrip(
            root: &Path,
            token: &str,
            workspace_id: &str,
            client: &AgentClient,
        ) {
            let Ok(python) = std::env::var("PHASE9_QA_PYTHON") else {
                eprintln!("External signer process QA skipped: PHASE9_QA_PYTHON is unset.");
                return;
            };
            // Only nonsecret connection metadata crosses stdin. The production
            // signer reads our isolated test-service key using real CredReadW.
            let script = r#"
import importlib.util, json, sys
from pathlib import Path
spec = importlib.util.spec_from_file_location("agent_submit", sys.argv[1])
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
module.SERVICE = "blue.bluehair.naiblue.agent-commands.test"
parameters = json.load(sys.stdin)
result = module.submit(parameters["connection"], {"name":"workspace.get_snapshot","input":{}},
                       Path(parameters["inbox"]), "external-process", 3600)
assert result["accepted"] is False and result["status"] == "submitted-to-inbox"
"#;
            let signer = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
                .parent()
                .unwrap()
                .join("scripts/submit-agent-command.py");
            let mut process = std::process::Command::new(python)
                .args(["-B", "-X", "utf8", "-c", script])
                .arg(signer)
                .stdin(std::process::Stdio::piped())
                .stdout(std::process::Stdio::piped())
                .stderr(std::process::Stdio::piped())
                .spawn()
                .expect("Start isolated external signer process");
            let parameters = json!({ "connection": { "workspaceId": workspace_id, "clientId": client.client_id,
                "keyId": client.key_id, "actorKind": client.actor_kind }, "inbox": root.join("inbox") });
            process
                .stdin
                .take()
                .unwrap()
                .write_all(parameters.to_string().as_bytes())
                .unwrap();
            let result = process.wait_with_output().unwrap();
            assert!(result.status.success(), "External signer process failed");
            assert!(result.stdout.is_empty() && result.stderr.is_empty());
            let raw = read_ready(token, "external-process", LIMIT).unwrap();
            let mut signed: serde_json::Value = serde_json::from_str(&raw).unwrap();
            let signature = signed["authentication"]
                .as_object_mut()
                .unwrap()
                .remove("signature")
                .unwrap();
            // These fixed ASCII envelope fields use the same sorted order as
            // serde_json; the separate TS/Python tests cover general UTF-16 keys.
            assert_eq!(
                authenticate(token, &signed.to_string(), signature.as_str().unwrap())
                    .unwrap()
                    .client_id,
                client.client_id
            );
            retire_ready(token, "external-process").unwrap();
            assert!(!root.join("inbox/external-process.ready.json").exists());
            eprintln!("External signer process QA passed: real CredReadW, isolated test vault, native authentication and retirement.");
        }

        fn client() -> AgentClient {
            AgentClient {
                client_id: "client-test".into(),
                key_id: "key-test".into(),
                label: "Test client".into(),
                actor_kind: "agent".into(),
                created_at: "2026-09-05T00:00:00.000Z".into(),
                revoked_at: None,
            }
        }
        fn signed() -> serde_json::Value {
            json!({"schemaVersion":1,"requestId":"request-test","requestHash":format!("sha256:{}", "a".repeat(64)),
                "submittedAt":"2026-09-05T00:00:00.000Z", "context":{"apiVersion":"nai-blue.agent/v1alpha1",
                "workspaceId":"workspace-test","clientId":"client-test","actor":{"kind":"agent"},"idempotencyKey":"request-test"},
                "command":{"name":"workspace.get_snapshot","input":{}},"authentication":{"scheme":"hmac-sha256","keyId":"key-test"}})
        }
        #[test]
        fn native_auth_binds_exact_bytes_client_workspace_key_and_actor() {
            let registry = Registry {
                schema_version: 1,
                workspace_id: "workspace-test".into(),
                clients: vec![client()],
            };
            let payload = serde_json::to_string(&signed()).unwrap();
            let secret = [42; 32];
            let mut mac = Hmac::<Sha256>::new_from_slice(&secret).unwrap();
            mac.update(payload.as_bytes());
            let signature = format!("hmac-sha256:{}", hex(&mac.finalize().into_bytes()));
            assert!(parse_signed(&payload, &registry).is_ok());
            assert!(verify_hmac(&payload, &signature, &secret).is_ok());
            assert!(verify_hmac(&(payload.clone() + " "), &signature, &secret).is_err());
            assert!(verify_hmac(&payload, &signature, &[43; 32]).is_err());
            for (section, field, value) in [
                ("context", "clientId", "other"),
                ("context", "workspaceId", "other"),
                ("authentication", "keyId", "other"),
                ("authentication", "scheme", "none"),
            ] {
                let mut altered = signed();
                altered[section][field] = json!(value);
                assert!(parse_signed(&altered.to_string(), &registry).is_err());
            }
            let mut altered = signed();
            altered["context"]["actor"]["kind"] = json!("service");
            assert!(parse_signed(&altered.to_string(), &registry).is_err());
            let mut revoked = registry;
            revoked.clients[0].revoked_at = Some("2026-09-05T00:00:01.000Z".into());
            assert!(parse_signed(&payload, &revoked).is_err());
            assert!(parse_signed(&" ".repeat(LIMIT + 1), &revoked).is_err());
            assert!(parse_signed(
                &payload.replacen(
                    "\"schemaVersion\":1",
                    "\"schemaVersion\":1,\"schemaVersion\":1",
                    1
                ),
                &revoked
            )
            .is_err());
        }

        #[test]
        fn windows_inbox_private_acl_owner_atomic_projection_and_retire() {
            let parent = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
                .join("target/agent-inbox-tests")
                .join(random_id("test-").unwrap());
            std::fs::create_dir_all(&parent).unwrap();
            let root = parent.join("agent-commands");
            let user = UserSid::get().unwrap();
            let directories = layout(&root, &user).unwrap();
            let first = registry(&root, &user).unwrap();
            assert_eq!(
                registry(&root, &user).unwrap().workspace_id,
                first.workspace_id
            );
            state().unwrap().root = Some(root.clone());
            let token = acquire_owner().unwrap().unwrap();
            assert!(acquire_owner().unwrap().is_none());
            // The real registration/rotation/revocation path uses only the
            // compile-time test vault namespace and this private temp registry.
            let registered = change_client(
                None,
                Some("Isolated test".into()),
                Some("agent".into()),
                false,
            )
            .unwrap();
            let sign = |client: &AgentClient| {
                let mut payload = signed();
                payload["context"]["workspaceId"] = json!(first.workspace_id);
                payload["context"]["clientId"] = json!(client.client_id);
                payload["authentication"]["keyId"] = json!(client.key_id);
                let payload = payload.to_string();
                let secret = Zeroizing::new(
                    entry(&first.workspace_id, client)
                        .unwrap()
                        .get_secret()
                        .unwrap(),
                );
                let mut mac = Hmac::<Sha256>::new_from_slice(&secret).unwrap();
                mac.update(payload.as_bytes());
                (
                    payload,
                    format!("hmac-sha256:{}", hex(&mac.finalize().into_bytes())),
                )
            };
            let (old_payload, old_signature) = sign(&registered);
            assert_eq!(
                authenticate(&token, &old_payload, &old_signature)
                    .unwrap()
                    .client_id,
                registered.client_id
            );
            external_signer_roundtrip(&root, &token, &first.workspace_id, &registered);
            let rotated =
                change_client(Some(registered.client_id.clone()), None, None, false).unwrap();
            assert_ne!(rotated.key_id, registered.key_id);
            assert!(matches!(
                entry(&first.workspace_id, &registered)
                    .unwrap()
                    .get_secret(),
                Err(keyring::Error::NoEntry)
            ));
            assert!(authenticate(&token, &old_payload, &old_signature).is_err());
            let (payload, signature) = sign(&rotated);
            assert!(authenticate(&token, &payload, &signature).is_ok());
            let revoked = change_client(Some(rotated.client_id.clone()), None, None, true).unwrap();
            assert!(revoked.revoked_at.is_some());
            assert!(authenticate(&token, &payload, &signature).is_err());
            assert!(matches!(
                entry(&first.workspace_id, &rotated).unwrap().get_secret(),
                Err(keyring::Error::NoEntry)
            ));
            assert!(change_client(Some(rotated.client_id), None, None, false).is_err());
            assert!(OpenOptions::new()
                .read(true)
                .write(true)
                .share_mode(0)
                .open(root.join("control/owner.lock"))
                .is_err());
            assert!(std::fs::rename(&root, parent.join("moved")).is_err());
            assert!(list_ready("wrong-owner").is_err());
            for id in ["../escape", "a:b", "CON", "lpt0", "", "a.b"] {
                assert!(!safe_id(id));
            }
            let oversized = root.join("inbox/oversized.ready.json");
            atomic_write(&oversized, &vec![b' '; LIMIT + 1], false, &user).unwrap();
            assert_eq!(
                read_ready(&token, "oversized", LIMIT).unwrap_err(),
                "E_AGENT_REQUEST_TOO_LARGE"
            );
            // No bytes are read/hashed, and replacement is denied while the
            // oversized rejection is pending against this exact file handle.
            assert!(std::fs::write(&oversized, b"replacement").is_err());
            publish(
                &token,
                "oversized",
                "{\"accepted\":false,\"code\":\"REQUEST_TOO_LARGE\"}",
                true,
            )
            .unwrap();
            retire_ready(&token, "oversized").unwrap();
            assert!(!oversized.exists());
            let invalid_utf8 = root.join("inbox/invalid-utf8.ready.json");
            atomic_write(&invalid_utf8, &[0xff], false, &user).unwrap();
            assert_eq!(
                read_ready(&token, "invalid-utf8", LIMIT).unwrap_err(),
                "E_AGENT_INVALID_ENVELOPE"
            );
            atomic_write(&invalid_utf8, b"{}", true, &user).unwrap();
            assert_eq!(
                retire_ready(&token, "invalid-utf8").unwrap_err(),
                "AGENT_READY_CHANGED"
            );
            assert!(invalid_utf8.exists());
            atomic_write(&invalid_utf8, &[0xff], true, &user).unwrap();
            assert_eq!(
                read_ready(&token, "invalid-utf8", LIMIT).unwrap_err(),
                "E_AGENT_INVALID_ENVELOPE"
            );
            publish(
                &token,
                "invalid-utf8",
                "{\"accepted\":false,\"code\":\"INVALID_ENVELOPE\"}",
                true,
            )
            .unwrap();
            retire_ready(&token, "invalid-utf8").unwrap();
            assert!(!invalid_utf8.exists());
            let ready = root.join("inbox/request-test.ready.json");
            atomic_write(&ready, b"{}", false, &user).unwrap();
            assert_eq!(list_ready(&token).unwrap(), vec!["request-test.ready.json"]);
            assert_eq!(read_ready(&token, "request-test", LIMIT).unwrap(), "{}");
            assert!(ready.exists());
            publish(&token, "request-test", "{\"status\":\"accepted\"}", false).unwrap();
            publish(&token, "request-test", "{\"status\":\"completed\"}", false).unwrap();
            assert!(
                std::fs::read_to_string(root.join("results/request-test.json"))
                    .unwrap()
                    .contains("completed")
            );
            let empty_result = json!({"note": ""});
            let full_result = json!({"note": " ".repeat(LIMIT - empty_result.to_string().len())});
            assert_eq!(full_result.to_string().len(), LIMIT);
            let full_receipt = json!({"schemaVersion": 1, "requestId": "maximum-result",
                "requestHash": format!("sha256:{}", "a".repeat(64)),
                "authenticatedClientId": registered.client_id, "command": "workspace.get_snapshot",
                "state": "completed", "observedAt": "2026-09-05T00:00:00.000Z", "resultSchemaVersion": 1,
                "resultDigest": format!("sha256:{}", hex(&Sha256::digest(full_result.to_string().as_bytes()))),
                "result": full_result}).to_string();
            assert!(full_receipt.len() > LIMIT && full_receipt.len() <= RECEIPT_LIMIT);
            publish(&token, "maximum-result", &full_receipt, false).unwrap();
            assert_eq!(
                std::fs::read_to_string(root.join("results/maximum-result.json")).unwrap(),
                full_receipt
            );
            let oversized_receipt = json!({"note": " ".repeat(RECEIPT_LIMIT)}).to_string();
            assert!(publish(&token, "oversized-result", &oversized_receipt, false).is_err());
            assert!(!root.join("results/oversized-result.json").exists());
            assert!(publish(&token, "oversized-rejection", &full_receipt, true).is_err());
            assert!(!root.join("rejections/oversized-rejection.json").exists());
            publish(&token, "request-test", "{}", true).unwrap();
            publish(&token, "request-test", "{}", true).unwrap();
            assert!(publish(&token, "request-test", "{\"different\":true}", true).is_err());
            atomic_write(&ready, b"{\"replacement\":true}", true, &user).unwrap();
            assert_eq!(
                retire_ready(&token, "request-test").unwrap_err(),
                "AGENT_READY_CHANGED"
            );
            read_ready(&token, "request-test", LIMIT).unwrap();
            retire_ready(&token, "request-test").unwrap();
            assert!(!ready.exists());

            // Real hard links and permissive DACLs are rejected on opened files.
            atomic_write(&ready, b"{}", false, &user).unwrap();
            let linked = root.join("inbox/linked.ready.json");
            std::fs::hard_link(&ready, &linked).unwrap();
            assert_eq!(
                read_ready(&token, "linked", LIMIT).unwrap_err(),
                "AGENT_UNSAFE_FILE"
            );
            std::fs::remove_file(linked).unwrap();
            unsafe {
                let sddl: Vec<u16> = "D:P(A;;FA;;;WD)".encode_utf16().chain(Some(0)).collect();
                let mut descriptor = ptr::null_mut();
                assert_ne!(
                    ConvertStringSecurityDescriptorToSecurityDescriptorW(
                        sddl.as_ptr(),
                        1,
                        &mut descriptor,
                        ptr::null_mut()
                    ),
                    0
                );
                let _descriptor = LocalMemory(descriptor);
                assert_ne!(
                    SetFileSecurityW(
                        wide(&ready).as_ptr(),
                        DACL_SECURITY_INFORMATION | PROTECTED_DACL_SECURITY_INFORMATION,
                        descriptor
                    ),
                    0
                );
            }
            assert_eq!(
                read_ready(&token, "request-test", LIMIT).unwrap_err(),
                "AGENT_UNSAFE_ACL"
            );
            release_owner(&token).unwrap();
            let reacquired = acquire_owner().unwrap().unwrap();
            assert_ne!(reacquired, token);
            release_owner(&reacquired).unwrap();
            state().unwrap().root = None;
            drop(directories);
            std::fs::remove_dir_all(parent).unwrap();
        }

        #[test]
        fn windows_isolated_keyring_roundtrip_keeps_secret_native() {
            // Separate test service and random account; never inspect user keys.
            let entry = keyring::Entry::new(
                "blue.bluehair.naiblue.agent-commands.test",
                &random_id("test-").unwrap(),
            )
            .unwrap();
            let secret = Zeroizing::new([19u8; 32]);
            entry.set_secret(secret.as_ref()).unwrap();
            let fetched = entry.get_secret();
            let deleted = entry.delete_credential();
            let fetched = Zeroizing::new(fetched.unwrap());
            assert_eq!(fetched.as_slice(), secret.as_ref());
            deleted.unwrap();
            assert!(matches!(entry.get_secret(), Err(keyring::Error::NoEntry)));
        }
    }
}

#[tauri::command]
pub fn agent_commands_initialize(app: tauri::AppHandle) -> Result<AgentInitialization> {
    #[cfg(target_os = "windows")]
    {
        native::initialize(app)
    }
    #[cfg(not(target_os = "windows"))]
    {
        let _ = app;
        Err(fail("AGENT_PLATFORM_UNAVAILABLE"))
    }
}
#[tauri::command]
pub fn agent_commands_register_client(label: String, actor_kind: String) -> Result<AgentClient> {
    #[cfg(target_os = "windows")]
    {
        native::change_client(None, Some(label), Some(actor_kind), false)
    }
    #[cfg(not(target_os = "windows"))]
    {
        let _ = (label, actor_kind);
        Err(fail("AGENT_PLATFORM_UNAVAILABLE"))
    }
}
#[tauri::command]
pub fn agent_commands_rotate_client(client_id: String) -> Result<AgentClient> {
    #[cfg(target_os = "windows")]
    {
        native::change_client(Some(client_id), None, None, false)
    }
    #[cfg(not(target_os = "windows"))]
    {
        let _ = client_id;
        Err(fail("AGENT_PLATFORM_UNAVAILABLE"))
    }
}
#[tauri::command]
pub fn agent_commands_revoke_client(client_id: String) -> Result<AgentClient> {
    #[cfg(target_os = "windows")]
    {
        native::change_client(Some(client_id), None, None, true)
    }
    #[cfg(not(target_os = "windows"))]
    {
        let _ = client_id;
        Err(fail("AGENT_PLATFORM_UNAVAILABLE"))
    }
}
#[tauri::command]
pub fn agent_commands_acquire_owner() -> Result<Option<String>> {
    #[cfg(target_os = "windows")]
    {
        native::acquire_owner()
    }
    #[cfg(not(target_os = "windows"))]
    {
        Err(fail("AGENT_PLATFORM_UNAVAILABLE"))
    }
}
#[tauri::command]
pub fn agent_commands_release_owner(owner_token: String) -> Result<()> {
    #[cfg(target_os = "windows")]
    {
        native::release_owner(&owner_token)
    }
    #[cfg(not(target_os = "windows"))]
    {
        let _ = owner_token;
        Err(fail("AGENT_PLATFORM_UNAVAILABLE"))
    }
}
#[tauri::command]
pub fn agent_commands_list_ready(owner_token: String) -> Result<Vec<String>> {
    #[cfg(target_os = "windows")]
    {
        native::list_ready(&owner_token)
    }
    #[cfg(not(target_os = "windows"))]
    {
        let _ = owner_token;
        Err(fail("AGENT_PLATFORM_UNAVAILABLE"))
    }
}
#[tauri::command]
pub fn agent_commands_read_ready(
    owner_token: String,
    request_id: String,
    max_bytes: usize,
) -> Result<String> {
    #[cfg(target_os = "windows")]
    {
        native::read_ready(&owner_token, &request_id, max_bytes)
    }
    #[cfg(not(target_os = "windows"))]
    {
        let _ = (owner_token, request_id, max_bytes);
        Err(fail("AGENT_PLATFORM_UNAVAILABLE"))
    }
}
#[tauri::command]
pub fn agent_commands_publish_result(
    owner_token: String,
    request_id: String,
    serialized: String,
) -> Result<()> {
    #[cfg(target_os = "windows")]
    {
        native::publish(&owner_token, &request_id, &serialized, false)
    }
    #[cfg(not(target_os = "windows"))]
    {
        let _ = (owner_token, request_id, serialized);
        Err(fail("AGENT_PLATFORM_UNAVAILABLE"))
    }
}
#[tauri::command]
pub fn agent_commands_publish_rejection(
    owner_token: String,
    request_id: String,
    serialized: String,
) -> Result<()> {
    #[cfg(target_os = "windows")]
    {
        native::publish(&owner_token, &request_id, &serialized, true)
    }
    #[cfg(not(target_os = "windows"))]
    {
        let _ = (owner_token, request_id, serialized);
        Err(fail("AGENT_PLATFORM_UNAVAILABLE"))
    }
}
#[tauri::command]
pub fn agent_commands_retire_ready(owner_token: String, request_id: String) -> Result<()> {
    #[cfg(target_os = "windows")]
    {
        native::retire_ready(&owner_token, &request_id)
    }
    #[cfg(not(target_os = "windows"))]
    {
        let _ = (owner_token, request_id);
        Err(fail("AGENT_PLATFORM_UNAVAILABLE"))
    }
}
#[tauri::command]
pub fn agent_commands_authenticate(
    owner_token: String,
    signing_payload: String,
    signature: String,
) -> Result<AgentIdentity> {
    #[cfg(target_os = "windows")]
    {
        native::authenticate(&owner_token, &signing_payload, &signature)
    }
    #[cfg(not(target_os = "windows"))]
    {
        let _ = (owner_token, signing_payload, signature);
        Err(fail("AGENT_PLATFORM_UNAVAILABLE"))
    }
}
