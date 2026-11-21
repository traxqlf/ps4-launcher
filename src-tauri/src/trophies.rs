use serde::{Deserialize, Deserializer, Serialize};
use serde_json::Value;
use std::collections::{HashMap, HashSet};
use std::fs;
use std::path::{Path, PathBuf};
use std::time::Duration;
use tauri::Manager;

const API_URL: &str =
    "https://api.steampowered.com/ISteamUserStats/GetGlobalAchievementPercentagesForApp/v2/";

/// Page publique de la communauté : noms et descriptions localisés, sans clé d'API.
const COMMUNITY_URL: &str = "https://steamcommunity.com/achievements/";

/// Schéma officiel : titres localisés et icônes couleur/grisée (clé Web API).
const SCHEMA_URL: &str = "https://api.steampowered.com/ISteamUserStats/GetSchemaForGame/v2/";

/// Trophées réellement débloqués sur le compte Steam du joueur.
const PLAYER_URL: &str = "https://api.steampowered.com/ISteamUserStats/GetPlayerAchievements/v1/";

/// Icônes officielles servies par le CDN communautaire Steam.
const ICON_CDN: &str = "https://cdn.akamai.steamstatic.com/steamcommunity/public/images/apps";

/// État des trophées déjà vus, pour ne notifier que les nouveautés.
const STATE_FILE: &str = "trophies_cache.json";
/// Steam ne fournit pas de trophée Platine : on le génère localement.
const PLATINUM_ID: &str = "ps4_platinum_trophy";
const PLATINUM_ICON: &str = "/trophies/platinum.png";

/// Petits mots anglais qui restent collés lorsque Steam ne fournit que l'identifiant.
const FUNCTION_WORDS: [&str; 8] = ["of", "the", "for", "is", "in", "on", "to", "and"];

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PercentEntry {
    pub name: String,
    #[serde(default, deserialize_with = "deserialize_percent")]
    pub percent: f64,
}

#[derive(Deserialize)]
#[serde(untagged)]
enum PercentValue {
    Number(f64),
    Text(String),
}

fn deserialize_percent<'de, D>(deserializer: D) -> Result<f64, D::Error>
where
    D: Deserializer<'de>,
{
    Ok(match PercentValue::deserialize(deserializer)? {
        PercentValue::Number(value) => value,
        // L'API Steam renvoie des chaînes ("74.9") ; le cache local écrit des nombres.
        PercentValue::Text(value) => value.parse().unwrap_or(0.0),
    })
}

#[derive(Deserialize)]
struct PercentResponse {
    achievementpercentages: PercentWrapper,
}

#[derive(Deserialize)]
struct PercentWrapper {
    #[serde(default)]
    achievements: Vec<PercentEntry>,
}

#[derive(Debug, Clone, Serialize)]
pub struct Trophy {
    pub id: String,
    pub name: String,
    pub description: String,
    pub percent: f64,
    pub rank: String,
    pub unlocked: bool,
    /// Succès masqué par le jeu : nom et description cachés tant qu'il n'est
    /// pas débloqué (révélables avec Carré dans l'écran Trophées).
    #[serde(default)]
    pub hidden: bool,
    /// Icône officielle couleur (vide si Steam ne la fournit pas).
    #[serde(default)]
    pub icon: String,
    /// Icône officielle grisée, affichée tant que le trophée est verrouillé.
    #[serde(default)]
    pub icongray: String,
    /// Date de déblocage (secondes Unix), absente pour les fichiers locaux.
    #[serde(default)]
    pub unlocked_at: Option<u64>,
}

/// Nom, description et icônes lisibles associés à un identifiant interne Steam.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct AchievementText {
    #[serde(default)]
    pub name: String,
    #[serde(default)]
    pub description: String,
    #[serde(default)]
    pub icon: String,
    #[serde(default)]
    pub icongray: String,
    /// Propriété `hidden` du schéma Steam, ou métadonnée locale équivalente.
    #[serde(default)]
    pub hidden: bool,
}

/// Textes conservés d'une visite à l'autre pour rester lisible hors ligne.
#[derive(Debug, Default, Serialize, Deserialize)]
struct TextCache {
    lang: String,
    entries: HashMap<String, AchievementText>,
}

#[derive(Default, Debug, Serialize)]
pub struct TrophyCounts {
    pub bronze: usize,
    pub silver: usize,
    pub gold: usize,
    pub platinum: usize,
}

#[derive(Debug, Serialize)]
pub struct TrophyReport {
    pub appid: String,
    pub progress: f64,
    pub unlocked: usize,
    pub total: usize,
    pub counts: TrophyCounts,
    pub trophies: Vec<Trophy>,
    /// Trophées débloqués depuis la vérification précédente (notification PS4).
    pub new_trophies: Vec<Trophy>,
    pub offline: bool,
}

