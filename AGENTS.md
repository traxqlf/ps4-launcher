# Instructions Projet — PS4 PC Game Launcher

## Contexte & Architecture
- **Objectif** : Launcher de jeux PC (`.exe` et Steam) ultra-léger (RAM, stockage et CPU) reproduisant fidèlement l'interface et les sensations de la **PlayStation 4 (Orbis OS / Dynamic Menu)**.
- **Environnement de développement** : macOS (Apple Silicon) via `npm run tauri dev`.
- **Cible de production** : Windows 11 (`.exe` compilé automatiquement via GitHub Actions).
- **Stack stricte** : Tauri v2 (Rust), React 18, TypeScript, Vite, Tailwind CSS v3.

## Règles critiques de compatibilité Mac / Windows & CI
1. Le code Rust DOIT compiler et s'exécuter sans erreur ni warning bloquant sur **macOS** ET sur **Windows** (runner GitHub Actions `windows-latest`).
2. Utilise toujours la compilation conditionnelle `#[cfg(target_os = "windows")]` et `#[cfg(not(target_os = "windows"))]` pour les appels système Windows (Win32 API, lancement de `.exe`, registres, chemins `%APPDATA%`). Sur macOS, fournis toujours un fallback propre avec logs console.
3. **Zéro dépendance `.lib` fragile sous Windows** : N'utilise jamais de liaison statique brute (`#[link(name = "...")]`) vers des bibliothèques Windows susceptibles d'échouer au linking sur GitHub Actions (ex. `xinput1_4.lib`). Privilégie le chargement dynamique (`LoadLibraryA` / `GetProcAddress`) ou les crates officielles `windows` / `windows-sys`.
4. Lors du lancement d'un `.exe` sous Windows, définis TOUJOURS `.current_dir(parent_dir)` avec le dossier parent de l'exécutable afin d'éviter les crashs liés aux DLL ou sauvegardes locales.
5. **Permissions Tauri v2** : Si une modification utilise une nouvelle API Tauri (ex. gestion de fenêtre `always_on_top`, plein écran, événements), mets impérativement à jour `src-tauri/capabilities/default.json`.

## Règles UI, Typographie & Ergonomie
- **Police unique obligatoire (`SST`)** : Seule la police **SST** (`font-family: 'SST', sans-serif`) doit être utilisée sur l'ensemble de l'application (textes, titres, boutons, modales, compteurs, chiffres). N'utilise **aucune autre police** et bannis toute classe ou déclaration utilisant `font-mono`, `font-sans`, `font-serif`, `-apple-system`, `SF Pro`, `Inter` ou `Roboto`.
- **Navigation Console-First** : Toute nouvelle interface, modale ou action doit être entièrement navigable à la manette et au clavier, en cohérence avec le système de focus existant (pas d'interactions réservées uniquement au clic souris).

## Règles de performance & État en jeu
- **Empreinte minimale (0 % CPU en jeu)** : Lorsqu'un jeu est en cours d'exécution, le moteur audio, les animations `<canvas>` (vagues/particules) et le polling manette doivent impérativement être mis en pause. N'introduis jamais de boucle (`setInterval`, `requestAnimationFrame`, thread Rust) active pendant qu'un jeu tourne.

## Règles de génération de code
- Ne modifie QUE les fichiers explicitement demandés dans le prompt courant (ainsi que `src-tauri/capabilities/default.json` si requis par Tauri v2).
- N'utilise JAMAIS de placeholders, de code tronqué ou de commentaires `// TODO`. Génère toujours des fichiers complets et fonctionnels.
- N'installe pas de librairies UI externes lourde (pas de Material UI, Framer Motion, etc.) : privilégie Tailwind CSS et les transitions CSS natives.
- Garde une séparation stricte : logique système/fichiers/Win32/réseau dans `src-tauri/src/` et interface/navigation dans `src/`.
