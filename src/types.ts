export interface Game {
  id: string;
  title: string;
  exe_path: string;
  steam_appid: string | null;
  cover_url: string | null;
  bg_url: string | null;
  last_played: number | null;
  playtime_seconds: number;
  launch_options: string;
  /** Épinglé en tête du ruban, juste après le PlayStation Store. */
  pinned?: boolean;
  /** Musique de thème téléchargée automatiquement (chemin absolu). */
  themeAudioPath?: string | null;
}

export interface UserProfile {
  username: string;
  bio: string;
  /** Chemin local de l'avatar (ou data URL Base64 d'un ancien profil). */
  avatar_data_url: string | null;
  /** Jeton personnel SteamGridDB : jaquettes et fonds 4K optionnels. */
  steamgriddb_api_key: string;
  /** SteamID64 du compte, pour la synchronisation officielle des trophées. */
  steam_id: string;
  /** Clé Web API Steam (schema localisé, trophées du joueur). */
  steam_api_key: string;
}
