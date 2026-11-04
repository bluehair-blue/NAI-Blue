//! Capture once at native startup, before inbox recovery. Re-reading the file
//! later could misidentify an old process after its installed file was replaced.
use serde::Serialize;
use sha2::{Digest, Sha256};
use std::{fs::File, io::Read, sync::OnceLock};

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentRuntimeIdentity {
    version: String,
    process_id: u32,
    executable_hash: String,
}

static IDENTITY: OnceLock<Option<AgentRuntimeIdentity>> = OnceLock::new();

pub fn capture() -> Option<AgentRuntimeIdentity> {
    IDENTITY.get_or_init(|| {
        let mut file = File::open(std::env::current_exe().ok()?).ok()?;
        let mut hash = Sha256::new();
        let mut buffer = [0_u8; 65_536];
        loop {
            let count = file.read(&mut buffer).ok()?;
            if count == 0 { break; }
            hash.update(&buffer[..count]);
        }
        Some(AgentRuntimeIdentity {
            version: env!("CARGO_PKG_VERSION").to_owned(),
            process_id: std::process::id(),
            executable_hash: format!("sha256:{:x}", hash.finalize()),
        })
    }).clone()
}
