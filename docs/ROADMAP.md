# Bibliolisa – Implementierungs-Roadmap

> **Verbindliches Status-Tracking gemäß `.antigravity/rules.md`**  
> `docs/ARCHITECTURE.md` und `docs/ROADMAP.md` sind die Single Source of Truth.  
> **Arbeitsregel:** Nach jeder abgeschlossenen Phase werden **Tests und Build ausgeführt**, alle erfüllten Aufgaben und Akzeptanzkriterien in dieser Datei abgehakt und etwaige Abweichungen im Abschnitt *Abweichungen / Notizen* der jeweiligen Phase dokumentiert, bevor die nächste Phase startet.

---

## Status-Übersicht

| Phase | Titel | Status | Kernziel | Verifikations-Gate |
| :--- | :--- | :--- | :--- | :--- |
| **Phase 1** | Monorepo-Fundament, Shared Contracts & Backend Core | `Abgeschlossen` | pnpm-Workspace, `/shared`, SQLite (WAL) + Drizzle, `scrypt`/JWT Auth, Bibliothek-CRUD | `pnpm test` + `pnpm build` (`shared`, `server`) |
| **Phase 2** | Metadaten-Provider, Cover-Cache, Delta-Sync, Empfehlungen & Export | `Abgeschlossen` | 3 Provider + Aggregator, SSRF-sicherer Cover-Cache, `POST /api/sync`, Empfehlungen, JSON/CSV | Mock-Provider-, SSRF-, Sync-Konflikt- & Export-Tests |
| **Phase 3** | Webapp (`/web`) & Docker Single-Container-Deployment | `Offen` | Vollständige React-Webapp (Verwaltung, Empfehlungen, Backup), Multi-Stage `Dockerfile` | `web` Build + Docker-Image-Build + Container-Smoke-Test |
| **Phase 4** | Offline-First Android-App (`/mobile`) | `Offen` | `expo-sqlite`, Offline-CRUD, Kamera-ISBN-Scanner, Offline-Empfehlungen, Settings & Test-Button | Typecheck + Expo/Metro-Bundle + Flugmodus-Funktionstest |
| **Phase 5** | Android Delta-Sync-Engine, E2E-Verifikation & Release-Härtung | `Offen` | `/api/health`-Pre-Check, Auto-/WLAN-Sync, Cover-Cache-Sync, Status-UI, E2E-Abnahme | Gesamttestsuite + E2E-Konflikt-/Multi-User-/Proxy-Check |

---

## Phase 1: Monorepo-Fundament, Shared Contracts & Backend Core (DB, Auth, Bibliothek-CRUD)

### Aufgaben-Checkliste

- [x] **Monorepo & Tooling einrichten:**
  - `pnpm-workspace.yaml`, Root-`package.json`, `tsconfig.base.json`, `.gitignore`, `.env.example` gemäß `docs/ARCHITECTURE.md` anlegen.
- [x] **Paket `@bibliolisa/shared` implementieren:**
  - Alle Zod-Schemas & TypeScript-Typen (`common.ts`, `auth.ts`, `book.ts`, `user-book.ts`, `sync.ts`, `metadata.ts`, `recommendation.ts`, `export.ts`) ohne duplizierte DTOs bereitstellen.
  - `isbn.ts`: Normalisierung, Prüfziffervalidierung (ISBN-10 & ISBN-13) und Konvertierung `ISBN-10 <-> ISBN-13`.
  - `sort.ts`: Deterministische Sortier-Comparatoren inkl. Buchreihen-Sortierung mit Dezimalbänden (`1, 1.5, 2, 10`).
  - `recommendations/engine.ts`: Reine, seiteneffektfreie Empfehlungs-Engine (Stufe 1–3) inkl. Unit-Tests.
