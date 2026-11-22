use serde::{Deserialize, Serialize};
use std::collections::HashSet;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};
use tauri::Manager;
use uuid::Uuid;

use base64::Engine as _;

mod trophies;

use sysinfo::{Pid, ProcessRefreshKind, ProcessesToUpdate, System, UpdateKind};
use tauri::Emitter;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Game {
    pub id: String,
    pub title: String,
    pub exe_path: String,
    #[serde(default)]
    pub steam_appid: Option<String>,
    #[serde(default)]
    pub cover_url: Option<String>,
    #[serde(default)]
    pub bg_url: Option<String>,
    #[serde(default)]
    pub last_played: Option<u64>,
    #[serde(default)]
    pub playtime_seconds: u64,
    #[serde(default)]
    pub launch_options: String,
    /// Jeu épinglé en tête du ruban, juste après le PlayStation Store.
    #[serde(default)]
    pub pinned: bool,
    /// Musique de thème téléchargée automatiquement (chemin absolu).
    #[serde(default, rename = "themeAudioPath")]
    pub theme_audio_path: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct UserProfile {
    #[serde(default = "default_username")]
    pub username: String,
    #[serde(default = "default_bio")]
    pub bio: String,
    #[serde(default)]
    pub avatar_data_url: Option<String>,
    /// Jeton personnel SteamGridDB : jaquettes et fonds 4K optionnels.
    #[serde(default)]
    pub steamgriddb_api_key: String,
    /// SteamID64 du compte : synchronisation officielle des trophées.
    #[serde(default)]
    pub steam_id: String,
    /// Clé Web API Steam (schema localisé + trophées du joueur).
    #[serde(default)]
    pub steam_api_key: String,
}

fn default_username() -> String {
    "Thibault".to_string()
}

fn default_bio() -> String {
    "En ligne".to_string()
}

impl Default for UserProfile {
    fn default() -> Self {
        Self {
            username: default_username(),
            bio: default_bio(),
            avatar_data_url: None,
            steamgriddb_api_key: String::new(),
            steam_id: String::new(),
            steam_api_key: String::new(),
        }
    }
}

const GENERIC_STEMS: [&str; 11] = [
    "game",
    "launcher",
    "start",
    "play",
    "run",
    "app",
    "application",
    "main",
    "client",
    "index",
    "setup",
];

fn games_file(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("app_data_dir indisponible: {e}"))?;
    fs::create_dir_all(&dir)
        .map_err(|e| format!("création de {} impossible: {e}", dir.display()))?;
    Ok(dir.join("games.json"))
}

fn load_games(app: &tauri::AppHandle) -> Result<Vec<Game>, String> {
    let path = games_file(app)?;
    let raw = match fs::read_to_string(&path) {
        Ok(raw) => raw,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(Vec::new()),
        Err(e) => return Err(format!("lecture de {} impossible: {e}", path.display())),
    };
    if raw.trim().is_empty() {
        return Ok(Vec::new());
    }
    serde_json::from_str(&raw).map_err(|e| format!("parsing de {} impossible: {e}", path.display()))
}

fn save_games(app: &tauri::AppHandle, games: &[Game]) -> Result<(), String> {
    let path = games_file(app)?;
    let raw = serde_json::to_string_pretty(games).map_err(|e| e.to_string())?;
    fs::write(&path, raw).map_err(|e| format!("écriture de {} impossible: {e}", path.display()))
}

fn profile_file(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("app_data_dir indisponible: {e}"))?;
    fs::create_dir_all(&dir)
        .map_err(|e| format!("création de {} impossible: {e}", dir.display()))?;
    Ok(dir.join("profile.json"))
}

fn load_profile(app: &tauri::AppHandle) -> Result<UserProfile, String> {
    let path = profile_file(app)?;
    let raw = match fs::read_to_string(&path) {
        Ok(raw) => raw,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(UserProfile::default()),
        Err(e) => return Err(format!("lecture de {} impossible: {e}", path.display())),
    };
    if raw.trim().is_empty() {
        return Ok(UserProfile::default());
    }
    serde_json::from_str(&raw).map_err(|e| format!("parsing de {} impossible: {e}", path.display()))
}

fn save_profile(app: &tauri::AppHandle, profile: &UserProfile) -> Result<(), String> {
    let path = profile_file(app)?;
    let raw = serde_json::to_string_pretty(profile).map_err(|e| e.to_string())?;
    fs::write(&path, raw).map_err(|e| format!("écriture de {} impossible: {e}", path.display()))
}

fn now_millis() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

fn clean_title(raw: &str) -> String {
    raw.replace(['_', '-'], " ")
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
}

fn derive_title(exe: &Path, dir: &Path) -> String {
    let stem = exe
        .file_stem()
        .and_then(|s| s.to_str())
        .filter(|s| !s.trim().is_empty())
        .unwrap_or("Jeu");
    let is_generic = GENERIC_STEMS.iter().any(|g| g.eq_ignore_ascii_case(stem));
    let candidate = if is_generic {
        dir.file_name()
            .and_then(|n| n.to_str())
            .filter(|n| !n.trim().is_empty())
            .unwrap_or(stem)
    } else {
        stem
    };
    let cleaned = clean_title(candidate);
    if cleaned.is_empty() {
        "Jeu".to_string()
    } else {
        cleaned
    }
}

/// Détection locale, par ordre de fiabilité : `steam_appid.txt`, clé `AppId`
/// des `.ini`/`.cfg` d'émulateur, puis manifestes Steam.
fn find_steam_appid(dir: &Path) -> Option<String> {
    scan_for_steam_appid_file(dir)
        .or_else(|| scan_for_appid_key(dir))
        .or_else(|| steam_appid_from_manifests(dir))
}

fn scan_for_steam_appid_file(dir: &Path) -> Option<String> {
    let mut dirs = vec![(dir.to_path_buf(), 0usize)];
    while let Some((current, depth)) = dirs.pop() {
        let Ok(entries) = fs::read_dir(&current) else {
            continue;
        };
        for entry in entries.flatten() {
            let path = entry.path();
            if path.is_dir() {
                if depth < 3 {
                    dirs.push((path, depth + 1));
                }
                continue;
            }
            let is_appid_file = path
                .file_name()
                .and_then(|n| n.to_str())
                .is_some_and(|n| n.eq_ignore_ascii_case("steam_appid.txt"));
            if !is_appid_file {
                continue;
            }
            let Ok(content) = fs::read_to_string(&path) else {
                continue;
            };
            let id: String = content
                .lines()
                .next()
                .unwrap_or("")
                .chars()
                .filter(|c| c.is_ascii_digit())
                .collect();
            if !id.is_empty() {
                return Some(id);
            }
        }
    }
    None
}

/// Fichiers de configuration des émulateurs qui portent l'AppID d'origine
/// (`steam_emu.ini`, `ALI213.ini`, `codex.ini`, `rune.ini`, `valve.ini`…).
const APPID_CONFIG_FILES: [&str; 8] = [
    "steam_emu.ini",
    "steam_api.ini",
    "ali213.ini",
    "codex.ini",
    "rune.ini",
    "valve.ini",
    "empress.ini",
    "flt.ini",
];

fn scan_for_appid_key(dir: &Path) -> Option<String> {
    let mut dirs = vec![(dir.to_path_buf(), 0usize)];
    while let Some((current, depth)) = dirs.pop() {
        let Ok(entries) = fs::read_dir(&current) else {
            continue;
        };
        let mut names: Vec<(PathBuf, usize)> = Vec::new();
        for entry in entries.flatten() {
            let path = entry.path();
            if path.is_dir() {
                if depth < 2 {
                    dirs.push((path, depth + 1));
                }
                continue;
            }
            let Some(name) = path.file_name().and_then(|n| n.to_str()) else {
                continue;
            };
            let lower = name.to_ascii_lowercase();
            let is_config = lower.ends_with(".ini") || lower.ends_with(".cfg");
            if !is_config {
                continue;
            }
            let priority = usize::from(!APPID_CONFIG_FILES.contains(&lower.as_str()));
            names.push((path, priority));
        }
        // Les fichiers d'émulateur connus passent avant les `.ini` quelconques.
        names.sort_by_key(|(_, priority)| *priority);
        for (path, _) in names {
            let Ok(content) = fs::read_to_string(&path) else {
                continue;
            };
            if let Some(id) = appid_from_config(&content) {
                return Some(id);
            }
        }
    }
    None
}

/// Lit une ligne `AppId=12345` (ou `appid = 12345`) dans un fichier ini.
fn appid_from_config(raw: &str) -> Option<String> {
    for line in raw.lines() {
        let line = line.trim();
        if line.is_empty() || line.starts_with(';') || line.starts_with('#') || line.starts_with('[')
        {
            continue;
        }
        let Some((key, value)) = line.split_once('=') else {
            continue;
        };
        if !key.trim().eq_ignore_ascii_case("appid") {
            continue;
        }
        let id: String = value
            .trim()
            .trim_matches(['"', '\''])
            .chars()
            .filter(|c| c.is_ascii_digit())
            .collect();
        if id.len() >= 2 && id.chars().any(|c| c != '0') {
            return Some(id);
        }
    }
    None
}

/// Retrouve l'AppID officiel via `steamapps/appmanifest_*.acf` quand le jeu est
/// installé sous `steamapps/common/<dossier>`. Le dossier de jeu est le premier
/// segment sous `common`, même si l'exécutable est dans un sous-dossier.
fn steam_appid_from_manifests(dir: &Path) -> Option<String> {
    let (steamapps, relative) = dir.ancestors().find_map(|ancestor| {
        if !ancestor
            .file_name()
            .and_then(|name| name.to_str())
            .is_some_and(|name| name.eq_ignore_ascii_case("common"))
        {
            return None;
        }
        let steamapps = ancestor.parent()?;
        if !steamapps
            .file_name()
            .and_then(|name| name.to_str())
            .is_some_and(|name| name.eq_ignore_ascii_case("steamapps"))
        {
            return None;
        }
        Some((steamapps, dir.strip_prefix(ancestor).ok()?))
    })?;

    let game_folder = relative
        .components()
        .next()?
        .as_os_str()
        .to_string_lossy()
        .trim()
        .to_string();
    if game_folder.is_empty() {
        return None;
    }

    for entry in fs::read_dir(steamapps).ok()?.flatten() {
        let file_name = entry.file_name().to_string_lossy().to_ascii_lowercase();
        if !file_name.starts_with("appmanifest_") || !file_name.ends_with(".acf") {
            continue;
        }
        let Ok(content) = fs::read_to_string(entry.path()) else {
            continue;
        };
        let Some(installdir) = vdf_value(&content, "installdir") else {
            continue;
        };
        if !installdir.trim().eq_ignore_ascii_case(&game_folder) {
            continue;
        }
        let appid = vdf_value(&content, "appid").unwrap_or_else(|| {
            file_name
                .trim_start_matches("appmanifest_")
                .trim_end_matches(".acf")
                .to_string()
        });
        let appid = appid.trim();
        if !appid.is_empty() && appid.chars().all(|c| c.is_ascii_digit()) {
            return Some(appid.to_string());
        }
    }
    None
}

#[derive(Deserialize)]
struct StoreSearchItem {
    id: u64,
    name: String,
}

#[derive(Deserialize)]
struct StoreSearchResponse {
    #[serde(default)]
    items: Vec<StoreSearchItem>,
}

fn normalize_title(value: &str) -> String {
    value
        .chars()
        .filter(|c| c.is_alphanumeric())
        .flat_map(|c| c.to_lowercase())
        .collect()
}

async fn search_steam_appid(
    client: &reqwest::Client,
    title: &str,
) -> Result<Option<String>, String> {
    let query = clean_search_title(title);
    let response = client
        .get("https://store.steampowered.com/api/storesearch/")
        .query(&[("term", query.as_str()), ("l", "french"), ("cc", "FR")])
        .send()
        .await
        .map_err(|e| format!("recherche Steam impossible: {e}"))?;

    if !response.status().is_success() {
        return Err(format!("recherche Steam: HTTP {}", response.status()));
    }

    let payload: StoreSearchResponse = response
        .json()
        .await
        .map_err(|e| format!("réponse Steam invalide: {e}"))?;

    let wanted = normalize_title(&query);
    let original = normalize_title(title);
    let best = payload
        .items
        .iter()
        .find(|item| {
            let candidate = normalize_title(&item.name);
            candidate == wanted || candidate == original
        })
        .or_else(|| payload.items.first());

    Ok(best.map(|item| item.id.to_string()))
}

// ---------------------------------------------------------------------------
// Jaquettes haute définition : nom nettoyé, SteamGridDB puis CDN Steam, cache.
// ---------------------------------------------------------------------------

const STEAM_ARTWORK: &str = "https://shared.akamai.steamstatic.com/store_item_assets/steam/apps";
const STEAMGRIDDB_API: &str = "https://www.steamgriddb.com/api/v2";
/// Protocole Tauri qui sert `app_data_dir/covers/` sans activer l'asset protocol.
const COVERS_SCHEME: &str = "ps4covers";
const COVERS_DIR: &str = "covers";
/// Icônes natives extraites des `.exe` pour le repli hors-ligne.
const ICONS_DIR: &str = "icons";

const MEDIA_EXTENSIONS: [&str; 8] = ["exe", "lnk", "url", "app", "bat", "cmd", "sh", "bin"];

/// Suffixes marketing retirés avant la recherche Steam, du plus long au plus court.
const EDITION_SUFFIXES: [&str; 24] = [
    "game of the year edition",
    "game of the year",
    "digitally deluxe edition",
    "digital deluxe edition",
    "collector's edition",
    "collectors edition",
    "anniversary edition",
    "definitive edition",
    "enhanced edition",
    "standard edition",
    "extended edition",
    "ultimate edition",
    "complete edition",
    "premium edition",
    "special edition",
    "deluxe edition",
    "legendary edition",
    "gold edition",
    "goty edition",
    "goty",
    "remastered",
    "hd remaster",
    "deluxe",
    "definitive",
];

const VERSION_KEYWORDS: [&str; 7] = [
    "build", "version", "ver", "rev", "revision", "release", "patch",
];

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum ArtworkKind {
    Cover,
    Hero,
}

impl ArtworkKind {
    fn suffix(self) -> &'static str {
        match self {
            ArtworkKind::Cover => "cover",
            ArtworkKind::Hero => "hero",
        }
    }
}

fn strip_media_extension(raw: &str) -> &str {
    match raw.rsplit_once('.') {
        Some((stem, extension))
            if MEDIA_EXTENSIONS
                .iter()
                .any(|known| known.eq_ignore_ascii_case(extension.trim())) =>
        {
            stem
        }
        _ => raw,
    }
}

/// Retire les groupes `[...]`, `(...)` et `{...}` : `[x64]`, `(2023)`, `(GOTY)`.
fn remove_bracket_tags(raw: &str) -> String {
    let mut out = String::with_capacity(raw.len());
    let mut expected: Vec<char> = Vec::new();
    for character in raw.chars() {
        if let Some(closing) = expected.last().copied() {
            if character == closing {
                expected.pop();
            }
            continue;
        }
        match character {
            '[' => expected.push(']'),
            '(' => expected.push(')'),
            '{' => expected.push('}'),
            _ => out.push(character),
        }
    }
    out
}

/// `v1.0`, `1.2.3`, `v2`, `123456` (build) : un numéro de version, pas un mot.
fn is_version_token(token: &str) -> bool {
    let trimmed = token.trim_matches(|c: char| c == '-' || c == '_');
    let bare = trimmed
        .strip_prefix('v')
        .or_else(|| trimmed.strip_prefix('V'))
        .unwrap_or(trimmed);
    if bare.is_empty() || !bare.chars().all(|c| c.is_ascii_digit() || c == '.') {
        return false;
    }
    bare.contains('.') || trimmed.len() != bare.len() || bare.len() >= 6
}

fn strip_edition_suffix(words: &mut Vec<String>) {
    loop {
        let lowered = words.join(" ").to_ascii_lowercase();
        let mut stripped = false;
        for suffix in EDITION_SUFFIXES {
            // Un titre qui n'est *que* ce tag garde son nom.
            if lowered == suffix {
                continue;
            }
            if let Some(rest) = lowered.strip_suffix(suffix) {
                if rest.is_empty() || rest.ends_with(' ') {
                    let kept = rest.split_whitespace().count();
                    words.truncate(kept);
                    stripped = true;
                    break;
                }
            }
        }
        if !stripped {
            break;
        }
    }
}

/// Remplace `needle` sans tenir compte de la casse (les deux chaînes ASCII
/// partagent leurs index d'octets).
fn replace_ignore_ascii_case(raw: &str, needle: &str, replacement: &str) -> String {
    let lower = raw.to_ascii_lowercase();
    let mut out = String::with_capacity(raw.len());
    let mut cursor = 0usize;
    while let Some(index) = lower[cursor..].find(needle) {
        let start = cursor + index;
        out.push_str(&raw[cursor..start]);
        out.push_str(replacement);
        cursor = start + needle.len();
    }
    out.push_str(&raw[cursor..]);
    out
}

/// Retire les suffixes de build (`Win64-Shipping`, `Shipping`) avant découpe.
fn strip_build_noise(raw: &str) -> String {
    let mut out = raw.to_string();
    for noise in [
        "win64-shipping",
        "win32-shipping",
        "win64shipping",
        "win32shipping",
    ] {
        out = replace_ignore_ascii_case(&out, noise, " ");
    }
    out
}

/// Retire les jetons techniques isolés (`x64`, `Shipping`, `Win64`…).
fn strip_noise_words(raw: &str) -> String {
    raw.split_whitespace()
        .filter(|word| {
            let bare = word
                .trim_matches(|c: char| !c.is_alphanumeric())
                .to_ascii_lowercase();
            !BUILD_NOISE_TOKENS.contains(&bare.as_str())
        })
        .collect::<Vec<_>>()
        .join(" ")
}

/// Sépare le CamelCase et les nombres collés : `Cyberpunk2077` →
/// `Cyberpunk 2077`, `witcher3` → `witcher 3`.
fn split_camel_and_digits(raw: &str) -> String {
    let mut out = String::with_capacity(raw.len() + 8);
    let mut previous: Option<char> = None;
    // Lettres consécutives du jeton courant : une seule lettre ne se sépare pas
    // de son chiffre (`F1 23`), deux ou plus oui (`witcher3`).
    let mut alpha_run = 0usize;
    for ch in raw.chars() {
        if let Some(prev) = previous {
            let camel = (prev.is_lowercase() && ch.is_uppercase())
                || (prev.is_ascii_alphabetic() && ch.is_ascii_digit() && alpha_run >= 2);
            if camel {
                out.push(' ');
                alpha_run = 0;
            }
        }
        out.push(ch);
        if ch.is_ascii_alphabetic() {
            alpha_run += 1;
        } else if !ch.is_ascii_digit() {
            alpha_run = 0;
        }
        previous = Some(ch);
    }
    out
}

/// Jetons techniques qui ne désignent jamais un titre de jeu.
const BUILD_NOISE_TOKENS: [&str; 8] = [
    "shipping", "win64", "win32", "x64", "x86", "dx11", "dx12", "vulkan",
];

/// Nom exploitable pour la boutique Steam : sans extension, version, tag ni édition.
fn clean_search_title(raw: &str) -> String {
    let trimmed = raw.trim();
    let without_noise = strip_build_noise(trimmed);
    let without_extension = strip_media_extension(&without_noise);
    let without_words = strip_noise_words(&without_extension);
    let without_tags = remove_bracket_tags(&without_words);
    let spaced = split_camel_and_digits(&without_tags);
    let flattened = spaced.replace(['_', '·'], " ");
    let words: Vec<String> = flattened.split_whitespace().map(str::to_string).collect();

    let mut kept: Vec<String> = Vec::with_capacity(words.len());
    let mut index = 0;
    while index < words.len() {
        let word = &words[index];
        let lower = word.to_ascii_lowercase();
        let bare = lower.trim_matches(|c: char| !c.is_alphanumeric());
        if BUILD_NOISE_TOKENS.contains(&bare) {
            index += 1;
            continue;
        }
        if VERSION_KEYWORDS.contains(&lower.as_str())
            && words.get(index + 1).is_some_and(|next| {
                !next.is_empty()
                    && next
                        .chars()
                        .all(|c| c.is_ascii_digit() || c == '.' || c == '-')
            })
        {
            index += 2;
            continue;
        }
        if is_version_token(word) {
            index += 1;
            continue;
        }
        let mut version_tail = false;
        for part in word.split('.') {
            if part.is_empty() {
                continue;
            }
            if is_version_token(part) {
                version_tail = true;
                continue;
            }
            // `Hades.v1.0.0` : une fois la version commencée, les chiffres suivants en font partie.
            if version_tail && part.chars().all(|c| c.is_ascii_digit()) {
                continue;
            }
            version_tail = false;
            kept.push(part.to_string());
        }
        index += 1;
    }

    strip_edition_suffix(&mut kept);

    let cleaned = kept
        .join(" ")
        .trim_matches(|c: char| c.is_whitespace() || "-–—:;,.!?*+&|/\\".contains(c))
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ");

    if cleaned.chars().filter(|c| c.is_alphanumeric()).count() < 2 {
        let fallback = clean_title(trimmed);
        if fallback.is_empty() {
            trimmed.to_string()
        } else {
            fallback
        }
    } else {
        cleaned
    }
}

fn covers_dir(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("app_data_dir indisponible: {e}"))?
        .join(COVERS_DIR);
    fs::create_dir_all(&dir)
        .map_err(|e| format!("création de {} impossible: {e}", dir.display()))?;
    Ok(dir)
}

fn covers_file(game_id: &str, kind: ArtworkKind) -> String {
    let safe: String = game_id
        .chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() || c == '-' || c == '_' {
                c
            } else {
                '_'
            }
        })
        .collect();
    format!("{safe}_{}.jpg", kind.suffix())
}

#[cfg(target_os = "windows")]
fn cached_artwork_url(file: &str, stamp: u64) -> String {
    format!("http://{COVERS_SCHEME}.localhost/{file}?v={stamp}")
}

#[cfg(not(target_os = "windows"))]
fn cached_artwork_url(file: &str, stamp: u64) -> String {
    format!("{COVERS_SCHEME}://localhost/{file}?v={stamp}")
}

fn icons_dir(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("app_data_dir indisponible: {e}"))?
        .join(ICONS_DIR);
    fs::create_dir_all(&dir)
        .map_err(|e| format!("création de {} impossible: {e}", dir.display()))?;
    Ok(dir)
}

