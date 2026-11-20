use serde::{Deserialize, Serialize};
use std::collections::HashSet;
use std::fs;
use std::path::{Path, PathBuf};
use tauri::Manager;
use uuid::Uuid;

use base64::Engine as _;

mod trophies;

#[cfg(target_os = "windows")]
use sysinfo::{ProcessRefreshKind, ProcessesToUpdate, System, UpdateKind};
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
    fs::create_dir_all(&dir).map_err(|e| format!("création de {} impossible: {e}", dir.display()))?;
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
    fs::create_dir_all(&dir).map_err(|e| format!("création de {} impossible: {e}", dir.display()))?;
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

fn find_steam_appid(dir: &Path) -> Option<String> {
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
    steam_appid_from_manifests(dir)
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

/// Nom exploitable pour la boutique Steam : sans extension, version, tag ni édition.
fn clean_search_title(raw: &str) -> String {
    let trimmed = raw.trim();
    let without_tags = remove_bracket_tags(strip_media_extension(trimmed));
    let flattened = without_tags.replace(['_', '·'], " ");
    let words: Vec<String> = flattened.split_whitespace().map(str::to_string).collect();

    let mut kept: Vec<String> = Vec::with_capacity(words.len());
    let mut index = 0;
    while index < words.len() {
        let word = &words[index];
        let lower = word.to_ascii_lowercase();
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
    fs::create_dir_all(&dir).map_err(|e| format!("création de {} impossible: {e}", dir.display()))?;
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
    fs::create_dir_all(&dir).map_err(|e| format!("création de {} impossible: {e}", dir.display()))?;
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
    let response = client
        .get(&url)
        .bearer_auth(api_key)
        .send()
        .await
        .ok()?;
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
    let response = client
        .get(&url)
        .bearer_auth(api_key)
        .send()
        .await
        .ok()?;
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

#[cfg(target_os = "windows")]
fn launch_executable(
    exe: &Path,
    title: &str,
    args: &[String],
) -> Result<std::process::Child, String> {
    let parent = exe
        .parent()
        .ok_or_else(|| format!("dossier parent introuvable pour {}", exe.display()))?;
    std::process::Command::new(exe)
        .current_dir(parent)
        .args(args)
        .spawn()
        .map_err(|e| format!("lancement de {title} impossible: {e}"))
}

// --------------------------------------------------------------------------
// Suivi du jeu lancé : temps de jeu réel, même avec un lanceur intermédiaire.
// --------------------------------------------------------------------------

#[cfg(target_os = "windows")]
const PROCESS_POLL_INTERVAL: std::time::Duration = std::time::Duration::from_millis(1500);

/// Durée simulée d'une session hors Windows : permet de tester le cycle
/// complet (minimisation, événement de fin, restauration) sans exécutable.
#[cfg(not(target_os = "windows"))]
const SIMULATED_SESSION_SECONDS: u64 = 5;

/// Dossiers d'exécutables à dépasser pour retrouver la racine du jeu.
#[cfg(any(target_os = "windows", test))]
const BINARY_DIRS: [&str; 8] = [
    "bin", "bin32", "bin64", "binaries", "win32", "win64", "x64", "x86",
];

/// Racine du jeu : `...\Jeu\Binaries\Win64\Jeu.exe` → `...\Jeu`.
#[cfg(any(target_os = "windows", test))]
fn game_root_dir(executable: &Path) -> PathBuf {
    let mut current = executable
        .parent()
        .map(Path::to_path_buf)
        .unwrap_or_else(|| PathBuf::from("."));
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
    current
}

/// Un exécutable appartient-il au jeu ? Comparaison insensible à la casse et
/// aux séparateurs, sans confondre `\Doom` avec `\Doom Eternal`.
#[cfg(any(target_os = "windows", test))]
fn path_is_inside(candidate: &Path, root: &Path) -> bool {
    let normalize = |path: &Path| {
        let raw = path
            .to_string_lossy()
            .replace('/', "\\")
            .to_ascii_lowercase();
        let raw = raw
            .strip_prefix("\\\\?\\")
            .map(str::to_string)
            .unwrap_or(raw);
        let trimmed = raw.trim_end_matches('\\');
        if trimmed.ends_with(':') {
            format!("{trimmed}\\")
        } else {
            trimmed.to_string()
        }
    };
    let root = normalize(root);
    let candidate = normalize(candidate);
    if root.is_empty() || !candidate.starts_with(&root) {
        return false;
    }
    matches!(candidate[root.len()..].chars().next(), None | Some('\\'))
}

/// Fenêtre de démarrage raté : session plus courte que cette durée avec un
/// code de sortie non nul.
const CRASH_WINDOW: std::time::Duration = std::time::Duration::from_secs(2);

/// Attend la fin de tous les processus du jeu (le lanceur peut céder la main)
/// et renvoie la durée exacte de la session ainsi que le code de sortie du
/// processus lancé.
#[cfg(target_os = "windows")]
fn monitor_game_processes(
    root: &Path,
    started: std::time::Instant,
    exit_code: Option<i32>,
    fast_failure: bool,
) -> (std::time::Duration, Option<i32>) {
    if root.parent().is_none() {
        // Racine d'un disque : trop large pour servir de filtre.
        return (started.elapsed(), exit_code);
    }
    let mut system = System::new();
    // Un lanceur qui rend la main immédiatement laisse au vrai jeu le temps
    // d'apparaître. Un échec rapide (code non nul) est conclu sans attendre,
    // pour mesurer la session réelle et détecter le crash au démarrage.
    if !fast_failure {
        std::thread::sleep(PROCESS_POLL_INTERVAL);
    }
    loop {
        // Seul le chemin de l'exécutable est relu : ni environnement, ni disque,
        // ni CPU/mémoire pour l'ensemble des processus.
        system.refresh_processes_specifics(
            ProcessesToUpdate::All,
            true,
            ProcessRefreshKind::new().with_exe(UpdateKind::OnlyIfNotSet),
        );
        let running = system
            .processes()
            .values()
            .filter_map(|process| process.exe())
            .any(|exe| path_is_inside(exe, root));
        if !running {
            return (started.elapsed(), exit_code);
        }
        std::thread::sleep(PROCESS_POLL_INTERVAL);
    }
}

/// Payload de fin de session : le front crédite la durée au jeu concerné.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct GameSessionEnded {
    game_id: String,
    duration_seconds: u64,
    exit_code: Option<i32>,
    crashed: bool,
}

/// Rend la main au launcher : fenêtre restaurée au premier plan, plein écran
/// réimposé, puis événement de fin de session pour le front.
fn finish_game_session(
    app: &tauri::AppHandle,
    game_id: &str,
    elapsed: std::time::Duration,
    exit_code: Option<i32>,
) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.unminimize();
        let _ = window.set_focus();
        let _ = window.set_fullscreen(true);
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
        duration_seconds: elapsed.as_secs(),
        exit_code,
        crashed,
    };
    if let Err(error) = app.emit("game-session-ended", payload) {
        eprintln!("[session] émission de game-session-ended impossible: {error}");
    }
    let _ = app.emit("game-closed", game_id);
}