- [x] **Server-Basis & SQLite-Datenbank (`/server`):**
  - Zod-validierte Umgebungskonfiguration (`env.ts`) inkl. Prüfung auf `JWT_SECRET` (mind. 32 Zeichen), `DATA_DIR` und `TRUST_PROXY`.
  - Fastify-5-Instanz (`app.ts`) mit `trustProxy: true`, `@fastify/cookie`, `@fastify/rate-limit` und einheitlichem Fehlerformat.
  - `better-sqlite3` mit `WAL`-Mode, `foreign_keys = ON`, `busy_timeout = 5000`, Shutdown-Checkpoint (`wal_checkpoint(TRUNCATE)`) sowie Drizzle-Schema (`users`, `refresh_tokens`, `books`, `user_books`) inkl. initialer SQL-Migration und partiellem Unique-Index `idx_user_books_active_unique`.
- [x] **Authentifizierung & Multi-User-Schutz:**
  - Passwort-Hashing mit `crypto.scrypt` (`N=32768, r=8, p=1`, `timingSafeEqual`).
  - `POST /api/auth/register` (erster User = `admin`, `ALLOW_REGISTRATION`-Steuerung), `POST /api/auth/login`, `POST /api/auth/refresh` (Rotation + 30s Grace-Window + Reuse-Detection), `POST /api/auth/logout`, `GET /api/auth/me`, `GET/DELETE /api/auth/sessions`, `POST /api/auth/change-password`.
  - Web-Cookies (`bibliolisa_refresh`, `bibliolisa_media`) mit dynamischem `Secure`-Flag bei `https` über `X-Forwarded-Proto`.
  - Globaler Fastify `onRequest`-Auth-Guard (lässt ausschließlich `/api/health`, `/api/auth/login`, `/api/auth/register`, `/api/auth/refresh` unauthentifiziert).
- [x] **System & Bibliothek-CRUD:**
  - `GET /api/health` (schnelle DB-Prüfung, Serverversion, `allowRegistration`, Provider-Status).
  - `GET /api/library` (alle Filter: `q`, `status`, `genre`, `author`, `series`, `minRating`, `maxRating`; alle Sortierungen: `series`, `author`, `title`, `status`, `added_at`, `rating`, `published_year`), `GET /api/library/facets`, `GET /api/library/:userBookId`, `POST /api/library`, `PATCH /api/library/:userBookId`, `DELETE /api/library/:userBookId` (Soft Delete via `deleted_at`), `POST /api/library/:userBookId/restore`.

### Verifikations-Check (Phase 1)

- [x] `pnpm --filter @bibliolisa/shared test` und `pnpm --filter @bibliolisa/shared build` laufen fehlerfrei durch.
- [x] `pnpm --filter @bibliolisa/server test` und `pnpm --filter @bibliolisa/server build` laufen fehlerfrei durch (inkl. In-Memory/Temp-SQLite-Integrationstests für Auth, Multi-User-Isolation, CRUD, Sortierung & Soft-Delete).

### Akzeptanzkriterien (Phase 1)

1. Alle API-Routen außer `/api/health`, `/api/auth/login`, `/api/auth/register` und `/api/auth/refresh` liefern ohne gültiges Access Token strikt HTTP `401`.
2. Benutzer B sieht weder in `GET /api/library`, `GET /api/library/:id`, `GET /api/library/facets` noch bei `PATCH`/`DELETE` Einträge aus dem `user_books`-Index von Benutzer A (`404`/leer).
3. Die Buchreihen-Sortierung (`sort=series`) ordnet Testbände exakt in der Reihenfolge `1`, `1.5`, `2`, `10` (und Bände ohne Reihe am Listenende).
4. `DELETE /api/library/:userBookId` entfernt keinen Datensatz physisch, sondern setzt `user_books.deleted_at`; `POST /api/library/:userBookId/restore` stellt den Eintrag wieder aktiv her.
5. Refresh-Token-Rotation akzeptiert einen Retry innerhalb von `30 s` (`grace_until`) und widerruft bei spätem Replay die Session-Kette.

