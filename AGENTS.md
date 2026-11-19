# Instructions Projet — PS4 PC Game Launcher

## Contexte & Architecture
- **Objectif** : Launcher de jeux PC (`.exe`) ultra-léger avec une interface inspirée du menu dynamique de la PlayStation 4 (XMB).
- **Environnement de développement** : macOS (Apple Silicon).
- **Cible de production** : Windows 11 (`.exe` compilé via GitHub Actions).
- **Stack stricte** : Tauri v2 (Rust), React 18, TypeScript, Vite, Tailwind CSS v3.

## Règles critiques de compatibilité Mac / Windows
1. Le code Rust DOIT compiler et s'exécuter sans erreur sur **macOS** (pour les tests via `npm run tauri dev`) ET sur **Windows** (pour le `.exe` final).
2. Utilise toujours la compilation conditionnelle `#[cfg(target_os = "windows")]` et `#[cfg(not(target_os = "windows"))]` pour les opérations spécifiques à Windows (lancement de `.exe`, chemins `%APPDATA%`). Sur macOS, fournis une simulation propre avec logs console.
3. Lors du lancement d'un `.exe` sous Windows, définis TOUJOURS `.current_dir(parent_dir)` avec le dossier parent de l'exécutable afin d'éviter les crashs liés aux DLL ou sauvegardes locales.

## Règles UI & Typographie
- **Police unique obligatoire (`SST`)** : Seule la police **SST** (`font-family: 'SST', sans-serif`) doit être utilisée sur l'ensemble de l'application (textes, titres, boutons, modales, compteurs, chiffres). N'utilise **aucune autre police** et bannis toute classe ou déclaration utilisant `font-mono`, `font-sans`, `font-serif`, `-apple-system`, `SF Pro`, `Inter` ou `Roboto`.

## Règles de génération de code
- Ne modifie QUE les fichiers explicitement demandés dans le prompt courant.
- N'utilise JAMAIS de placeholders, de code tronqué ou de commentaires `// TODO`. Génère toujours des fichiers complets et fonctionnels.
- N'installe pas de librairies UI externes lourdes (pas de Material UI, Framer Motion lourd, etc.) : privilégie Tailwind CSS et les transitions CSS natives pour garder une empreinte RAM minimale.
- Garde une séparation stricte : logique système/fichiers/réseau dans `src-tauri/src/` et interface/navigation dans `src/`.