#[cfg(not(target_os = "windows"))]
fn launch_executable(exe: &Path, title: &str, args: &[String]) -> Result<(), String> {
    println!(
        "[simulation] lancement de \"{title}\" depuis {} (arguments: {:?})",
        exe.display(),
        args
    );
    Ok(())
}

/// Lance le jeu puis attend sa fermeture complète avant de rendre la main au
/// launcher. Le processus est démarré ici (les erreurs remontent à l'appel),
/// l'attente se fait dans un thread pour ne jamais bloquer l'interface.
#[cfg(target_os = "windows")]
fn run_game_session(
    app: tauri::AppHandle,
    exe: PathBuf,
    title: String,
    args: Vec<String>,
    game_id: String,
    started: std::time::Instant,
) -> Result<(), String> {
    let game_root = game_root_dir(&exe);
    let mut child = launch_executable(&exe, &title, &args)?;
    std::thread::spawn(move || {
        // Le lanceur rend souvent la main avant le vrai jeu : on attend sa
        // sortie, puis on surveille les processus de la racine du jeu.
        let exit_code = child.wait().ok().and_then(|status| status.code());
        let exited_after = started.elapsed();
        let fast_failure = exited_after < CRASH_WINDOW
            && exit_code.is_some_and(|code| code != 0);
        let (elapsed, exit_code) =
            monitor_game_processes(&game_root, started, exit_code, fast_failure);
        finish_game_session(&app, &game_id, elapsed, exit_code);
    });
    Ok(())
}