### Abweichungen / Notizen
- Bei `crypto.scrypt` (`N=32768, r=8, p=1`) wurde explizit `maxmem: 64 * 1024 * 1024` gesetzt, da Node.js' Standard-Limit (`32 MiB`) andernfalls überschritten wird.
- `POST /api/auth/refresh` erneuert bei Web-Clients (`client_type = 'web'`) neben `bibliolisa_refresh` auch das kurzlebige `bibliolisa_media`-Cookie (`Path=/api/covers`, `scope: 'media:read'`).
- Für HS256-JWT-Signierung und -Verifizierung kommt `jose` zum Einsatz; `package.json` konfiguriert `pnpm.onlyBuiltDependencies` für `better-sqlite3` und `esbuild`.
- Verifikation nach Abschluss (Phase 1): `@bibliolisa/shared` (3 Testdateien, 12 Tests) sowie `@bibliolisa/server` (2 Testdateien, 10 Tests) inkl. Typechecks und Builds vollständig grün.

---

## Phase 2: Metadaten-Provider, Cover-Cache, Delta-Sync-Backend, Empfehlungen & Export

### Aufgaben-Checkliste

- [x] **Modulare Metadaten-Provider-Architektur:**
  - `MetadataProvider`-Interface und `OpenLibraryAdapter` (key-frei), `GoogleBooksAdapter` (key-frei, optionaler API-Key) sowie `HardcoverAdapter` (GraphQL, optional über `HARDCOVER_API_KEY`).
  - `MetadataAggregator`: Parallele Ausführung (`Promise.allSettled`, `4000 ms` Timeout pro Adapter), `15 min` In-Memory-TTL-Cache, feldspezifisches Merge-Ranking (Buchreihen/Bände bevorzugt aus Hardcover/Open Library), Rausch-Tag-Filterung.
  - Endpunkte `GET /api/metadata/isbn/:isbn`, `GET /api/metadata/search` und `GET /api/metadata/providers`.
- [x] **Cover-Cache & Bildverarbeitung (`CoverService`):**
  - SSRF-Schutz (nur `http`/`https`, IP-Blocklist gegen Loopback/Private/Link-Local nach DNS-Auflösung, max. 3 Redirects, `10 MB` Limit, `8 s` Timeout).
  - `sharp`-Konvertierung nach WebP (`max 600x900`, Qualität `82`), SHA-256 Content-Addressed Ablage unter `${DATA_DIR}/covers/<sha256_24>.webp` per atomarem Write.
  - Routen `GET /api/covers/:coverKey` (akzeptiert Bearer-Header **oder** `bibliolisa_media`-Cookie; Path-Traversal-Schutz), `POST /api/books/:bookId/cover` (Multipart, max `5 MB`) und `POST /api/books/:bookId/cover/fetch`.
- [x] **Delta-Sync-Backend (`POST /api/sync`):**
  - Atomare SQLite-Transaktion für kombinierten Push & Pull.
  - Konfliktauflösung über `updated_at` (LWW) inkl. Clock-Skew-Kappung (`> serverNow + 5 min`) und `clockSkewWarning`.
  - Serverseitig streng monotoner `server_updated_at`-Timestamp und Base64-Compound-Cursor (`server_updated_at|id`) mit Pagination (`limit`, `hasMore`, `nextCursor`).
  - Behandlung doppelter aktiver `(user_id, book_id)`-Einträge (LWW-Merge auf bestehende Server-Zeile) sowie Soft-Delete-/Restore-Konflikte.
- [x] **Empfehlungs-Endpunkt & Backup/Export:**
  - `GET /api/recommendations` an `@bibliolisa/shared` anbinden (`continue_series`, `affinity`, `quick_read`, `dust_collector`, `surprise_me`).
  - `GET /api/export/json`, `GET /api/export/csv` (UTF-8 BOM + CSV-Formula-Injection-Maskierung für `=`, `+`, `-`, `@`) und `POST /api/import/json` (Zod-Validierung + idempotenter Import).

### Verifikations-Check (Phase 2)

- [x] Unit- & Integrationstests für alle 3 Provider-Adapter (gemockte HTTP-Antworten inkl. Teilausfall/Timeout) sowie Merge-Prioritäten bestehen.
- [x] SSRF-Testsuite blockiert `127.0.0.1`, `169.254.169.254`, `10.0.0.1` und ungültige Cover-Pfade (`../`).
- [x] Sync-Testmatrix deckt Initial-Pull, Pagination (`hasMore`), LWW-Client-Wins, LWW-Server-Wins, verzögerten Offline-Push bei zwischenzeitlichem Cursor, Soft-Delete-Konflikt und Multi-User-Isolation ab.
- [x] JSON-Export -> Löschung/neuer Benutzer -> JSON-Import Roundtrip sowie CSV-Formula-Injection-Test bestehen.