/// Nom de fichier sûr pour une icône : l'identifiant de jeu ne doit jamais
/// pouvoir sortir du dossier `icons`.
fn icon_file(game_id: &str) -> Result<String, String> {
    let safe: String = game_id
        .chars()
        .filter(|c| c.is_ascii_alphanumeric() || *c == '-' || *c == '_')
        .take(96)
        .collect();
    if safe.is_empty() {
        return Err("identifiant de jeu invalide pour l'icône".to_string());
    }
    Ok(format!("{safe}.png"))
}

#[cfg(target_os = "windows")]
fn cached_icon_url(file: &str, stamp: u64) -> String {
    format!("http://{COVERS_SCHEME}.localhost/{file}?v={stamp}&kind=icon")
}

fn image_mime(bytes: &[u8]) -> &'static str {
    if bytes.starts_with(&[0xFF, 0xD8, 0xFF]) {
        "image/jpeg"
    } else if bytes.starts_with(&[0x89, b'P', b'N', b'G']) {
        "image/png"
    } else if bytes.len() >= 12 && &bytes[0..4] == b"RIFF" && &bytes[8..12] == b"WEBP" {
        "image/webp"
    } else if bytes.starts_with(b"GIF8") {
        "image/gif"
    } else {
        "application/octet-stream"
    }
}

async fn download_image(
    client: &reqwest::Client,
    url: &str,
    destination: &Path,
) -> Result<(), String> {
    let response = client
        .get(url)
        .send()
        .await
        .map_err(|e| format!("téléchargement de {url} impossible: {e}"))?;
    if !response.status().is_success() {
        return Err(format!("{url}: HTTP {}", response.status()));
    }
    let bytes = response
        .bytes()
        .await
        .map_err(|e| format!("lecture de {url} impossible: {e}"))?;
    if bytes.len() < 1024 {
        return Err(format!("{url}: réponse trop courte pour une image"));
    }
    fs::write(destination, &bytes)
        .map_err(|e| format!("écriture de {} impossible: {e}", destination.display()))
}

fn steam_candidates(appid: &str, kind: ArtworkKind) -> Vec<String> {
    let base = format!("{STEAM_ARTWORK}/{appid}");
    match kind {
        ArtworkKind::Cover => vec![
            format!("{base}/library_600x900_2x.jpg"),
            format!("{base}/library_600x900.jpg"),
            format!("{base}/header.jpg"),
        ],
        ArtworkKind::Hero => vec![
            format!("{base}/library_hero_2x.jpg"),
            format!("{base}/library_hero.jpg"),
            format!("{base}/header.jpg"),
        ],
    }
}

/// Meilleure image SteamGridDB pour le fond héros d'un appid Steam.
async fn steamgriddb_hero_url(
    client: &reqwest::Client,
    api_key: &str,
    appid: &str,
) -> Option<String> {
    let url = format!(
        "{STEAMGRIDDB_API}/heroes/steam/{appid}?dimensions=3840x1240,1920x620&types=static&nsfw=false&humor=false"
    );
    let response = client.get(&url).bearer_auth(api_key).send().await.ok()?;
    if !response.status().is_success() {
        return None;
    }
    let payload: serde_json::Value = response.json().await.ok()?;
    best_sgdb_image_url(payload.get("data")?.as_array()?, (3840, 1240))
}

/// Encodage minimal d'un segment de chemin pour la recherche SteamGridDB.
fn encode_path_segment(raw: &str) -> String {
    let mut out = String::with_capacity(raw.len());
    for byte in raw.bytes() {
        match byte {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                out.push(byte as char)
            }
            b' ' => out.push_str("%20"),
            _ => out.push_str(&format!("%{:02X}", byte)),
        }
    }
    out
}

fn best_sgdb_image_url(items: &[serde_json::Value], preferred: (u64, u64)) -> Option<String> {
    let mut best: Option<(u8, f64, String)> = None;
    for item in items {
        let Some(raw) = item.get("url").and_then(serde_json::Value::as_str) else {
            continue;
        };
        let candidate = if raw.starts_with("http://") || raw.starts_with("https://") {
            raw.to_string()
        } else {
            format!("https://{raw}")
        };
        let width = item
            .get("width")
            .and_then(serde_json::Value::as_u64)
            .unwrap_or(0);
        let height = item
            .get("height")
            .and_then(serde_json::Value::as_u64)
            .unwrap_or(0);
        let score = item
            .get("score")
            .and_then(serde_json::Value::as_f64)
            .unwrap_or(0.0);
        let rank = if (width, height) == preferred {
            0u8
        } else if width >= preferred.0 && height >= preferred.1 {
            1
        } else {
            2
        };
        let improves = match &best {
            None => true,
            Some((current_rank, current_score, _)) => {
                rank < *current_rank || (rank == *current_rank && score > *current_score)
            }
        };
        if improves {
            best = Some((rank, score, candidate));
        }
    }
    best.map(|(_, _, url)| url)
}

/// Grilles carrées 1024×1024 / 512×512 pour un jeu SteamGridDB identifié.
async fn sgdb_square_cover_by_id(
    client: &reqwest::Client,
    api_key: &str,
    path: &str,
) -> Option<String> {
    let url = format!(
        "{STEAMGRIDDB_API}/grids/{path}?dimensions=1024x1024,512x512&types=static&nsfw=false&humor=false"
    );
    let response = client.get(&url).bearer_auth(api_key).send().await.ok()?;
    if !response.status().is_success() {
        return None;
    }
    let payload: serde_json::Value = response.json().await.ok()?;
    let items = payload.get("data")?.as_array()?;
    if items.is_empty() {
        return None;
    }
    best_sgdb_image_url(items, (1024, 1024))
}

/// Recherche une jaquette carrée SteamGridDB : d'abord par appid Steam, sinon
/// par recherche de nom nettoyé (autocomplete → id SGDB → grilles carrées).
async fn steamgriddb_square_cover_url(
    client: &reqwest::Client,
    api_key: &str,
    appid: Option<&str>,
    title: &str,
) -> Option<String> {
    if let Some(appid) = appid {
        if let Some(url) = sgdb_square_cover_by_id(client, api_key, &format!("steam/{appid}")).await
        {
            return Some(url);
        }
    }

    let cleaned = clean_search_title(title);
    if cleaned.trim().is_empty() {
        return None;
    }
    let search_url = format!(
        "{STEAMGRIDDB_API}/search/autocomplete/{}",
        encode_path_segment(cleaned.trim())
    );
    let response = client
        .get(&search_url)
        .bearer_auth(api_key)
        .send()
        .await
        .ok()?;
    if !response.status().is_success() {
        return None;
    }
    let payload: serde_json::Value = response.json().await.ok()?;
    let sgdb_id = payload
        .get("data")?
        .as_array()?
        .first()?
        .get("id")?
        .as_u64()?;
    sgdb_square_cover_by_id(client, api_key, &format!("game/{sgdb_id}")).await
}

/* ────────────── Fenêtre du jeu : attente de la première image ────────────── */

/// Payload de disponibilité du jeu : le splash peut rendre la main.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct GameWindowReady {
    game_id: String,
}

#[cfg(target_os = "windows")]
mod game_window {
    use super::{GameWindowReady, path_is_inside};
    use std::collections::HashSet;
    use std::path::{Path, PathBuf};
    use std::sync::Arc;
    use std::sync::atomic::{AtomicBool, Ordering};
    use std::time::{Duration, Instant};
    use tauri::{Emitter, Manager};
    use winapi::shared::minwindef::{BOOL, DWORD, FALSE, LPARAM, TRUE};
    use winapi::shared::windef::{HWND, RECT};
    use winapi::um::dwmapi::{DWMWA_CLOAKED, DwmGetWindowAttribute};
    use winapi::um::handleapi::CloseHandle;
    use winapi::um::processthreadsapi::{GetCurrentProcessId, OpenProcess};
    use winapi::um::winbase::QueryFullProcessImageNameW;
    use winapi::um::winnt::PROCESS_QUERY_LIMITED_INFORMATION;
    use winapi::um::winuser::{
        EnumWindows, GetWindowRect, GetWindowThreadProcessId, IsWindowVisible, SW_RESTORE,
        SetForegroundWindow, ShowWindow,
    };

    /// Attente maximale de l'apparition de la fenêtre du jeu.
    const TIMEOUT: Duration = Duration::from_secs(45);
    /// Fréquence d'énumération des fenêtres de premier niveau.
    const POLL_INTERVAL: Duration = Duration::from_millis(200);
    /// Délai après création : DirectX / Vulkan présente sa première image.
    const FRAME_DELAY: Duration = Duration::from_millis(400);
    /// Taille minimale : ignore les popups Steam et les overlays d'anticheat.
    const MIN_WIDTH: i32 = 640;
    const MIN_HEIGHT: i32 = 480;

    /// Fenêtres visibles avant le lancement, hors launcher : toute nouvelle
    /// fenêtre absente de cet ensemble est candidate.
    pub(super) fn snapshot() -> HashSet<isize> {
        unsafe extern "system" fn collect(hwnd: HWND, lparam: LPARAM) -> BOOL {
            let windows = unsafe { &mut *(lparam as *mut HashSet<isize>) };
            let mut pid = 0u32;
            unsafe { GetWindowThreadProcessId(hwnd, &mut pid) };
            if pid != 0
                && pid != unsafe { GetCurrentProcessId() }
                && unsafe { IsWindowVisible(hwnd) } != 0
            {
                windows.insert(hwnd as isize);
            }
            TRUE
        }

        let mut windows = HashSet::new();
        unsafe {
            EnumWindows(Some(collect), &mut windows as *mut _ as LPARAM);
        }
        windows
    }

    /// Ramène au premier plan la première fenêtre visible du processus.
    /// Retourne `false` si le processus n'a pas encore de fenêtre.
    pub(super) fn focus_pid(target_pid: u32) -> bool {
        struct Search {
            target_pid: u32,
            hwnd: Option<HWND>,
        }

        unsafe extern "system" fn inspect(hwnd: HWND, lparam: LPARAM) -> BOOL {
            let search = unsafe { &mut *(lparam as *mut Search) };
            if search.hwnd.is_some() {
                return FALSE;
            }
            let mut pid = 0u32;
            unsafe { GetWindowThreadProcessId(hwnd, &mut pid) };
            if pid != search.target_pid || unsafe { IsWindowVisible(hwnd) } == 0 {
                return TRUE;
            }
            search.hwnd = Some(hwnd);
            FALSE
        }

        let mut search = Search {
            target_pid,
            hwnd: None,
        };
        unsafe {
            EnumWindows(Some(inspect), &mut search as *mut _ as LPARAM);
        }
        let Some(hwnd) = search.hwnd else {
            return false;
        };
        unsafe {
            ShowWindow(hwnd, SW_RESTORE);
            SetForegroundWindow(hwnd);
        }
        true
    }

    /// Chemin de l'exécutable propriétaire d'un processus, si accessible.
    fn process_path(pid: u32) -> Option<PathBuf> {
        use std::os::windows::ffi::OsStringExt;

        let process = unsafe { OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, FALSE, pid) };
        if process.is_null() {
            return None;
        }
        let mut buffer = [0u16; 1024];
        let mut size = buffer.len() as DWORD;
        let read =
            unsafe { QueryFullProcessImageNameW(process, 0, buffer.as_mut_ptr(), &mut size) };
        unsafe { CloseHandle(process) };
        if read == 0 || size == 0 {
            return None;
        }
        Some(PathBuf::from(std::ffi::OsString::from_wide(
            &buffer[..size as usize],
        )))
    }

    /// Nouvelle fenêtre du jeu : priorité au processus installé dans le dossier
    /// du jeu, sinon la première grande fenêtre apparue depuis le snapshot.
    fn find(snapshot: &HashSet<isize>, game_root: &Path) -> Option<HWND> {
        struct Search<'a> {
            snapshot: &'a HashSet<isize>,
            game_root: &'a Path,
            fallback: Option<HWND>,
            priority: Option<HWND>,
        }

        unsafe extern "system" fn inspect(hwnd: HWND, lparam: LPARAM) -> BOOL {
            let search = unsafe { &mut *(lparam as *mut Search<'_>) };
            if search.priority.is_some() {
                return FALSE;
            }
            if search.snapshot.contains(&(hwnd as isize)) {
                return TRUE;
            }
            if unsafe { IsWindowVisible(hwnd) } == 0 {
                return TRUE;
            }

            let mut pid = 0u32;
            unsafe { GetWindowThreadProcessId(hwnd, &mut pid) };
            if pid == 0 || pid == unsafe { GetCurrentProcessId() } {
                return TRUE;
            }

            let mut cloaked = 0u32;
            let cloaked_result = unsafe {
                DwmGetWindowAttribute(
                    hwnd,
                    DWMWA_CLOAKED as DWORD,
                    &mut cloaked as *mut u32 as *mut _,
                    std::mem::size_of::<u32>() as DWORD,
                )
            };
            if cloaked_result == 0 && cloaked != 0 {
                return TRUE;
            }

            let mut rect: RECT = unsafe { std::mem::zeroed() };
            if unsafe { GetWindowRect(hwnd, &mut rect) } == 0
                || rect.right - rect.left < MIN_WIDTH
                || rect.bottom - rect.top < MIN_HEIGHT
            {
                return TRUE;
            }

            if process_path(pid).is_some_and(|path| path_is_inside(&path, search.game_root)) {
                search.priority = Some(hwnd);
                return FALSE;
            }
            if search.fallback.is_none() {
                search.fallback = Some(hwnd);
            }
            TRUE
        }

        let mut search = Search {
            snapshot,
            game_root,
            fallback: None,
            priority: None,
        };
        unsafe {
            EnumWindows(Some(inspect), &mut search as *mut _ as LPARAM);
        }
        search.priority.or(search.fallback)
    }

    /// Range le launcher derrière le jeu et retire le premier plan forcé.
    fn dismiss_launcher(app: &tauri::AppHandle) {
        if let Some(window) = app.get_webview_window("main") {
            let _ = window.set_always_on_top(false);
            let _ = window.minimize();
        }
    }

    /// Attend la fenêtre du jeu puis lui donne le premier plan. Le polling
    /// s'arrête dès la fenêtre trouvée, au timeout ou à la fin de la session.
    pub(super) fn watch(
        app: tauri::AppHandle,
        game_root: PathBuf,
        game_id: String,
        snapshot: HashSet<isize>,
        stop: Arc<AtomicBool>,
    ) {
        let deadline = Instant::now() + TIMEOUT;
        let hwnd = loop {
            if stop.load(Ordering::Relaxed) {
                return;
            }
            if let Some(hwnd) = find(&snapshot, &game_root) {
                break hwnd;
            }
            if Instant::now() >= deadline {
                eprintln!(
                    "[jeu] fenêtre de {game_id} introuvable après {} s",
                    TIMEOUT.as_secs()
                );
                // Le splash se referme de lui-même après 45 s : rendre la main
                // à l'accueil plutôt que de révéler le bureau.
                if let Some(window) = app.get_webview_window("main") {
                    let _ = window.set_always_on_top(false);
                }
                return;
            }
            std::thread::sleep(POLL_INTERVAL);
        };

        // Le jeu vient de créer sa fenêtre : laisser le moteur graphique
        // présenter sa première image avant de retirer le splash.
        std::thread::sleep(FRAME_DELAY);
        if stop.load(Ordering::Relaxed) {
            return;
        }

        unsafe {
            ShowWindow(hwnd, SW_RESTORE);
            SetForegroundWindow(hwnd);
        }
        dismiss_launcher(&app);
        if let Err(error) = app.emit("game-window-ready", GameWindowReady { game_id }) {
            eprintln!("[jeu] émission de game-window-ready impossible: {error}");
        }
    }
}

/// Détection d'un processus déjà actif par son nom d'exécutable.
/// Win32 uniquement : permet de ne jamais démarrer un second `Game.exe`.
#[cfg(target_os = "windows")]
mod process_guard {
    use std::path::Path;
    use winapi::shared::minwindef::FALSE;
    use winapi::um::handleapi::{CloseHandle, INVALID_HANDLE_VALUE};
    use winapi::um::tlhelp32::{
        CreateToolhelp32Snapshot, PROCESSENTRY32W, Process32FirstW, Process32NextW,
        TH32CS_SNAPPROCESS,
    };

    /// PID du premier processus dont le nom correspond, hors launcher.
    pub(super) fn find_pid(exe: &Path) -> Option<u32> {
        let target = exe.file_name()?.to_string_lossy().to_string();
        if target.is_empty() {
            return None;
        }

        unsafe {
            let snapshot = CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0);
            if snapshot == INVALID_HANDLE_VALUE {
                eprintln!("[jeu] snapshot des processus indisponible");
                return None;
            }

            let mut entry: PROCESSENTRY32W = std::mem::zeroed();
            entry.dwSize = std::mem::size_of::<PROCESSENTRY32W>() as u32;
            let mut current = Process32FirstW(snapshot, &mut entry);
            let mut found = None;
            while current != FALSE {
                let len = entry
                    .szExeFile
                    .iter()
                    .position(|character| *character == 0)
                    .unwrap_or(entry.szExeFile.len());
                let name = String::from_utf16_lossy(&entry.szExeFile[..len]);
                if entry.th32ProcessID != std::process::id() && name.eq_ignore_ascii_case(&target) {
                    found = Some(entry.th32ProcessID);
                    break;
                }
                current = Process32NextW(snapshot, &mut entry);
            }
            CloseHandle(snapshot);
            found
        }
    }
}

// --------------------------------------------------------------------------
// Suivi du jeu lancé : temps de jeu réel, même avec un lanceur intermédiaire.
// --------------------------------------------------------------------------

/// Écart entre deux lectures de la table des processus : 5 s suffisent pour
/// mesurer une session et gardent un coût CPU nul pendant la partie.
const PROCESS_POLL_INTERVAL: Duration = Duration::from_secs(5);

/// Fenêtre de grâce après la sortie d'un bootstrapper (6 à 8 s) : le vrai jeu
/// a le temps de créer ses processus avant le premier verdict.
const BOOTSTRAP_GRACE: Duration = Duration::from_secs(7);

/// Un exécutable qui rend la main en moins de 15 s est un lanceur intermédiaire
/// (Rockstar, REDlauncher, `cmd /c start`, `.bat`…).
const QUICK_EXIT: Duration = Duration::from_secs(15);

/// Attente maximale d'un lanceur lent quand aucun processus du jeu n'a encore
/// été observé : au-delà, la session est conclue.
const STARTUP_BUDGET: Duration = Duration::from_secs(60);

/// Profondeur d'exploration du dossier du jeu et plafond d'entrées lues : ce
/// scan a lieu une seule fois au lancement, jamais pendant la partie.
const SCAN_DEPTH: u8 = 3;
const SCAN_LIMIT: usize = 4000;

/// Dossiers techniques ignorés pendant la recherche des exécutables.
const SKIPPED_DIRS: [&str; 9] = [
    "_commonredist",
    "redist",
    "redistributables",
    "directx",
    "vcredist",
    "support",
    "installers",
    ".git",
    "node_modules",
];

/// Préfixes d'utilitaires jamais pris pour le jeu principal.
const UTILITY_PREFIXES: [&str; 10] = [
    "unins",
    "crashreport",
    "unitycrashhandler",
    "vc_redist",
    "vcredist",
    "dxsetup",
    "dxwebsetup",
    "redprelauncher",
    "setup",
    "install",
];

/// Dossiers d'exécutables à dépasser pour retrouver la racine du jeu.
#[cfg(any(target_os = "windows", test))]
const BINARY_DIRS: [&str; 8] = [
    "bin", "bin32", "bin64", "binaries", "win32", "win64", "x64", "x86",
];

/// Racine du jeu : `...\Jeu\Binaries\Win64\Jeu.exe` → `...\Jeu`, et pour un
/// bundle macOS `.../Jeu.app/Contents/MacOS/Jeu` → `.../Jeu.app`.
fn game_root_dir(executable: &Path) -> PathBuf {
    #[cfg(target_os = "macos")]
    for ancestor in executable.ancestors() {
        let is_bundle = ancestor
            .extension()
            .is_some_and(|extension| extension.eq_ignore_ascii_case("app"));
        if is_bundle {
            return ancestor.to_path_buf();
        }
    }

    let parent = executable
        .parent()
        .map(Path::to_path_buf)
        .unwrap_or_else(|| PathBuf::from("."));
    #[cfg(any(target_os = "windows", test))]
    {
        let mut current = parent;
        for _ in 0..BINARY_DIRS.len() {
            let name = current
                .file_name()
                .and_then(|name| name.to_str())
                .map(str::to_ascii_lowercase)
                .unwrap_or_default();
            if !BINARY_DIRS.contains(&name.as_str()) {
                break;
            }
            match current.parent() {
                Some(parent) => current = parent.to_path_buf(),
                None => break,
            }
        }
        return current;
    }

    #[cfg(not(any(target_os = "windows", test)))]
    parent
}

/// Un exécutable appartient-il au jeu ? Comparaison insensible à la casse et
/// aux séparateurs, sans confondre `\Doom` avec `\Doom Eternal`.
fn path_is_inside(candidate: &Path, root: &Path) -> bool {
    let separator = std::path::MAIN_SEPARATOR.to_string();
    let normalize = |path: &Path| {
        let raw = path.to_string_lossy().to_string();
        // Préfixe canonique `\\?\` retiré avant l'unification des séparateurs.
        let raw = raw
            .strip_prefix("\\\\?\\")
            .map(str::to_string)
            .unwrap_or(raw);
        let mut raw = raw.replace(['/', '\\'], &separator);
        // Windows et macOS (APFS par défaut) sont insensibles à la casse.
        #[cfg(any(target_os = "windows", target_os = "macos"))]
        {
            raw = raw.to_lowercase();
        }
        let trimmed = raw.trim_end_matches(std::path::MAIN_SEPARATOR).to_string();
        if trimmed.ends_with(':') {
            format!("{trimmed}{separator}")
        } else {
            trimmed
        }
    };
    let root = normalize(root);
    let candidate = normalize(candidate);
    if root.is_empty() || !candidate.starts_with(&root) {
        return false;
    }
    matches!(
        candidate[root.len()..].chars().next(),
        None | Some(std::path::MAIN_SEPARATOR)
    )
}