/// Simulation macOS / Linux : aucune attente de processus, une session de
/// durée fixe tient lieu de jeu pour vérifier tout le cycle.
#[cfg(not(target_os = "windows"))]
fn run_game_session(
    app: tauri::AppHandle,
    exe: PathBuf,
    title: String,
    args: Vec<String>,
    game_id: String,
    started: std::time::Instant,
) -> Result<(), String> {
    launch_executable(&exe, &title, &args)?;
    std::thread::spawn(move || {
        std::thread::sleep(std::time::Duration::from_secs(SIMULATED_SESSION_SECONDS));
        finish_game_session(&app, &game_id, started.elapsed(), None);
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
const THEME_EXTENSIONS: [&str; 3] = ["m4a", "webm", "mp3"];

fn themes_dir(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("app_data_dir indisponible: {e}"))?
        .join(THEMES_DIR);
    fs::create_dir_all(&dir).map_err(|e| format!("création de {} impossible: {e}", dir.display()))?;
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
    fs::create_dir_all(&dir).map_err(|e| format!("création de {} impossible: {e}", dir.display()))?;
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

    let response = client
        .get(url)
        .send()
        .await
        .map_err(|e| format!("téléchargement de yt-dlp impossible: {e}"))?;
    if !response.status().is_success() {
        return Err(format!("yt-dlp: HTTP {}", response.status()));
    }
    let bytes = response
        .bytes()
        .await
        .map_err(|e| format!("lecture de yt-dlp impossible: {e}"))?;

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

/// Cherche et télécharge une piste audio : première requête, puis repli.
fn run_yt_dlp(
    binary: &Path,
    themes: &Path,
    game_id: &str,
    query: &str,
) -> Result<(), String> {
    let output_path = themes.join(format!("{game_id}.%(ext)s"));
    let mut command = std::process::Command::new(binary);
    command
        .arg("--no-playlist")
        .arg("--match-filter")
        .arg("duration < 600")
        .arg("-f")
        .arg("bestaudio[ext=m4a]/bestaudio[ext=webm]/bestaudio")
        .arg("-o")
        .arg(&output_path)
        .arg(format!("ytsearch1:{query}"));

    // Sous Windows, pas de fenêtre de console qui clignote par-dessus le jeu.
    #[cfg(target_os = "windows")]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(0x0800_0000);
    }

    let output = command
        .output()
        .map_err(|e| format!("exécution de yt-dlp impossible: {e}"))?;
    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
        return Err(if stderr.is_empty() {
            format!("yt-dlp a échoué ({})", output.status)
        } else {
            stderr
        });
    }
    Ok(())
}

/// Musique de thème d'un jeu : fichier déjà présent, sinon recherche YouTube
/// automatique. Renvoie le chemin absolu du fichier audio.
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
    if let Some(existing) = existing_theme(&themes, &game_id) {
        return Ok(existing.to_string_lossy().to_string());
    }

    let binary = ensure_yt_dlp(&app).await?;

    let attempts = [
        format!("{game_title} PS4 Theme Music"),
        format!("{game_title} Main Menu Theme"),
    ];
    let mut last_error = String::new();

    for query in attempts {
        let binary_for_task = binary.clone();
        let themes_for_task = themes.clone();
        let id_for_task = game_id.clone();
        let result = tauri::async_runtime::spawn_blocking(move || {
            run_yt_dlp(&binary_for_task, &themes_for_task, &id_for_task, &query)
        })
        .await
        .map_err(|e| format!("tâche yt-dlp interrompue: {e}"))?;

        if let Err(error) = result {
            last_error = error;
            eprintln!("[thème] recherche pour « {game_title} »: {last_error}");
        }

        if let Some(found) = existing_theme(&themes, &game_id) {
            return Ok(found.to_string_lossy().to_string());
        }
    }

    Err(if last_error.is_empty() {
        format!("aucune musique trouvée pour « {game_title} »")
    } else {
        last_error
    })
}

/// Enregistre (ou efface) le chemin de la musique de thème d'un jeu.
#[tauri::command]
fn set_game_theme_audio(
    app: tauri::AppHandle,
    game_id: String,
    theme_audio_path: Option<String>,
) -> Result<Vec<Game>, String> {
    let mut games = load_games(&app)?;
    if let Some(game) = games.iter_mut().find(|game| game.id == game_id) {
        game.theme_audio_path = theme_audio_path;
    }
    save_games(&app, &games)?;
    Ok(games)
}

/// Supprime le fichier de thème d'un jeu et oublie son chemin : la prochaine
/// génération repart d'une recherche neuve.
#[tauri::command]
fn clear_game_theme(app: tauri::AppHandle, game_id: String) -> Result<Vec<Game>, String> {
    let themes = themes_dir(&app)?;
    for ext in THEME_EXTENSIONS {
        let candidate = themes.join(format!("{game_id}.{ext}"));
        if candidate.is_file() {
            let _ = fs::remove_file(&candidate);
        }
    }

    let mut games = load_games(&app)?;
    if let Some(game) = games.iter_mut().find(|game| game.id == game_id) {
        game.theme_audio_path = None;
    }
    save_games(&app, &games)?;
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
    remove_cache_files(&data_dir.join(THEMES_DIR), game_id);
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
        (tokens.len() >= 2 && tokens[0].eq_ignore_ascii_case(key))
            .then(|| tokens[1].clone())
    })
}