### Akzeptanzkriterien (Phase 2)

1. Ein ISBN-Lookup liefert auch bei Ausfall eines oder zweier Provider deterministisch ein gültiges Ergebnis aus den verbleibenden Adaptern ohne `500`-Fehler.
2. Heruntergeladene oder hochgeladene Cover liegen ausschließlich unter `${DATA_DIR}/covers/*.webp` und sind ohne gültige Session/Token via `GET /api/covers/:coverKey` nicht abrufbar (`401`).
3. Bei `POST /api/sync` gewinnt stets der Datensatz mit dem neueren `updated_at`; bei unterlegenem Push liefert `pushResults` `conflict_server_won` und `pull` enthält sofort den autoritativen Server-Stand.
4. Verspätet gesyncte Offline-Änderungen (älteres `updated_at`, aber neueres `server_updated_at`) werden von einem zweiten Gerät beim nächsten inkrementellen Pull zuverlässig empfangen.
5. `GET /api/recommendations` empfiehlt bei begonnener Buchreihe (z. B. Band `1` gelesen) den nächsten ungelesenen Band (z. B. Band `1.5`) an höchster Position mit verständlicher Begründung.

### Abweichungen / Notizen
- `POST /api/sync` (`SyncService`) filtert `pull.books` auf SQL-Ebene strikt über `EXISTS (SELECT 1 FROM user_books WHERE user_id = ? AND book_id = b.id)`, sodass ausschließlich Bücher ausgeliefert werden, die von mindestens einem `user_books`-Eintrag des authentifizierten Benutzers referenziert werden (kein Leak fremder Katalog-Einträge). Zudem lädt der Pull beim erstmaligen Referenzieren eines bereits existierenden globalen `books`-Datensatzes über `user_books` auch dessen zugehöriges `Book`-Objekt mit, selbst wenn `books.server_updated_at` älter als der Sync-Cursor ist.
- In `@bibliolisa/server` wurden `sharp` (`^0.35.5`) für WebP-Konvertierung sowie `@fastify/multipart` (`^9.4.0`, kompatibel mit Fastify 5) ergänzt; `@bibliolisa/shared` wurde um die Request-/Response-Schemas `MetadataSearchQuerySchema`, `FetchBookCoverRequestSchema`, `BookCoverResponseSchema` und `ExportImportEnvelopeSchema` erweitert.
- Verifikation nach Abschluss (Phase 2): `@bibliolisa/shared` (3 Testdateien, 12 Tests) sowie `@bibliolisa/server` (7 Testdateien, 23 Tests — inkl. Provider-Mock-, SSRF-, Cover-, Sync-Konflikt-, Export/Import- und Empfehlungstests) inkl. Typechecks (`pnpm -r typecheck`) und Builds (`pnpm -r build`) vollständig grün.

---

## Phase 3: Webapp (`/web`) & Docker Single-Container / Reverse-Proxy-Deployment

### Aufgaben-Checkliste

- [ ] **Webapp-Grundgerüst (`/web`):**
  - Vite + React + TypeScript + Tailwind CSS + shadcn/ui einrichten (Dev-Proxy `/api` -> Server).
  - Auth-Layer mit In-Memory Access Token, Silent Refresh über `HttpOnly`-Cookie, Login-/Registrierungsseite und Session-/Geräteverwaltung in den Einstellungen.