/// Trophée Platine synthétique : même rareté que le succès le plus rare du jeu
/// (donc « Ultra rare »), icône locale dédiée, débloqué à 100 %.
fn platinum_trophy(trophies: &[Trophy], unlocked: bool, earned_at: Option<u64>) -> Trophy {
    let rarest = trophies
        .iter()
        .map(|trophy| trophy.percent)
        .filter(|percent| *percent > 0.0)
        .fold(f64::INFINITY, f64::min);
    Trophy {
        id: PLATINUM_ID.to_string(),
        name: "Trophée de platine".to_string(),
        description: "Obtenez tous les trophées.".to_string(),
        percent: if rarest.is_finite() { rarest } else { 0.1 },
        rank: "platinum".to_string(),
        unlocked,
        hidden: false,
        icon: PLATINUM_ICON.to_string(),
        icongray: PLATINUM_ICON.to_string(),
        unlocked_at: if unlocked { earned_at } else { None },
    }
}

/// Grades PS4 selon la rareté mondiale : l'Or reste réservé aux trophées
/// obtenus par moins de 10 % des joueurs, le Platine couronne les 100 %.
fn rank_for(percent: f64) -> &'static str {
    if percent < 10.0 {
        "or"
    } else if percent < 35.0 {
        "argent"
    } else {
        "bronze"
    }
}

/// `hidden` peut arriver en booléen, en nombre (`1`) ou en chaîne selon la
/// source (schéma officiel, payload communautaire, cache local).
fn hidden_flag(value: Option<&Value>) -> bool {
    match value {
        Some(Value::Bool(flag)) => *flag,
        Some(Value::Number(number)) => {
            number.as_u64() == Some(1) || number.as_f64().is_some_and(|v| v == 1.0)
        }
        Some(Value::String(text)) => matches!(
            text.trim().to_ascii_lowercase().as_str(),
            "1" | "true" | "yes"
        ),
        _ => false,
    }
}

fn icon_from_cdn(appid: &str, file: &str) -> String {
    let file = file.trim();
    if file.is_empty() {
        return String::new();
    }
    if let Some(rest) = file.strip_prefix("http://") {
        return format!("https://{rest}");
    }
    if file.starts_with("https://") {
        return file.to_string();
    }
    format!("{ICON_CDN}/{appid}/{file}")
}

/// Trophées débloqués (et dates) récupérés localement ou via Steam.
#[derive(Debug, Default)]
struct EarnedState {
    names: HashSet<String>,
    times: HashMap<String, u64>,
}

impl EarnedState {
    fn insert(&mut self, name: &str, time: u64) {
        let name = name.trim();
        if name.is_empty() {
            return;
        }
        let key = name.to_uppercase();
        self.names.insert(key.clone());
        if time > 0 {
            self.times.entry(key).or_insert(time);
        }
    }

    fn contains(&self, name: &str) -> bool {
        self.names.contains(&name.to_uppercase())
    }

    fn merge(&mut self, other: EarnedState) {
        for name in other.names {
            self.names.insert(name.clone());
        }
        for (name, time) in other.times {
            self.times.entry(name).or_insert(time);
        }
    }
}

fn is_function_word(word: &str) -> bool {
    FUNCTION_WORDS.contains(&word)
}

/// Découpe un bloc entièrement collé (« Kingofthecups ») sur les petits mots
/// anglais. La découpe n'est acceptée que si un petit mot est encadré de deux
/// fragments francs, et l'en-tête n'est autorisé qu'après une première coupe :
/// les identifiants déjà lisibles (« Champion », « Island ») restent intacts.
fn split_glued(word: &str) -> Vec<String> {
    let chars: Vec<char> = word.chars().collect();
    if chars.len() < 8 {
        return vec![word.to_string()];
    }

    let mut pieces: Vec<String> = Vec::new();
    let mut start = 0usize;
    let mut cursor = 0usize;
    while cursor < chars.len() {
        let mut matched: Option<usize> = None;
        for word_fn in FUNCTION_WORDS {
            let len = word_fn.chars().count();
            if cursor + len > chars.len() {
                continue;
            }
            let candidate: String = chars[cursor..cursor + len].iter().collect();
            if candidate != word_fn {
                continue;
            }
            let before = cursor - start;
            let after = chars.len() - (cursor + len);
            // En tête de mot on exige un reste franc et une coupe déjà
            // engagée, sinon on éclaterait des mots entiers (« Island »).
            let boundary_ok = if cursor == start {
                !pieces.is_empty() && after >= 4
            } else {
                before >= 3 && after >= 3
            };
            if boundary_ok {
                matched = Some(len);
                break;
            }
        }

        match matched {
            Some(len) => {
                if cursor > start {
                    pieces.push(chars[start..cursor].iter().collect());
                }
                pieces.push(chars[cursor..cursor + len].iter().collect());
                cursor += len;
                start = cursor;
            }
            None => cursor += 1,
        }
    }

    if start < chars.len() {
        pieces.push(chars[start..].iter().collect());
    }
    pieces
}

fn capitalize(word: &str) -> String {
    let mut chars = word.chars();
    match chars.next() {
        Some(first) => format!("{}{}", first.to_uppercase(), chars.as_str()),
        None => String::new(),
    }
}

