use std::path::{Path, PathBuf};

use anyhow::{anyhow, Context};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use uuid::Uuid;

const AUTH_RECORD_VERSION: u8 = 1;
const MIN_CODE_CHARS: usize = 6;
const MAX_CODE_CHARS: usize = 64;
const HASH_ROUNDS: u32 = 120_000;

#[derive(Debug, Clone, Serialize, Deserialize)]
struct AuthorizationRecord {
    version: u8,
    salt: String,
    password_hash: String,
}

#[derive(Debug)]
pub struct AuthorizationStore {
    path: PathBuf,
    record: Option<AuthorizationRecord>,
}

impl AuthorizationStore {
    pub fn open(path: impl Into<PathBuf>) -> anyhow::Result<Self> {
        let path = path.into();
        let record = match std::fs::read(&path) {
            Ok(bytes) => {
                let record: AuthorizationRecord = serde_json::from_slice(&bytes)
                    .context("decode persisted Weixin authorization state")?;
                if record.version != AUTH_RECORD_VERSION {
                    return Err(anyhow!(
                        "unsupported Weixin authorization record version {}",
                        record.version
                    ));
                }
                Some(record)
            }
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => None,
            Err(error) => {
                return Err(error).context("read persisted Weixin authorization state");
            }
        };
        Ok(Self { path, record })
    }

    pub fn is_configured(&self) -> bool {
        self.record.is_some()
    }

    pub fn configure(&mut self, code: &str) -> anyhow::Result<()> {
        validate_code(code)?;
        let salt = Uuid::new_v4().to_string();
        let password_hash = derive_hash(code, &salt);
        let record = AuthorizationRecord {
            version: AUTH_RECORD_VERSION,
            salt,
            password_hash,
        };
        persist_record(&self.path, &record)?;
        self.record = Some(record);
        Ok(())
    }

    pub fn verify(&self, code: &str) -> anyhow::Result<bool> {
        let Some(record) = self.record.as_ref() else {
            return Ok(false);
        };
        Ok(constant_time_eq(
            derive_hash(code, &record.salt).as_bytes(),
            record.password_hash.as_bytes(),
        ))
    }

    pub fn clear(&mut self) -> anyhow::Result<()> {
        self.record = None;
        match std::fs::remove_file(&self.path) {
            Ok(()) => Ok(()),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
            Err(error) => Err(error).context("remove Weixin authorization state"),
        }
    }
}
fn derive_hash(code: &str, salt: &str) -> String {
    let mut first = Sha256::new();
    first.update(salt.as_bytes());
    first.update([0]);
    first.update(code.as_bytes());
    let mut digest = first.finalize().to_vec();

    for round in 1..HASH_ROUNDS {
        let mut hasher = Sha256::new();
        hasher.update(&digest);
        hasher.update(salt.as_bytes());
        hasher.update(round.to_le_bytes());
        hasher.update(code.as_bytes());
        digest = hasher.finalize().to_vec();
    }

    let mut hex = String::with_capacity(digest.len() * 2);
    for byte in digest {
        use std::fmt::Write as _;
        let _ = write!(&mut hex, "{byte:02x}");
    }
    hex
}

fn constant_time_eq(left: &[u8], right: &[u8]) -> bool {
    if left.len() != right.len() {
        return false;
    }
    let mut diff = 0u8;
    for (&a, &b) in left.iter().zip(right.iter()) {
        diff |= a ^ b;
    }
    diff == 0
}

pub fn validate_code(code: &str) -> anyhow::Result<()> {
    let count = code.chars().count();
    if !(MIN_CODE_CHARS..=MAX_CODE_CHARS).contains(&count) {
        return Err(anyhow!("授权码长度必须在允许范围内"));
    }
    if code.chars().any(char::is_whitespace) {
        return Err(anyhow!("授权码不能包含空白字符"));
    }
    Ok(())
}

pub fn looks_like_code(text: &str) -> bool {
    validate_code(text).is_ok()
}
fn persist_record(path: &Path, record: &AuthorizationRecord) -> anyhow::Result<()> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).context("create Weixin authorization directory")?;
    }
    let bytes = serde_json::to_vec_pretty(record).context("encode Weixin authorization state")?;
    let temp = path.with_extension("tmp");
    std::fs::write(&temp, bytes).context("write temporary Weixin authorization state")?;

    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&temp, std::fs::Permissions::from_mode(0o600))
            .context("restrict Weixin authorization state permissions")?;
    }

    match std::fs::rename(&temp, path) {
        Ok(()) => Ok(()),
        Err(_error) if cfg!(windows) => {
            if path.exists() {
                std::fs::remove_file(path)
                    .context("replace existing Weixin authorization state on Windows")?;
            }
            std::fs::rename(&temp, path)
                .context("finish replacing Weixin authorization state on Windows")
        }
        Err(error) => Err(error).context("atomically replace Weixin authorization state"),
    }
}
#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn authorization_code_round_trip_uses_a_hash() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("weixin-authorization.json");
        let mut store = AuthorizationStore::open(&path).unwrap();
        store.configure("839201").unwrap();

        let raw = std::fs::read_to_string(&path).unwrap();
        assert!(!raw.contains("839201"));
        assert!(store.verify("839201").unwrap());
        assert!(!store.verify("839202").unwrap());

        let reopened = AuthorizationStore::open(&path).unwrap();
        assert!(reopened.verify("839201").unwrap());
    }

    #[test]
    fn authorization_code_validation_is_strict() {
        assert!(validate_code("123456").is_ok());
        assert!(validate_code("abCD-839201").is_ok());
        assert!(validate_code("12345").is_err());
        assert!(validate_code("123 456").is_err());
    }
}