- [ ] **Bibliotheksverwaltung (Feature-Parität):**
  - Übersicht als Grid- und Listenansicht mit Live-Suche (`q`), Filtern (Lesestatus, Genre/Tag, Autor, Buchreihe, Mindestbewertung) und allen Sortiermodi (Reihe inkl. Dezimalband, Autor, Titel, Status, Hinzufügedatum, Bewertung).
  - Buch hinzufügen & bearbeiten: ISBN-/Titelsuche mit Provider-Auswahl (inkl. Cover-Vorschau), nahtloser Übergang in manuelle Eingabe/Korrektur, Cover-Upload, Dezimal-Bandnummer, Sterne-Bewertung `1–5`, Notizen, Statuswechsel und Soft Delete inkl. Wiederherstellen-Toast.
- [ ] **Empfehlungen & Backup/Export in der Webapp:**
  - Ansicht „Was lese ich als Nächstes?“ mit Kategorien (Begonnene Reihen, Empfohlen für dich, Schneller Read `<300` Seiten, Staubfänger, Überrasch mich mit Würfel-Button) inklusive Anzeige der jeweiligen Begründung.
  - Backup-Seite mit Ein-Klick-Download für JSON & CSV sowie Upload-Dialog für JSON-Reimport inkl. Import-Zusammenfassung.
- [ ] **Single-Container-Docker & Reverse-Proxy-Kompatibilität:**
  - Fastify Static-Serving (`@fastify/static`) für `web/dist` auf `/` mit SPA-Fallback (während unbekannte `/api/*`-Pfade strikt JSON `404` liefern).
  - Multi-Stage `Dockerfile` (`node:22-bookworm-slim`, Non-Root-User `bibliolisa`, `HEALTHCHECK`), `.dockerignore` und `docker-compose.yml` (konfigurierbarer Port, Volume `./data:/data`, kein eingebauter Reverse Proxy).

### Verifikations-Check (Phase 3)

- [ ] `pnpm --filter @bibliolisa/web typecheck` und `pnpm --filter @bibliolisa/web build` laufen fehlerfrei durch.
- [ ] `docker build -t bibliolisa:local .` erstellt das Image erfolgreich ohne Dev-Abhängigkeiten in der Runtime-Stage.
- [ ] Container-Smoke-Test mit gemountetem Host-Verzeichnis unter `/data` startet, liefert `/` (HTML) und `/api/health` (`200 OK`), und übersteht Container-Neustart ohne Daten- oder Cover-Verlust.
- [ ] Simulation von Reverse-Proxy-Headern (`X-Forwarded-Proto: https`, `X-Forwarded-For`) setzt das `Secure`-Flag auf Auth-Cookies korrekt und liefert authentifizierte Cover in der Web-UI.

### Akzeptanzkriterien (Phase 3)

1. Die gesamte Anwendung (API + Webapp) läuft in genau einem Docker-Container auf dem konfigurierten Port (nicht `80`/`443`) und benötigt keinen separaten Proxy im Container.
2. Alle Buchfelder, Reihen-Sortierungen, Filter, Empfehlungen und JSON/CSV-Exporte sind vollständig über die Web-Oberfläche nutzbar.
3. Nach einem `docker compose down && docker compose up -d` bleiben alle Benutzer, Bücher, Bewertungen und gecachten Cover in `/data` erhalten.

### Abweichungen / Notizen
- `POST /api/sync` (`SyncService`) filtert `pull.books` auf SQL-Ebene strikt über `EXISTS (SELECT 1 FROM user_books WHERE user_id = ? AND book_id = b.id)`, sodass ausschließlich Bücher ausgeliefert werden, die von mindestens einem `user_books`-Eintrag des authentifizierten Benutzers referenziert werden (kein Leak fremder Katalog-Einträge). Zudem lädt der Pull beim erstmaligen Referenzieren eines bereits existierenden globalen `books`-Datensatzes über `user_books` auch dessen zugehöriges `Book`-Objekt mit, selbst wenn `books.server_updated_at` älter als der Sync-Cursor ist.
- In `@bibliolisa/server` wurden `sharp` (`^0.35.5`) für WebP-Konvertierung sowie `@fastify/multipart` (`^9.4.0`, kompatibel mit Fastify 5) ergänzt; `@bibliolisa/shared` wurde um die Request-/Response-Schemas `MetadataSearchQuerySchema`, `FetchBookCoverRequestSchema`, `BookCoverResponseSchema` und `ExportImportEnvelopeSchema` erweitert.
- Verifikation nach Abschluss (Phase 2): `@bibliolisa/shared` (3 Testdateien, 12 Tests) sowie `@bibliolisa/server` (7 Testdateien, 23 Tests — inkl. Provider-Mock-, SSRF-, Cover-, Sync-Konflikt-, Export/Import- und Empfehlungstests) inkl. Typechecks (`pnpm -r typecheck`) und Builds (`pnpm -r build`) vollständig grün.