/// Ajoute un nom d'exécutable et son radical : `sysinfo` renvoie tantôt
/// `Game.exe`, tantôt `Game` selon la plateforme qui publie le nom.
fn insert_process_name(names: &mut HashSet<String>, name: &str) {
    let lower = name.to_ascii_lowercase();
    if let Some((stem, _)) = lower.rsplit_once('.') {
        names.insert(stem.to_string());
    }
    names.insert(lower);
}

/// Utilitaire d'installation, de crash ou de redistribuable : jamais le jeu.
fn is_utility_executable(name: &str) -> bool {
    let lower = name.to_ascii_lowercase();
    UTILITY_PREFIXES
        .iter()
        .any(|prefix| lower.starts_with(prefix))
}

/// Vrai si le fichier peut être l'exécutable principal du jeu.
fn is_game_executable(path: &Path) -> bool {
    let extension = path
        .extension()
        .and_then(|extension| extension.to_str())
        .unwrap_or("")
        .to_ascii_lowercase();

    #[cfg(target_os = "windows")]
    return extension == "exe";

    #[cfg(target_os = "macos")]
    return extension.is_empty() || extension == "exe";

    #[cfg(not(any(target_os = "windows", target_os = "macos")))]
    {
        use std::os::unix::fs::PermissionsExt;
        if extension == "exe" {
            return true;
        }
        extension.is_empty()
            && path
                .metadata()
                .is_ok_and(|metadata| metadata.permissions().mode() & 0o111 != 0)
    }
}

/// Exécutables candidats sous la racine du jeu (profondeur ≤ 3), hors
/// utilitaires. Aucun accès disque n'est fait ensuite pendant la session.
fn scan_game_executables(root: &Path) -> Vec<PathBuf> {
    let mut found = Vec::new();
    let mut budget = SCAN_LIMIT;
    let mut stack = vec![(root.to_path_buf(), 0u8)];
    while let Some((directory, depth)) = stack.pop() {
        // Trois niveaux de sous-dossiers au maximum.
        if depth >= SCAN_DEPTH {
            continue;
        }
        let Ok(entries) = fs::read_dir(&directory) else {
            continue;
        };
        for entry in entries.flatten() {
            if budget == 0 {
                break;
            }
            budget -= 1;
            let path = entry.path();
            if path.is_dir() {
                let name = path
                    .file_name()
                    .and_then(|name| name.to_str())
                    .unwrap_or_default()
                    .to_ascii_lowercase();
                if depth + 1 < SCAN_DEPTH && !SKIPPED_DIRS.contains(&name.as_str()) {
                    stack.push((path, depth + 1));
                }
                continue;
            }
            let Some(name) = path.file_name().and_then(|name| name.to_str()) else {
                continue;
            };
            if is_utility_executable(name) || !is_game_executable(&path) {
                continue;
            }
            found.push(path);
            // Une bibliothèque de jeux peut être volumineuse : on s'arrête tôt.
            if found.len() >= 64 {
                return found;
            }
        }
    }
    found
}

/// Fenêtre de démarrage raté : session plus courte que cette durée avec un
/// code de sortie non nul.
const CRASH_WINDOW: std::time::Duration = std::time::Duration::from_secs(2);

/// Un seul lancement de jeu à la fois, pendant toute la session : les appels
/// concurrents (clavier, clic, manette) sont rejetés avant tout `Command::new`.
static GAME_LAUNCH_LOCK: AtomicBool = AtomicBool::new(false);

/// Cible réelle d'un lancement : programme exécuté, dossier d'installation du
/// jeu, et exécutables reconnus pendant toute la session.
struct LaunchPlan {
    program: PathBuf,
    args: Vec<String>,
    workdir: PathBuf,
    root: PathBuf,
    names: HashSet<String>,
    /// Lancement indirect : raccourci, `.url`, `.bat` ou bundle `.app`. Le
    /// processus initial n'est alors pas le jeu.
    indirect: bool,
}

#[cfg(target_os = "windows")]
fn resolve_windows_shortcut(path: &Path) -> Option<PathBuf> {
    use std::os::windows::process::CommandExt;

    // CREATE_NO_WINDOW : la résolution ne fait clignoter aucune console.
    const CREATE_NO_WINDOW: u32 = 0x0800_0000;
    let escaped = path.to_string_lossy().replace('\'', "''");
    let script = format!(
        "(New-Object -ComObject WScript.Shell).CreateShortcut('{escaped}').TargetPath"
    );
    let output = std::process::Command::new("powershell")
        .args(["-NoProfile", "-NonInteractive", "-Command", script.as_str()])
        .creation_flags(CREATE_NO_WINDOW)
        .output()
        .ok()?;
    if !output.status.success() {
        return None;
    }
    let raw = String::from_utf8_lossy(&output.stdout).trim().to_string();
    if raw.is_empty() {
        return None;
    }
    let target = PathBuf::from(raw);
    target.is_file().then_some(target)
}

/// Hors Windows, aucun raccourci `.lnk` n'existe : rien à résoudre.
#[cfg(not(target_os = "windows"))]
fn resolve_windows_shortcut(_path: &Path) -> Option<PathBuf> {
    None
}

/// Chemin réel visé par un raccourci `.lnk` (Windows) ou `.url`.
fn resolve_shortcut(path: &Path) -> Option<PathBuf> {
    let extension = path
        .extension()
        .and_then(|extension| extension.to_str())?
        .to_ascii_lowercase();
    match extension.as_str() {
        "lnk" => resolve_windows_shortcut(path),
        "url" => {
            let content = fs::read_to_string(path).ok()?;
            let target = content.lines().find_map(|line| {
                let (key, value) = line.split_once('=')?;
                if key.trim().eq_ignore_ascii_case("url") {
                    Some(value.trim().to_string())
                } else {
                    None
                }
            })?;
            let candidate = PathBuf::from(target);
            candidate.is_file().then_some(candidate)
        }
        _ => None,
    }
}

impl LaunchPlan {
    /// Prépare le lancement : résout le raccourci pour retrouver le dossier
    /// d'installation, choisit le programme à exécuter et liste les
    /// exécutables candidats du jeu.
    fn build(exe: &Path, options: &[String]) -> Self {
        let extension = exe
            .extension()
            .and_then(|extension| extension.to_str())
            .unwrap_or("")
            .to_ascii_lowercase();
        let resolved = resolve_shortcut(exe);
        let target = resolved.clone().unwrap_or_else(|| exe.to_path_buf());
        let root = game_root_dir(&target);
        let workdir = exe
            .parent()
            .map(Path::to_path_buf)
            .unwrap_or_else(|| root.clone());

        let mut program = exe.to_path_buf();
        let mut args = options.to_vec();
        let mut indirect = false;

        #[cfg(target_os = "windows")]
        {
            match extension.as_str() {
                // Un `.lnk` ou un `.url` passe par le shell : `Command` ne sait
                // pas les exécuter directement. Le processus initial rend la
                // main aussitôt, d'où le suivi par dossier / nom.
                "lnk" | "url" => {
                    program = PathBuf::from("cmd");
                    args = vec![
                        "/C".to_string(),
                        "start".to_string(),
                        String::new(),
                        exe.to_string_lossy().to_string(),
                    ];
                    indirect = true;
                }
                "bat" | "cmd" => {
                    program = PathBuf::from("cmd");
                    args = vec![
                        "/C".to_string(),
                        "call".to_string(),
                        exe.to_string_lossy().to_string(),
                    ];
                    indirect = true;
                }
                _ => {}
            }
        }

        #[cfg(target_os = "macos")]
        if extension == "app" || extension == "webloc" || extension == "url" {
            // Un bundle `.app` est un dossier : il s'ouvre par LaunchServices.
            program = PathBuf::from("open");
            args = vec![exe.to_string_lossy().to_string()];
            indirect = true;
        }

        // Le parent d'un raccourci non résolu peut être le Bureau : dans ce cas
        // on se fie seulement au nom d'exécutable.
        let scan = resolved.is_some() || extension != "lnk";
        let mut names = HashSet::new();
        if scan {
            for candidate in scan_game_executables(&root) {
                if let Some(name) = candidate.file_name().and_then(|name| name.to_str()) {
                    insert_process_name(&mut names, name);
                }
            }
        }
        for candidate in [&target, exe] {
            if let Some(name) = candidate.file_name().and_then(|name| name.to_str()) {
                insert_process_name(&mut names, name);
            }
        }

        Self {
            program,
            args,
            workdir,
            root,
            names,
            indirect,
        }
    }
}

/// Démarre le jeu depuis son dossier (DLL et sauvegardes locales incluses).
fn spawn_game(plan: &LaunchPlan, title: &str) -> Result<std::process::Child, String> {
    let mut command = std::process::Command::new(&plan.program);
    command
        .current_dir(&plan.workdir)
        .args(&plan.args)
        // Aucun descripteur bloquant hérité : les sorties du jeu ne retiennent
        // ni le launcher ni un pipe ouvert.
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null());

    // CREATE_NEW_PROCESS_GROUP : le jeu ne partage pas le groupe de processus
    // du launcher et peut être détaché proprement, comme un jeu non-Steam.
    #[cfg(target_os = "windows")]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NEW_PROCESS_GROUP: u32 = 0x0000_0200;
        command.creation_flags(CREATE_NEW_PROCESS_GROUP);
    }

    command
        .spawn()
        .map_err(|error| format!("lancement de {title} impossible: {error}"))
}

/// Vrai si un processus du jeu est encore actif : processus lancé, descendant,
/// exécutable installé dans le dossier du jeu, ou nom d'exécutable connu.
fn find_game_process(system: &mut System, plan: &LaunchPlan, initial_pid: u32) -> bool {
    // Seul le chemin des exécutables est relu : ni environnement, ni CPU ni
    // mémoire pour l'ensemble de la table des processus.
    system.refresh_processes_specifics(
        ProcessesToUpdate::All,
        true,
        ProcessRefreshKind::new().with_exe(UpdateKind::OnlyIfNotSet),
    );

    let initial = Pid::from_u32(initial_pid);
    let launcher = std::process::id();
    // PID 0 : session adoptée (jeu déjà lancé), aucun parent à remonter.
    let track_pid = initial_pid != 0;

    // Descendants du processus lancé, directs ou indirects (un bootstrapper
    // peut lui-même relancer un second processus).
    let mut descendants: HashSet<Pid> = HashSet::new();
    let mut grew = track_pid;
    while grew {
        grew = false;
        for (pid, process) in system.processes() {
            if *pid == initial || descendants.contains(pid) {
                continue;
            }
            let from_session = process
                .parent()
                .is_some_and(|parent| parent == initial || descendants.contains(&parent));
            if from_session {
                descendants.insert(*pid);
                grew = true;
            }
        }
    }

    // Racine d'un disque : trop large pour servir de filtre de chemin.
    let match_path = plan.root.parent().is_some();
    for (pid, process) in system.processes() {
        if pid.as_u32() == launcher {
            continue;
        }
        if track_pid && (*pid == initial || descendants.contains(pid)) {
            return true;
        }
        // Nom publié par la table des processus : disponible même quand le
        // chemin exact est refusé (processus élevé, protégé ou d'un autre
        // utilisateur).
        if plan
            .names
            .contains(&process.name().to_string_lossy().to_ascii_lowercase())
        {
            return true;
        }
        let Some(exe) = process.exe() else {
            continue;
        };
        if match_path && path_is_inside(exe, &plan.root) {
            return true;
        }
        if exe
            .file_name()
            .and_then(|name| name.to_str())
            .is_some_and(|name| plan.names.contains(&name.to_ascii_lowercase()))
        {
            return true;
        }
    }
    false
}

/// Surveille la session toutes les 5 s et renvoie la durée réelle une fois le
/// dernier processus du jeu terminé. Aucune boucle ne tourne dans la WebView.
fn monitor_game_session(
    plan: &LaunchPlan,
    initial_pid: u32,
    child_exited: &AtomicBool,
    fast_failure: &AtomicBool,
    exit_code: &Mutex<Option<i32>>,
    exit_at: &Mutex<Option<Instant>>,
    started: Instant,
) -> (Duration, Option<i32>) {
    let mut system = System::new();
    let mut last_seen = started;
    let mut observed = false;
    let mut bootstrap_exited = false;
    // Lancement direct : le programme exécuté est lui-même dans le dossier du
    // jeu, donc aucun lanceur ne peut apparaître après sa sortie.
    let direct = !plan.indirect && path_is_inside(&plan.program, &plan.root);
    // Lancement indirect : laisser le shell ou le lanceur démarrer le jeu.
    let mut grace_deadline = plan.indirect.then(|| Instant::now() + BOOTSTRAP_GRACE);

    loop {
        std::thread::sleep(PROCESS_POLL_INTERVAL);
        let now = Instant::now();
        let child_alive = !child_exited.load(Ordering::Relaxed);
        let matching = child_alive || find_game_process(&mut system, plan, initial_pid);
        if matching {
            observed = true;
            last_seen = now;
        }

        if !child_alive && !bootstrap_exited {
            bootstrap_exited = true;
            // Échec immédiat (code non nul) : aucun lanceur à attendre.
            if fast_failure.load(Ordering::Relaxed) && !matching {
                break;
            }
            // Sortie rapide : c'était un bootstrapper, le vrai jeu arrive.
            if now.duration_since(started) < QUICK_EXIT && grace_deadline.is_none() {
                grace_deadline = Some(now + BOOTSTRAP_GRACE);
            }
        }

        if matching || grace_deadline.is_some_and(|deadline| now < deadline) {
            continue;
        }
        // Rien n'a encore été vu : un lanceur lent peut encore démarrer le jeu.
        // Un jeu lancé directement n'a personne à attendre.
        if !observed && !direct && now.duration_since(started) < STARTUP_BUDGET {
            continue;
        }
        break;
    }

    // Session reconnue : dernière observation. Sinon, seule la durée du
    // processus réellement lancé est créditée (échec de démarrage).
    let elapsed = if observed {
        last_seen.saturating_duration_since(started)
    } else {
        exit_at
            .lock()
            .ok()
            .and_then(|slot| *slot)
            .map(|at| at.saturating_duration_since(started))
            .unwrap_or_default()
    };
    let code = exit_code.lock().ok().and_then(|slot| *slot);
    (elapsed, code)
}

/// Payload de fin de session : le front crédite la durée au jeu concerné.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct GameSessionEnded {
    game_id: String,
    duration_seconds: u64,
    /// Total cumulé déjà écrit sur le disque : le front n'a rien à additionner.
    total_playtime_seconds: u64,
    /// Date de la dernière session (ms epoch), pour le tri « Récents ».
    last_played: Option<u64>,
    exit_code: Option<i32>,
    crashed: bool,
}

/// Dossier d'installation du jeu : racine utile (dossier du bundle `.app`,
/// dossier parent de l'exécutable) où chercher AppID et succès locaux.
fn game_install_dir(game: &Game) -> Option<PathBuf> {
    if game.exe_path.trim().is_empty() {
        return None;
    }
    Some(game_root_dir(&PathBuf::from(game.exe_path.trim())))
}

/// Dossier d'un jeu déjà associé à un AppID (pour lire ses succès locaux).
pub(crate) fn game_dir_for_appid(app: &tauri::AppHandle, appid: &str) -> Option<PathBuf> {
    load_games(app)
        .ok()?
        .iter()
        .find(|game| game.steam_appid.as_deref() == Some(appid))
        .and_then(game_install_dir)
}

/// AppID d'un jeu : métadonnées, puis détection locale dans son dossier, puis
/// recherche Steam par titre normalisé. Le résultat est mémorisé sur disque.
async fn resolve_game_appid(app: &tauri::AppHandle, game: &Game) -> Option<String> {
    if let Some(appid) = game.steam_appid.as_ref().filter(|id| !id.is_empty()) {
        return Some(appid.clone());
    }

    let mut found = game_install_dir(game).and_then(|dir| find_steam_appid(&dir));
    if found.is_none() {
        let client = reqwest::Client::builder()
            .user_agent(concat!("ps4-launcher/", env!("CARGO_PKG_VERSION")))
            .timeout(std::time::Duration::from_secs(20))
            .build()
            .ok()?;
        found = search_steam_appid(&client, &game.title).await.ok().flatten();
    }
    let appid = found?;

    if let Ok(mut games) = load_games(app) {
        if let Some(entry) = games.iter_mut().find(|entry| entry.id == game.id) {
            entry.steam_appid = Some(appid.clone());
        }
        if let Err(error) = save_games(app, &games) {
            eprintln!("[trophées] mémorisation de l'AppID impossible: {error}");
        }
    }
    Some(appid)
}

/// Résolution + synchronisation multi-sources d'un jeu, puis diffusion du
/// rapport complet au frontend (`trophies-updated`).
async fn sync_trophies_for_game(
    app: &tauri::AppHandle,
    game_id: &str,
) -> Result<trophies::TrophyReport, String> {
    let games = load_games(app)?;
    let game = games
        .iter()
        .find(|game| game.id == game_id)
        .ok_or_else(|| format!("jeu introuvable: {game_id}"))?;
    let appid = resolve_game_appid(app, game)
        .await
        .ok_or_else(|| format!("Steam AppID introuvable pour « {} »", game.title))?;
    let game_dir = game_install_dir(game);
    let report = trophies::build_report(app.clone(), appid, game_dir, true).await?;
    trophies::emit_updated(app, game_id, &report);
    Ok(report)
}

/// Action « Synchroniser les trophées » de l'écran Trophées.
#[tauri::command]
async fn sync_game_trophies(
    app: tauri::AppHandle,
    game_id: String,
) -> Result<trophies::TrophyReport, String> {
    sync_trophies_for_game(&app, &game_id).await
}

/// Synchronisation silencieuse : l'interface n'attend jamais le réseau.
/// Ignorée pendant une partie pour respecter le 0 % CPU/GPU en jeu.
fn trigger_trophy_sync(app: &tauri::AppHandle, game_id: String) {
    if GAME_LAUNCH_LOCK.load(Ordering::SeqCst) {
        return;
    }
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        if let Err(error) = sync_trophies_for_game(&app, &game_id).await {
            eprintln!("[trophées] synchronisation de {game_id}: {error}");
        }
    });
}

/// Une seule passe au démarrage, en arrière-plan et sans jamais chevaucher une
/// partie lancée entre-temps.
fn sync_trophies_on_startup(app: tauri::AppHandle) {
    std::thread::spawn(move || {
        // Laisse la WebView finir son premier rendu avant le réseau.
        std::thread::sleep(std::time::Duration::from_secs(3));
        let games = load_games(&app).unwrap_or_default();
        for game in games {
            if GAME_LAUNCH_LOCK.load(Ordering::SeqCst) {
                break;
            }
            let app_ref = app.clone();
            let game_id = game.id.clone();
            tauri::async_runtime::block_on(async move {
                if let Err(error) = sync_trophies_for_game(&app_ref, &game_id).await {
                    eprintln!("[trophées] démarrage, {game_id}: {error}");
                }
            });
        }
    });
}

/// Rend la main au launcher : durée créditée et sauvegardée, fenêtre restaurée
/// au premier plan, plein écran réimposé, puis événements pour le front.
fn finish_game_session(
    app: &tauri::AppHandle,
    game_id: &str,
    elapsed: Duration,
    exit_code: Option<i32>,
) {
    // Crédit immédiat côté Rust : la durée est écrite sur le disque même si la
    // WebView est suspendue, masquée ou en cours de rechargement. L'unité est
    // la seconde, donc les sessions de moins d'une minute restent comptées.
    let seconds = elapsed.as_secs();
    let mut total_playtime_seconds = 0u64;
    let mut last_played = None;
    match load_games(app) {
        Ok(mut games) => {
            if let Some(game) = games.iter_mut().find(|game| game.id == game_id) {
                game.playtime_seconds = game.playtime_seconds.saturating_add(seconds);
                game.last_played = Some(now_millis());
                total_playtime_seconds = game.playtime_seconds;
                last_played = game.last_played;
            }
            match save_games(app, &games) {
                Ok(()) => {
                    // Le front applique la liste telle quelle : accueil,
                    // bibliothèque et profil affichent le nouveau total.
                    if let Err(error) = app.emit("games-updated", &games) {
                        eprintln!("[session] émission de games-updated impossible: {error}");
                    }
                }
                Err(error) => {
                    eprintln!("[session] sauvegarde du temps de jeu impossible: {error}")
                }
            }
        }
        Err(error) => eprintln!("[session] lecture de la bibliothèque impossible: {error}"),
    }

    if let Some(window) = app.get_webview_window("main") {
        // Ordre Windows : réafficher, restaurer, puis voler le premier plan.
        // `unminimize` seul ne suffit pas si la fenêtre a été masquée.
        let _ = window.show();
        let _ = window.set_always_on_top(false);
        let _ = window.unminimize();
        let _ = window.set_fullscreen(true);
        let _ = window.set_focus();
    }

    // Un jeu qui rend la main presque aussitôt avec un code non nul n'a pas
    // démarré correctement (mauvaise DLL, dépendance manquante, etc.).
    let crashed = elapsed < CRASH_WINDOW && exit_code.is_some_and(|code| code != 0);
    if crashed {
        eprintln!(
            "[session] {game_id} s'est arrêté après {} ms (code {:?})",
            elapsed.as_millis(),
            exit_code
        );
    }
    let payload = GameSessionEnded {
        game_id: game_id.to_string(),
        duration_seconds: seconds,
        total_playtime_seconds,
        last_played,
        exit_code,
        crashed,
    };
    if let Err(error) = app.emit("game-session-ended", payload) {
        eprintln!("[session] émission de game-session-ended impossible: {error}");
    }
    let _ = app.emit("game-closed", game_id);

    // La session est entièrement terminée et enregistrée : un nouveau lancement
    // est autorisé. Le verrou n'est libéré qu'après l'écriture disque, pour
    // qu'un lancement concurrent ne puisse pas écraser le total crédité.
    GAME_LAUNCH_LOCK.store(false, Ordering::SeqCst);

    // Succès obtenus pendant la partie : relus immédiatement après la fermeture.
    trigger_trophy_sync(app, game_id.to_string());
}