/// Filet de sécurité quand Steam ne donne que l'identifiant interne :
/// séparateurs, découpage CamelCase, mots collés, puis mise en forme.
fn humanize(name: &str) -> String {
    let mut spaced = String::with_capacity(name.len() + 8);
    let mut previous: Option<char> = None;
    for ch in name.chars() {
        if matches!(ch, '_' | '-' | '.' | '/') {
            spaced.push(' ');
            previous = None;
            continue;
        }
        if let Some(prev) = previous {
            let camel = (prev.is_lowercase() || prev.is_ascii_digit()) && ch.is_uppercase();
            if camel {
                spaced.push(' ');
            }
        }
        spaced.push(ch);
        previous = Some(ch);
    }

    let mut words: Vec<String> = Vec::new();
    for token in spaced.split_whitespace() {
        words.extend(split_glued(token));
    }
    if words.is_empty() {
        return name.trim().to_string();
    }

    let mut formatted: Vec<String> = Vec::with_capacity(words.len());
    for (index, word) in words.iter().enumerate() {
        let lower = word.to_lowercase();
        if index > 0 && is_function_word(&lower) {
            formatted.push(lower);
        } else {
            formatted.push(capitalize(&lower));
        }
    }
    formatted.join(" ")
}

fn normalize_key(raw: &str) -> String {
    raw.chars()
        .filter(|c| c.is_alphanumeric())
        .flat_map(|c| c.to_lowercase())
        .collect()
}

fn decode_entities(raw: &str) -> String {
    let mut out = String::with_capacity(raw.len());
    let mut rest = raw;
    while let Some(index) = rest.find('&') {
        out.push_str(&rest[..index]);
        let tail = &rest[index..];
        let semi = tail.find(';').filter(|semi| *semi <= 10);
        let Some(semi) = semi else {
            out.push('&');
            rest = &tail[1..];
            continue;
        };
        let entity = &tail[1..semi];
        let replacement = match entity {
            "amp" => Some('&'),
            "quot" => Some('"'),
            "apos" => Some('\''),
            "lt" => Some('<'),
            "gt" => Some('>'),
            "nbsp" => Some(' '),
            _ => entity.strip_prefix('#').and_then(|number| {
                let code = match number.strip_prefix(['x', 'X']) {
                    Some(hex) => u32::from_str_radix(hex, 16).ok()?,
                    None => number.parse::<u32>().ok()?,
                };
                char::from_u32(code)
            }),
        };
        match replacement {
            Some(ch) => {
                out.push(ch);
                rest = &tail[semi + 1..];
            }
            None => {
                out.push('&');
                rest = &tail[1..];
            }
        }
    }
    out.push_str(rest);
    out
}

fn clean_text(raw: &str) -> String {
    let decoded = decode_entities(raw);
    let mut out = String::with_capacity(decoded.len());
    let mut pending_space = false;
    for ch in decoded.chars() {
        if ch.is_whitespace() {
            pending_space = true;
            continue;
        }
        if pending_space && !out.is_empty() {
            out.push(' ');
        }
        pending_space = false;
        out.push(ch);
    }
    out
}

/// Le payload SSR de la page communauté est un JSON qui contient des JSON
/// encodés en chaînes ; on le parcourt jusqu'aux fiches de trophées.
fn collect_texts(
    node: &Value,
    out: &mut HashMap<String, AchievementText>,
    depth: usize,
    appid: &str,
) {
    if depth > 12 {
        return;
    }
    match node {
        Value::Object(map) => {
            if let Some(api) = map.get("api_name").and_then(Value::as_str) {
                let name = clean_text(map.get("name").and_then(Value::as_str).unwrap_or(""));
                let description =
                    clean_text(map.get("description").and_then(Value::as_str).unwrap_or(""));
                // La page communauté ne donne que les noms de fichiers : le CDN
                // Steam les complète avec l'appid.
                let icon = icon_from_cdn(
                    appid,
                    map.get("icon_achieved")
                        .and_then(Value::as_str)
                        .unwrap_or(""),
                );
                let icongray = icon_from_cdn(
                    appid,
                    map.get("icon_unachieved")
                        .and_then(Value::as_str)
                        .unwrap_or(""),
                );
                let hidden = hidden_flag(map.get("hidden"));
                if !name.is_empty() {
                    out.entry(normalize_key(api)).or_insert(AchievementText {
                        name,
                        description,
                        icon,
                        icongray,
                        hidden,
                    });
                } else if !icon.is_empty() || !icongray.is_empty() {
                    // Une fiche sans libellé garde quand même ses icônes.
                    out.entry(normalize_key(api)).and_modify(|existing| {
                        if existing.icon.is_empty() {
                            existing.icon = icon.clone();
                        }
                        if existing.icongray.is_empty() {
                            existing.icongray = icongray.clone();
                        }
                        existing.hidden = existing.hidden || hidden;
                    });
                }
                return;
            }
            for child in map.values() {
                collect_texts(child, out, depth + 1, appid);
            }
        }
        Value::Array(items) => {
            for item in items {
                collect_texts(item, out, depth + 1, appid);
            }
        }
        Value::String(text) => {
            let trimmed = text.trim_start();
            if (trimmed.starts_with('{') || trimmed.starts_with('['))
                && let Ok(inner) = serde_json::from_str::<Value>(trimmed)
            {
                collect_texts(&inner, out, depth + 1, appid);
            }
        }
        _ => {}
    }
}