---

## Phase 4: Offline-First Android-App (`/mobile`) – Lokale DB, Barcode-Scanner & Feature-Parität

### Aufgaben-Checkliste

- [ ] **Expo-Monorepo-Setup & LAN-Netzwerksicherheit:**
  - Expo SDK (TypeScript) in `/mobile` konfigurieren; `metro.config.js` für Auflösung von `@bibliolisa/shared` und pnpm-Symlinks einrichten.
  - Expo Config Plugin (`plugins/withLanNetworkSecurity.js`) implementieren, das `network_security_config.xml` (Cleartext `http://` im LAN + System- & User-CA-Zertifikate für selbstsigniertes `https://`) in den Android-Build einbindet.
- [ ] **Lokales SQLite, Cover-Cache & Secure Storage:**
  - `expo-sqlite`-Initialisierung & Migrationen (`books`, `user_books`, `sync_state`, `is_dirty`, `dirty_updated_at`, `cover_local_uri`, `cover_pending_upload`).
  - `secure-storage.ts` auf Basis von `expo-secure-store` für `accessToken`, `refreshToken`, `accessTokenExpiresAt`.
  - Lokale Bibliothek-Repository-Schicht (`library.repo.ts`) für alle Schreib-/Leseoperationen vollständig **ohne Netzwerkverbindung** (mit Client-UUIDv4-Generierung und `updated_at`-UTC-Stempeln).
- [ ] **Kamera-ISBN-Scanner & Buch-CRUD (Offline & Online):**
  - `BarcodeScanner.tsx` mit `expo-camera` (EAN-13/ISBN-Erkennung & Prüfziffervalidierung via `@bibliolisa/shared`).
  - Online-Metadaten-Lookup gegen den konfigurierten Server bei Erreichbarkeit – bei Offline-Zustand oder Nicht-Treffer nahtloser Fallback auf manuelles Formular mit bereits übernommener ISBN.
  - Lokale Bibliotheksansicht, Detailansicht, Status-/Bewertungs-/Notiz-Bearbeitung, Soft Delete, Suche, Filter und Reihen-Sortierung (inkl. `1, 1.5, 2`).
- [ ] **Offline-Empfehlungen & Verbindungs-Einstellungen:**
  - Empfehlungs-Screen („Was lese ich als Nächstes?“) direkt auf lokalen SQLite-Daten über `generateRecommendations()` aus `@bibliolisa/shared`.
  - Einstellungs-Screen: frei konfigurierbare Server-URL (`https://...` oder `http://...`), **„Verbindung testen“**-Button (gegen `GET /api/health` mit `<= 1.5s` Timeout und Diagnose-Anzeige), einmaliger Login mit Persistierung im SecureStore sowie Logout/Account-Wechsel (mit sauberem Reset der lokalen App-DB).

### Verifikations-Check (Phase 4)

- [ ] `pnpm --filter @bibliolisa/mobile typecheck` und Expo-Metro-Bundle-Export (`npx expo export --platform android`) laufen fehlerfrei durch.
- [ ] Android-Build/Prebuild (`npx expo prebuild --platform android`) erzeugt korrekt `AndroidManifest.xml` und `network_security_config.xml` ohne manuelle Nacharbeit.
- [ ] Manueller Funktionstest im Flugmodus: Bücher per Kamera-Scan / manuell anlegen, Reihennummer `1.5` setzen, Status/Bewertung/Notizen ändern, filtern, sortieren und Empfehlungen abrufen funktioniert vollständig ohne Server.

### Akzeptanzkriterien (Phase 4)