/// Lance le jeu puis surveille sa session jusqu'à la fermeture complète. Le
/// processus est démarré ici (les erreurs remontent à l'appel), la suite se
/// fait dans des threads pour ne jamais bloquer l'interface.
fn run_game_session(
    app: tauri::AppHandle,
    exe: PathBuf,
    title: String,
    args: Vec<String>,
    game_id: String,
    started: Instant,
) -> Result<(), String> {
    let plan = LaunchPlan::build(&exe, &args);

    // Snapshot avant le lancement : seules les fenêtres apparues ensuite
    // peuvent être celle du jeu.
    #[cfg(target_os = "windows")]
    let snapshot = game_window::snapshot();

    let mut child = spawn_game(&plan, &title)?;
    let initial_pid = child.id();

    let stop = Arc::new(AtomicBool::new(false));

    #[cfg(target_os = "windows")]
    {
        let watcher_app = app.clone();
        let watcher_root = plan.root.clone();
        let watcher_game = game_id.clone();
        let watcher_stop = stop.clone();
        std::thread::spawn(move || {
            game_window::watch(
                watcher_app,
                watcher_root,
                watcher_game,
                snapshot,
                watcher_stop,
            );
        });
    }

    // Hors Windows, la fenêtre du jeu n'est pas détectable sans API système
    // supplémentaire : le splash est libéré dès le démarrage du processus.
    #[cfg(not(target_os = "windows"))]
    {
        let ready_app = app.clone();
        let ready_game = game_id.clone();
        std::thread::spawn(move || {
            std::thread::sleep(Duration::from_secs(3));
            let payload = GameWindowReady {
                game_id: ready_game,
            };
            if let Err(error) = ready_app.emit("game-window-ready", payload) {
                eprintln!("[jeu] émission de game-window-ready impossible: {error}");
            }
        });
    }

    // Sortie du processus initial, observée sans bloquer la surveillance : un
    // lanceur intermédiaire rend la main bien avant la fin du jeu.
    let child_exited = Arc::new(AtomicBool::new(false));
    let fast_failure = Arc::new(AtomicBool::new(false));
    let exit_code = Arc::new(Mutex::new(None));
    let exit_at = Arc::new(Mutex::new(None));
    {
        let child_exited = child_exited.clone();
        let fast_failure = fast_failure.clone();
        let exit_code = exit_code.clone();
        let exit_at = exit_at.clone();
        std::thread::spawn(move || {
            let status = child.wait();
            let code = status.ok().and_then(|status| status.code());
            let failed = Instant::now().saturating_duration_since(started) < CRASH_WINDOW
                && code.is_some_and(|code| code != 0);
            if let Ok(mut slot) = exit_code.lock() {
                *slot = code;
            }
            if let Ok(mut slot) = exit_at.lock() {
                *slot = Some(Instant::now());
            }
            fast_failure.store(failed, Ordering::Relaxed);
            child_exited.store(true, Ordering::Relaxed);
        });
    }

    std::thread::spawn(move || {
        let (elapsed, code) = monitor_game_session(
            &plan,
            initial_pid,
            &child_exited,
            &fast_failure,
            &exit_code,
            &exit_at,
            started,
        );
        // La session est finie : la surveillance de fenêtre ne doit plus
        // masquer le retour au launcher.
        stop.store(true, Ordering::Relaxed);
        finish_game_session(&app, &game_id, elapsed, code);
    });
    Ok(())
}

/// Découpe les options de lancement en arguments, en respectant les guillemets.
/// `-windowed -screen-width 1920` → `["-windowed", "-screen-width", "1920"]`,
/// `-mod-dir "C:\\Mods perso"` reste un seul argument.
fn parse_launch_options(raw: &str) -> Vec<String> {
    let mut args: Vec<String> = Vec::new();
    let mut current = String::new();
    let mut quote: Option<char> = None;
    let mut started = false;

    for character in raw.chars() {
        match quote {
            Some(delimiter) => {
                if character == delimiter {
                    quote = None;
                } else {
                    current.push(character);
                }
                started = true;
            }
            None => {
                if character == '"' || character == '\'' {
                    quote = Some(character);
                    started = true;
                } else if character.is_whitespace() {
                    if started {
                        args.push(std::mem::take(&mut current));
                        started = false;
                    }
                } else {
                    current.push(character);
                    started = true;
                }
            }
        }
    }

    if started {
        args.push(current);
    }

    args
}

#[tauri::command]
fn get_games(app: tauri::AppHandle) -> Result<Vec<Game>, String> {
    load_games(&app)
}

/// Fermeture propre demandée par le bouton Alimentation : quitte l'application
/// en laissant Tauri démonter ses fenêtres et ses ressources.
#[tauri::command]
fn quit_app(app: tauri::AppHandle) {
    app.exit(0);
}

/* ────────────── Musiques de thème automatiques (yt-dlp) ────────────── */

const THEMES_DIR: &str = "themes";
const YTDLP_DIR: &str = "bin";
const THEME_EXTENSIONS: [&str; 6] = ["m4a", "webm", "mp3", "opus", "ogg", "aac"];

fn themes_dir(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("app_data_dir indisponible: {e}"))?
        .join(THEMES_DIR);
    fs::create_dir_all(&dir)
        .map_err(|e| format!("création de {} impossible: {e}", dir.display()))?;
    Ok(dir)
}

/// Lit un fichier de thème et le renvoie en base64 : repli du front quand
/// `fetch` sur `asset://` est refusé par la WebView (WKWebView sur macOS).
#[tauri::command]
fn read_theme_audio(app: tauri::AppHandle, theme_path: String) -> Result<String, String> {
    let themes = themes_dir(&app)?;
    let root = themes
        .canonicalize()
        .map_err(|e| format!("dossier des thèmes introuvable: {e}"))?;
    let path = PathBuf::from(&theme_path)
        .canonicalize()
        .map_err(|e| format!("thème introuvable: {e}"))?;
    if !path.starts_with(&root) {
        return Err("chemin de thème hors du dossier autorisé".to_string());
    }
    let bytes = fs::read(&path).map_err(|e| format!("lecture du thème impossible: {e}"))?;
    Ok(base64::engine::general_purpose::STANDARD.encode(bytes))
}

fn existing_theme(themes: &Path, game_id: &str) -> Option<PathBuf> {
    THEME_EXTENSIONS
        .iter()
        .map(|ext| themes.join(format!("{game_id}.{ext}")))
        .find(|path| path.is_file())
}

/* ── Correspondance stricte des bandes-son ── */

/// Incrémenté à chaque durcissement des règles : un cache dont la provenance
/// n'a pas été validée par cette version est purgé, jamais rejoué.
const THEME_VALIDATION_VERSION: u32 = 2;
const THEME_MIN_DURATION: f64 = 30.0;
const THEME_MAX_DURATION: f64 = 600.0;
const THEME_MIN_CONFIDENCE: u32 = 75;
const THEME_SEARCH_RESULTS: usize = 10;
const THEME_MIN_FILE_BYTES: u64 = 64 * 1024;

/// Pause demandée par le front (jeu en cours, fenêtre masquée, lancement).
static THEME_FETCH_ENABLED: std::sync::atomic::AtomicBool =
    std::sync::atomic::AtomicBool::new(true);
static THEME_TEMP_COUNTER: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);

#[tauri::command]
fn cancel_theme_fetch() {
    THEME_FETCH_ENABLED.store(false, std::sync::atomic::Ordering::SeqCst);
}

#[tauri::command]
fn resume_theme_fetch() {
    THEME_FETCH_ENABLED.store(true, std::sync::atomic::Ordering::SeqCst);
}

fn theme_fetch_cancelled() -> bool {
    !THEME_FETCH_ENABLED.load(std::sync::atomic::Ordering::SeqCst)
}

/// Provenance du fichier audio : sans elle, impossible de re-vérifier qu'une
/// musique mise en cache correspond encore réellement au jeu.
#[derive(Debug, Clone, Serialize, Deserialize)]
struct ThemeMetadata {
    version: u32,
    game_title: String,
    match_title: String,
    channel: String,
    video_id: String,
    source_url: String,
    duration: Option<f64>,
}

#[derive(Debug, Clone)]
struct ThemeCandidate {
    video_id: String,
    title: String,
    channel: String,
    duration: Option<f64>,
    source_url: String,
    score: u32,
}

fn theme_metadata_path(themes: &Path, game_id: &str) -> PathBuf {
    themes.join(format!("{game_id}.json"))
}

fn read_theme_metadata(themes: &Path, game_id: &str) -> Option<ThemeMetadata> {
    let bytes = fs::read(theme_metadata_path(themes, game_id)).ok()?;
    serde_json::from_slice(&bytes).ok()
}

fn write_theme_metadata(
    themes: &Path,
    game_id: &str,
    metadata: &ThemeMetadata,
) -> Result<(), String> {
    let path = theme_metadata_path(themes, game_id);
    let temp = themes.join(format!("{game_id}.json.tmp"));
    let bytes = serde_json::to_vec_pretty(metadata)
        .map_err(|error| format!("métadonnées du thème illisibles: {error}"))?;
    fs::write(&temp, bytes)
        .map_err(|error| format!("écriture de {} impossible: {error}", temp.display()))?;
    // Windows refuse le renommage par-dessus un fichier existant.
    if path.exists() {
        let _ = fs::remove_file(&path);
    }
    fs::rename(&temp, &path).map_err(|error| {
        let _ = fs::remove_file(&temp);
        format!("installation de {} impossible: {error}", path.display())
    })
}

/// Supprime le fichier audio, ses parties interrompues et le sidecar JSON.
fn remove_theme_artifacts(themes: &Path, game_id: &str) {
    let prefix = format!("{game_id}.");
    let Ok(entries) = fs::read_dir(themes) else {
        return;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        if !path.is_file() {
            continue;
        }
        let Some(name) = path.file_name().and_then(|name| name.to_str()) else {
            continue;
        };
        if name == game_id || name.starts_with(&prefix) {
            if let Err(error) = fs::remove_file(&path) {
                eprintln!(
                    "[thème] suppression de {} impossible: {error}",
                    path.display()
                );
            }
        }
    }
}

fn cached_theme_is_valid(themes: &Path, game_id: &str, game_title: &str) -> bool {
    let Some(audio) = existing_theme(themes, game_id) else {
        return false;
    };
    let size = fs::metadata(&audio).map(|meta| meta.len()).unwrap_or(0);
    if size < THEME_MIN_FILE_BYTES {
        return false;
    }
    let Some(metadata) = read_theme_metadata(themes, game_id) else {
        return false;
    };
    metadata.version == THEME_VALIDATION_VERSION
        && validate_theme_candidate(
            game_title,
            &metadata.match_title,
            &metadata.channel,
            metadata.duration,
        )
        .is_some()
}

/// Minuscules, accents repliés, ponctuation retirée. Le contenu entre
/// parenthèses est conservé : « DOOM (2016) » ne doit pas devenir « DOOM ».
fn normalize_theme_text(raw: &str) -> String {
    let mut output = String::with_capacity(raw.len());
    let mut pending_space = false;
    for character in raw.chars() {
        // Les apostrophes sont supprimées sans espace : « Assassin's » et
        // « Assassins » doivent produire la même clé de comparaison.
        if matches!(character, '\'' | '\u{2019}' | '\u{02BC}' | '`') {
            continue;
        }
        let folded = fold_latin(character.to_lowercase().next().unwrap_or(character));
        if folded.is_alphanumeric() {
            if pending_space && !output.is_empty() {
                output.push(' ');
            }
            output.push(folded);
            pending_space = false;
        } else {
            pending_space = true;
        }
    }
    output
}

/// Repli ASCII des accents latins courants : « Ragnarök » et « Ragnarok »
/// doivent produire le même titre comparable.
fn fold_latin(character: char) -> char {
    match character {
        'à' | 'á' | 'â' | 'ã' | 'ä' | 'å' | 'ā' | 'ă' | 'ą' => 'a',
        'ç' | 'ć' | 'č' => 'c',
        'è' | 'é' | 'ê' | 'ë' | 'ē' | 'ė' | 'ę' => 'e',
        'ì' | 'í' | 'î' | 'ï' | 'ī' | 'į' => 'i',
        'ñ' | 'ń' => 'n',
        'ò' | 'ó' | 'ô' | 'õ' | 'ö' | 'ø' | 'ō' | 'ő' => 'o',
        'ù' | 'ú' | 'û' | 'ü' | 'ū' | 'ů' | 'ű' | 'ų' => 'u',
        'ý' | 'ÿ' => 'y',
        'ß' => 's',
        'æ' => 'a',
        'œ' => 'o',
        _ => character,
    }
}

fn squash_spaces(raw: &str) -> String {
    raw.split_whitespace().collect::<Vec<_>>().join(" ")
}

/// Éditions commerciales retirées du titre du jeu : « GOTY », « Definitive
/// Edition », etc. ne doivent pas empêcher de reconnaître la bande-son.
const THEME_EDITION_SUFFIXES: [&str; 14] = [
    "game of the year edition",
    "game of the year",
    "goty edition",
    "goty",
    "definitive edition",
    "complete edition",
    "deluxe edition",
    "ultimate edition",
    "enhanced edition",
    "special edition",
    "collector s edition",
    "gold edition",
    "anniversary edition",
    "legendary edition",
];

fn strip_editions(normalized: &str) -> String {
    let mut text = format!(" {normalized} ");
    loop {
        let mut changed = false;
        for suffix in THEME_EDITION_SUFFIXES {
            let needle = format!(" {suffix} ");
            if text.contains(&needle) {
                text = text.replace(&needle, " ");
                changed = true;
            }
        }
        if !changed {
            break;
        }
    }
    squash_spaces(&text)
}

/// Résultats sans rapport avec une bande-son officielle.
const BLOCKED_TERMS: [&str; 20] = [
    "cover",
    "remix",
    "nightcore",
    "8 bit",
    "8bit",
    "piano",
    "gameplay",
    "review",
    "trailer",
    "reaction",
    "karaoke",
    "parody",
    "fan made",
    "fanmade",
    "mashup",
    "medley",
    "slowed",
    "reverb",
    "bass boosted",
    "type beat",
];

fn has_blocked_term(normalized: &str) -> bool {
    if normalized.is_empty() {
        return false;
    }
    let padded = format!(" {normalized} ");
    BLOCKED_TERMS
        .iter()
        .any(|term| padded.contains(&format!(" {term} ")))
}

/// Marqueurs acceptés, du plus spécifique au plus générique. « theme » seul
/// n'est volontairement pas accepté : trop souvent utilisé par des reprises.
const OFFICIAL_MARKERS: [&[&str]; 9] = [
    &["original", "soundtrack"],
    &["official", "soundtrack"],
    &["original", "game", "soundtrack"],
    &["soundtrack"],
    &["ost"],
    &["main", "menu", "theme"],
    &["main", "theme"],
    &["theme", "music"],
    &["title", "theme"],
];

const SUBJECT_FILLERS: [&str; 15] = [
    "official",
    "video",
    "audio",
    "ps4",
    "ps5",
    "playstation",
    "pc",
    "steam",
    "hd",
    "4k",
    "hq",
    "full",
    "album",
    "version",
    "edition",
];

fn find_official_marker(tokens: &[String]) -> Option<(usize, &'static [&'static str])> {
    let mut best: Option<(usize, usize, &'static [&'static str])> = None;
    for index in 0..tokens.len() {
        for marker in OFFICIAL_MARKERS.iter().copied() {
            if index + marker.len() > tokens.len() {
                continue;
            }
            let matches = marker
                .iter()
                .zip(&tokens[index..])
                .all(|(needle, token)| token.as_str() == *needle);
            if !matches {
                continue;
            }
            let better = match best {
                None => true,
                Some((best_index, best_len, _)) => {
                    index < best_index || (index == best_index && marker.len() > best_len)
                }
            };
            if better {
                best = Some((index, marker.len(), marker));
            }
        }
    }
    best.map(|(index, _, marker)| (index, marker))
}

/// Seuil élevé obligatoire : titre exact (éditions retirées), marqueur officiel,
/// aucun mot-clé parasite, durée plausible. Le score départage les sources.
fn validate_theme_candidate(
    game_title: &str,
    candidate_title: &str,
    channel: &str,
    duration: Option<f64>,
) -> Option<u32> {
    let game_base = strip_editions(&normalize_theme_text(game_title));
    if game_base.is_empty() {
        return None;
    }

    let title = normalize_theme_text(candidate_title);
    let channel_normalized = normalize_theme_text(channel);
    if title.is_empty() || has_blocked_term(&title) || has_blocked_term(&channel_normalized) {
        return None;
    }

    let duration = duration?;
    if !(THEME_MIN_DURATION..=THEME_MAX_DURATION).contains(&duration) {
        return None;
    }

    let tokens: Vec<String> = title.split_whitespace().map(str::to_string).collect();
    let (marker_index, marker) = find_official_marker(&tokens)?;
    let subject = tokens[..marker_index]
        .iter()
        .map(String::as_str)
        .filter(|token| !SUBJECT_FILLERS.contains(token))
        .collect::<Vec<_>>()
        .join(" ");

    // Correspondance stricte : ni titre partiel, ni suffixe supplémentaire
    // (DOOM ne doit pas accepter DOOM Eternal, et inversement).
    if subject.is_empty() || subject != game_base {
        return None;
    }

    let mut score = 60;
    if marker
        .iter()
        .any(|token| *token == "soundtrack" || *token == "ost")
    {
        score += 10;
    }
    if title.split_whitespace().any(|token| token == "official") {
        score += 5;
    }
    if channel_normalized.split_whitespace().any(|token| {
        matches!(
            token,
            "soundtrack" | "ost" | "official" | "records" | "topic" | "music"
        )
    }) {
        score += 15;
    }
    if (60.0..=420.0).contains(&duration) {
        score += 5;
    }

    Some(score)
}

fn pick_best_theme(
    game_title: &str,
    candidates: &[ThemeCandidate],
) -> Result<ThemeCandidate, &'static str> {
    let mut scored: Vec<ThemeCandidate> = candidates
        .iter()
        .filter_map(|candidate| {
            validate_theme_candidate(
                game_title,
                &candidate.title,
                &candidate.channel,
                candidate.duration,
            )
            .map(|score| ThemeCandidate {
                score,
                ..candidate.clone()
            })
        })
        .collect();

    scored.sort_by(|left, right| {
        right
            .score
            .cmp(&left.score)
            .then_with(|| left.video_id.cmp(&right.video_id))
    });

    let best = scored
        .first()
        .ok_or("aucun résultat ne correspond exactement au titre du jeu")?;
    if best.score < THEME_MIN_CONFIDENCE {
        return Err("score de confiance insuffisant");
    }
    if scored
        .get(1)
        .is_some_and(|second| best.score.saturating_sub(second.score) < 10)
    {
        return Err("correspondance ambiguë entre plusieurs résultats");
    }
    Ok(best.clone())
}

#[cfg(target_os = "windows")]
fn yt_dlp_name() -> &'static str {
    "yt-dlp.exe"
}

#[cfg(not(target_os = "windows"))]
fn yt_dlp_name() -> &'static str {
    "yt-dlp"
}

/// `yt-dlp` local (téléchargé par le launcher) ou présent dans le PATH.
fn find_yt_dlp(app: &tauri::AppHandle) -> Option<PathBuf> {
    if let Ok(local) = app.path().app_data_dir() {
        let candidate = local.join(YTDLP_DIR).join(yt_dlp_name());
        if candidate.is_file() {
            return Some(candidate);
        }
    }

    let path = std::env::var_os("PATH")?;
    std::env::split_paths(&path)
        .map(|dir| dir.join(yt_dlp_name()))
        .find(|candidate| candidate.is_file())
}

/// Installe `yt-dlp` dans `app_data_dir()/bin/` s'il n'est disponible nulle part.
async fn ensure_yt_dlp(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    if let Some(found) = find_yt_dlp(app) {
        return Ok(found);
    }

    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("app_data_dir indisponible: {e}"))?
        .join(YTDLP_DIR);
    fs::create_dir_all(&dir)
        .map_err(|e| format!("création de {} impossible: {e}", dir.display()))?;
    let target = dir.join(yt_dlp_name());

    let url = if cfg!(target_os = "windows") {
        "https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp.exe"
    } else if cfg!(target_os = "macos") {
        "https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp_macos"
    } else {
        "https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp"
    };

    let client = reqwest::Client::builder()
        .user_agent(concat!("ps4-launcher/", env!("CARGO_PKG_VERSION")))
        .timeout(std::time::Duration::from_secs(180))
        .build()
        .map_err(|e| format!("client HTTP indisponible: {e}"))?;

    let mut response = client
        .get(url)
        .send()
        .await
        .map_err(|e| format!("téléchargement de yt-dlp impossible: {e}"))?;
    if !response.status().is_success() {
        return Err(format!("yt-dlp: HTTP {}", response.status()));
    }
    // Lecture par blocs : une pause demandée pendant l'installation coupe le
    // réseau au lieu d'attendre la fin du téléchargement complet.
    const MAX_YT_DLP_BYTES: usize = 256 * 1024 * 1024;
    let mut bytes = Vec::with_capacity(4 * 1024 * 1024);
    while let Some(chunk) = response
        .chunk()
        .await
        .map_err(|e| format!("lecture de yt-dlp impossible: {e}"))?
    {
        if theme_fetch_cancelled() {
            return Err("thème: téléchargement annulé".to_string());
        }
        if bytes.len().saturating_add(chunk.len()) > MAX_YT_DLP_BYTES {
            return Err("yt-dlp: téléchargement anormalement volumineux".to_string());
        }
        bytes.extend_from_slice(&chunk);
    }
    if theme_fetch_cancelled() {
        return Err("thème: téléchargement annulé".to_string());
    }

    // Téléchargement dans un fichier temporaire, puis renommage atomique : un
    // binaire tronqué (réseau coupé) ne remplace jamais une installation saine.
    const MIN_YT_DLP_BYTES: u64 = 1024 * 1024;
    let tmp = dir.join("yt-dlp.tmp");
    let _ = fs::remove_file(&tmp);
    if bytes.len() as u64 <= MIN_YT_DLP_BYTES {
        return Err(format!(
            "yt-dlp: téléchargement incomplet ({} octets reçus)",
            bytes.len()
        ));
    }
    if let Err(error) = fs::write(&tmp, &bytes) {
        let _ = fs::remove_file(&tmp);
        return Err(format!("écriture de {} impossible: {error}", tmp.display()));
    }

    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let mut permissions = match fs::metadata(&tmp) {
            Ok(metadata) => metadata.permissions(),
            Err(error) => {
                let _ = fs::remove_file(&tmp);
                return Err(format!("accès à {} impossible: {error}", tmp.display()));
            }
        };
        permissions.set_mode(0o755);
        if let Err(error) = fs::set_permissions(&tmp, permissions) {
            let _ = fs::remove_file(&tmp);
            return Err(format!("chmod de {} impossible: {error}", tmp.display()));
        }
    }

    // Windows refuse le renommage si la cible existe déjà.
    if target.exists() {
        let _ = fs::remove_file(&target);
    }
    if let Err(error) = fs::rename(&tmp, &target) {
        let _ = fs::remove_file(&tmp);
        return Err(format!(
            "installation de {} impossible: {error}",
            target.display()
        ));
    }

    println!("[thème] yt-dlp installé dans {}", target.display());
    Ok(target)
}