#[cfg(target_os = "windows")]
fn vdf_quoted_values(content: &str, key: &str) -> Vec<String> {
    content
        .lines()
        .filter_map(|line| {
            let tokens = vdf_tokens(line);
            (tokens.len() >= 2 && tokens[0].eq_ignore_ascii_case(key))
                .then(|| tokens[1].clone())
        })
        .collect()
}

#[cfg(target_os = "windows")]
fn steam_path_from_registry() -> Option<PathBuf> {
    use winreg::enums::{HKEY_CURRENT_USER, KEY_READ};
    use winreg::RegKey;

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
        if candidate.join("steamapps").is_dir()
            && !roots.iter().any(|root| root == &candidate)
        {
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
                    steam_appid: (!appid.trim().is_empty())
                        .then(|| appid.trim().to_string()),
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
    use winreg::enums::{HKEY_LOCAL_MACHINE, KEY_READ};
    use winreg::RegKey;

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
    games.push(Game {
        id: Uuid::new_v4().to_string(),
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
fn set_game_pinned(
    app: tauri::AppHandle,
    id: String,
    pinned: bool,
) -> Result<Vec<Game>, String> {
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

#[tauri::command]
fn launch_game(app: tauri::AppHandle, id: String) -> Result<Vec<Game>, String> {
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

    // Instant exact du démarrage, avant même la minimisation.
    let started = std::time::Instant::now();
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.minimize();
    }

    if let Err(error) = run_game_session(app.clone(), exe, title, args, id, started) {
        // Échec du lancement : le launcher ne doit pas rester minimisé.
        if let Some(window) = app.get_webview_window("main") {
            let _ = window.unminimize();
            let _ = window.set_focus();
            let _ = window.set_fullscreen(true);
        }
        return Err(error);
    }

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
async fn fetch_game_artwork(
    app: tauri::AppHandle,
    game_id: String,
) -> Result<Vec<Game>, String> {
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
        if let Some(url) =
            steamgriddb_square_cover_url(&client, &api_key, appid_ref, &title).await
        {
            cover_saved = download_image(&client, &url, &cover_path).await.is_ok();
        }
    }
    if !cover_saved {
        if let Some(appid) = appid_ref {
            let fallback = format!("{STEAM_ARTWORK}/{appid}/library_600x900_2x.jpg");
            cover_saved = download_image(&client, &fallback, &cover_path).await.is_ok();
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
            url.starts_with(COVERS_SCHEME)
                || url.starts_with(&format!("http://{COVERS_SCHEME}."))
        });
        if !cover_saved && !cached_cover {
            if let (Ok(file), Ok(directory)) = (icon_file(&game_id), icons_dir(&app)) {
                if write_exe_icon(
                    Path::new(&games[index].exe_path),
                    &directory.join(&file),
                )
                .is_ok()
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
                if download_image(&client, &candidate, &hero_path).await.is_ok() {
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
    fs::create_dir_all(&dir).map_err(|e| format!("création de {} impossible: {e}", dir.display()))?;
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
        CreateCompatibleDC, DeleteDC, DeleteObject, GetDIBits, GetObjectW, SelectObject,
        BITMAP, BITMAPINFO, BI_RGB, DIB_RGB_COLORS,
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
        assert_eq!(derive_title(Path::new("/games/My_Game/launcher.exe"), dir), "My Game");
        assert_eq!(derive_title(Path::new("/games/My_Game/GTA V.exe"), dir), "GTA V");
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
        assert_eq!(
            find_steam_appid(&game.join("bin")).as_deref(),
            Some("620")
        );
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
type XInputGetStateFn =
    unsafe extern "system" fn(user_index: u32, state: *mut XInputState) -> u32;
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
    static API: std::sync::OnceLock<
        Option<(XInputGetStateFn, XInputGetBatteryInformationFn)>,
    > = std::sync::OnceLock::new();
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
        let known = unsafe {
            xinput_get_battery(index, BATTERY_DEVTYPE_GAMEPAD, &mut battery)
        } == ERROR_SUCCESS;
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
            trophies::get_game_trophies
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