fn extract_ssr_payload(html: &str) -> Option<Value> {
    let marker = html.find("id=\"valve-ssr-data\"")?;
    let start = marker + html[marker..].find('>')? + 1;
    let end = start + html[start..].find("</script>")?;
    serde_json::from_str::<Value>(&html[start..end]).ok()
}

fn cache_path(app: &tauri::AppHandle, appid: &str) -> Result<PathBuf, String> {
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("app_data_dir indisponible: {e}"))?
        .join("trophies");
    fs::create_dir_all(&dir)
        .map_err(|e| format!("création de {} impossible: {e}", dir.display()))?;
    Ok(dir.join(format!("{appid}.json")))
}

#[cfg(target_os = "windows")]
fn unlocked_paths(_app: &tauri::AppHandle, appid: &str) -> Vec<PathBuf> {
    let mut paths = Vec::new();
    if let Some(appdata) = std::env::var_os("APPDATA") {
        let root = PathBuf::from(appdata);
        paths.push(
            root.join("Goldberg SteamEmu Saves")
                .join(appid)
                .join("achievements.json"),
        );
        paths.push(root.join("GSE Saves").join(appid).join("achievements.json"));
        for emulator in ["CODEX", "RUNE", "TENOKE"] {
            paths.push(root.join(emulator).join(appid).join("achievements.ini"));
        }
    }
    // Dépôt public partagé par les émulateurs de sauvegarde.
    let public = PathBuf::from("C:\\Users\\Public\\Documents\\Steam");
    for emulator in ["CODEX", "RUNE", "TENOKE"] {
        paths.push(public.join(emulator).join(appid).join("achievements.ini"));
    }
    paths
}

#[cfg(not(target_os = "windows"))]
fn unlocked_paths(app: &tauri::AppHandle, appid: &str) -> Vec<PathBuf> {
    let Ok(dir) = app.path().app_data_dir() else {
        return Vec::new();
    };
    vec![
        dir.join("trophies")
            .join("unlocked")
            .join(format!("{appid}.json")),
    ]
}

fn earned_time_of(value: &Value) -> u64 {
    value
        .get("earned_time")
        .or_else(|| value.get("unlocktime"))
        .or_else(|| value.get("time"))
        .and_then(|time| time.as_u64().or_else(|| time.as_f64().map(|t| t as u64)))
        .unwrap_or(0)
}

fn collect_earned(value: &Value, earned: &mut EarnedState) {
    match value {
        Value::Object(map) => {
            if map.get("earned").and_then(Value::as_bool) == Some(true)
                && let Some(name) = map.get("name").and_then(Value::as_str)
            {
                earned.insert(name, earned_time_of(value));
            }
            for (key, child) in map {
                if child.get("earned").and_then(Value::as_bool) == Some(true) {
                    earned.insert(key, earned_time_of(child));
                }
                collect_earned(child, earned);
            }
        }
        Value::Array(items) => {
            for item in items {
                collect_earned(item, earned);
            }
        }
        _ => {}
    }
}

/// Fichiers `achievements.ini` des émulateurs : `ACH_NAME=1`, ou index → nom.
fn parse_ini_achievements(raw: &str, earned: &mut EarnedState) {
    for line in raw.lines() {
        let line = line.trim();
        if line.is_empty()
            || line.starts_with(';')
            || line.starts_with('#')
            || line.starts_with('[')
        {
            continue;
        }
        let Some((key, value)) = line.split_once('=') else {
            continue;
        };
        let key = key.trim();
        let value = value.trim();
        if key.is_empty() || value.is_empty() {
            continue;
        }
        if matches!(
            value.to_ascii_lowercase().as_str(),
            "1" | "true" | "yes" | "unlocked"
        ) {
            earned.insert(key, 0);
        } else if key.chars().all(|c| c.is_ascii_digit())
            && !matches!(value.to_ascii_lowercase().as_str(), "0" | "false" | "no")
        {
            earned.insert(value, 0);
        }
    }
}

fn load_earned(app: &tauri::AppHandle, appid: &str) -> EarnedState {
    let mut earned = EarnedState::default();
    for path in unlocked_paths(app, appid) {
        let Ok(raw) = fs::read_to_string(&path) else {
            continue;
        };
        let is_ini = path
            .extension()
            .and_then(|extension| extension.to_str())
            .is_some_and(|extension| extension.eq_ignore_ascii_case("ini"));
        if is_ini {
            parse_ini_achievements(&raw, &mut earned);
        } else if let Ok(value) = serde_json::from_str::<Value>(&raw) {
            collect_earned(&value, &mut earned);
        }
    }
    earned
}

/// État persisté : appid → identifiant de trophée → date de déblocage connue.
#[derive(Debug, Default, Serialize, Deserialize)]
struct TrophyState {
    #[serde(default)]
    games: HashMap<String, HashMap<String, u64>>,
}

fn state_path(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("app_data_dir indisponible: {e}"))?;
    fs::create_dir_all(&dir)
        .map_err(|e| format!("création de {} impossible: {e}", dir.display()))?;
    Ok(dir.join(STATE_FILE))
}

fn load_state(app: &tauri::AppHandle) -> TrophyState {
    state_path(app)
        .ok()
        .and_then(|path| fs::read_to_string(path).ok())
        .and_then(|raw| serde_json::from_str::<TrophyState>(&raw).ok())
        .unwrap_or_default()
}