// Sous Windows, pas de fenêtre de console qui clignote par-dessus le jeu.
fn hide_process_window(command: &mut std::process::Command) {
    #[cfg(target_os = "windows")]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(0x0800_0000);
    }
    #[cfg(not(target_os = "windows"))]
    {
        let _ = command;
    }
}

/// Exécute yt-dlp sans pipe bloquant (sorties dans des fichiers temporaires),
/// avec un contrôle de pause toutes les 100 ms : un jeu qui démarre tue
/// immédiatement le téléchargement au lieu de le laisser tourner en fond.
fn run_theme_command(mut command: std::process::Command) -> Result<std::process::Output, String> {
    if theme_fetch_cancelled() {
        return Err("thème: téléchargement annulé".to_string());
    }

    let serial = THEME_TEMP_COUNTER.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
    let base = std::env::temp_dir().join(format!(
        "ps4-launcher-theme-{}-{serial}",
        std::process::id()
    ));
    let stdout_path = base.with_extension("out");
    let stderr_path = base.with_extension("err");
    let cleanup = || {
        let _ = fs::remove_file(&stdout_path);
        let _ = fs::remove_file(&stderr_path);
    };

    let stdout = match fs::File::create(&stdout_path) {
        Ok(file) => file,
        Err(error) => {
            cleanup();
            return Err(format!("fichier temporaire stdout impossible: {error}"));
        }
    };
    let stderr = match fs::File::create(&stderr_path) {
        Ok(file) => file,
        Err(error) => {
            cleanup();
            return Err(format!("fichier temporaire stderr impossible: {error}"));
        }
    };
    command.stdout(stdout).stderr(stderr);

    let mut child = match command.spawn() {
        Ok(child) => child,
        Err(error) => {
            cleanup();
            return Err(format!("exécution de yt-dlp impossible: {error}"));
        }
    };

    let status = loop {
        if theme_fetch_cancelled() {
            let _ = child.kill();
            let _ = child.wait();
            cleanup();
            return Err("thème: téléchargement annulé".to_string());
        }
        match child.try_wait() {
            Ok(Some(status)) => break status,
            Ok(None) => std::thread::sleep(std::time::Duration::from_millis(100)),
            Err(error) => {
                let _ = child.kill();
                let _ = child.wait();
                cleanup();
                return Err(format!("attente de yt-dlp impossible: {error}"));
            }
        }
    };

    let stdout = fs::read(&stdout_path).unwrap_or_default();
    let stderr = fs::read(&stderr_path).unwrap_or_default();
    cleanup();
    Ok(std::process::Output {
        status,
        stdout,
        stderr,
    })
}

#[derive(Debug, Deserialize)]
struct YtDlpEntry {
    #[serde(default)]
    id: Option<String>,
    #[serde(default)]
    title: Option<String>,
    #[serde(default)]
    channel: Option<String>,
    #[serde(default)]
    uploader: Option<String>,
    #[serde(default)]
    duration: Option<f64>,
    #[serde(default)]
    live_status: Option<String>,
}

#[derive(Debug, Deserialize)]
struct YtDlpSearch {
    entries: Option<Vec<YtDlpEntry>>,
}

fn merge_candidates(target: &mut Vec<ThemeCandidate>, incoming: Vec<ThemeCandidate>) {
    for candidate in incoming {
        if !target
            .iter()
            .any(|existing| existing.video_id == candidate.video_id)
        {
            target.push(candidate);
        }
    }
}

/// Recherche large (10 résultats) mais aucune sélection ici : tous les
/// candidats sont renvoyés au validateur strict.
fn search_theme_candidates(binary: &Path, query: &str) -> Result<Vec<ThemeCandidate>, String> {
    let mut command = std::process::Command::new(binary);
    command
        .arg("--no-playlist")
        .arg("--flat-playlist")
        .arg("--dump-single-json")
        .arg("--no-warnings")
        .arg("--socket-timeout")
        .arg("20")
        .arg(format!("ytsearch{THEME_SEARCH_RESULTS}:{query}"));
    hide_process_window(&mut command);

    let output = run_theme_command(command)?;
    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr)
            .trim()
            .chars()
            .take(400)
            .collect::<String>();
        return Err(if stderr.is_empty() {
            format!("recherche yt-dlp échouée ({})", output.status)
        } else {
            stderr
        });
    }

    let parsed: YtDlpSearch = serde_json::from_slice(&output.stdout)
        .map_err(|error| format!("réponse yt-dlp illisible: {error}"))?;

    let mut candidates = Vec::new();
    for entry in parsed.entries.unwrap_or_default() {
        let Some(id) = entry.id.filter(|id| !id.trim().is_empty()) else {
            continue;
        };
        let Some(title) = entry.title else {
            continue;
        };
        if entry
            .live_status
            .as_deref()
            .is_some_and(|status| status != "not_live")
        {
            continue;
        }
        let channel = entry.channel.or(entry.uploader).unwrap_or_default();
        candidates.push(ThemeCandidate {
            source_url: format!("https://www.youtube.com/watch?v={id}"),
            video_id: id,
            title,
            channel,
            duration: entry.duration,
            score: 0,
        });
    }
    Ok(candidates)
}

fn download_theme(
    binary: &Path,
    themes: &Path,
    game_id: &str,
    candidate: &ThemeCandidate,
) -> Result<PathBuf, String> {
    remove_theme_artifacts(themes, game_id);
    let output_path = themes.join(format!("{game_id}.%(ext)s"));
    let mut command = std::process::Command::new(binary);
    command
        .arg("--no-playlist")
        .arg("--no-warnings")
        .arg("--no-progress")
        .arg("--socket-timeout")
        .arg("20")
        .arg("--retries")
        .arg("2")
        .arg("-f")
        .arg("bestaudio[ext=m4a]/bestaudio[ext=webm]/bestaudio")
        .arg("-o")
        .arg(&output_path)
        .arg(&candidate.source_url);
    hide_process_window(&mut command);

    let output = match run_theme_command(command) {
        Ok(output) => output,
        Err(error) => {
            remove_theme_artifacts(themes, game_id);
            return Err(error);
        }
    };
    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr)
            .trim()
            .chars()
            .take(400)
            .collect::<String>();
        remove_theme_artifacts(themes, game_id);
        return Err(if stderr.is_empty() {
            format!("téléchargement yt-dlp échoué ({})", output.status)
        } else {
            stderr
        });
    }

    let Some(path) = existing_theme(themes, game_id) else {
        remove_theme_artifacts(themes, game_id);
        return Err("yt-dlp n'a produit aucun format audio lisible".to_string());
    };
    let size = fs::metadata(&path).map(|meta| meta.len()).unwrap_or(0);
    if size < THEME_MIN_FILE_BYTES {
        remove_theme_artifacts(themes, game_id);
        return Err(format!("fichier audio invalide ou tronqué ({size} octets)"));
    }
    Ok(path)
}

/// Musique de thème d'un jeu : cache re-validé, sinon recherche YouTube
/// strictement filtrée. Aucun fichier n'est conservé si la correspondance
/// n'atteint pas le seuil de confiance.
#[tauri::command]
async fn fetch_game_theme_auto(
    app: tauri::AppHandle,
    game_id: String,
    game_title: String,
) -> Result<String, String> {
    if game_id.trim().is_empty() {
        return Err("identifiant de jeu manquant".to_string());
    }
    let themes = themes_dir(&app)?;

    if existing_theme(&themes, &game_id).is_some() {
        if cached_theme_is_valid(&themes, &game_id, &game_title) {
            if let Some(existing) = existing_theme(&themes, &game_id) {
                return Ok(existing.to_string_lossy().to_string());
            }
        }
        // Ancien cache sans provenance, ou musique devenue non conforme : on
        // la supprime avant toute nouvelle recherche.
        eprintln!("[thème] cache non conforme purgé pour « {game_title} »");
        remove_theme_artifacts(&themes, &game_id);
    } else {
        // Sidecar ou fichier partiel laissé par une tentative interrompue.
        remove_theme_artifacts(&themes, &game_id);
    }

    if theme_fetch_cancelled() {
        return Err("thème: téléchargement annulé".to_string());
    }

    let binary = ensure_yt_dlp(&app).await?;
    if theme_fetch_cancelled() {
        return Err("thème: téléchargement annulé".to_string());
    }

    let queries = [
        format!("{game_title} original soundtrack"),
        format!("{game_title} main theme"),
    ];
    let mut candidates = Vec::new();
    let mut last_error = String::new();

    for query in queries {
        if theme_fetch_cancelled() {
            return Err("thème: téléchargement annulé".to_string());
        }
        let binary_for_task = binary.clone();
        let query_for_task = query.clone();
        let result = tauri::async_runtime::spawn_blocking(move || {
            search_theme_candidates(&binary_for_task, &query_for_task)
        })
        .await
        .map_err(|error| format!("tâche yt-dlp interrompue: {error}"))?;

        match result {
            Ok(found) => merge_candidates(&mut candidates, found),
            Err(error) => {
                last_error = error;
                eprintln!("[thème] recherche pour « {game_title} »: {last_error}");
            }
        }
    }

    if theme_fetch_cancelled() {
        return Err("thème: téléchargement annulé".to_string());
    }

    let best = match pick_best_theme(&game_title, &candidates) {
        Ok(best) => best,
        Err(reason) => {
            return Err(if last_error.is_empty() {
                format!("aucune bande-son fiable pour « {game_title} » : {reason}")
            } else {
                format!("aucune bande-son fiable pour « {game_title} » : {reason} ({last_error})")
            });
        }
    };

    eprintln!(
        "[thème] « {game_title} » → « {} » ({}, score {})",
        best.title, best.channel, best.score
    );

    let binary_for_task = binary.clone();
    let themes_for_task = themes.clone();
    let id_for_task = game_id.clone();
    let candidate_for_task = best.clone();
    let downloaded = tauri::async_runtime::spawn_blocking(move || {
        download_theme(
            &binary_for_task,
            &themes_for_task,
            &id_for_task,
            &candidate_for_task,
        )
    })
    .await
    .map_err(|error| format!("tâche yt-dlp interrompue: {error}"))?;

    let path = downloaded?;
    // Un jeu a pu démarrer pendant le téléchargement : on ne conserve pas un
    // fichier obtenu après la demande de pause.
    if theme_fetch_cancelled() {
        remove_theme_artifacts(&themes, &game_id);
        return Err("thème: téléchargement annulé".to_string());
    }
    let metadata = ThemeMetadata {
        version: THEME_VALIDATION_VERSION,
        game_title: game_title.clone(),
        match_title: best.title,
        channel: best.channel,
        video_id: best.video_id,
        source_url: best.source_url,
        duration: best.duration,
    };
    if let Err(error) = write_theme_metadata(&themes, &game_id, &metadata) {
        remove_theme_artifacts(&themes, &game_id);
        return Err(error);
    }
    Ok(path.to_string_lossy().to_string())
}

/// Enregistre (ou efface) le chemin de la musique de thème d'un jeu.
#[tauri::command]
fn set_game_theme_audio(
    app: tauri::AppHandle,
    game_id: String,
    theme_audio_path: Option<String>,
) -> Result<Vec<Game>, String> {
    if let Some(path) = theme_audio_path.as_deref() {
        let themes = themes_dir(&app)?;
        let root = themes
            .canonicalize()
            .map_err(|error| format!("dossier des thèmes introuvable: {error}"))?;
        let file = PathBuf::from(path)
            .canonicalize()
            .map_err(|error| format!("thème introuvable: {error}"))?;
        if !file.starts_with(&root) {
            return Err("chemin de thème hors du dossier autorisé".to_string());
        }
    }

    let mut games = load_games(&app)?;
    if let Some(game) = games.iter_mut().find(|game| game.id == game_id) {
        game.theme_audio_path = theme_audio_path;
    }
    save_games(&app, &games)?;
    Ok(games)
}

/// Supprime le fichier de thème (et sa provenance) d'un jeu et oublie son
/// chemin : la prochaine génération repart d'une recherche neuve.
#[tauri::command]
fn clear_game_theme(app: tauri::AppHandle, game_id: String) -> Result<Vec<Game>, String> {
    let themes = themes_dir(&app)?;
    remove_theme_artifacts(&themes, &game_id);

    let mut games = load_games(&app)?;
    if let Some(game) = games.iter_mut().find(|game| game.id == game_id) {
        game.theme_audio_path = None;
    }
    save_games(&app, &games)?;
    Ok(games)
}

/// Purge les caches audio antérieurs au durcissement des règles, les fichiers
/// sans provenance et les associations devenues invalides. Ne touche jamais au
/// réseau : appelé au démarrage, avant la file de téléchargement.
#[tauri::command]
fn revalidate_game_themes(app: tauri::AppHandle) -> Result<Vec<Game>, String> {
    let themes = themes_dir(&app)?;
    let mut games = load_games(&app)?;
    let mut changed = false;

    for game in games.iter_mut() {
        let Some(path) = existing_theme(&themes, &game.id) else {
            let had_path = game.theme_audio_path.take().is_some();
            changed |= had_path;
            // Supprime un sidecar orphelin ou un fichier partiel.
            remove_theme_artifacts(&themes, &game.id);
            continue;
        };

        if !cached_theme_is_valid(&themes, &game.id, &game.title) {
            eprintln!("[thème] cache invalide purgé pour « {} »", game.title);
            remove_theme_artifacts(&themes, &game.id);
            if game.theme_audio_path.take().is_some() {
                changed = true;
            }
            continue;
        }

        let path = path.to_string_lossy().to_string();
        if game.theme_audio_path.as_deref() != Some(path.as_str()) {
            game.theme_audio_path = Some(path);
            changed = true;
        }
    }

    if changed {
        save_games(&app, &games)?;
    }
    Ok(games)
}

/// Supprime tous les fichiers dont le nom, sans extension, vaut `stem`.
fn remove_cache_files(directory: &Path, stem: &str) {
    let Ok(entries) = fs::read_dir(directory) else {
        return;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        if !path.is_file() {
            continue;
        }
        let matches = path
            .file_stem()
            .and_then(|name| name.to_str())
            .is_some_and(|name| name == stem);
        if matches {
            if let Err(error) = fs::remove_file(&path) {
                eprintln!(
                    "[cache] suppression de {} impossible: {error}",
                    path.display()
                );
            }
        }
    }
}

/// Nettoie le thème audio et l'icône locale d'un jeu retiré de la bibliothèque.
fn remove_game_cache(app: &tauri::AppHandle, game_id: &str) {
    let Ok(data_dir) = app.path().app_data_dir() else {
        return;
    };
    remove_theme_artifacts(&data_dir.join(THEMES_DIR), game_id);
    if let Ok(file) = icon_file(game_id) {
        if let Some(stem) = Path::new(&file).file_stem().and_then(|name| name.to_str()) {
            remove_cache_files(&data_dir.join(ICONS_DIR), stem);
        }
    }
}

/// Purge un dossier de cache de tous les fichiers dont l'identifiant n'est plus
/// présent dans `games.json`.
fn cleanup_cache_dir(directory: &Path, allowed: &HashSet<String>) -> Result<(), String> {
    let entries = match fs::read_dir(directory) {
        Ok(entries) => entries,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(()),
        Err(error) => {
            return Err(format!(
                "lecture de {} impossible: {error}",
                directory.display()
            ));
        }
    };

    for entry in entries.flatten() {
        let path = entry.path();
        if !path.is_file() {
            continue;
        }
        let Some(stem) = path.file_stem().and_then(|name| name.to_str()) else {
            continue;
        };
        if allowed.contains(stem) {
            continue;
        }
        if let Err(error) = fs::remove_file(&path) {
            eprintln!(
                "[cache] suppression de {} impossible: {error}",
                path.display()
            );
        }
    }
    Ok(())
}

/// Supprime les thèmes audio et icônes dont le jeu n'existe plus.
#[tauri::command]
fn cleanup_orphan_cache(app: tauri::AppHandle) -> Result<(), String> {
    let games = load_games(&app)?;
    let data_dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("app_data_dir indisponible: {e}"))?;

    let theme_ids: HashSet<String> = games.iter().map(|game| game.id.clone()).collect();
    let icon_ids: HashSet<String> = games
        .iter()
        .filter_map(|game| {
            let file = icon_file(&game.id).ok()?;
            Path::new(&file)
                .file_stem()
                .and_then(|stem| stem.to_str())
                .map(str::to_string)
        })
        .collect();

    cleanup_cache_dir(&data_dir.join(THEMES_DIR), &theme_ids)?;
    cleanup_cache_dir(&data_dir.join(ICONS_DIR), &icon_ids)?;
    Ok(())
}

/// Entrée proposée par le scan d'un dossier : le front coche celles à garder.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct ScannedGame {
    path: String,
    title: String,
}

/// Utilitaires livrés avec les jeux : jamais de vraies entrées de bibliothèque.
const SCAN_IGNORED: [&str; 7] = [
    "unins000",
    "unitycrashhandler",
    "dxsetup",
    "vcredist",
    "redist",
    "crashreporter",
    "vc_redist",
];

/// Le dossier choisi, puis deux niveaux de sous-dossiers au maximum.
const SCAN_MAX_DEPTH: usize = 2;
/// Plafond de sécurité pour les dossiers fourre-tout (bibliothèque Steam…).
const SCAN_MAX_RESULTS: usize = 300;

#[cfg(target_os = "windows")]
const SCAN_EXTENSIONS: [&str; 1] = ["exe"];
#[cfg(not(target_os = "windows"))]
const SCAN_EXTENSIONS: [&str; 1] = ["app"];

fn scan_extension_matches(name: &str) -> bool {
    Path::new(name)
        .extension()
        .and_then(|ext| ext.to_str())
        .is_some_and(|ext| {
            SCAN_EXTENSIONS
                .iter()
                .any(|allowed| ext.eq_ignore_ascii_case(allowed))
        })
}

fn scan_is_ignored(name: &str) -> bool {
    let lower = name.to_ascii_lowercase();
    SCAN_IGNORED.iter().any(|needle| lower.contains(needle))
}

/// Sur macOS, le `.app` est un bundle : on pointe l'exécutable qu'il contient.
#[cfg(target_os = "macos")]
fn scan_executable(path: &Path) -> Option<PathBuf> {
    let entries = fs::read_dir(path.join("Contents").join("MacOS")).ok()?;
    entries
        .flatten()
        .map(|entry| entry.path())
        .find(|candidate| candidate.is_file())
}

#[cfg(not(target_os = "macos"))]
fn scan_executable(path: &Path) -> Option<PathBuf> {
    path.is_file().then(|| path.to_path_buf())
}

/// Titre propre : nom du bundle sur macOS, sinon nom de l'exécutable ou du
/// dossier parent quand l'exécutable porte un nom générique (`Game.exe`).
fn scan_title(path: &Path, exe: &Path) -> String {
    let is_bundle = path
        .extension()
        .and_then(|ext| ext.to_str())
        .is_some_and(|ext| ext.eq_ignore_ascii_case("app"));
    if is_bundle {
        let stem = path.file_stem().and_then(|s| s.to_str()).unwrap_or("");
        let cleaned = clean_title(stem);
        if !cleaned.is_empty() {
            return cleaned;
        }
    }
    derive_title(exe, exe.parent().unwrap_or_else(|| Path::new(".")))
}

/// Parcourt un dossier (deux niveaux) et propose les exécutables trouvés. Les
/// jeux déjà présents dans la bibliothèque sont écartés : le front n'a plus
/// qu'à cocher, et l'import réutilise `add_game` + `fetch_game_artwork`.
#[tauri::command]
fn scan_games_directory(
    app: tauri::AppHandle,
    dir_path: String,
) -> Result<Vec<ScannedGame>, String> {
    let root = PathBuf::from(dir_path.trim());
    if !root.is_dir() {
        return Err(format!("dossier introuvable: {}", root.display()));
    }

    let mut seen: Vec<String> = load_games(&app)
        .map(|games| {
            games
                .into_iter()
                .map(|game| game.exe_path.to_ascii_lowercase())
                .collect()
        })
        .unwrap_or_default();

    let mut found: Vec<ScannedGame> = Vec::new();
    let mut pending = vec![(root, 0usize)];

    while let Some((dir, depth)) = pending.pop() {
        if found.len() >= SCAN_MAX_RESULTS {
            break;
        }
        let Ok(entries) = fs::read_dir(&dir) else {
            continue;
        };
        for entry in entries.flatten() {
            if found.len() >= SCAN_MAX_RESULTS {
                break;
            }
            let name = entry.file_name().to_string_lossy().to_string();
            // Dossiers cachés (`.git`, `.steam`…) : rien à lancer dedans.
            if name.starts_with('.') {
                continue;
            }

            let path = entry.path();
            let is_dir = path.is_dir();
            let is_bundle = is_dir && scan_extension_matches(&name);

            if scan_extension_matches(&name) && !scan_is_ignored(&name) {
                if let Some(exe) = scan_executable(&path) {
                    let key = exe.to_string_lossy().to_ascii_lowercase();
                    if !seen.contains(&key) {
                        seen.push(key);
                        found.push(ScannedGame {
                            path: exe.to_string_lossy().to_string(),
                            title: scan_title(&path, &exe),
                        });
                    }
                }
            }

            // Un bundle est une entrée, pas un dossier à explorer.
            if is_dir && !is_bundle && depth < SCAN_MAX_DEPTH {
                pending.push((path, depth + 1));
            }
        }
    }

    found.sort_by_key(|game| game.title.to_ascii_lowercase());
    Ok(found)
}

/* ────────── Détection des jeux déjà installés (Steam / Epic / GOG) ────────── */

/// Entrée proposée par la détection automatique : le front coche celles à
/// importer, comme pour le scan manuel d'un dossier.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct DetectedGame {
    path: String,
    title: String,
    platform: String,
    steam_appid: Option<String>,
}