1. Die App ist zu 100 % ohne Serververbindung bedienbar (Anlegen, Bearbeiten, Status-/Bewertungsänderung, Soft Delete, Sortieren, Filtern, Empfehlungen).
2. In den Einstellungen kann eine beliebige `http://`- oder `https://`-URL eingegeben und per „Verbindung testen“ in maximal `1,5 s` überprüft werden; im Code ist keine LAN-IP fest hinterlegt.
3. Nach einmaligem Login bleiben die Tokens sicher in `expo-secure-store` erhalten und überstehen App-Neustarts.
4. `@bibliolisa/shared` wird direkt genutzt (keine kopierten DTOs, Validatoren oder Empfehlungsfunktionen in `/mobile`).

### Abweichungen / Notizen
- `POST /api/sync` (`SyncService`) filtert `pull.books` auf SQL-Ebene strikt über `EXISTS (SELECT 1 FROM user_books WHERE user_id = ? AND book_id = b.id)`, sodass ausschließlich Bücher ausgeliefert werden, die von mindestens einem `user_books`-Eintrag des authentifizierten Benutzers referenziert werden (kein Leak fremder Katalog-Einträge). Zudem lädt der Pull beim erstmaligen Referenzieren eines bereits existierenden globalen `books`-Datensatzes über `user_books` auch dessen zugehöriges `Book`-Objekt mit, selbst wenn `books.server_updated_at` älter als der Sync-Cursor ist.
- In `@bibliolisa/server` wurden `sharp` (`^0.35.5`) für WebP-Konvertierung sowie `@fastify/multipart` (`^9.4.0`, kompatibel mit Fastify 5) ergänzt; `@bibliolisa/shared` wurde um die Request-/Response-Schemas `MetadataSearchQuerySchema`, `FetchBookCoverRequestSchema`, `BookCoverResponseSchema` und `ExportImportEnvelopeSchema` erweitert.
- Verifikation nach Abschluss (Phase 2): `@bibliolisa/shared` (3 Testdateien, 12 Tests) sowie `@bibliolisa/server` (7 Testdateien, 23 Tests — inkl. Provider-Mock-, SSRF-, Cover-, Sync-Konflikt-, Export/Import- und Empfehlungstests) inkl. Typechecks (`pnpm -r typecheck`) und Builds (`pnpm -r build`) vollständig grün.

---

## Phase 5: Android Delta-Sync-Engine, End-to-End-Verifikation & Release-Härtung

### Aufgaben-Checkliste

- [ ] **Mobile Delta-Sync-Engine (`sync-engine.ts`):**
  - Pre-Flight-Reachability-Check (`GET /api/health`, `1500 ms` AbortController-Timeout): bei Nichterreichbarkeit stiller Abbruch auf Status `offline`.
  - Transparenter Token-Refresh bei ablaufendem `accessToken` (`< 60 s` Restlaufzeit) vor Sync-Start ohne Benutzer-Interaktion.
  - Single-Flight-Mutex + Pagination-Loop (`POST /api/sync` bis `hasMore === false`), LWW-Konvergenz bei `conflict_server_won`, Remap bei Duplikat-Merge und race-safe `is_dirty`-Reset (`WHERE dirty_updated_at = ?`).
- [ ] **Automatische Sync-Trigger & Cover-Cache-Sync:**
  - Trigger bei App-Start / Foreground-Resume (30s Cooldown), Pull-to-Refresh, debounced (`2s`) nach lokalen Schreibvorgängen ausschließlich im WLAN (`expo-network`) und manuellem Sync-Button.
  - Paralleler Cover-Download (max. 3 gleichzeitig, `Authorization: Bearer`) in `${documentDirectory}covers/`, Upload offline hinzugefügter Cover (`cover_pending_upload = 1`) und Orphan-Cleanup.
- [ ] **Sichtbare Sync-Status-UI:**
  - Status-Badge im Header (`synced`, `syncing`, `pending`, `offline`, `auth_required`, `error`) plus Detail-Ansicht mit letztem Sync-Zeitpunkt, ausstehenden Änderungen und manueller Sync-/Retry-Aktion.