fn save_state(app: &tauri::AppHandle, state: &TrophyState) {
    let Ok(path) = state_path(app) else {
        return;
    };
    if let Ok(raw) = serde_json::to_string_pretty(state) {
        let _ = fs::write(path, raw);
    }
}

fn now_seconds() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|elapsed| elapsed.as_secs())
        .unwrap_or(0)
}

fn http_client() -> Result<reqwest::Client, String> {
    reqwest::Client::builder()
        .user_agent(concat!("ps4-launcher/", env!("CARGO_PKG_VERSION")))
        .timeout(Duration::from_secs(20))
        .build()
        .map_err(|e| format!("client HTTP indisponible: {e}"))
}

async fn fetch_percentages(appid: &str) -> Result<Vec<PercentEntry>, String> {
    let client = http_client()?;

    let response = client
        .get(API_URL)
        .query(&[("gameid", appid)])
        .send()
        .await
        .map_err(|e| format!("API trophées injoignable: {e}"))?;

    if !response.status().is_success() {
        return Err(format!("API trophées: HTTP {}", response.status()));
    }

    let payload: PercentResponse = response
        .json()
        .await
        .map_err(|e| format!("réponse trophées invalide: {e}"))?;

    Ok(payload.achievementpercentages.achievements)
}

async fn load_percentages(
    app: &tauri::AppHandle,
    appid: &str,
) -> Result<(Vec<PercentEntry>, bool), String> {
    let cache = cache_path(app, appid)?;

    match fetch_percentages(appid).await {
        Ok(entries) if !entries.is_empty() => {
            if let Ok(raw) = serde_json::to_string_pretty(&entries) {
                let _ = fs::write(&cache, raw);
            }
            Ok((entries, false))
        }
        _ => {
            let raw = fs::read_to_string(&cache).map_err(|_| {
                format!("aucun trophée disponible en ligne ou en cache pour l'appid {appid}")
            })?;
            let entries =
                serde_json::from_str(&raw).map_err(|e| format!("cache trophées invalide: {e}"))?;
            Ok((entries, true))
        }
    }
}

async fn fetch_community_texts(
    client: &reqwest::Client,
    appid: &str,
    lang: &str,
) -> Result<HashMap<String, AchievementText>, String> {
    let url = format!("{COMMUNITY_URL}{appid}?l={lang}");
    let response = client
        .get(&url)
        .send()
        .await
        .map_err(|e| format!("page trophées ({lang}) injoignable: {e}"))?;

    if !response.status().is_success() {
        return Err(format!(
            "page trophées ({lang}): HTTP {}",
            response.status()
        ));
    }

    let html = response
        .text()
        .await
        .map_err(|e| format!("page trophées ({lang}) illisible: {e}"))?;

    let payload = extract_ssr_payload(&html)
        .ok_or_else(|| format!("page trophées ({lang}) sans données embarquées"))?;

    let mut entries = HashMap::new();
    collect_texts(&payload, &mut entries, 0, appid);
    if entries.is_empty() {
        return Err(format!("page trophées ({lang}) sans trophée lisible"));
    }
    Ok(entries)
}

/// Schéma officiel : libellés localisés et icônes couleur / grisée.
async fn fetch_schema_texts(
    client: &reqwest::Client,
    appid: &str,
    api_key: Option<&str>,
) -> HashMap<String, AchievementText> {
    // L'API officielle exige une clé : sans elle, la page communauté suffit.
    let key = match api_key.map(str::trim).filter(|key| !key.is_empty()) {
        Some(key) => key.to_string(),
        None => match std::env::var("STEAM_API_KEY") {
            Ok(key) if !key.trim().is_empty() => key.trim().to_string(),
            _ => return HashMap::new(),
        },
    };

    let Ok(response) = client
        .get(SCHEMA_URL)
        .query(&[("key", key.as_str()), ("appid", appid), ("l", "french")])
        .send()
        .await
    else {
        return HashMap::new();
    };
    if !response.status().is_success() {
        return HashMap::new();
    }
    let Ok(payload) = response.json::<Value>().await else {
        return HashMap::new();
    };
    let Some(list) = payload
        .pointer("/game/availableGameStats/achievements")
        .and_then(Value::as_array)
    else {
        return HashMap::new();
    };

    let mut entries = HashMap::new();
    for item in list {
        let Some(api) = item.get("name").and_then(Value::as_str) else {
            continue;
        };
        let name = clean_text(
            item.get("displayName")
                .and_then(Value::as_str)
                .unwrap_or(""),
        );
        if name.is_empty() {
            continue;
        }
        let description = clean_text(
            item.get("description")
                .and_then(Value::as_str)
                .unwrap_or(""),
        );
        let icon = icon_from_cdn(
            appid,
            item.get("icon").and_then(Value::as_str).unwrap_or(""),
        );
        let icongray = icon_from_cdn(
            appid,
            item.get("icongray").and_then(Value::as_str).unwrap_or(""),
        );
        entries.insert(
            normalize_key(api),
            AchievementText {
                name,
                description,
                icon,
                icongray,
                hidden: hidden_flag(item.get("hidden")),
            },
        );
    }
    entries
}