/// Détecte les jeux des launchers installés, puis écarte les doublons et ceux
/// déjà présents dans `games.json`.
#[tauri::command]
async fn detect_installed_pc_games(app: tauri::AppHandle) -> Result<Vec<DetectedGame>, String> {
    let known: Vec<String> = load_games(&app)
        .map(|games| {
            games
                .into_iter()
                .map(|game| game.exe_path.to_ascii_lowercase())
                .collect()
        })
        .unwrap_or_default();

    let detected = tauri::async_runtime::spawn_blocking(detect_installed_games)
        .await
        .map_err(|error| format!("détection interrompue: {error}"))??;

    let mut seen: std::collections::HashSet<String> = std::collections::HashSet::new();
    let mut found: Vec<DetectedGame> = detected
        .into_iter()
        .filter(|game| {
            let key = game.path.to_ascii_lowercase();
            if key.is_empty() || known.contains(&key) {
                return false;
            }
            seen.insert(key)
        })
        .collect();
    found.sort_by_key(|game| game.title.to_ascii_lowercase());
    Ok(found)
}

#[cfg(target_os = "windows")]
fn detect_installed_games() -> Result<Vec<DetectedGame>, String> {
    let mut found = Vec::new();
    found.extend(detect_steam_games());
    found.extend(detect_epic_games());
    found.extend(detect_gog_games());
    Ok(found)
}

#[cfg(not(target_os = "windows"))]
fn detect_installed_games() -> Result<Vec<DetectedGame>, String> {
    Ok(detect_application_bundles())
}

/// `.app` de `~/Applications` et `/Applications` : simulation de développement
/// hors Windows, les launchers Steam / Epic / GOG n'existant pas sur macOS.
#[cfg(not(target_os = "windows"))]
const MAC_NON_GAME_APPS: [&str; 23] = [
    "activity monitor",
    "app store",
    "calculator",
    "calendar",
    "discord",
    "epic games launcher",
    "facetime",
    "finder",
    "firefox",
    "gog galaxy",
    "google chrome",
    "iterm",
    "mail",
    "music",
    "notes",
    "safari",
    "slack",
    "spotify",
    "steam",
    "terminal",
    "visual studio code",
    "xcode",
    "zoom",
];

#[cfg(not(target_os = "windows"))]
fn detect_application_bundles() -> Vec<DetectedGame> {
    let mut roots = vec![PathBuf::from("/Applications")];
    if let Some(home) = std::env::var_os("HOME") {
        roots.push(PathBuf::from(home).join("Applications"));
    }

    let mut found = Vec::new();
    for root in roots {
        let Ok(entries) = fs::read_dir(&root) else {
            continue;
        };
        for entry in entries.flatten() {
            let path = entry.path();
            let file_name = entry.file_name().to_string_lossy().to_string();
            if !file_name.to_ascii_lowercase().ends_with(".app") {
                continue;
            }
            let title = scan_title(&path, &path);
            let lower = title.to_ascii_lowercase();
            if MAC_NON_GAME_APPS.iter().any(|app| lower == *app) {
                continue;
            }
            let Some(exe) = scan_executable(&path) else {
                continue;
            };
            found.push(DetectedGame {
                path: exe.to_string_lossy().to_string(),
                title,
                platform: "macos".to_string(),
                steam_appid: None,
            });
        }
    }
    found
}

/* ────────────────────────────── Windows ────────────────────────────── */

/// Jetons entre guillemets d'une ligne VDF/ACF, échappements `\\` et `\"`
/// dépliés (les chemins Steam sont stockés avec des doubles antislashs).
fn vdf_tokens(line: &str) -> Vec<String> {
    let mut tokens = Vec::new();
    let mut current = String::new();
    let mut in_quotes = false;
    let mut chars = line.chars();

    while let Some(character) = chars.next() {
        match character {
            '"' => {
                if in_quotes {
                    tokens.push(std::mem::take(&mut current));
                }
                in_quotes = !in_quotes;
            }
            '\\' if in_quotes => {
                if let Some(escaped) = chars.next() {
                    current.push(escaped);
                }
            }
            _ if in_quotes => current.push(character),
            _ => {}
        }
    }
    tokens
}

fn vdf_value(content: &str, key: &str) -> Option<String> {
    content.lines().find_map(|line| {
        let tokens = vdf_tokens(line);
        (tokens.len() >= 2 && tokens[0].eq_ignore_ascii_case(key)).then(|| tokens[1].clone())
    })
}

#[cfg(target_os = "windows")]
fn vdf_quoted_values(content: &str, key: &str) -> Vec<String> {
    content
        .lines()
        .filter_map(|line| {
            let tokens = vdf_tokens(line);
            (tokens.len() >= 2 && tokens[0].eq_ignore_ascii_case(key)).then(|| tokens[1].clone())
        })
        .collect()
}

#[cfg(target_os = "windows")]
fn steam_path_from_registry() -> Option<PathBuf> {
    use winreg::RegKey;
    use winreg::enums::{HKEY_CURRENT_USER, KEY_READ};

    let key = RegKey::predef(HKEY_CURRENT_USER)
        .open_subkey_with_flags("Software\\Valve\\Steam", KEY_READ)
        .ok()?;
    let path: String = key.get_value("SteamPath").ok()?;
    let path = path.trim();
    (!path.is_empty()).then(|| PathBuf::from(path))
}

/// Racines Steam : installation standard 32/64 bits + chemin du registre.
#[cfg(target_os = "windows")]
fn steam_install_roots() -> Vec<PathBuf> {
    let mut roots: Vec<PathBuf> = Vec::new();
    for variable in ["ProgramFiles(x86)", "ProgramFiles"] {
        if let Some(base) = std::env::var_os(variable) {
            let candidate = PathBuf::from(base).join("Steam");
            if candidate.join("steamapps").is_dir() {
                roots.push(candidate);
            }
        }
    }
    if let Some(from_registry) = steam_path_from_registry() {
        if from_registry.join("steamapps").is_dir()
            && !roots.iter().any(|root| root == &from_registry)
        {
            roots.push(from_registry);
        }
    }
    roots
}

/// Toutes les bibliothèques déclarées dans `libraryfolders.vdf`, plus la racine
/// d'installation elle-même (elle n'y figure pas toujours).
#[cfg(target_os = "windows")]
fn steam_library_roots(steam_root: &Path) -> Vec<PathBuf> {
    let mut roots = vec![steam_root.to_path_buf()];
    let vdf = steam_root.join("steamapps").join("libraryfolders.vdf");
    let Ok(content) = fs::read_to_string(&vdf) else {
        return roots;
    };

    // Format récent : "path" "D:\\SteamLibrary". Format historique : "1" "D:\\SteamLibrary".
    let mut libraries = vdf_quoted_values(&content, "path");
    for line in content.lines() {
        let tokens = vdf_tokens(line);
        if tokens.len() >= 2 && tokens[0].parse::<u32>().is_ok() {
            libraries.push(tokens[1].clone());
        }
    }

    for value in libraries {
        let candidate = PathBuf::from(value);
        // Le VDF référence la racine de la bibliothèque, parfois son steamapps.
        let candidate = if candidate
            .file_name()
            .and_then(|name| name.to_str())
            .is_some_and(|name| name.eq_ignore_ascii_case("steamapps"))
        {
            candidate
                .parent()
                .map(Path::to_path_buf)
                .unwrap_or(candidate)
        } else {
            candidate
        };
        if candidate.join("steamapps").is_dir() && !roots.iter().any(|root| root == &candidate) {
            roots.push(candidate);
        }
    }
    roots
}

#[cfg(target_os = "windows")]
fn detect_steam_games() -> Vec<DetectedGame> {
    let mut found = Vec::new();
    for steam_root in steam_install_roots() {
        for library in steam_library_roots(&steam_root) {
            let steamapps = library.join("steamapps");
            let Ok(entries) = fs::read_dir(&steamapps) else {
                continue;
            };
            for entry in entries.flatten() {
                let file_name = entry.file_name().to_string_lossy().to_ascii_lowercase();
                if !file_name.starts_with("appmanifest_") || !file_name.ends_with(".acf") {
                    continue;
                }
                let Ok(content) = fs::read_to_string(entry.path()) else {
                    continue;
                };
                let appid = vdf_value(&content, "appid").unwrap_or_default();
                let title = vdf_value(&content, "name").unwrap_or_default();
                let Some(installdir) = vdf_value(&content, "installdir") else {
                    continue;
                };
                let installdir = installdir.trim();
                if installdir.is_empty() {
                    continue;
                }
                let install = steamapps.join("common").join(installdir);
                let Some(exe) = find_main_executable(&install) else {
                    continue;
                };
                found.push(DetectedGame {
                    path: exe.to_string_lossy().to_string(),
                    title: if title.trim().is_empty() {
                        derive_title(&exe, &install)
                    } else {
                        title.trim().to_string()
                    },
                    platform: "steam".to_string(),
                    steam_appid: (!appid.trim().is_empty()).then(|| appid.trim().to_string()),
                });
            }
        }
    }
    found
}

#[cfg(target_os = "windows")]
#[derive(Deserialize)]
struct EpicManifest {
    #[serde(rename = "DisplayName", default)]
    display_name: String,
    #[serde(rename = "InstallLocation", default)]
    install_location: String,
    #[serde(rename = "LaunchExecutable", default)]
    launch_executable: String,
}

#[cfg(target_os = "windows")]
fn detect_epic_games() -> Vec<DetectedGame> {
    let manifests = std::env::var_os("ProgramData")
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from(r"C:\ProgramData"))
        .join("Epic")
        .join("EpicGamesLauncher")
        .join("Data")
        .join("Manifests");

    let Ok(entries) = fs::read_dir(&manifests) else {
        return Vec::new();
    };

    let mut found = Vec::new();
    for entry in entries.flatten() {
        if !entry
            .file_name()
            .to_string_lossy()
            .to_ascii_lowercase()
            .ends_with(".item")
        {
            continue;
        }
        let Ok(content) = fs::read_to_string(entry.path()) else {
            continue;
        };
        let Ok(manifest) = serde_json::from_str::<EpicManifest>(&content) else {
            continue;
        };

        let install = PathBuf::from(manifest.install_location.trim());
        if manifest.install_location.trim().is_empty() || !install.is_dir() {
            continue;
        }

        let executable = manifest.launch_executable.trim();
        let exe = if executable.is_empty() {
            find_main_executable(&install)
        } else {
            let candidate = PathBuf::from(executable);
            let candidate = if candidate.is_absolute() {
                candidate
            } else {
                install.join(candidate)
            };
            candidate
                .is_file()
                .then_some(candidate)
                .or_else(|| find_main_executable(&install))
        };
        let Some(exe) = exe else {
            continue;
        };

        let title = manifest.display_name.trim();
        found.push(DetectedGame {
            path: exe.to_string_lossy().to_string(),
            title: if title.is_empty() {
                derive_title(&exe, &install)
            } else {
                title.to_string()
            },
            platform: "epic".to_string(),
            steam_appid: find_steam_appid(&install),
        });
    }
    found
}

#[cfg(target_os = "windows")]
fn detect_gog_games() -> Vec<DetectedGame> {
    let mut found = detect_gog_registry();
    // Certaines installations ne sont plus référencées au registre : les
    // fichiers `goggame-*.info` restent une source fiable.
    found.extend(detect_gog_info_files());
    found
}

#[cfg(target_os = "windows")]
fn detect_gog_registry() -> Vec<DetectedGame> {
    use winreg::RegKey;
    use winreg::enums::{HKEY_LOCAL_MACHINE, KEY_READ};

    let Ok(container) = RegKey::predef(HKEY_LOCAL_MACHINE)
        .open_subkey_with_flags(r"SOFTWARE\WOW6432Node\GOG.com\Games", KEY_READ)
    else {
        return Vec::new();
    };

    let mut found = Vec::new();
    for key_name in container.enum_keys().flatten() {
        let Ok(key) = container.open_subkey(&key_name) else {
            continue;
        };
        let title: String = key.get_value("gameName").unwrap_or_default();
        let install: String = key.get_value("path").unwrap_or_default();
        let executable: String = key.get_value("exe").unwrap_or_default();

        let install = install.trim().trim_matches('"');
        if install.is_empty() {
            continue;
        }
        let install = PathBuf::from(install);
        if !install.is_dir() {
            continue;
        }

        let executable = executable.trim().trim_matches('"');
        let exe = if executable.is_empty() {
            find_main_executable(&install)
        } else {
            let candidate = PathBuf::from(executable);
            let candidate = if candidate.is_absolute() {
                candidate
            } else {
                install.join(candidate)
            };
            candidate
                .is_file()
                .then_some(candidate)
                .or_else(|| find_main_executable(&install))
        };
        let Some(exe) = exe else {
            continue;
        };

        found.push(DetectedGame {
            path: exe.to_string_lossy().to_string(),
            title: if title.trim().is_empty() {
                derive_title(&exe, &install)
            } else {
                title.trim().to_string()
            },
            platform: "gog".to_string(),
            steam_appid: find_steam_appid(&install),
        });
    }
    found
}

#[cfg(target_os = "windows")]
#[derive(Deserialize)]
struct GogInfo {
    #[serde(default)]
    name: String,
    #[serde(default, rename = "playTasks")]
    play_tasks: Vec<GogPlayTask>,
}

#[cfg(target_os = "windows")]
#[derive(Deserialize)]
struct GogPlayTask {
    #[serde(default, rename = "type")]
    kind: String,
    #[serde(default)]
    path: String,
    #[serde(default, rename = "isPrimary")]
    is_primary: bool,
}

#[cfg(target_os = "windows")]
fn detect_gog_info_files() -> Vec<DetectedGame> {
    let mut roots: Vec<PathBuf> = Vec::new();
    for variable in ["ProgramFiles(x86)", "ProgramFiles"] {
        if let Some(base) = std::env::var_os(variable) {
            let base = PathBuf::from(base);
            roots.push(base.join("GOG Galaxy").join("Games"));
            roots.push(base.join("GOG.com").join("Games"));
            roots.push(base.join("GOG Games"));
        }
    }
    roots.push(PathBuf::from(r"C:\GOG Games"));
    roots.push(PathBuf::from(r"C:\Program Files (x86)\GOG Games"));

    let mut found = Vec::new();
    for root in roots {
        scan_gog_infos(&root, 0, &mut found);
    }
    found
}

#[cfg(target_os = "windows")]
fn scan_gog_infos(dir: &Path, depth: usize, found: &mut Vec<DetectedGame>) {
    if depth > 2 || !dir.is_dir() {
        return;
    }
    let Ok(entries) = fs::read_dir(dir) else {
        return;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        if path.is_dir() {
            scan_gog_infos(&path, depth + 1, found);
            continue;
        }
        let file_name = entry.file_name().to_string_lossy().to_ascii_lowercase();
        if !file_name.starts_with("goggame-") || !file_name.ends_with(".info") {
            continue;
        }
        let Ok(content) = fs::read_to_string(&path) else {
            continue;
        };
        let Ok(info) = serde_json::from_str::<GogInfo>(&content) else {
            continue;
        };

        let task = info
            .play_tasks
            .iter()
            .find(|task| task.kind.eq_ignore_ascii_case("FileTask") && task.is_primary)
            .or_else(|| {
                info.play_tasks
                    .iter()
                    .find(|task| task.kind.eq_ignore_ascii_case("FileTask"))
            });
        let Some(task) = task else {
            continue;
        };
        let executable = task.path.trim();
        if executable.is_empty() {
            continue;
        }

        let parent = path.parent().unwrap_or_else(|| Path::new("."));
        let exe = parent.join(executable);
        if !exe.is_file() {
            continue;
        }

        found.push(DetectedGame {
            path: exe.to_string_lossy().to_string(),
            title: if info.name.trim().is_empty() {
                derive_title(&exe, parent)
            } else {
                info.name.trim().to_string()
            },
            platform: "gog".to_string(),
            steam_appid: find_steam_appid(parent),
        });
    }
}

/// Exécutable principal d'un dossier de jeu : parcours de deux niveaux, les
/// utilitaires (`unins000`, `UnityCrashHandler`, `redist`, `dxsetup`…) écartés.
#[cfg(target_os = "windows")]
fn find_main_executable(root: &Path) -> Option<PathBuf> {
    if !root.is_dir() {
        return None;
    }

    let mut candidates: Vec<(u16, PathBuf)> = Vec::new();
    let mut pending = vec![(root.to_path_buf(), 0usize)];
    while let Some((dir, depth)) = pending.pop() {
        let Ok(entries) = fs::read_dir(&dir) else {
            continue;
        };
        for entry in entries.flatten() {
            let path = entry.path();
            let file_name = entry.file_name().to_string_lossy().to_string();
            if path.is_dir() {
                if depth < 2 {
                    pending.push((path, depth + 1));
                }
                continue;
            }

            let lower = file_name.to_ascii_lowercase();
            if !lower.ends_with(".exe") || scan_is_ignored(&file_name) {
                continue;
            }
            if lower.contains("setup")
                || lower.contains("install")
                || lower.contains("unins")
                || lower.contains("launcher")
            {
                continue;
            }

            candidates.push((executable_score(&file_name, depth), path));
        }
    }

    candidates.sort_by(|left, right| left.0.cmp(&right.0));
    candidates.into_iter().next().map(|(_, path)| path)
}

#[cfg(target_os = "windows")]
fn executable_score(name: &str, depth: usize) -> u16 {
    let lower = name.to_ascii_lowercase();
    let stem = lower.strip_suffix(".exe").unwrap_or(lower.as_str());
    let mut score = (depth as u16) * 10;
    if GENERIC_STEMS
        .iter()
        .any(|generic| generic.eq_ignore_ascii_case(stem))
    {
        score += 6;
    }
    if lower.contains("helper") || lower.contains("crash") || lower.contains("report") {
        score += 5;
    }
    score
}

#[tauri::command]
fn add_game(app: tauri::AppHandle, exe_path: String) -> Result<Vec<Game>, String> {
    let exe = PathBuf::from(exe_path.trim());
    if !exe.is_file() {
        return Err(format!("fichier introuvable: {}", exe.display()));
    }

    let mut games = load_games(&app)?;
    let stored_path = exe.to_string_lossy().to_string();
    if games
        .iter()
        .any(|g| g.exe_path.eq_ignore_ascii_case(&stored_path))
    {
        return Ok(games);
    }

    let dir = exe.parent().unwrap_or_else(|| Path::new("."));
    let new_id = Uuid::new_v4().to_string();
    games.push(Game {
        id: new_id.clone(),
        title: derive_title(&exe, dir),
        exe_path: stored_path,
        steam_appid: find_steam_appid(dir),
        cover_url: None,
        bg_url: None,
        last_played: None,
        playtime_seconds: 0,
        launch_options: String::new(),
        pinned: false,
        theme_audio_path: None,
    });

    save_games(&app, &games)?;
    // Trophées du jeu qui vient d'être ajouté, sans bloquer l'interface.
    trigger_trophy_sync(&app, new_id);
    Ok(games)
}

#[tauri::command]
fn update_launch_options(
    app: tauri::AppHandle,
    id: String,
    launch_options: String,
) -> Result<Vec<Game>, String> {
    let mut games = load_games(&app)?;
    {
        let game = games
            .iter_mut()
            .find(|g| g.id == id)
            .ok_or_else(|| format!("jeu introuvable: {id}"))?;
        game.launch_options = launch_options.trim().to_string();
    }
    save_games(&app, &games)?;
    Ok(games)
}

#[tauri::command]
fn set_game_pinned(app: tauri::AppHandle, id: String, pinned: bool) -> Result<Vec<Game>, String> {
    let mut games = load_games(&app)?;
    {
        let game = games
            .iter_mut()
            .find(|game| game.id == id)
            .ok_or_else(|| format!("jeu introuvable: {id}"))?;
        game.pinned = pinned;
    }
    save_games(&app, &games)?;
    Ok(games)
}

#[tauri::command]
fn remove_game(app: tauri::AppHandle, id: String) -> Result<Vec<Game>, String> {
    let mut games = load_games(&app)?;
    games.retain(|g| g.id != id);
    save_games(&app, &games)?;
    remove_game_cache(&app, &id);
    Ok(games)
}

struct LaunchLockGuard {
    release_on_drop: bool,
}

impl LaunchLockGuard {
    fn acquire() -> Result<Self, String> {
        if GAME_LAUNCH_LOCK
            .compare_exchange(false, true, Ordering::SeqCst, Ordering::SeqCst)
            .is_err()
        {
            return Err("un lancement de jeu est déjà en cours".to_string());
        }
        Ok(Self {
            release_on_drop: true,
        })
    }
}

impl Drop for LaunchLockGuard {
    fn drop(&mut self) {
        if self.release_on_drop {
            GAME_LAUNCH_LOCK.store(false, Ordering::SeqCst);
        }
    }
}

#[tauri::command]
fn launch_game(app: tauri::AppHandle, id: String) -> Result<Vec<Game>, String> {
    let mut launch_lock = LaunchLockGuard::acquire().map_err(|error| {
        eprintln!("[jeu] lancement de {id} refusé : {error}");
        error
    })?;

    let mut games = load_games(&app)?;
    let index = games
        .iter()
        .position(|g| g.id == id)
        .ok_or_else(|| format!("jeu introuvable: {id}"))?;

    let game = &mut games[index];
    game.last_played = Some(now_millis());
    let exe = PathBuf::from(&game.exe_path);
    let title = game.title.clone();
    let args = parse_launch_options(&game.launch_options);

    // Comme sur PS4, le dernier jeu lancé remonte en première position de la
    // bibliothèque. Le Store permanent n'y figure pas : il occupe l'index 0 du
    // ruban, donc le jeu lancé apparaît juste à sa droite (index 1). L'ordre
    // relatif des autres jeux est conservé.
    if index > 0 {
        let launched = games.remove(index);
        games.insert(0, launched);
    }
    save_games(&app, &games)?;

    // Instant exact du démarrage. Le splash reste au premier plan tant que le
    // jeu n'a pas affiché sa première image : le launcher n'est pas minimisé
    // ici, mais par le thread de surveillance une fois la fenêtre trouvée.
    let started = std::time::Instant::now();

    // Processus déjà actif (lancement manuel, ancienne session du launcher) :
    // on ne démarre jamais un second exemplaire. On ramène sa fenêtre au
    // premier plan et on adopte la session existante pour le suivi du temps.
    #[cfg(target_os = "windows")]
    if let Some(pid) = process_guard::find_pid(&exe) {
        eprintln!("[jeu] « {title} » déjà actif (PID {pid}) : second lancement bloqué");
        if !game_window::focus_pid(pid) {
            eprintln!("[jeu] fenêtre du processus {pid} introuvable pour le focus");
        }
        // Le processus tourne déjà : aucune attente de sortie à observer, la
        // session est reconnue par le dossier et le nom de l'exécutable.
        let plan = LaunchPlan::build(&exe, &[]);
        let session_app = app.clone();
        let session_id = id;
        std::thread::spawn(move || {
            let _ = session_app.emit(
                "game-window-ready",
                GameWindowReady {
                    game_id: session_id.clone(),
                },
            );
            let exited = AtomicBool::new(true);
            let fast_failure = AtomicBool::new(false);
            let exit_code = Mutex::new(None);
            let exit_at = Mutex::new(Some(Instant::now()));
            let (elapsed, code) = monitor_game_session(
                &plan,
                0,
                &exited,
                &fast_failure,
                &exit_code,
                &exit_at,
                started,
            );
            finish_game_session(&session_app, &session_id, elapsed, code);
        });
        // Le thread de session devient propriétaire du verrou et le libérera
        // dans finish_game_session.
        launch_lock.release_on_drop = false;
        return Ok(games);
    }

    if let Err(error) = run_game_session(app.clone(), exe, title, args, id, started) {
        // Échec du lancement : le launcher ne doit pas rester au premier plan.
        if let Some(window) = app.get_webview_window("main") {
            let _ = window.show();
            let _ = window.set_always_on_top(false);
            let _ = window.unminimize();
            let _ = window.set_fullscreen(true);
            let _ = window.set_focus();
        }
        return Err(error);
    }

    // La session (et son thread de surveillance) libérera le verrou à la
    // fermeture réelle du jeu.
    launch_lock.release_on_drop = false;
    Ok(games)
}

