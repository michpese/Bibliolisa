# Changelog

Alle wesentlichen Änderungen an **Bibliolisa** werden in dieser Datei dokumentiert.

Das Format orientiert sich an [Keep a Changelog](https://keepachangelog.com/de/1.1.0/) und verwendet [Semantic Versioning](https://semver.org/).

---

## [0.3.0] - 2026-11-24

### ✨ Highlights

- **Webapp-Sync-Anzeige & manueller Sync (#6):** Die Webapp zeigt auf der Startseite sofort ein klickbares Sync-Badge (*Synchron*, *Handy ausstehend*, *Handy nicht gesynct*, *Kein Handy*) und bietet in **Einstellungen → Synchronisation** einen eigenen *„Jetzt synchronisieren“*-Button samt gerätebezogenem Gesamtfeedback.
- **Nahtloses Mehrfach-Erfassen in der Android-App (#2):** Nach dem Speichern eines Buches erscheint ein themengerechtes Bestätigungs-Popup mit der Primäroption **„Noch ein Buch hinzufügen“**, die Formular und Suche geleert lässt und sofort zum Seitenanfang scrollt.
- **Umfassende UI-, Safe-Area- & Navigations-Fixes (#1, #3, #4, #5):** Verbesserte Edge-to-Edge-Abstände auf Android, vollständiger Filter-/Scroll-Erhalt in der Webapp beim Zurückkehren aus Buchdetails sowie aktiver Reload-Spinner bei Empfehlungen.

### 🚀 Neue Funktionen

- **Webapp Sync-Status (`shared`, `server`, `web`, `mobile`):**
  - Neue SQLite-Tabelle `sync_devices` inklusive automatischer Drizzle-Migration `0001_sync_devices.sql` für bestehende Server-Datenbanken.
  - Neuer authentifizierter, strikt nach `user_id` isolierter Endpunkt `GET /api/sync/status` mit Bibliotheksstand, ausstehenden Änderungen je Mobilgerät und letztem Transfer (`↑ gepusht / ↓ gepullt`).
  - Klickbares `WebSyncBadge` im Header der Web-Bibliothek mit Detail-Dialog sowie automatischem Aktualisieren der Webapp-Listen, sobald ein externes Handy-Sync neue Änderungen auf den Server schreibt.
  - Eigene `Synchronisation`-Karte in den Web-Einstellungen mit manuellem Sync-Button, Ladeanzeige, Inline-Statusrückmeldung und Hinweis auf reine Offline-Änderungen bis zum nächsten App-Sync.
  - Optionales Feld `deviceName` in `SyncRequestSchema` für abwärtskompatible Gerätebenennung aus der Android-App.
- **Android „Noch ein Buch hinzufügen“ (`mobile`):** Themengerechtes Bottom-Sheet-Modal in `AddBookScreen.tsx` nach dem Speichern mit den drei Aktionen *„Noch ein Buch hinzufügen“*, *„Details öffnen“* und *„Zur Bibliothek“*.

### 🐛 Fehlerbehebungen

- **Android System-Navigationsleiste (`#1`):** Einheitliches Safe-Area-Handling über `useBottomSafePadding()` für `BookDetailScreen`, `LibraryScreen`, `RecommendationsScreen`, `BarcodeScanner`, `SyncStatusBadge` und `UpdateModal`, sodass untere Aktionsbuttons bei 3-Tasten- oder Gestennavigation nicht mehr verdeckt werden.
- **Webapp Filter-, Sortierungs- & Scroll-Erhalt (`#3`):** Beim Zurückkehren von der Buchdetailseite bleiben Suchbegriff, Status-Tab, Filter, Sortierung und Scroll-Position sowohl über den Zurück-Link als auch über die Browser-Historie erhalten.
- **Android Sync-Badge-Überlauf (`#4`):** Verbessertes Header- und Einstellungs-Layout, damit `SyncStatusBadge` auch auf schmalen Displays nicht abgeschnitten wird.
- **Android Empfehlungen-Reload (`#5`):** Aktiver Ladeindikator, optionaler Online-Sync, Pull-to-Refresh, neuer Seed und Zeitstempel-Feedback auch im Offline-Modus.

### 📚 Dokumentation & Tests

- **Architektur- & Roadmap-Abgleich (`docs/ARCHITECTURE.md`, `docs/ROADMAP.md`):** Tabelle `sync_devices` und Endpunkt `GET /api/sync/status` in `docs/ARCHITECTURE.md` dokumentiert.
- **Automatisierte Tests (`server` & `mobile`):** Integrationstests in `server/tests/sync.test.ts` für `GET /api/sync/status`, `no_mobile_device`/`never_synced`/`synced`/`server_ahead`, Multi-User-Isolation und Drizzle-Migration sowie Changelog-Tests für `v0.3.0` in `mobile/tests/app-updater.test.ts`.

### 💾 Hinweis zum Update

Bestehende Server-Datenbanken (`/data/bibliolisa.sqlite`) migrieren beim Container-Start automatisch und verlustfrei über `0001_sync_devices.sql`. Bestehende Android-Installationen ab `v0.2.0` (mit demselben Release-Keystore) können das Update direkt über **Einstellungen → App-Updates** ohne Deinstallation einspielen; alle lokalen Bücher, Cover, Notizen, Bewertungen und Sync-Einstellungen bleiben vollständig erhalten.

---

## [0.2.1] - 2026-11-22

### ✨ Highlights

- **Zuverlässige Reihenfolge bei Buchreihen-Empfehlungen:** In „Was lese ich als Nächstes?“ werden in keiner Kategorie mehr spätere Folgebände vorgeschlagen, solange frühere Bände noch ungelesen sind – identisch auf Server, Webapp und offline in der Android-App.

### 🐛 Fehlerbehebungen

- **Unbegonnene Buchreihen (`shared`, `server`, `web`, `mobile`):** Reihen ohne gelesenen oder aktuell gelesenen Band schlagen in keiner Empfehlungskategorie (`continue_series`, `affinity`, `quick_read`, `dust_collector`, `surprise_me`) mehr Bände mit `seriesNumber > 1` vor – auch nicht mehr als Fallback in „Überrasch mich“.
- **Begonnene Buchreihen:** Pro begonnener Reihe ist über alle fünf Kategorien hinweg höchstens noch der eine nächste offene Band zulässig; spätere Bände (z. B. Band 3 oder 4) rutschen nicht mehr in „Empfohlen für dich“, „Schneller Read“, „Staubfänger“ oder „Überrasch mich“.
- **Fehlende Zwischenbände & Dezimalbände:** Bei nummeriertem Reihenfortschritt (`maxProgress`) werden direkte Folgebände auf `maxProgress < seriesNumber <= Math.floor(maxProgress) + 1` begrenzt. Dezimalbände/Novellas (z. B. `1 → 1.5 → 2`) bleiben zulässig, fehlende ganze Zwischenbände (z. B. Band 1 gelesen, Band 2–3 nicht vorhanden, Band 4 vorhanden) werden nicht mehr übersprungen.
- **Reihen-Edge-Cases (`abandoned`, `seriesNumber === null`, `seriesName`):** Abgebrochene Bücher zählen nicht als Reihenfortschritt, unnummerierte Bände schalten keine nummerierten Folgebände `> 1` frei, und leere/Whitespace- sowie unterschiedlich geschriebene `seriesName`-Werte werden einheitlich normalisiert.

### 📚 Dokumentation & Tests

- **Architektur-Spezifikation (`docs/ARCHITECTURE.md`):** Kapitel 8 um die kategorieübergreifende Reihen-Schutzregel und das Intervall für fehlende Zwischenbände präzisiert.
- **Automatisierte Tests (`shared` & `server`):** Gezielte Unit-Tests in `shared/tests/recommendations.test.ts` sowie API-Integrationstests in `server/tests/recommendations.test.ts` für unbegonnene Reihen, begonnene Reihen, Dezimalbände, fehlende Zwischenbände, `surprise_me`-Fallback und Edge Cases ergänzt.

### 💾 Hinweis zum Update

Bestehende Android-Installationen ab `v0.2.0` (mit demselben Release-Keystore) können das Update direkt über **Einstellungen → App-Updates** ohne Deinstallation einspielen; alle lokalen Bücher, Cover, Notizen, Bewertungen und Sync-Einstellungen bleiben vollständig erhalten.

---

## [0.2.0] - 2026-11-21

### ✨ Highlights

- **Android In-App-Updates mit Benutzerdaten-Schutz:** Die Android-App prüft optional beim Start sowie jederzeit über **Einstellungen → App-Updates → Nach Updates suchen** auf neue GitHub-Releases, zeigt dieses Changelog samt Highlights an und installiert das Update direkt im App-Kontext.
- **Umfassende Sicherheits-Härtung:** Schutz gegen DNS-Rebinding-/TOCTOU-SSRF bei Server-Covern, konstante Login-Antwortzeiten (`scrypt`), strikte Security-Header/CSP für die Webapp sowie Rate-Limits für Refresh und Passwortwechsel.
- **Bessere Bedienbarkeit in Web & Mobile:** Löschen-Bestätigung und funktionierendes Rückgängig-Machen, Suche innerhalb des mobilen Filter-Modals ohne 20er-Abschnitt, entprellte Live-Suche sowie direkte Berechtigungsführung beim Barcode-Scanner.

### 📱 Neu (Android-App)

- **Automatische Update-Prüfung beim App-Start:** Fragt optional beim Öffnen im Hintergrund die GitHub Releases API (inkl. ETag-Caching) ab, lässt sich in den Einstellungen ein-/ausschalten und merkt sich übersprungene Versionen.
- **Update-Schaltfläche in den Einstellungen:** Zeigt installierte Version, Build-Code und Zeitpunkt der letzten Prüfung an und erlaubt das manuelle Anstoßen der Update-Suche.
- **Direkter APK-Download & Installer-Start:** Streamt verifizierte HTTPS-Release-APKs mit Fortschrittsanzeige, prüft Dateigröße und APK-Signaturheader und startet den Android-Paketinstaller inklusive Hilfestellung für „Unbekannte Apps installieren“.

### 🔒 Sicherheit

- **SSRF-Schutz gehärtet (`server`):** Gepinnte IP-Verbindungen (`lookup`-Pinning + TLS SNI) verhindern DNS-Rebinding zwischen Validierung und HTTP-Download bei externen Cover-URLs; fehlerhafte Redirect-`Location`-Header liefern sauber `502` statt `500`.
- **Auth & Sessions (`server`):** Konstante Antwortzeit bei unbekanntem Benutzernamen durch Dummy-`scrypt`-Prüfung, frühe `ALLOW_REGISTRATION`-Prüfung vor CPU-intensivem Hashing, automatisches Aufräumen abgelaufener/widerrufener Refresh-Tokens sowie Rate-Limits auf `/api/auth/refresh` und `/api/auth/change-password`.
- **Browser-Schutz (`server` & `web`):** Globale Security-Header (`X-Content-Type-Options`, `X-Frame-Options`, `Referrer-Policy`, `Permissions-Policy`, HSTS bei HTTPS) sowie strenge `Content-Security-Policy` ohne Inline-Scripts (`web/public/theme-init.js`).
- **Import- & Schema-Limits (`shared` & `server`):** Obergrenzen für Autoren-/Genre-Listen und Sync-Batches, Schutz gegen Überschreiben fremder globaler Bücher beim JSON-Import, Clock-Skew-Kappung und Verifizierung existierender Cover-Dateien.

### 🐛 Fehlerbehebungen

- **Mobile Filter & Suche (`mobile`):** Suche mit 250 ms Debounce, entkoppeltes Facetten-Laden, Suchfeld für Autoren/Genres/Reihen im Filter-Modal ohne `20`-Einträge-Begrenzung.
- **Mobile UI & Scanner (`mobile`):** Eingaben bleiben in Einstellungen editierbar, Cover-Fehler fallen auf typografischen Platzhalter zurück, Kamera-Scanner-Sperre setzt sich sauber zurück und fehlende Berechtigung bietet direkten Link in die App-Einstellungen, plus `KeyboardAvoidingView` in Formularen und Re-Login.
- **Cover-Upload-Retry (`mobile`):** Dauerhafte `4xx`-Fehler oder fehlende lokale Cover-Dateien werden nicht endlos neu versucht (`cover_pending_upload = 0`).
- **Webapp (`web`):** Sicherheitsabfrage beim Löschen in `BookDetailPage`, korrigiertes Undo-Restore nach Seitenwechsel, synchrone URL-Suche nach Browser-Navigation, saubere `htmlFor`-Verknüpfungen im Buchformular und Session-Aktualisierung nach Passwortwechsel.
- **Empfehlungs-Engine (`shared`):** Toter Zweig bei Reihennummern behoben und einheitliche Erkennung unbegonnener Fortsetzungsbände (`isUnstartedSequel`).

### 🛠️ Infrastruktur & Release

- **Dynamische Versionsauflösung:** Server (`/api/health`) und Docker-Workflow (`APP_VERSION`) beziehen ihre Version direkt aus Tag/Build bzw. `package.json`.
- **Android-Build & CI:** Prerelease-sicheres monotones `versionCode`-Schema in `.github/workflows/android-release.yml` und automatische Einbindung der `CHANGELOG.md`-Sektion in neue GitHub Releases.
- **Orphan-Cleanup (`server`):** Verwaiste Cover-Dateien unter `DATA_DIR/covers/` werden beim Serverstart sicher bereinigt.

### 💾 Hinweis zum Update

Beim Aktualisieren der Android-App über den In-App-Updater (sofern die APK mit demselben Release-Keystore signiert ist) bleiben **alle vorhandenen Benutzerdaten vollständig erhalten**: lokale SQLite-Bibliothek (`books`, `user_books`, Notizen, Bewertungen, Status), gecachte Cover-Bilder, Server-URL, `SecureStore`-Tokens sowie Synchronisationsstatus werden **nicht** überschrieben.

> **Wichtiger Hinweis beim Wechsel auf einen eigenen Release-Keystore:** Wurde zuvor noch eine mit dem Standard-Debug-Keystore signierte `v0.1.0`-APK installiert, verlangt Android beim ersten Umstieg auf eine mit eigenem `ANDROID_KEYSTORE_*` signierte APK aus Sicherheitsgründen eine einmalige Neuinstallation (vorher ggf. mit dem Server synchronisieren oder exportieren). Alle folgenden Updates (`v0.2.0` → `v0.3.0+`) laufen danach nahtlos ohne Deinstallation und ohne Datenverlust.

---

## [0.1.0] - 2026-11-21

### ✨ Highlights

- **Erstes vollständiges Release von Bibliolisa:** Monorepo aus `@bibliolisa/shared`, `@bibliolisa/server`, `@bibliolisa/web` und `@bibliolisa/mobile`.
- **Single-Container-Deployment:** Fastify 5 API, SQLite (WAL) mit Drizzle ORM und React 19 Webapp in einem gemeinsamen Multi-Arch Docker-Image (`linux/amd64`, `linux/arm64`) für LAN und Host-Reverse-Proxys.
- **Offline-First Android-App:** Lokale SQLite-Datenbank, Kamera-ISBN-Scanner, Buchreihen-Sortierung inkl. Dezimalbänden (`1, 1.5, 2, 10`), Offline-Empfehlungen und bidirektionaler LWW-Delta-Sync inklusive Cover-Cache.
- **Backup & Export:** Vollständiger JSON- und CSV-Export sowie idempotenter JSON-Reimport in der Webapp.
