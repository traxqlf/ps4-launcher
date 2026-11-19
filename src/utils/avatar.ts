import { convertFileSrc } from "@tauri-apps/api/core";

// L'avatar garde le même chemin d'un import à l'autre : sans version dans
// l'URL, la WebView ressert l'image en cache. La version change à chaque
// session et après chaque import, sans rien ajouter à profile.json.
let avatarVersion = Date.now();

export function invalidateAvatarCache() {
  avatarVersion += 1;
}

/**
 * `avatar_data_url` garde son nom historique : les profils existants y stockent
 * une data URL Base64, les nouveaux le chemin absolu du fichier local.
 */
export function avatarSrc(value: string | null | undefined): string | null {
  if (!value) return null;
  if (value.startsWith("data:")) return value;
  return `${convertFileSrc(value)}?v=${avatarVersion}`;
}