/// Trophées réellement débloqués sur le compte Steam (et date de déblocage).
async fn fetch_player_achievements(
    client: &reqwest::Client,
    api_key: &str,
    steam_id: &str,
    appid: &str,
) -> EarnedState {
    let mut earned = EarnedState::default();
    let Ok(response) = client
        .get(PLAYER_URL)
        .query(&[
            ("appid", appid),
            ("key", api_key),
            ("steamid", steam_id),
            ("l", "french"),
        ])
        .send()
        .await
    else {
        return earned;
    };
    if !response.status().is_success() {
        return earned;
    }
    let Ok(payload) = response.json::<Value>().await else {
        return earned;
    };
    let Some(list) = payload
        .pointer("/playerstats/achievements")
        .and_then(Value::as_array)
    else {
        return earned;
    };

    for item in list {
        if item.get("achieved").and_then(Value::as_u64).unwrap_or(0) != 1 {
            continue;
        }
        let Some(api) = item.get("apiname").and_then(Value::as_str) else {
            continue;
        };
        earned.insert(api, earned_time_of(item));
    }
    earned
}

fn texts_cache_path(app: &tauri::AppHandle, appid: &str) -> Result<PathBuf, String> {
    Ok(cache_path(app, appid)?.with_file_name(format!("{appid}.texts.json")))
}

fn save_text_cache(path: Option<&Path>, lang: &str, entries: &HashMap<String, AchievementText>) {
    let Some(path) = path else {
        return;
    };
    let payload = TextCache {
        lang: lang.to_string(),
        entries: entries.clone(),
    };
    if let Ok(raw) = serde_json::to_string_pretty(&payload) {
        let _ = fs::write(path, raw);
    }
}

/// Noms et descriptions : page communauté française, puis anglaise, puis API
/// officielle, puis cache local — sans jamais bloquer l'affichage des trophées.
async fn load_achievement_texts(
    app: &tauri::AppHandle,
    appid: &str,
    api_key: Option<&str>,
) -> HashMap<String, AchievementText> {
    let cache = texts_cache_path(app, appid).ok();

    if let Ok(client) = http_client() {
        let community = {
            let mut found = None;
            for lang in ["french", "english"] {
                if let Ok(entries) = fetch_community_texts(&client, appid, lang).await {
                    found = Some((lang, entries));
                    break;
                }
            }
            found
        };

        // Le schéma officiel complète les icônes et les libellés manquants.
        let schema = fetch_schema_texts(&client, appid, api_key).await;

        match community {
            Some((lang, mut entries)) => {
                for (key, text) in schema {
                    match entries.get_mut(&key) {
                        Some(existing) => {
                            if existing.icon.is_empty() {
                                existing.icon = text.icon;
                            }
                            if existing.icongray.is_empty() {
                                existing.icongray = text.icongray;
                            }
                            if existing.name.is_empty() {
                                existing.name = text.name;
                            }
                            if existing.description.is_empty() {
                                existing.description = text.description;
                            }
                            existing.hidden = existing.hidden || text.hidden;
                        }
                        None => {
                            entries.insert(key, text);
                        }
                    }
                }
                save_text_cache(cache.as_deref(), &lang, &entries);
                return entries;
            }
            None if !schema.is_empty() => {
                save_text_cache(cache.as_deref(), "schema", &schema);
                return schema;
            }
            None => {}
        }
    }

    if let Some(path) = cache
        && let Ok(raw) = fs::read_to_string(path)
        && let Ok(cached) = serde_json::from_str::<TextCache>(&raw)
    {
        return cached.entries;
    }

    HashMap::new()
}