/// Crédite la durée d'une session au jeu, l'écrit immédiatement et renvoie la
/// liste complète : le front n'a aucune écriture disque à faire lui-même.
#[tauri::command]
fn add_playtime(app: tauri::AppHandle, game_id: String, seconds: u64) -> Result<Vec<Game>, String> {
    let mut games = load_games(&app)?;
    if let Some(game) = games.iter_mut().find(|game| game.id == game_id) {
        game.playtime_seconds = game.playtime_seconds.saturating_add(seconds);
    }
    save_games(&app, &games)?;
    Ok(games)
}

#[tauri::command]
async fn fetch_game_artwork(app: tauri::AppHandle, game_id: String) -> Result<Vec<Game>, String> {
    let games = load_games(&app)?;
    let index = games
        .iter()
        .position(|game| game.id == game_id)
        .ok_or_else(|| format!("jeu introuvable: {game_id}"))?;
    let title = games[index].title.clone();
    let had_cover = games[index].cover_url.is_some();
    let had_hero = games[index].bg_url.is_some();

    let client = reqwest::Client::builder()
        .user_agent(concat!("ps4-launcher/", env!("CARGO_PKG_VERSION")))
        .timeout(std::time::Duration::from_secs(20))
        .build()
        .map_err(|e| format!("client HTTP indisponible: {e}"))?;

    let mut appid = games[index].steam_appid.clone();
    // AppID découvert pendant les requêtes : appliqué seulement à la relecture
    // finale, jamais sur la copie chargée avant le réseau.
    let mut discovered_appid: Option<String> = None;
    if appid.is_none() {
        if let Some(found) = search_steam_appid(&client, &title).await? {
            discovered_appid = Some(found.clone());
            appid = Some(found);
        }
    }

    // Clé SteamGridDB optionnelle : lue sur le profil, vide par défaut.
    let api_key = load_profile(&app)
        .map(|profile| profile.steamgriddb_api_key)
        .unwrap_or_default();
    let api_key = api_key.trim().to_string();

    let directory = covers_dir(&app)?;
    let stamp = now_millis();
    let appid_ref = appid.as_deref();

    // Jaquette carrée 1024×1024 (SteamGridDB) avec repli CDN Steam.
    let cover_file = covers_file(&game_id, ArtworkKind::Cover);
    let cover_path = directory.join(&cover_file);
    let mut cover_saved = false;
    if !api_key.is_empty() {
        if let Some(url) = steamgriddb_square_cover_url(&client, &api_key, appid_ref, &title).await
        {
            cover_saved = download_image(&client, &url, &cover_path).await.is_ok();
        }
    }
    if !cover_saved {
        if let Some(appid) = appid_ref {
            let fallback = format!("{STEAM_ARTWORK}/{appid}/library_600x900_2x.jpg");
            cover_saved = download_image(&client, &fallback, &cover_path)
                .await
                .is_ok();
        }
    }
    let mut cover_url_update: Option<String> = None;
    if cover_saved {
        cover_url_update = Some(cached_artwork_url(&cover_file, stamp));
    } else if !had_cover {
        if let Some(appid) = appid_ref {
            cover_url_update = Some(format!("{STEAM_ARTWORK}/{appid}/library_600x900_2x.jpg"));
        }
    }

    // Repli local : icône native du .exe quand Steam et SteamGridDB n'ont fourni
    // aucune jaquette (jeu indé inconnu, API absente ou mode hors-ligne).
    #[cfg(target_os = "windows")]
    {
        let cached_cover = games[index].cover_url.as_deref().is_some_and(|url| {
            url.starts_with(COVERS_SCHEME) || url.starts_with(&format!("http://{COVERS_SCHEME}."))
        });
        if !cover_saved && !cached_cover {
            if let (Ok(file), Ok(directory)) = (icon_file(&game_id), icons_dir(&app)) {
                if write_exe_icon(Path::new(&games[index].exe_path), &directory.join(&file)).is_ok()
                {
                    cover_url_update = Some(cached_icon_url(&file, stamp));
                }
            }
        }
    }

    // Fond héro : SteamGridDB par appid Steam, puis CDN Steam.
    let hero_file = covers_file(&game_id, ArtworkKind::Hero);
    let hero_path = directory.join(&hero_file);
    let mut hero_saved = false;
    let mut hero_url_update: Option<String> = None;
    if let Some(appid) = appid_ref {
        if !api_key.is_empty() {
            if let Some(url) = steamgriddb_hero_url(&client, &api_key, appid).await {
                hero_saved = download_image(&client, &url, &hero_path).await.is_ok();
            }
        }
        if !hero_saved {
            for candidate in steam_candidates(appid, ArtworkKind::Hero) {
                if download_image(&client, &candidate, &hero_path)
                    .await
                    .is_ok()
                {
                    hero_saved = true;
                    break;
                }
            }
        }
        if hero_saved {
            hero_url_update = Some(cached_artwork_url(&hero_file, stamp));
        } else if !had_hero {
            hero_url_update = Some(format!("{STEAM_ARTWORK}/{appid}/library_hero_2x.jpg"));
        }
    }

    // Relecture juste avant d'écrire : une session terminée pendant les appels
    // réseau a pu créditer du temps de jeu ou changer l'ordre récent. Seuls les
    // champs d'artwork de ce jeu sont modifiés sur la version fraîche.
    let mut games = load_games(&app)?;
    let game = games
        .iter_mut()
        .find(|game| game.id == game_id)
        .ok_or_else(|| format!("jeu introuvable: {game_id}"))?;
    if let Some(found) = discovered_appid {
        if game.steam_appid.is_none() {
            game.steam_appid = Some(found);
        }
    }
    if let Some(url) = cover_url_update {
        game.cover_url = Some(url);
    }
    if let Some(url) = hero_url_update {
        game.bg_url = Some(url);
    }
    save_games(&app, &games)?;
    // Actualisation des métadonnées : les trophées suivent le nouvel AppID.
    trigger_trophy_sync(&app, game_id.clone());
    Ok(games)
}

#[tauri::command]
fn get_profile(app: tauri::AppHandle) -> Result<UserProfile, String> {
    load_profile(&app)
}

#[tauri::command]
fn update_profile(
    app: tauri::AppHandle,
    username: String,
    bio: String,
    steamgriddb_api_key: Option<String>,
    steam_id: Option<String>,
    steam_api_key: Option<String>,
) -> Result<UserProfile, String> {
    let username = username.trim();
    if username.is_empty() {
        return Err("le pseudo ne peut pas être vide".to_string());
    }
    let mut profile = load_profile(&app)?;
    profile.username = username.chars().take(40).collect();
    profile.bio = bio.trim().chars().take(80).collect();
    if let Some(key) = steamgriddb_api_key {
        profile.steamgriddb_api_key = key.trim().chars().take(64).collect();
    }
    if let Some(id) = steam_id {
        let id = id.trim().to_string();
        if !id.is_empty() && (id.len() != 17 || !id.chars().all(|c| c.is_ascii_digit())) {
            return Err("SteamID64 invalide : 17 chiffres attendus.".to_string());
        }
        profile.steam_id = id;
    }
    if let Some(key) = steam_api_key {
        profile.steam_api_key = key.trim().chars().take(64).collect();
    }
    save_profile(&app, &profile)?;
    Ok(profile)
}

#[tauri::command]
fn greet(name: &str) -> String {
    format!("Hello, {}! You've been greeted from Rust!", name)
}

/// Garde-fou : taille maximale de l'image source de l'avatar.
const MAX_AVATAR_BYTES: u64 = 8 * 1024 * 1024;

/// Un seul fichier d'avatar est conservé dans `app_data_dir`.
const AVATAR_EXTENSIONS: [&str; 3] = ["png", "jpg", "webp"];

#[tauri::command]
fn update_avatar(app: tauri::AppHandle, file_path: String) -> Result<UserProfile, String> {
    let path = PathBuf::from(&file_path);
    let size = fs::metadata(&path)
        .map_err(|e| format!("lecture de {} impossible: {e}", path.display()))?
        .len();
    if size > MAX_AVATAR_BYTES {
        return Err("image trop lourde (8 Mo maximum)".to_string());
    }
    let bytes =
        fs::read(&path).map_err(|e| format!("lecture de {} impossible: {e}", path.display()))?;

    // Le format réel vient des octets, pas du nom du fichier choisi.
    let extension = match image_mime(&bytes) {
        "image/png" => "png",
        "image/jpeg" => "jpg",
        "image/webp" => "webp",
        _ => return Err("format non pris en charge (png, jpg, jpeg, webp)".to_string()),
    };

    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("app_data_dir indisponible: {e}"))?;
    fs::create_dir_all(&dir)
        .map_err(|e| format!("création de {} impossible: {e}", dir.display()))?;
    let target = dir.join(format!("avatar.{extension}"));
    fs::write(&target, &bytes)
        .map_err(|e| format!("écriture de {} impossible: {e}", target.display()))?;

    // L'ancien avatar d'une autre extension ne doit pas rester sur le disque.
    for stale_extension in AVATAR_EXTENSIONS {
        if stale_extension == extension {
            continue;
        }
        let stale = dir.join(format!("avatar.{stale_extension}"));
        if stale.is_file() {
            let _ = fs::remove_file(&stale);
        }
    }

    let mut profile = load_profile(&app)?;
    // Le champ garde son nom historique : Base64 pour les anciens profils,
    // chemin du fichier local pour les nouveaux (le frontend gère les deux).
    profile.avatar_data_url = Some(target.to_string_lossy().to_string());
    save_profile(&app, &profile)?;
    Ok(profile)
}

/// Extrait l'icône haute résolution du `.exe` et la conserve en PNG dans
/// `app_data_dir()/icons/<game_id>.png` pour le repli hors-ligne.
#[tauri::command]
fn extract_exe_icon(
    app: tauri::AppHandle,
    exe_path: String,
    game_id: String,
) -> Result<String, String> {
    let directory = icons_dir(&app)?;
    let target = directory.join(icon_file(&game_id)?);
    write_exe_icon(Path::new(&exe_path), &target)?;
    Ok(target.to_string_lossy().to_string())
}

#[cfg(not(target_os = "windows"))]
fn write_exe_icon(_exe: &Path, _target: &Path) -> Result<(), String> {
    Err("extraction de l'icône .exe disponible uniquement sous Windows".to_string())
}

#[cfg(target_os = "windows")]
#[link(name = "user32")]
#[allow(non_snake_case)]
unsafe extern "system" {
    fn PrivateExtractIconsW(
        sz_file_name: *const u16,
        n_icon_index: i32,
        cx_icon: i32,
        cy_icon: i32,
        phicon: *mut *mut std::ffi::c_void,
        piconid: *mut u32,
        n_icons: u32,
        flags: u32,
    ) -> u32;
}

