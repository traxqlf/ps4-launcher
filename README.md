# 🎮 PulsePS4 (Tutorial in English below🇬🇧)

Un launcher de jeux PC moderne, fluide et ultra-léger développé avec **Tauri v2**, **Rust** et **React**, reproduisant fidèlement l'interface dynamique **Orbis OS** de la PlayStation 4.

---

## 📥 Téléchargement (Download)
Vous ne souhaitez pas compiler le code ? Téléchargez directement la dernière version :
* **[👉 Télécharger l'installateur Windows (.exe)](https://github.com/traxqlf/ps4-launcher/releases/latest)** *(Ou récupérez la dernière build dans l'onglet [Actions](https://github.com/traxqlf/ps4-launcher/actions))*

## ⚠️ Note importante
Si Windows SmartScreen affiche un avertissement lors de l'ouverture de l'application :
1. Cliquez sur **Informations complémentaires** dans la fenêtre bleue.
2. Cliquez ensuite sur **Exécuter quand même** pour démarrer le launcher.
*(Cette manipulation n'est à faire qu'au tout premier lancement, l'exécutable n'étant pas signé numériquement).*

---

## ✨ Fonctionnalités
* 🌟 Interface dynamique **Orbis OS** authentique avec fond animé *Flow*, typographie officielle **SST** et sons système PS4.
* 🎮 Navigation **100 % manette** (DualShock 4, DualSense, Xbox) avec vibrations haptiques, niveau de batterie et clavier virtuel intégré.
* 🔍 Détection automatique des jeux installés (**Steam**, **Epic Games**, **GOG**) avec récupération des jaquettes HD et musiques de thème.
* 🏆 Système de trophées intégré (avec gestion des trophées masqués) et notifications système en jeu.
* 🍃 Ultra-léger : mise en veille automatique du moteur audio, des animations et de la manette dès qu'un jeu est lancé (`0 %` de CPU/GPU en arrière-plan).

## 🛠️ Prérequis (Pour les développeurs)
Pour compiler et exécuter ce projet depuis le code source :
* **Node.js** (v20 ou version supérieure).
* **Rust** (`rustup` et Cargo).
* **Windows** : Microsoft Visual Studio C++ Build Tools & WebView2.
* **macOS** *(tests de développement)* : Xcode Command Line Tools.

## 🚀 Installation & Utilisation (Via le code source)

1. **Cloner le dépôt sur votre machine :**
   ```bash
   git clone https://github.com/traxqlf/ps4-launcher.git
   cd ps4-launcher
   ```

2. **Installer les dépendances et lancer en mode développement :**
   ```bash
   npm install
   npm run tauri dev
   ```

3. **Compiler l'exécutable final (`.exe` / `.app`) :**
   ```bash
   npm run tauri build
   ```

<br>
<br>



# 🎮 PulsePS4 (English🇬🇧)

A modern, smooth, and ultra-lightweight PC game launcher built with **Tauri v2**, **Rust**, and **React**, faithfully recreating the PlayStation 4 **Orbis OS** dynamic menu.

---

## 📥 Download
Don't want to compile the code? Download the latest release directly:
* **[👉 Download Windows Installer (.exe)](https://github.com/traxqlf/ps4-launcher/releases/latest)** *(Or grab the latest build from the [Actions](https://github.com/traxqlf/ps4-launcher/actions) tab)*

## ⚠️ Important Note (Windows Security)
If Windows SmartScreen blocks the app from opening:
1. Click **More info** on the warning popup.
2. Click **Run anyway** to launch the application.
*(You only need to do this the very first time you run the app).*

---

## ✨ Features
* 🌟 Authentic **Orbis OS** dynamic interface featuring the animated *Flow* background, official **SST** typography, and PS4 system sound effects.
* 🎮 **100% Controller navigation** (DualShock 4, DualSense, Xbox) with haptic feedback, battery indicator, and built-in on-screen keyboard.
* 🔍 Automatic detection of installed PC games (**Steam**, **Epic Games**, **GOG**) with HD artwork and theme music fetching.
* 🏆 Built-in trophy viewer (including hidden trophies) and authentic system toast notifications.
* 🍃 Featherlight footprint: automatically suspends audio, animations, and controller polling while playing (`0%` background CPU/GPU usage).

## 🛠️ Prerequisites (For Developers)
To build and run this project from the source code, you will need:
* **Node.js** (v20 or newer).
* **Rust** (`rustup` and Cargo).
* **Windows**: Microsoft Visual Studio C++ Build Tools & WebView2.
* **macOS** *(development testing)*: Xcode Command Line Tools.

## 🚀 Installation & Usage (From Source Code)

1. **Clone the repository to your machine:**
   ```bash
   git clone https://github.com/traxqlf/ps4-launcher.git
   cd ps4-launcher
   ```

2. **Install dependencies and run in development mode:**
   ```bash
   npm install
   npm run tauri dev
   ```

3. **Build the production executable (`.exe` / `.app`):**
   ```bash
   npm run tauri build
   ```