#[tauri::command]
pub async fn get_game_trophies(
    app: tauri::AppHandle,
    steam_appid: String,
    mark_new: Option<bool>,
) -> Result<TrophyReport, String> {
    if steam_appid.is_empty() || !steam_appid.chars().all(|c| c.is_ascii_digit()) {
        return Err(format!("Steam AppID invalide: {steam_appid}"));
    }

    let profile = crate::load_profile(&app).unwrap_or_default();
    let api_key = {
        let key = profile.steam_api_key.trim().to_string();
        if key.is_empty() { None } else { Some(key) }
    };
    let steam_id = profile.steam_id.trim().to_string();

    let (entries, offline) = load_percentages(&app, &steam_appid).await?;

    // Déblocages locaux (émulateurs Windows) puis compte Steam officiel.
    let mut earned = load_earned(&app, &steam_appid);
    if let (Some(key), false) = (api_key.as_deref(), steam_id.is_empty())
        && let Ok(client) = http_client()
    {
        let steam = fetch_player_achievements(&client, key, &steam_id, &steam_appid).await;
        earned.merge(steam);
    }

    // Les pourcentages ne portent que des identifiants internes : on récupère
    // les vrais libellés et les icônes officielles.
    let texts = load_achievement_texts(&app, &steam_appid, api_key.as_deref()).await;

    let track = mark_new.unwrap_or(true);
    let mut state = load_state(&app);
    let previous = state.games.get(&steam_appid).cloned();
    let first_check = previous.is_none();
    let previous = previous.unwrap_or_default();
    let now = now_seconds();
    // Premier passage : seuls les déblocages récents méritent une notification,
    // sinon la file d'attente déverserait tout l'historique du compte.
    let recent_cutoff = now.saturating_sub(24 * 3600);

    let total = entries.len();
    let mut unlocked_count = 0usize;
    let mut counts = TrophyCounts::default();
    let mut trophies = Vec::with_capacity(total + 1);
    let mut new_trophies: Vec<Trophy> = Vec::new();

    for entry in entries {
        let key = entry.name.to_uppercase();
        let unlocked = earned.contains(&entry.name);
        let rank = rank_for(entry.percent).to_string();
        if unlocked {
            unlocked_count += 1;
            match rank.as_str() {
                "or" => counts.gold += 1,
                "argent" => counts.silver += 1,
                _ => counts.bronze += 1,
            }
        }
        let text = texts.get(&normalize_key(&entry.name));
        let name = match text {
            Some(text) if !text.name.is_empty() => text.name.clone(),
            _ => humanize(&entry.name),
        };
        let description = text
            .map(|text| text.description.clone())
            .unwrap_or_default();
        let unlocked_at = if unlocked {
            earned
                .times
                .get(&key)
                .copied()
                .filter(|time| *time > 0)
                .or_else(|| previous.get(&key).copied().filter(|time| *time > 0))
        } else {
            None
        };
        let is_new = unlocked
            && if first_check {
                unlocked_at.is_some_and(|time| time >= recent_cutoff)
            } else {
                !previous.contains_key(&key)
            };

        let trophy = Trophy {
            id: entry.name.clone(),
            name,
            description,
            percent: entry.percent,
            rank,
            unlocked,
            hidden: text.map(|text| text.hidden).unwrap_or(false),
            icon: text.map(|text| text.icon.clone()).unwrap_or_default(),
            icongray: text.map(|text| text.icongray.clone()).unwrap_or_default(),
            unlocked_at,
        };
        if is_new {
            new_trophies.push(trophy.clone());
        }
        trophies.push(trophy);
    }

    trophies.sort_by(|a, b| a.percent.total_cmp(&b.percent));

    // Comme sur PS4, le Platine coiffe la collection : il est ajouté en tête dès
    // que le jeu expose au moins un succès, et ne tombe qu'à 100 %.
    let platinum_unlocked = total > 0 && unlocked_count == total;
    let platinum_earned_at = trophies
        .iter()
        .filter_map(|trophy| trophy.unlocked_at)
        .max();
    if total > 0 {
        counts.platinum = usize::from(platinum_unlocked);
        let platinum = platinum_trophy(&trophies, platinum_unlocked, platinum_earned_at);
        let platinum_is_new = platinum_unlocked
            && if first_check {
                platinum_earned_at.is_some_and(|time| time >= recent_cutoff)
            } else {
                !previous.contains_key(PLATINUM_ID)
            };
        if platinum_is_new {
            new_trophies.push(platinum.clone());
        }
        trophies.insert(0, platinum);
    }

    if track {
        let mut record = previous.clone();
        for name in &earned.names {
            let time = earned
                .times
                .get(name)
                .copied()
                .filter(|time| *time > 0)
                .unwrap_or(now);
            record.entry(name.clone()).or_insert(time);
        }
        if platinum_unlocked {
            record
                .entry(PLATINUM_ID.to_string())
                .or_insert(platinum_earned_at.unwrap_or(now));
        }
        state.games.insert(steam_appid.clone(), record);
        save_state(&app, &state);
    }

    let total_with_platinum = if total > 0 { total + 1 } else { 0 };
    let unlocked_with_platinum = unlocked_count + usize::from(platinum_unlocked);
    let progress = if total_with_platinum == 0 {
        0.0
    } else {
        (unlocked_with_platinum as f64 * 1000.0 / total_with_platinum as f64).round() / 10.0
    };

    Ok(TrophyReport {
        appid: steam_appid,
        progress,
        unlocked: unlocked_with_platinum,
        total: total_with_platinum,
        counts,
        trophies,
        new_trophies,
        offline,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn assigns_ps4_ranks_by_worldwide_rarity() {
        assert_eq!(rank_for(0.5), "or");
        assert_eq!(rank_for(9.9), "or");
        assert_eq!(rank_for(10.0), "argent");
        assert_eq!(rank_for(34.9), "argent");
        assert_eq!(rank_for(35.0), "bronze");
        assert_eq!(rank_for(74.9), "bronze");
    }

    #[test]
    fn builds_the_ps4_platinum_trophy() {
        let sample = Trophy {
            id: "ACH".to_string(),
            name: "Succès".to_string(),
            description: String::new(),
            percent: 0.4,
            rank: "or".to_string(),
            unlocked: true,
            hidden: false,
            icon: String::new(),
            icongray: String::new(),
            unlocked_at: Some(1_700_000_000),
        };
        let platinum = platinum_trophy(&[sample.clone()], true, Some(1_700_000_000));
        assert_eq!(platinum.id, "ps4_platinum_trophy");
        assert_eq!(platinum.name, "Trophée de platine");
        assert_eq!(platinum.description, "Obtenez tous les trophées.");
        assert_eq!(platinum.rank, "platinum");
        assert_eq!(platinum.percent, 0.4);
        assert_eq!(platinum.icon, "/trophies/platinum.png");
        assert!(platinum.unlocked);
        assert_eq!(platinum.unlocked_at, Some(1_700_000_000));

        // Rareté par défaut d'un jeu dont les pourcentages sont inconnus.
        let mut unknown = sample.clone();
        unknown.percent = 0.0;
        let fallback = platinum_trophy(&[unknown.clone()], false, None);
        assert_eq!(fallback.percent, 0.1);
        assert!(!fallback.unlocked);
        assert_eq!(fallback.unlocked_at, None);
        assert_eq!(platinum_trophy(&[], false, None).percent, 0.1);
    }

    #[test]
    fn reads_goldberg_achievement_shapes() {
        let direct: Value = serde_json::from_str(
            r#"{"ACH_ONE":{"earned":true,"earned_time":12},"ACH_TWO":{"earned":false}}"#,
        )
        .unwrap();
        let wrapped: Value = serde_json::from_str(
            r#"{"achievements":{"ACH_THREE":{"earned":true,"earned_time":34}}}"#,
        )
        .unwrap();
        let listed: Value =
            serde_json::from_str(r#"{"achievements":[{"name":"ACH_FOUR","earned":true}]}"#)
                .unwrap();

        let mut earned = EarnedState::default();
        collect_earned(&direct, &mut earned);
        collect_earned(&wrapped, &mut earned);
        collect_earned(&listed, &mut earned);

        assert_eq!(earned.names.len(), 3);
        assert!(earned.contains("ACH_ONE"));
        assert!(earned.contains("ACH_THREE"));
        assert!(earned.contains("ACH_FOUR"));
        assert!(!earned.contains("ACH_TWO"));
        assert_eq!(earned.times.get("ACH_ONE"), Some(&12));
        assert_eq!(earned.times.get("ACH_THREE"), Some(&34));
    }

    #[test]
    fn reads_emulator_ini_achievements() {
        let raw = "[Achievements]\r\nACH_ONE=1\r\nACH_TWO=0\r\n12=ACH_THREE\r\n; commentaire\r\n";
        let mut earned = EarnedState::default();
        parse_ini_achievements(raw, &mut earned);
        assert!(earned.contains("ACH_ONE"));
        assert!(!earned.contains("ACH_TWO"));
        assert!(earned.contains("ACH_THREE"));
    }

    #[test]
    fn builds_official_icon_urls() {
        assert_eq!(
            icon_from_cdn("252950", "abc123.jpg"),
            "https://cdn.akamai.steamstatic.com/steamcommunity/public/images/apps/252950/abc123.jpg"
        );
        assert_eq!(
            icon_from_cdn("252950", "http://cdn.example/icon.jpg"),
            "https://cdn.example/icon.jpg"
        );
        assert_eq!(icon_from_cdn("252950", ""), "");
    }

    #[test]
    fn accepts_string_and_numeric_percentages() {
        let mixed: Vec<PercentEntry> =
            serde_json::from_str(r#"[{"name":"A","percent":"74.9"},{"name":"B","percent":5}]"#)
                .unwrap();
        assert_eq!(mixed[0].percent, 74.9);
        assert_eq!(mixed[1].percent, 5.0);
    }

    #[test]
    fn humanizes_steam_achievement_ids() {
        assert_eq!(humanize("ACH_WIN_ONE_GAME"), "Ach Win One Game");
        assert_eq!(humanize("PLAY_CS2"), "Play Cs2");
    }

    #[test]
    fn separates_glued_achievement_names() {
        assert_eq!(humanize("Kingofthecups"), "King of the Cups");
        assert_eq!(humanize("HydraIsDead"), "Hydra is Dead");
        assert_eq!(
            humanize("Thatissohardfortheknees"),
            "That is Sohard for the Knees"
        );
    }

    #[test]
    fn keeps_regular_words_intact() {
        assert_eq!(humanize("Champion"), "Champion");
        assert_eq!(humanize("Island"), "Island");
        assert_eq!(humanize("Stocked"), "Stocked");
    }

    #[test]
    fn extracts_names_and_descriptions_from_community_payload() {
        let html = r#"<html><script type="application/json" id="valve-ssr-data">{"renderContext":{"queryData":"{\"queries\":[{\"state\":{\"data\":{\"groups\":[{\"achievements\":[{\"api_name\":\"Kingofthecups\",\"name\":\"Roi de la Coupe\",\"description\":\"Gagnez 5&#160;matchs\",\"icon_achieved\":\"abc.jpg\",\"icon_unachieved\":\"gray.jpg\"}]}]}}}]}"}}</script></html>"#;

        let payload = extract_ssr_payload(html).expect("payload SSR absent");
        let mut texts = HashMap::new();
        collect_texts(&payload, &mut texts, 0, "252950");

        let entry = texts
            .get(&normalize_key("Kingofthecups"))
            .expect("trophée non extrait");
        assert_eq!(entry.name, "Roi de la Coupe");
        assert_eq!(entry.description, "Gagnez 5 matchs");
        assert_eq!(
            entry.icon,
            "https://cdn.akamai.steamstatic.com/steamcommunity/public/images/apps/252950/abc.jpg"
        );
        assert!(entry.icongray.ends_with("/252950/gray.jpg"));
    }
}