#[cfg(target_os = "windows")]
fn write_exe_icon(exe: &Path, target: &Path) -> Result<(), String> {
    use std::os::windows::ffi::OsStrExt;
    use winapi::shared::windef::{HGDIOBJ, HICON};
    use winapi::um::wingdi::{
        BI_RGB, BITMAP, BITMAPINFO, CreateCompatibleDC, DIB_RGB_COLORS, DeleteDC, DeleteObject,
        GetDIBits, GetObjectW, SelectObject,
    };
    use winapi::um::winuser::{DestroyIcon, GetIconInfo, ICONINFO};

    let wide: Vec<u16> = exe
        .as_os_str()
        .encode_wide()
        .chain(std::iter::once(0))
        .collect();
    let mut icons: [HICON; 1] = [std::ptr::null_mut()];
    let mut icon_id: u32 = 0;
    let extracted = unsafe {
        PrivateExtractIconsW(
            wide.as_ptr(),
            0,
            256,
            256,
            icons.as_mut_ptr() as *mut *mut std::ffi::c_void,
            &mut icon_id,
            1,
            0,
        )
    };
    if extracted == 0 || icons[0].is_null() {
        return Err("aucune icône exploitable dans cet exécutable".to_string());
    }
    let icon = icons[0];

    let result = (|| -> Result<(), String> {
        let mut info: ICONINFO = unsafe { std::mem::zeroed() };
        if unsafe { GetIconInfo(icon, &mut info) } == 0 {
            return Err("lecture de l'icône Windows impossible".to_string());
        }
        let color = info.hbmColor;
        let mask = info.hbmMask;

        let outcome = (|| -> Result<(), String> {
            if color.is_null() {
                return Err("icône monochrome non prise en charge".to_string());
            }

            let mut bitmap: BITMAP = unsafe { std::mem::zeroed() };
            let read = unsafe {
                GetObjectW(
                    color as HGDIOBJ,
                    std::mem::size_of::<BITMAP>() as i32,
                    &mut bitmap as *mut BITMAP as *mut _,
                )
            };
            if read == 0 {
                return Err("dimensions de l'icône illisibles".to_string());
            }

            let width = bitmap.bmWidth;
            let height = bitmap.bmHeight;
            if width <= 0 || height <= 0 || width > 1024 || height > 1024 {
                return Err(format!("taille d'icône inattendue: {width}×{height}"));
            }

            let dc = unsafe { CreateCompatibleDC(std::ptr::null_mut()) };
            if dc.is_null() {
                return Err("contexte graphique Windows indisponible".to_string());
            }
            let previous = unsafe { SelectObject(dc, color as HGDIOBJ) };

            let mut header: BITMAPINFO = unsafe { std::mem::zeroed() };
            header.bmiHeader.biSize = std::mem::size_of_val(&header.bmiHeader) as u32;
            header.bmiHeader.biWidth = width;
            header.bmiHeader.biHeight = -height;
            header.bmiHeader.biPlanes = 1;
            header.bmiHeader.biBitCount = 32;
            header.bmiHeader.biCompression = BI_RGB;

            let mut pixels = vec![0u8; width as usize * height as usize * 4];
            let lines = unsafe {
                GetDIBits(
                    dc,
                    color,
                    0,
                    height as u32,
                    pixels.as_mut_ptr() as *mut _,
                    &mut header,
                    DIB_RGB_COLORS,
                )
            };
            unsafe {
                SelectObject(dc, previous);
                DeleteDC(dc);
            }
            if lines == 0 {
                return Err("pixels de l'icône illisibles".to_string());
            }

            // GetDIBits renvoie du BGRA ; les anciennes icônes n'ont pas d'alpha.
            let mut has_alpha = false;
            for pixel in pixels.chunks_exact_mut(4) {
                pixel.swap(0, 2);
                if pixel[3] != 0 {
                    has_alpha = true;
                }
            }
            if !has_alpha {
                for pixel in pixels.chunks_exact_mut(4) {
                    pixel[3] = 255;
                }
            }

            let file = fs::File::create(target)
                .map_err(|e| format!("création de {} impossible: {e}", target.display()))?;
            let writer = std::io::BufWriter::new(file);
            let mut encoder = png::Encoder::new(writer, width as u32, height as u32);
            encoder.set_color(png::ColorType::Rgba);
            encoder.set_depth(png::BitDepth::Eight);
            let mut png_writer = encoder
                .write_header()
                .map_err(|e| format!("en-tête PNG impossible: {e}"))?;
            png_writer
                .write_image_data(&pixels)
                .map_err(|e| format!("écriture PNG impossible: {e}"))?;
            png_writer
                .finish()
                .map_err(|e| format!("finalisation PNG impossible: {e}"))?;
            Ok(())
        })();

        unsafe {
            if !color.is_null() {
                DeleteObject(color as HGDIOBJ);
            }
            if !mask.is_null() {
                DeleteObject(mask as HGDIOBJ);
            }
        }
        outcome
    })();

    unsafe { DestroyIcon(icon) };
    result
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn title_falls_back_to_folder_for_generic_names() {
        let dir = Path::new("/games/My_Game");
        assert_eq!(
            derive_title(Path::new("/games/My_Game/launcher.exe"), dir),
            "My Game"
        );
        assert_eq!(
            derive_title(Path::new("/games/My_Game/GTA V.exe"), dir),
            "GTA V"
        );
    }

    #[test]
    fn old_games_json_defaults_playtime_to_zero() {
        let raw = r#"{"id":"1","title":"T","exe_path":"C:/Game/game.exe"}"#;
        let game: Game = serde_json::from_str(raw).unwrap();
        assert_eq!(game.playtime_seconds, 0);
    }

    #[test]
    fn old_games_json_defaults_launch_options_to_empty() {
        let raw = r#"{"id":"1","title":"T","exe_path":"C:/Game/game.exe"}"#;
        let game: Game = serde_json::from_str(raw).unwrap();
        assert_eq!(game.launch_options, "");
    }

    #[test]
    fn splits_launch_options_on_spaces_and_quotes() {
        assert!(parse_launch_options("  ").is_empty());
        assert_eq!(
            parse_launch_options("-dx11 -novid -windowed"),
            vec!["-dx11", "-novid", "-windowed"]
        );
        assert_eq!(
            parse_launch_options("-screen-width 1920  -screen-height=1080"),
            vec!["-screen-width", "1920", "-screen-height=1080"]
        );
        assert_eq!(
            parse_launch_options(r#"-mod-dir "C:\Mods perso" -novid"#),
            vec!["-mod-dir", r"C:\Mods perso", "-novid"]
        );
    }

    #[test]
    fn launch_lock_rejects_concurrent_acquisition() {
        let first = LaunchLockGuard::acquire().expect("premier lancement accepté");
        assert!(LaunchLockGuard::acquire().is_err());
        drop(first);
        let second = LaunchLockGuard::acquire().expect("verrou libéré après la session");
        drop(second);
    }

    #[test]
    fn normalizes_titles_for_steam_matching() {
        assert_eq!(
            normalize_title("Grand Theft Auto V"),
            normalize_title("Grand Theft Auto V™")
        );
    }

    #[test]
    fn finds_steam_appid_down_to_depth_three() {
        let root = std::env::temp_dir().join(format!("ps4-launcher-test-{}", Uuid::new_v4()));
        let deep = root.join("a").join("b").join("c");
        fs::create_dir_all(&deep).unwrap();
        fs::write(deep.join("steam_appid.txt"), "730\r\n").unwrap();
        assert_eq!(find_steam_appid(&root).as_deref(), Some("730"));
        fs::remove_dir_all(&root).unwrap();
    }

    #[test]
    fn finds_appid_in_emulator_config_files() {
        let root = std::env::temp_dir().join(format!("ps4-launcher-ini-{}", Uuid::new_v4()));
        fs::create_dir_all(root.join("Engine")).unwrap();
        fs::write(
            root.join("steam_emu.ini"),
            "[Settings]\r\nAppId=292030\r\nLanguage=french\r\n",
        )
        .unwrap();
        // Un `steam_appid.txt` reste prioritaire sur toute configuration.
        assert_eq!(find_steam_appid(&root).as_deref(), Some("292030"));
        fs::write(root.join("steam_appid.txt"), "489830").unwrap();
        assert_eq!(find_steam_appid(&root).as_deref(), Some("489830"));
        fs::remove_dir_all(&root).unwrap();
    }

    #[test]
    fn finds_appid_from_steam_appmanifest() {
        let root = std::env::temp_dir().join(format!("ps4-launcher-acf-{}", Uuid::new_v4()));
        let steamapps = root.join("steamapps");
        let game = steamapps.join("common").join("Portal 2");
        fs::create_dir_all(game.join("bin")).unwrap();
        fs::write(
            steamapps.join("appmanifest_620.acf"),
            "\"AppState\"\n{\n\t\"appid\"\t\t\"620\"\n\t\"installdir\"\t\t\"Portal 2\"\n}\n",
        )
        .unwrap();
        // Même depuis un sous-dossier, le dossier de jeu reste le premier
        // segment sous `common`.
        assert_eq!(find_steam_appid(&game.join("bin")).as_deref(), Some("620"));
        fs::remove_dir_all(&root).unwrap();
    }

    #[test]
    fn profile_json_missing_fields_falls_back_to_defaults() {
        let profile: UserProfile = serde_json::from_str(r#"{"username":"Alex"}"#).unwrap();
        assert_eq!(profile.username, "Alex");
        assert_eq!(profile.bio, "En ligne");
        assert_eq!(profile.avatar_data_url, None);
        assert_eq!(profile.steamgriddb_api_key, "");
        assert_eq!(profile.steam_id, "");
        assert_eq!(profile.steam_api_key, "");

        let empty = UserProfile::default();
        assert_eq!(empty.username, "Thibault");
        assert_eq!(empty.bio, "En ligne");
        assert_eq!(empty.steamgriddb_api_key, "");
        assert_eq!(empty.steam_id, "");
        assert_eq!(empty.steam_api_key, "");
    }

    #[test]
    fn cleans_versions_tags_and_extensions_before_searching() {
        assert_eq!(clean_search_title("Cyberpunk_2077.exe"), "Cyberpunk 2077");
        assert_eq!(
            clean_search_title("Rocket League v1.2.3 [x64]"),
            "Rocket League"
        );
        assert_eq!(
            clean_search_title("The Witcher 3 (2023) Build 12345"),
            "The Witcher 3"
        );
        assert_eq!(clean_search_title("Hades.v1.0.0"), "Hades");
    }

    #[test]
    fn normalizes_raw_installed_titles() {
        assert_eq!(clean_search_title("Cyberpunk2077"), "Cyberpunk 2077");
        assert_eq!(clean_search_title("witcher3"), "witcher 3");
        assert_eq!(clean_search_title("hollow knight"), "hollow knight");
        assert_eq!(clean_search_title("Hades-Win64-Shipping"), "Hades");
        assert_eq!(clean_search_title("Hades-Win64-Shipping.exe"), "Hades");
    }

    #[test]
    fn reads_appid_from_emulator_config_files() {
        assert_eq!(
            appid_from_config("[Settings]\r\nAppId=292030\r\nUserName=Player\r\n"),
            Some("292030".to_string())
        );
        assert_eq!(appid_from_config("appid = 489830\n"), Some("489830".to_string()));
        assert_eq!(appid_from_config("AppId=0\n"), None);
        assert_eq!(appid_from_config("[Settings]\nUnlockAll=1\n"), None);
    }

    #[test]
    fn strips_marketing_editions() {
        assert_eq!(
            clean_search_title("Elden Ring Deluxe Edition"),
            "Elden Ring"
        );
        assert_eq!(
            clean_search_title("Cyberpunk 2077 Game of the Year Edition"),
            "Cyberpunk 2077"
        );
        assert_eq!(clean_search_title("Skyrim GOTY"), "Skyrim");
    }

    #[test]
    fn keeps_real_titles_intact() {
        assert_eq!(clean_search_title("Half-Life 2"), "Half-Life 2");
        assert_eq!(clean_search_title("Battlefield 1942"), "Battlefield 1942");
        assert_eq!(
            clean_search_title("Assassin's Creed IV Black Flag"),
            "Assassin's Creed IV Black Flag"
        );
        assert_eq!(clean_search_title("F1 23"), "F1 23");
        assert_eq!(clean_search_title("GOTY"), "GOTY");
    }

    #[test]
    fn builds_safe_cover_file_names() {
        assert_eq!(
            covers_file("abc-123", ArtworkKind::Cover),
            "abc-123_cover.jpg"
        );
        assert_eq!(
            covers_file("abc-123", ArtworkKind::Hero),
            "abc-123_hero.jpg"
        );
        assert_eq!(covers_file("a/../b", ArtworkKind::Hero), "a____b_hero.jpg");
    }

    #[test]
    fn detects_image_mime_from_magic_bytes() {
        assert_eq!(image_mime(&[0xFF, 0xD8, 0xFF, 0x00]), "image/jpeg");
        assert_eq!(image_mime(b"\x89PNG\r\n"), "image/png");
        assert_eq!(image_mime(b"RIFF0000WEBPVP8 "), "image/webp");
        assert_eq!(image_mime(b"<html>"), "application/octet-stream");
    }

    #[test]
    fn finds_game_root_above_binary_folders() {
        assert_eq!(
            game_root_dir(Path::new("C:/Jeux/Doom/Binaries/Win64/Doom.exe")),
            PathBuf::from("C:/Jeux/Doom")
        );
        assert_eq!(
            game_root_dir(Path::new("C:/Jeux/Doom/Doom.exe")),
            PathBuf::from("C:/Jeux/Doom")
        );
        assert_eq!(
            game_root_dir(Path::new("C:/Jeux/Doom/Bin64/Doom.exe")),
            PathBuf::from("C:/Jeux/Doom")
        );
    }

    #[test]
    fn matches_processes_from_the_game_folder_only() {
        let root = Path::new("C:/Jeux/Doom");
        assert!(path_is_inside(
            Path::new("c:\\jeux\\doom\\binaries\\win64\\doom.exe"),
            root
        ));
        assert!(path_is_inside(
            Path::new("C:\\Jeux\\Doom\\Binaries\\Win64\\Doom.exe"),
            root
        ));
        assert!(!path_is_inside(
            Path::new("C:\\Jeux\\Doom Eternal\\Doom.exe"),
            root
        ));
        assert!(!path_is_inside(Path::new("C:\\Autre\\Doom.exe"), root));
        // Chemins canoniques `\\?\` et racine avec séparateur final.
        assert!(path_is_inside(
            Path::new("\\\\?\\C:\\Jeux\\Doom\\bin\\game.exe"),
            root
        ));
        assert!(path_is_inside(
            Path::new("C:\\Jeux\\Doom\\game.exe"),
            Path::new("C:\\Jeux\\Doom\\")
        ));
    }

    #[test]
    fn prefers_hd_steam_assets() {
        let cover = steam_candidates("730", ArtworkKind::Cover);
        assert!(cover[0].ends_with("/730/library_600x900_2x.jpg"));
        let hero = steam_candidates("730", ArtworkKind::Hero);
        assert!(hero[0].ends_with("/730/library_hero_2x.jpg"));
        assert!(hero.last().unwrap().ends_with("/730/header.jpg"));
    }

    #[test]
    fn theme_normalization_keeps_years_and_folds_accents() {
        assert_eq!(normalize_theme_text("Ragnarök™"), "ragnarok");
        assert_eq!(normalize_theme_text("DOOM (2016)"), "doom 2016");
        assert_eq!(
            normalize_theme_text("Assassin's Creed IV: Black Flag"),
            "assassins creed iv black flag"
        );
    }

    #[test]
    fn theme_accepts_exact_official_track() {
        let score = validate_theme_candidate(
            "The Witcher 3: Wild Hunt",
            "The Witcher 3: Wild Hunt — Official Soundtrack",
            "CD PROJEKT RED",
            Some(245.0),
        );
        assert!(score.is_some_and(|score| score >= THEME_MIN_CONFIDENCE));
    }

    #[test]
    fn theme_strips_marketing_editions() {
        assert!(
            validate_theme_candidate(
                "Elden Ring Deluxe Edition",
                "Elden Ring OST",
                "Bandai Namco",
                Some(180.0),
            )
            .is_some()
        );
    }

    #[test]
    fn theme_rejects_partial_or_extended_title_collisions() {
        assert!(
            validate_theme_candidate("DOOM", "DOOM Eternal OST", "Bethesda", Some(200.0)).is_none()
        );
        assert!(
            validate_theme_candidate("DOOM Eternal", "DOOM OST", "Bethesda", Some(200.0)).is_none()
        );
        assert!(
            validate_theme_candidate("DOOM", "DOOM (2016) OST", "Bethesda", Some(200.0)).is_none()
        );
    }

    #[test]
    fn theme_rejects_covers_remixes_and_trailers() {
        for title in [
            "DOOM OST (Piano Cover)",
            "DOOM OST Nightcore Remix",
            "DOOM OST - Gameplay Trailer",
        ] {
            assert!(
                validate_theme_candidate("DOOM", title, "Some Channel", Some(180.0)).is_none(),
                "{title}"
            );
        }
    }

    #[test]
    fn theme_rejects_without_official_marker_or_with_bad_duration() {
        assert!(validate_theme_candidate("DOOM", "DOOM Theme", "Official", Some(180.0)).is_none());
        assert!(validate_theme_candidate("DOOM", "DOOM OST", "Official", Some(12.0)).is_none());
        assert!(validate_theme_candidate("DOOM", "DOOM OST", "Official", Some(601.0)).is_none());
        assert!(validate_theme_candidate("DOOM", "DOOM OST", "Official", None).is_none());
    }

    #[test]
    fn theme_rejects_ambiguous_duplicates() {
        let candidates = vec![
            ThemeCandidate {
                video_id: "a".into(),
                title: "DOOM OST".into(),
                channel: "Topic".into(),
                duration: Some(200.0),
                source_url: "a".into(),
                score: 0,
            },
            ThemeCandidate {
                video_id: "b".into(),
                title: "DOOM OST".into(),
                channel: "Topic".into(),
                duration: Some(200.0),
                source_url: "b".into(),
                score: 0,
            },
        ];
        assert!(pick_best_theme("DOOM", &candidates).is_err());
    }

    #[test]
    fn theme_picks_unique_high_confidence_result() {
        let candidates = vec![
            ThemeCandidate {
                video_id: "a".into(),
                title: "DOOM OST".into(),
                channel: "Bethesda Softworks".into(),
                duration: Some(200.0),
                source_url: "a".into(),
                score: 0,
            },
            ThemeCandidate {
                video_id: "b".into(),
                title: "DOOM OST (Piano Cover)".into(),
                channel: "Piano Covers".into(),
                duration: Some(200.0),
                source_url: "b".into(),
                score: 0,
            },
        ];
        let picked = pick_best_theme("DOOM", &candidates).expect("unique result");
        assert_eq!(picked.video_id, "a");
    }

    #[test]
    fn skips_installers_and_crash_helpers_when_scanning() {
        let root = std::env::temp_dir().join(format!("ps4-launcher-scan-{}", Uuid::new_v4()));
        fs::create_dir_all(root.join("bin").join("deep").join("deeper")).unwrap();
        for name in [
            "Game.exe",
            "unins000.exe",
            "UnityCrashHandler64.exe",
            "REDprelauncher.exe",
        ] {
            fs::write(root.join(name), b"x").unwrap();
        }
        fs::write(root.join("bin").join("Helper.exe"), b"x").unwrap();
        fs::write(
            root.join("bin")
                .join("deep")
                .join("deeper")
                .join("Hidden.exe"),
            b"x",
        )
        .unwrap();

        let names: Vec<String> = scan_game_executables(&root)
            .iter()
            .filter_map(|path| path.file_name())
            .map(|name| name.to_string_lossy().to_string())
            .collect();
        assert!(names.iter().any(|name| name == "Game.exe"));
        assert!(names.iter().any(|name| name == "Helper.exe"));
        assert!(!names.iter().any(|name| name.starts_with("unins")));
        assert!(!names.iter().any(|name| name.contains("CrashHandler")));
        assert!(!names.iter().any(|name| name.starts_with("REDprelauncher")));
        // Quatrième niveau : hors du périmètre de recherche.
        assert!(!names.iter().any(|name| name == "Hidden.exe"));
        fs::remove_dir_all(&root).unwrap();
    }

    /// Vérifie la fenêtre de grâce et la durée créditée d'une session courte.
    /// Volontairement ignoré : il dure le temps réel d'une session (≈15 s).
    /// `cargo test short_direct_session -- --ignored`
    #[cfg(unix)]
    #[test]
    #[ignore = "dure une quinzaine de secondes en temps réel"]
    fn short_direct_session_stops_after_the_grace_window() {
        let root = std::env::temp_dir().join(format!("ps4-launcher-short-{}", Uuid::new_v4()));
        fs::create_dir_all(&root).unwrap();
        let plan = LaunchPlan {
            program: root.join("Game"),
            args: Vec::new(),
            workdir: root.clone(),
            root,
            names: HashSet::new(),
            indirect: false,
        };
        let started = Instant::now();
        let mut child = std::process::Command::new("/bin/sh")
            .arg("-c")
            .arg("exec sleep 2")
            .spawn()
            .unwrap();
        let pid = child.id();
        let child_exited = Arc::new(AtomicBool::new(false));
        let fast_failure = Arc::new(AtomicBool::new(false));
        let exit_code = Arc::new(Mutex::new(None));
        let exit_at = Arc::new(Mutex::new(None));
        {
            let child_exited = child_exited.clone();
            let exit_code = exit_code.clone();
            let exit_at = exit_at.clone();
            std::thread::spawn(move || {
                let status = child.wait();
                *exit_code.lock().unwrap() = status.ok().and_then(|status| status.code());
                *exit_at.lock().unwrap() = Some(Instant::now());
                child_exited.store(true, Ordering::Relaxed);
            });
        }

        let (elapsed, code) = monitor_game_session(
            &plan,
            pid,
            &child_exited,
            &fast_failure,
            &exit_code,
            &exit_at,
            started,
        );
        assert_eq!(code, Some(0));
        assert!(
            elapsed.as_secs() >= 1 && elapsed.as_secs() <= 3,
            "durée inattendue: {elapsed:?}"
        );
        assert!(
            started.elapsed() < Duration::from_secs(30),
            "attente trop longue: {:?}",
            started.elapsed()
        );
    }

    #[cfg(unix)]
    #[test]
    fn finds_a_running_game_process_by_executable_name() {
        let root = std::env::temp_dir().join(format!("ps4-launcher-session-{}", Uuid::new_v4()));
        fs::create_dir_all(&root).unwrap();
        // Le nom est celui du vrai processus : `sleep`, lancé hors du dossier
        // du jeu, ne peut être reconnu que par son nom.
        let mut child = std::process::Command::new("/bin/sh")
            .arg("-c")
            .arg("exec sleep 30")
            .current_dir(&root)
            .spawn()
            .unwrap();
        std::thread::sleep(Duration::from_millis(800));

        let mut names = HashSet::new();
        names.insert("sleep".to_string());
        let plan = LaunchPlan {
            program: PathBuf::from("/bin/sh"),
            args: Vec::new(),
            workdir: root.clone(),
            root,
            names,
            indirect: false,
        };

        // PID 0 : session adoptée, aucune reconnaissance par PID possible.
        let mut system = System::new();
        assert!(find_game_process(&mut system, &plan, 0));

        let _ = child.kill();
        let _ = child.wait();
    }

    #[test]
    fn treats_every_installer_helper_as_utility() {
        assert!(is_utility_executable("unins000.exe"));
        assert!(is_utility_executable("VC_redist.x64.exe"));
        assert!(is_utility_executable("dxsetup.exe"));
        assert!(is_utility_executable("REDprelauncher.exe"));
        assert!(!is_utility_executable("GTA5.exe"));
    }

    #[test]
    fn resolves_url_shortcuts_to_local_targets() {
        let root = std::env::temp_dir().join(format!("ps4-launcher-url-{}", Uuid::new_v4()));
        fs::create_dir_all(&root).unwrap();
        let target = root.join("Game.exe");
        fs::write(&target, b"x").unwrap();
        let shortcut = root.join("Game.url");
        fs::write(
            &shortcut,
            format!("[InternetShortcut]\nURL={}\n", target.display()),
        )
        .unwrap();
        assert_eq!(resolve_shortcut(&shortcut), Some(target));
        // URL distante (Steam) : aucune cible locale à suivre.
        fs::write(
            &shortcut,
            "[InternetShortcut]\nURL=steam://rungameid/730\n",
        )
        .unwrap();
        assert_eq!(resolve_shortcut(&shortcut), None);
        fs::remove_dir_all(&root).unwrap();
    }
}

/* ────────────── Batterie de la manette ────────────── */

/// Niveau de batterie de la première manette connectée (0..100).
#[tauri::command]
fn get_controller_battery() -> Option<u8> {
    controller_battery()
}

/// Hors Windows, aucune API système fiable : le front masque l'indicateur.
#[cfg(not(target_os = "windows"))]
fn controller_battery() -> Option<u8> {
    None
}

#[cfg(target_os = "windows")]
#[repr(C)]
#[derive(Default)]
#[allow(dead_code)]
struct XInputGamepad {
    buttons: u16,
    left_trigger: u8,
    right_trigger: u8,
    left_thumb_x: i16,
    left_thumb_y: i16,
    right_thumb_x: i16,
    right_thumb_y: i16,
}

#[cfg(target_os = "windows")]
#[repr(C)]
#[derive(Default)]
#[allow(dead_code)]
struct XInputState {
    packet_number: u32,
    gamepad: XInputGamepad,
}

#[cfg(target_os = "windows")]
#[repr(C)]
#[derive(Default)]
struct XInputBatteryInformation {
    battery_type: u8,
    battery_level: u8,
}

#[cfg(target_os = "windows")]
type XInputGetStateFn = unsafe extern "system" fn(user_index: u32, state: *mut XInputState) -> u32;
#[cfg(target_os = "windows")]
type XInputGetBatteryInformationFn = unsafe extern "system" fn(
    user_index: u32,
    device_type: u8,
    battery: *mut XInputBatteryInformation,
) -> u32;

/// `xinput1_4.lib` n'est pas fourni par tous les SDK Windows : les fonctions
/// sont résolues dans la DLL à l'exécution, sans dépendance à l'édition de liens.
#[cfg(target_os = "windows")]
#[link(name = "kernel32")]
unsafe extern "system" {
    fn LoadLibraryA(name: *const u8) -> *mut std::ffi::c_void;
    fn GetProcAddress(module: *mut std::ffi::c_void, name: *const u8) -> *mut std::ffi::c_void;
}

#[cfg(target_os = "windows")]
fn load_xinput() -> Option<(XInputGetStateFn, XInputGetBatteryInformationFn)> {
    for dll in [
        b"xinput1_4.dll\0".as_slice(),
        b"xinput9_1_0.dll\0".as_slice(),
    ] {
        let module = unsafe { LoadLibraryA(dll.as_ptr()) };
        if module.is_null() {
            continue;
        }
        let get_state = unsafe { GetProcAddress(module, b"XInputGetState\0".as_ptr()) };
        let get_battery =
            unsafe { GetProcAddress(module, b"XInputGetBatteryInformation\0".as_ptr()) };
        if get_state.is_null() || get_battery.is_null() {
            continue;
        }
        // SAFETY: signatures documentées par XInput ; la DLL reste chargée.
        return Some(unsafe {
            (
                std::mem::transmute::<*mut std::ffi::c_void, XInputGetStateFn>(get_state),
                std::mem::transmute::<*mut std::ffi::c_void, XInputGetBatteryInformationFn>(
                    get_battery,
                ),
            )
        });
    }
    None
}

#[cfg(target_os = "windows")]
fn xinput_api() -> Option<(XInputGetStateFn, XInputGetBatteryInformationFn)> {
    static API: std::sync::OnceLock<Option<(XInputGetStateFn, XInputGetBatteryInformationFn)>> =
        std::sync::OnceLock::new();
    *API.get_or_init(load_xinput)
}

/// XInput expose la charge des manettes sans fil (Bluetooth inclus) et signale
/// les manettes filaires. Fonctions chargées dynamiquement depuis la DLL.
#[cfg(target_os = "windows")]
fn controller_battery() -> Option<u8> {
    const ERROR_SUCCESS: u32 = 0;
    const BATTERY_DEVTYPE_GAMEPAD: u8 = 0;
    const BATTERY_TYPE_DISCONNECTED: u8 = 0;
    const BATTERY_TYPE_WIRED: u8 = 1;

    let (xinput_get_state, xinput_get_battery) = xinput_api()?;

    for index in 0..4u32 {
        let mut state = XInputState::default();
        let connected = unsafe { xinput_get_state(index, &mut state) } == ERROR_SUCCESS;
        if !connected {
            continue;
        }

        let mut battery = XInputBatteryInformation::default();
        let known = unsafe { xinput_get_battery(index, BATTERY_DEVTYPE_GAMEPAD, &mut battery) }
            == ERROR_SUCCESS;
        if !known {
            // Manette connectée mais charge inconnue : on l'affiche pleine
            // plutôt que de faire disparaître l'indicateur.
            return Some(100);
        }

        if battery.battery_type == BATTERY_TYPE_DISCONNECTED {
            continue;
        }
        if battery.battery_type == BATTERY_TYPE_WIRED {
            return Some(100);
        }

        let level = (battery.battery_level as u16 * 100 + 127) / 255;
        return Some(level.min(100) as u8);
    }

    None
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        .register_uri_scheme_protocol(COVERS_SCHEME, |ctx, request| {
            let not_found = |status: u16| {
                tauri::http::Response::builder()
                    .status(status)
                    .header("Access-Control-Allow-Origin", "*")
                    .body(Vec::new())
                    .unwrap_or_else(|_| tauri::http::Response::new(Vec::new()))
            };

            let file = request.uri().path().trim_start_matches('/').to_string();
            if file.is_empty() || file.contains('/') || file.contains('\\') || file.contains("..") {
                return not_found(400);
            }
            // `?kind=icon` sert les icônes de repli, le reste les jaquettes.
            let icon_request = request
                .uri()
                .query()
                .is_some_and(|query| query.split('&').any(|pair| pair == "kind=icon"));
            let folder = if icon_request { ICONS_DIR } else { COVERS_DIR };
            let Ok(directory) = ctx.app_handle().path().app_data_dir() else {
                return not_found(500);
            };
            let Ok(bytes) = fs::read(directory.join(folder).join(&file)) else {
                return not_found(404);
            };
            tauri::http::Response::builder()
                .status(200)
                .header("Content-Type", image_mime(&bytes))
                .header("Cache-Control", "public, max-age=31536000, immutable")
                .header("Access-Control-Allow-Origin", "*")
                .body(bytes)
                .unwrap_or_else(|_| tauri::http::Response::new(Vec::new()))
        })
        .setup(|app| {
            // Plein écran natif imposé dès l'ouverture, quel que soit l'OS.
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.set_fullscreen(true);
                // Icône appliquée à chaud : gabarit squircle macOS sur tous les OS.
                let icon_bytes = include_bytes!("../icons/app-icon-macos.png");
                match tauri::image::Image::from_bytes(icon_bytes) {
                    Ok(icon) => {
                        if let Err(error) = window.set_icon(icon) {
                            eprintln!("[icône] application impossible: {error}");
                        }
                    }
                    Err(error) => eprintln!("[icône] décodage impossible: {error}"),
                }
            }
            // Purge des anciens thèmes / icônes sans bloquer le démarrage.
            let handle = app.handle().clone();
            std::thread::spawn(move || {
                if let Err(error) = cleanup_orphan_cache(handle) {
                    eprintln!("[cache] nettoyage des orphelins impossible: {error}");
                }
            });
            // Une passe de trophées, différée et silencieuse.
            sync_trophies_on_startup(app.handle().clone());
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            greet,
            get_games,
            quit_app,
            fetch_game_theme_auto,
            set_game_theme_audio,
            read_theme_audio,
            clear_game_theme,
            revalidate_game_themes,
            cancel_theme_fetch,
            resume_theme_fetch,
            add_game,
            scan_games_directory,
            detect_installed_pc_games,
            remove_game,
            update_launch_options,
            set_game_pinned,
            extract_exe_icon,
            launch_game,
            add_playtime,
            cleanup_orphan_cache,
            fetch_game_artwork,
            get_profile,
            update_profile,
            update_avatar,
            get_controller_battery,
            trophies::get_game_trophies,
            sync_game_trophies
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
