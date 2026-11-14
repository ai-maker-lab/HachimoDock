//! Global device status-cue preference, stored beside the existing app-data settings.
use serde::{Deserialize, Serialize};
use std::{path::{Path, PathBuf}, sync::{Mutex, OnceLock}, io::Write};
static DIR: OnceLock<PathBuf> = OnceLock::new();
static LOCK: Mutex<()> = Mutex::new(());
#[derive(Clone, Copy, Debug, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Config { pub enabled: bool, pub volume: u8 }
impl Default for Config { fn default() -> Self { Self { enabled: false, volume: 30 } } }
pub fn configure(dir: PathBuf) { let _ = DIR.set(dir); }
fn read_at(dir: &Path) -> Config {
    std::fs::read(dir.join("status-cues.json")).ok()
        .and_then(|s| serde_json::from_slice::<Config>(&s).ok())
        .filter(|c| c.volume <= 100).unwrap_or_default()
}
pub fn load() -> Result<Config, String> {
    let _guard = LOCK.lock().map_err(|e| e.to_string())?;
    Ok(read_at(DIR.get().ok_or("设备设置目录尚未初始化")?))
}
pub fn save(config: Config) -> Result<Config, String> {
    if config.volume > 100 { return Err("音量须为 0–100".into()); }
    let _guard = LOCK.lock().map_err(|e| e.to_string())?;
    let dir = DIR.get().ok_or("设备设置目录尚未初始化")?;
    std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    let mut temp = tempfile::NamedTempFile::new_in(dir).map_err(|e| e.to_string())?;
    temp.write_all(&serde_json::to_vec(&config).map_err(|e| e.to_string())?).map_err(|e| e.to_string())?;
    temp.as_file().sync_all().map_err(|e| e.to_string())?;
    temp.persist(dir.join("status-cues.json")).map_err(|e| e.to_string())?;
    Ok(config)
}
pub fn payload(config: Config) -> serde_json::Value {
    serde_json::json!({"enabled":config.enabled,"volume":config.volume,
        "requestId":format!("status-cues-{}", uuid::Uuid::new_v4())})
}
#[cfg(test)] mod tests {
    use super::*;
    #[test] fn status_cues_defaults_and_validation() {
        let dir = tempfile::tempdir().unwrap();
        assert_eq!(read_at(dir.path()), Config::default());
        for raw in [r#"{"enabled":1,"volume":30}"#, r#"{"enabled":true,"volume":30.5}"#,
                    r#"{"enabled":true,"volume":101}"#, "{}"] {
            std::fs::write(dir.path().join("status-cues.json"), raw).unwrap();
            assert_eq!(read_at(dir.path()), Config::default());
        }
        std::fs::write(dir.path().join("status-cues.json"), r#"{"enabled":true,"volume":70}"#).unwrap();
        assert_eq!(read_at(dir.path()), Config {enabled:true,volume:70});
        assert_eq!(payload(Config::default())["volume"],30);
    }
}
