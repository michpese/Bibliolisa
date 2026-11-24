# Bibliolisa

[![Docker Image](https://github.com/michpese/Bibliolisa/actions/workflows/docker.yml/badge.svg)](https://github.com/michpese/Bibliolisa/actions/workflows/docker.yml)
[![Android Release](https://github.com/michpese/Bibliolisa/actions/workflows/android-release.yml/badge.svg)](https://github.com/michpese/Bibliolisa/actions/workflows/android-release.yml)
[![Latest Release](https://img.shields.io/github/v/release/michpese/Bibliolisa)](https://github.com/michpese/Bibliolisa/releases/latest)
[![License: GPL v3](https://img.shields.io/badge/License-GPLv3-blue.svg)](LICENSE)

**Bibliolisa** ist eine selbstgehostete Bücher-Indexierungs-Plattform für das lokale Netzwerk (LAN) oder den Betrieb hinter einem bestehenden Reverse Proxy – bestehend aus einem **Single-Container-Server (Fastify 5 API + React Webapp + SQLite WAL)** und einer **Offline-First Android-App (React Native / Expo)** mit Kamera-ISBN-Scanner und bidirektionalem Delta-Sync.

---

## Funktionsumfang

- **Strikt getrennte Benutzer-Indizes:** Gemeinsamer Metadaten- und Cover-Pool (`books`), strikt isolierter persönlicher Lese-Index pro Benutzer (`user_books` mit `status`, Bewertung `1–5`, Notizen, Lese-Daten, Soft Delete & Restore).
- **Offline-First Android-App:** Vollständige lokale Bedienung in `expo-sqlite` ohne Serververbindung (Anlegen, Bearbeiten, Suche, Filter, Reihen-Sortierung inkl. Dezimalbänden wie `1, 1.5, 2, 10`, Offline-Empfehlungen, Kamera-ISBN-Scanner) inklusive direktem **In-App-Updater** über GitHub Releases unter Erhalt aller Benutzerdaten.
- **Delta-Sync mit Last-Write-Wins (LWW):** Konfliktauflösung über UTC-`updated_at` (mit Clock-Skew-Schutz), lückenlose Pagination über monotonen `server_updated_at`-Cursor, automatischer WLAN-Sync (2 s Debounce), Pull-to-Refresh, Pre-Flight-Health-Check (`1,5 s`), transparenter Token-Refresh und paralleler WebP-Cover-Cache.
- **Metadaten-Aggregation & SSRF-sicherer Cover-Cache:** Parallele Abfrage von **Open Library**, **Google Books** und optional **Hardcover.app** (`HARDCOVER_API_KEY`); Server-Cover-Cache skaliert & speichert Bilder als WebP unter `DATA_DIR/covers/`.
- **Regelbasierte Empfehlungen („Was lese ich als Nächstes?“):** Identische Logik in Webapp, Server und Offline-Android-App via `@bibliolisa/shared` (begonnene Buchreihen fortsetzen, Autoren-/Genre-Affinität, Schnelle Reads `< 300` Seiten, Staubfänger, Überraschungs-Würfel).
- **Backup & Export:** Ein-Klick-Export als JSON oder UTF-8-CSV (inkl. BOM & CSV-Formula-Injection-Schutz) sowie idempotenter JSON-Reimport in der Webapp.

---

## Monorepo-Architektur

| Pfad | Paket / Rolle |
| :--- | :--- |
| [`shared/`](shared/package.json) | `@bibliolisa/shared` – Single Source of Truth für Zod-Schemas, DTOs, Sync-Contracts, ISBN-Tools, Sortierung & Empfehlungs-Engine |
| [`server/`](server/package.json) | `@bibliolisa/server` – Fastify 5 REST-API (`/api/*`), SQLite (WAL) + Drizzle ORM, `scrypt`/JWT Auth, Delta-Sync, Cover-Cache & Static-Serving |
| [`web/`](web/package.json) | `@bibliolisa/web` – React 19 + Vite + Tailwind CSS Webapp (ausgeliefert unter `/` durch Fastify) |
| [`mobile/`](mobile/package.json) | `@bibliolisa/mobile` – Expo React Native Android-App (`expo-sqlite`, `expo-secure-store`, `expo-camera`, `expo-network`, `expo-file-system`) |
| [`docs/`](docs/ARCHITECTURE.md) | Verbindliche Spezifikation ([`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md)) und Projektstatus ([`docs/ROADMAP.md`](docs/ROADMAP.md)) |

---

## 1. Docker-Compose-Setup (Einzelcontainer)

Webapp (`/`) und API (`/api/*`) werden zusammen als **ein einziger Docker-Container** ausgeliefert. Der Container bringt bewusst **keinen eigenen Reverse Proxy** mit und bindet nicht an Port `80` oder `443`.

### Voraussetzungen

- Docker Engine + Docker Compose Plugin (`docker compose version`)
- Auf dem Host bei Bedarf ein bestehender Reverse Proxy (Nginx, Caddy, Traefik)

### Schritt 1: Konfiguration (`.env`) anlegen

```bash
cp .env.example .env
```

Erzeuge ein sicheres `JWT_SECRET` (mindestens **32 Zeichen**):

```bash
# Variante A: OpenSSL
openssl rand -hex 32

# Variante B: Node.js
node -e "console.log(require('node:crypto').randomBytes(32).toString('hex'))"
```

Trage das Secret in `.env` ein und passe bei Bedarf die weiteren Variablen an:

| Variable | Standard | Beschreibung |
| :--- | :--- | :--- |
| `BIBLIOLISA_IMAGE` | `ghcr.io/michpese/bibliolisa:latest` | Optionales Container-Image für `docker compose pull` (z. B. `:0.3.1` pinnen) |
| `JWT_SECRET` | *(Pflicht)* | Signierschlüssel für Access- und Media-Tokens (min. 32 Zeichen) |
| `HOST_PORT` | `3000` | Host-Port, auf den Port `3000` des Containers gemappt wird (nie `80`/`443`) |
| `HOST_BIND` | `0.0.0.0` | `0.0.0.0` für direkten LAN-Zugriff, `127.0.0.1` falls nur der lokale Host-Reverse-Proxy zugreifen darf |
| `TRUST_PROXY` | `true` | Muss hinter einem Reverse Proxy `true` sein (`X-Forwarded-Proto` / `X-Forwarded-For`) |
| `ALLOW_REGISTRATION` | `true` | Öffnet/sperrt `POST /api/auth/register`. Der erste registrierte Benutzer erhält automatisch `role = 'admin'`; danach zum Sperren auf `false` setzen |
| `HARDCOVER_API_KEY` | *(leer)* | Optionaler GraphQL-API-Key für Hardcover.app |
| `GOOGLE_BOOKS_API_KEY` | *(leer)* | Optionaler API-Key für höhere Google-Books-Kontingente |
| `LOG_LEVEL` | `info` | Pino-Loglevel (`fatal`, `error`, `warn`, `info`, `debug`, `trace`, `silent`) |

### Schritt 2: Verzeichnisrechte für UID `10001` auf `/data` setzen

Aus Sicherheitsgründen läuft der Container als **Non-Root-Benutzer `bibliolisa` (`UID 10001`, `GID 10001`)**. Alle persistenten Daten (SQLite-Datenbank `bibliolisa.sqlite` inkl. WAL-Dateien sowie gecachte WebP-Cover unter `covers/`) liegen ausschließlich unter `/data`.

Wird ein Host-Verzeichnis wie `./data:/data` per Bind-Mount eingebunden, muss es für UID `10001` beschreibbar sein. Andernfalls bricht [`docker/entrypoint.sh`](docker/entrypoint.sh) den Start bewusst mit einer klaren Fehlermeldung ab, statt später mit `SQLITE_CANTOPEN` zu scheitern.

**Option A – Empfohlen (Besitzrechte auf dem Host setzen):**

```bash
mkdir -p data/covers
sudo chown -R 10001:10001 data
chmod 750 data
```

**Option B – Ohne `sudo` beim Erststart über den Entrypoint korrigieren:**

1. In [`docker-compose.yml`](docker-compose.yml) temporär `user: "0:0"` ergänzen und einmal starten (`docker compose up -d --build`). Der Entrypoint legt `/data/covers` an, führt `chown -R 10001:10001 /data` aus und wechselt sofort per `setpriv` auf Non-Root (`10001:10001`).
2. Danach `user: "0:0"` wieder aus `docker-compose.yml` entfernen und `docker compose up -d` ausführen.

**Option C – Docker Named Volume verwenden:**

Alternativ kann `./data:/data` in `docker-compose.yml` durch ein Named Volume (z. B. `bibliolisa_data:/data`) ersetzt werden; Docker übernimmt dann beim ersten Start die `10001:10001`-Rechte aus dem Image automatisch.

### Schritt 3: Container starten (GHCR-Image oder lokaler Build)

**Variante 1 – Vorgebautes Image aus der GitHub Container Registry (GHCR) ziehen:**

```bash
docker compose pull && docker compose up -d
```

Optional lässt sich in `.env` ein festes Release-Tag pinnen, z. B. `BIBLIOLISA_IMAGE=ghcr.io/michpese/bibliolisa:0.3.1`.

**Variante 2 – Image lokal aus dem Quellcode bauen:**

```bash
docker compose up -d --build
```

Status und Healthcheck prüfen:

```bash
docker compose ps
curl -s http://127.0.0.1:3000/api/health
```

Erwartete Antwort (`200 OK`):

```json
{
  "status": "ok",
  "version": "0.3.1",
  "serverTime": "...",
  "allowRegistration": true,
  "providers": {
    "openLibrary": true,
    "googleBooks": true,
    "hardcover": false
  }
}
```

### Betrieb, Updates & Backup

- **Logs einsehen:** `docker compose logs -f bibliolisa`
- **Update einspielen (GHCR):** `docker compose pull && docker compose up -d` (SQLite-Migrationen laufen beim Start automatisch)
- **Update einspielen (lokaler Build):** `git pull && docker compose up -d --build`
- **Dateibasiertes Backup (Server gestoppt):** `docker compose stop && tar -czf bibliolisa-backup-$(date +%F).tar.gz data .env && docker compose start`
- **Benutzer-Backup über UI:** In der Webapp unter **Backup** jederzeit als vollständiges JSON oder CSV herunterladbar.

---

## 2. Reverse-Proxy-Konfiguration (Host)

Der Container vertraut dank `TRUST_PROXY=true` den Headern `X-Forwarded-For`, `X-Forwarded-Proto` und `X-Forwarded-Host`. Erkennt Fastify darüber `https`, setzt es automatisch das `Secure`-Flag auf die `HttpOnly`-Auth- und Media-Cookies der Webapp.

> **Empfehlung:** Soll Bibliolisa ausschließlich über den Proxy erreichbar sein, setze in `.env` `HOST_BIND=127.0.0.1`. Soll die Android-App im Heim-WLAN optional auch direkt per `http://<LAN-IP>:3000` verbinden können, belasse `HOST_BIND=0.0.0.0`.

### Nginx

```nginx
server {
    listen 443 ssl http2;
    server_name books.home.lan;

    ssl_certificate     /etc/ssl/certs/books.home.lan.crt;
    ssl_certificate_key /etc/ssl/private/books.home.lan.key;

    # Erlaubt Cover-Uploads (5 MB) und JSON-Backups
    client_max_body_size 10m;

    location / {
        proxy_pass http://127.0.0.1:3000;
        proxy_http_version 1.1;
        proxy_set_header Host              $host;
        proxy_set_header X-Real-IP         $remote_addr;
        proxy_set_header X-Forwarded-For   $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_set_header X-Forwarded-Host  $host;
    }
}
```

### Caddy

```caddyfile
books.home.lan {
    # Für lokale LAN-Domains mit eigener interner CA (Root-CA auf Android als Benutzer-CA importieren)
    tls internal
    reverse_proxy 127.0.0.1:3000
}
```

### Traefik (Dynamic File Config Beispiel)

```yaml
http:
  routers:
    bibliolisa:
      rule: "Host(`books.home.lan`)"
      entryPoints:
        - websecure
      tls: {}
      service: bibliolisa-svc
  services:
    bibliolisa-svc:
      loadBalancer:
        servers:
          - url: "http://127.0.0.1:3000"
```

---

## 3. Android-APK bauen & Erstverbindung mit dem LAN-Server

Die Android-App unter [`mobile/`](mobile/package.json) ist über das Config-Plugin [`mobile/plugins/withLanNetworkSecurity.js`](mobile/plugins/withLanNetworkSecurity.js) vorkonfiguriert:
- Generiert automatisch `network_security_config.xml` mit `cleartextTrafficPermitted="true"` (für `http://<LAN-IP>:3000`) und `<certificates src="system" />` + `<certificates src="user" />` (für selbstsignierte LAN-HTTPS-Zertifikate wie Caddy `tls internal`).
- Im Code sind **keine** Server-IPs oder Secrets hinterlegt.

### Variante A: Lokaler APK-Build mit Gradle (ohne Cloud-Konto)

#### Voraussetzungen
- **Node.js 22 LTS** & **pnpm 10+** (`corepack enable`)
- **JDK 17** (z. B. Temurin 17; `JAVA_HOME` gesetzt)
- **Android SDK** (API Level 36 / Build-Tools `36.0.0` / Platform-Tools / NDK `27.1.12297006` passend zu Expo SDK 54 / RN 0.81; `ANDROID_HOME` bzw. `ANDROID_SDK_ROOT` gesetzt)

#### Schritte

1. **Abhängigkeiten installieren & `@bibliolisa/shared` bauen:**
   ```bash
   pnpm install --frozen-lockfile
   pnpm --filter @bibliolisa/shared build
   ```

2. **Natives Android-Projekt (`mobile/android/`) via Expo Prebuild erzeugen:**
   ```bash
   pnpm --filter @bibliolisa/mobile exec expo prebuild --platform android --clean
   ```
   *(Prüfung: `mobile/android/app/src/main/res/xml/network_security_config.xml` sowie `AndroidManifest.xml` mit `CAMERA`-Berechtigung und `@xml/network_security_config` werden automatisch erstellt.)*

3. **APK kompilieren:**

   - **Eigenständige Sideload-APK (`assembleRelease`, ohne Metro-Bundler offline lauffähig):**
     Expo Prebuild hinterlegt in `mobile/android/app/build.gradle` standardmäßig den Debug-Signierschlüssel als Fallback, sodass `./gradlew assembleRelease` direkt eine eigenständige, installierbare Standalone-APK erzeugt:
     ```bash
     # Linux / macOS
     cd mobile/android && ./gradlew assembleRelease
     ```
     ```powershell
     # Windows PowerShell
     Push-Location mobile\android; .\gradlew.bat assembleRelease; Pop-Location
     ```
     Ausgabe-Datei: `mobile/android/app/build/outputs/apk/release/app-release.apk`

     *(Optional für dauerhafte Updates mit eigenem Schlüssel:)*
     1. Keystore anlegen (einmalig, außerhalb von Git speichern!):
        ```bash
        keytool -genkeypair -v -storetype PKCS12 -keystore bibliolisa-release.keystore \
          -alias bibliolisa -keyalg RSA -keysize 2048 -validity 10000
        ```
     2. Signatur in `mobile/android/app/build.gradle` unter `android.signingConfigs.release` bzw. über `~/.gradle/gradle.properties` hinterlegen und `assembleRelease` erneut ausführen.

   - **Entwickler-APK (`assembleDebug`, benötigt laufenden Metro-Bundler):**
     Für aktive Entwicklung am PC (`pnpm --filter @bibliolisa/mobile start`):
     ```bash
     # Linux / macOS
     cd mobile/android && ./gradlew assembleDebug
     ```
     ```powershell
     # Windows PowerShell
     Push-Location mobile\android; .\gradlew.bat assembleDebug; Pop-Location
     ```
     Ausgabe-Datei: `mobile/android/app/build/outputs/apk/debug/app-debug.apk`

4. **APK auf dem Smartphone installieren:**
   - **Per USB-Debugging (ADB):**
     ```bash
     adb install -r mobile/android/app/build/outputs/apk/release/app-release.apk
     ```
   - **Ohne Kabel:** `.apk` aufs Smartphone kopieren und über den Android-Dateimanager öffnen („Installation aus unbekannten Quellen“ für die Dateimanager-App einmalig erlauben).

---

### Variante B: EAS Build (Expo Application Services, liefert fertige `.apk`)

In [`mobile/eas.json`](mobile/eas.json) sind bereits APK-Profile (`development`, `preview` und `production` jeweils mit `"buildType": "apk"`) vorkonfiguriert. Der Hook `"eas-build-post-install"` in [`mobile/package.json`](mobile/package.json) baut bei jedem EAS-Build automatisch `@bibliolisa/shared`, bevor Metro/Gradle die APK bündeln.

1. **EAS CLI installieren & anmelden:**
   ```bash
   npm install -g eas-cli
   eas login
   ```

2. **Abhängigkeiten installieren & Projekt einmalig verknüpfen:**
   ```bash
   pnpm install --frozen-lockfile
   cd mobile
   eas init
   ```
   *(Beantworte die Frage nach einem neuen Expo-Projekt mit Ja; dadurch wird die `projectId` in `mobile/app.json` ergänzt.)*

3. **Installierbare APK bauen:**
   ```bash
   # Empfohlen für direktes Sideloading (internal distribution):
   eas build --platform android --profile preview

   # Oder Production-APK:
   eas build --platform android --profile production

   # Optional unter Linux/macOS lokal über EAS ohne Cloud-Build-Queue:
   eas build --platform android --profile preview --local
   ```

4. **APK installieren:** Nach Abschluss stellt EAS einen Download-Link bzw. QR-Code zur direkten Installation der `.apk`-Datei auf dem Android-Gerät bereit.

---

### Erstverbindung der Android-App mit dem LAN-Server

1. **Netzwerk & Erreichbarkeit vorbereiten:**
   - Smartphone und Server befinden sich im selben WLAN (oder per WireGuard/VPN im Heimnetz).
   - Bei direkter IP (`http://192.168.x.x:3000`): Host-Firewall muss eingehendes TCP auf `HOST_PORT` (Standard `3000`) erlauben.
   - Bei Reverse Proxy mit eigener/lokaler CA (`https://books.home.lan`, z. B. Caddy `tls internal`): Installiere zuerst das Root-CA-Zertifikat auf Android unter **Einstellungen → Sicherheit → Verschlüsselung & Anmeldedaten → Zertifikat installieren → CA-Zertifikat**.

2. **Server-URL in Bibliolisa testen & speichern:**
   - Öffne in der App den Tab **Einstellungen**.
   - Gib im Feld **Bibliolisa-Server** die Basis-URL ohne Pfad ein, z. B.:
     - `http://192.168.178.42:3000` (direkt im LAN)
     - `https://books.home.lan` (über Reverse Proxy)
   - Tippe auf **Verbindung testen**. Die App prüft `GET /api/health` (max. `1,5 s` Timeout) und zeigt Latenz, Serverversion und aktive Metadaten-Provider (oder eine konkrete TLS-/Timeout-Diagnose) an.
   - Tippe auf **Speichern**.

3. **Anmelden oder erstes Konto erstellen:**
   - Wähle unter **Benutzerkonto (SecureStore)** zwischen **Anmelden** und **Registrieren**.
   - Wurden vor der Anmeldung bereits Bücher rein offline auf dem Gerät erfasst, werden sie beim ersten Login automatisch diesem Konto zugeordnet und direkt hochgeladen.
   - Access- und Refresh-Tokens landen ausschließlich im hardwaregestützten Android Keystore (`expo-secure-store`).

4. **Synchronisations-Verhalten im Alltag:**
   - **Automatisch:** Beim App-Start, beim Wechsel in den Vordergrund (30 s Cooldown), nach lokalen Änderungen (2 s Debounce, **nur im WLAN**) sowie beim Wiederherstellen einer WLAN-Verbindung.
   - **Manuell:** Pull-to-Refresh in der Bibliothek oder über das Status-Badge in der Kopfzeile / **Einstellungen → Jetzt synchronisieren**.
   - **Status-Badge:** Zeigt jederzeit den aktuellen Zustand (`Synchron`, `Synct…`, `X offen`, `Offline`, `Anmelden` bei abgelaufener Sitzung mit Inline-Re-Login ohne Datenverlust, `Sync-Fehler`).

5. **In-App-Updates auf Android:**
   - **Beim Start (optional) & manuell:** Die App prüft optional bei jedem Start sowie über **Einstellungen → App-Updates → Nach Updates suchen** direkt gegen GitHub Releases ([`CHANGELOG.md`](CHANGELOG.md) wird im Update-Dialog samt Highlights angezeigt).
   - **Benutzerdaten bleiben erhalten:** Beim Aktualisieren bleiben lokale SQLite-Bibliothek (`books`, `user_books`), Cover-Cache, Server-URL, `SecureStore`-Tokens und ungesyncte Änderungen vollständig erhalten.
   - **Installationshinweis:** Nach dem verifizierten APK-Download öffnet Android den Paketinstaller. Voraussetzung für nahtlose In-Place-Updates ohne vorherige Deinstallation ist dieselbe APK-Signatur (`ANDROID_KEYSTORE_*`).

---

## 4. Lokale Entwicklung & Tests

```bash
# Abhängigkeiten installieren
pnpm install

# Entwicklungsserver starten (Terminal 1 & 2)
pnpm dev:server
pnpm dev:web

# Alle Typechecks, Tests und Builds über alle Workspaces ausführen
pnpm typecheck
pnpm test
pnpm build

# Docker-Image bauen & kompletten Container-Smoke-Test ausführen
pnpm docker:build
pnpm docker:smoke
```

---

## 5. GitHub Actions CI/CD (GHCR-Image & Android-APK-Releases)

Das Repository enthält zwei Workflows unter `.github/workflows/`:

### Docker-Image in GHCR ([`.github/workflows/docker.yml`](.github/workflows/docker.yml))

- **Trigger:**
  - `push` auf `main` sowie Tags `v*` (bei Code-/Docker-Änderungen auf `main`; Tag-Pushes laufen immer)
  - `pull_request` auf `main` (führt Build + kompletten Container-Smoke-Test ohne Push aus)
  - `workflow_dispatch` (manuell mit Plattformwahl `linux/amd64,linux/arm64` oder `linux/amd64`)
- **Ablauf:** Baut zuerst ein `linux/amd64`-Image und prüft es gegen [`scripts/docker-smoke-test.mjs`](scripts/docker-smoke-test.mjs); erst bei Erfolg wird das Multi-Arch-Image (`linux/amd64`, `linux/arm64`) nach `ghcr.io/michpese/bibliolisa` gepusht.
- **Image-Tags:** `latest` (Standard-Branch), `main`, `<version>` & `<major>.<minor>` (bei SemVer-Tags wie `v0.3.1`), `sha-<commit>`.
- **Hinweis zur Sichtbarkeit:** Das erste automatisch angelegte GHCR-Package ist bei GitHub ggf. zunächst *private*. Soll `docker compose pull` ohne `docker login ghcr.io` funktionieren, unter **GitHub → Packages → bibliolisa → Package settings → Change visibility** auf *Public* umstellen (oder alternativ einmalig mit einem PAT `read:packages` einloggen).

### Android-APK als GitHub Release ([`.github/workflows/android-release.yml`](.github/workflows/android-release.yml))

- **Trigger:**
  - `push` auf Tags `v*` (baut die Standalone-APK und erstellt/aktualisiert automatisch das passende GitHub Release mit `.apk`, `.apk.sha256` und den passenden Highlights/Abschnitten aus [`CHANGELOG.md`](CHANGELOG.md))
  - `workflow_dispatch` (optional mit `release_tag`, `architectures` und `prerelease`; ohne `release_tag` wird die APK nur als Workflow-Artifact hochgeladen)
- **Ablauf:** Installiert Workspace-Abhängigkeiten, baut `@bibliolisa/shared`, führt `typecheck` und `test` in `mobile/` aus, generiert das native Android-Projekt per `expo prebuild --platform android --clean --no-install` (inkl. `withLanNetworkSecurity` und `withAndroidReleaseSigning`), kompiliert `./gradlew assembleRelease` und verifiziert die Signatur mit `apksigner`.
- **Release-Signatur (optional über Repository Secrets):**
  Ohne Secrets nutzt Gradle automatisch Expos deterministischen Debug-Fallback-Keystore (direkt installierbar per Sideloading). **Sicherheitsempfehlung für öffentliche Releases:** Vor dem Veröffentlichen der ersten APK unbedingt die vier Secrets mit einem eigenen Release-Keystore hinterlegen, damit spätere App-Updates nahtlos ohne Deinstallation eingespielt werden können und niemand mit dem öffentlich bekannten Debug-Schlüssel signierte APKs unterschieben kann:
  - `ANDROID_KEYSTORE_BASE64`
  - `ANDROID_KEYSTORE_PASSWORD`
  - `ANDROID_KEY_ALIAS`
  - `ANDROID_KEY_PASSWORD`

  Keystore einmalig erzeugen und für `ANDROID_KEYSTORE_BASE64` Base64-kodieren (ohne Zeilenumbrüche):
  ```bash
  keytool -genkeypair -v -storetype PKCS12 -keystore bibliolisa-release.keystore \
    -alias bibliolisa -keyalg RSA -keysize 2048 -validity 10000
  base64 -w 0 bibliolisa-release.keystore
  ```

### Gemeinsames Release (Docker-Image + Android-APK) auslösen

1. Passenden Abschnitt in [`CHANGELOG.md`](CHANGELOG.md) unter `## [<version>]` pflegen (`scripts/extract-changelog.mjs` übernimmt ihn automatisch in das GitHub Release).
2. Einen SemVer-Tag setzen und pushen – er stößt beide Workflows gleichzeitig an:

```bash
git tag v0.3.1
git push origin v0.3.1
```