- [ ] **End-to-End-Verifikation & Release-Härtung:**
  - E2E-Abnahme aller Kernszenarien über alle Schichten hinweg (Flugmodus-Edits -> WLAN-Sync -> Web-Verifikation; gleichzeitiger Edit-Konflikt Web vs. Offline-Android; 2-User-Isolation; Reverse-Proxy-HTTPS + LAN-HTTP; Restart-Persistenz).
  - Finaler Gesamtlauf aller Tests und Builds (`shared`, `server`, `web`, `mobile`, `docker build`) sowie Abschlussabgleich von `docs/ARCHITECTURE.md` und `docs/ROADMAP.md`.

### Verifikations-Check (Phase 5)

- [ ] Vollständige Testsuite & Typechecks über alle Workspaces (`pnpm -r typecheck && pnpm -r test && pnpm -r build`) laufen grün durch.
- [ ] E2E-Checkliste (Szenarien 1–5 unten) wurde am laufenden Docker-Container + Webbrowser + Android-Gerät/Emulator nachweislich durchlaufen und protokolliert.

### Akzeptanzkriterien (Phase 5)

1. **Offline-zu-Online-Nahtlosigkeit:** Mehrere im Flugmodus auf Android angelegte/geänderte/gelöschte Bücher (inkl. Cover und Dezimalbänden) synchronisieren sich beim Wiederherstellen der LAN-Verbindung automatisch ohne erneuten Login und erscheinen sofort identisch in der Webapp.
2. **Deterministische Konfliktauflösung:** Ein zeitgleicher Offline-Edit auf Android und neuerer Edit in der Webapp konvergiert nach Sync ohne Datenkorruption auf beiden Geräten auf denselben LWW-Stand.
3. **Resilienz bei Server-Abwesenheit:** Befindet sich das Android-Gerät außerhalb des Heimnetzes, bricht der `/api/health`-Check spätestens nach `1,5 s` ab, blockiert die UI nicht, zeigt sauber `Offline` an und behält alle ungesyncten Änderungen (`is_dirty = 1`).
4. **LAN & Reverse Proxy:** Sowohl direkte `http://<LAN-IP>:<PORT>`-Verbindungen als auch `https://<proxy-domain>` über den bestehenden Host-Reverse-Proxy funktionieren in Webapp und Android-App zuverlässig.
5. **Dokumentations-Parität:** `docs/ROADMAP.md` und `docs/ARCHITECTURE.md` spiegeln den final getesteten Stand ohne offene Widersprüche wider.

### Abweichungen / Notizen
- `POST /api/sync` (`SyncService`) filtert `pull.books` auf SQL-Ebene strikt über `EXISTS (SELECT 1 FROM user_books WHERE user_id = ? AND book_id = b.id)`, sodass ausschließlich Bücher ausgeliefert werden, die von mindestens einem `user_books`-Eintrag des authentifizierten Benutzers referenziert werden (kein Leak fremder Katalog-Einträge). Zudem lädt der Pull beim erstmaligen Referenzieren eines bereits existierenden globalen `books`-Datensatzes über `user_books` auch dessen zugehöriges `Book`-Objekt mit, selbst wenn `books.server_updated_at` älter als der Sync-Cursor ist.
- In `@bibliolisa/server` wurden `sharp` (`^0.35.5`) für WebP-Konvertierung sowie `@fastify/multipart` (`^9.4.0`, kompatibel mit Fastify 5) ergänzt; `@bibliolisa/shared` wurde um die Request-/Response-Schemas `MetadataSearchQuerySchema`, `FetchBookCoverRequestSchema`, `BookCoverResponseSchema` und `ExportImportEnvelopeSchema` erweitert.
- Verifikation nach Abschluss (Phase 2): `@bibliolisa/shared` (3 Testdateien, 12 Tests) sowie `@bibliolisa/server` (7 Testdateien, 23 Tests — inkl. Provider-Mock-, SSRF-, Cover-, Sync-Konflikt-, Export/Import- und Empfehlungstests) inkl. Typechecks (`pnpm -r typecheck`) und Builds (`pnpm -r build`) vollständig grün.
