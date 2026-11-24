# Umsetzungsplan: Enhancement-Issues (`#2`, `#6`)

> **Ziel:** Strukturiertes Umsetzen der beiden offenen Enhancement-Issues aus `michpese/Bibliolisa` in einem dedizierten neuen Umsetzungs-Chat.  
> **Grundlage:** Alle Regeln aus `.antigravity/rules.md` sind verbindlich – insbesondere:  
> - Geteilte DTOs und Zod-Schemas gehören zwingend nach `/shared` (keine duplizierten DTOs).  
> - Jeder neue API-Endpunkt ist strikt authentifiziert und filtert serverseitig nach `request.user.id`.  
> - Schema- und Endpunkt-Erweiterungen werden in `docs/ARCHITECTURE.md` nachgezogen.

---

## Übersicht

| Reihenfolge | Issue | Bereich | Kernfunktion | Betroffene Workspaces |
| :---: | :--- | :--- | :--- | :--- |
| **1** | **#2** | Mobile (Android) | Option *„Noch ein Buch hinzufügen“* direkt im *„Buch gespeichert“*-Popup | `/mobile` (`AddBookScreen.tsx`) |
| **2** | **#6** | Shared / Server / Web / Mobile | Synchron-Anzeige auf Web-Home + manueller Sync-Button mit Gesamt-Feedback in Web-Einstellungen | `/shared`, `/server`, `/web`, `/mobile`, `/docs/ARCHITECTURE.md` |

---

## 1. Issue #2 — App: „Noch ein Buch hinzufügen“-Option

**GitHub-Issue:** `michpese/Bibliolisa#2`

### Anforderung
Nach dem Speichern eines Buches soll das Popup *„Buch gespeichert“* direkt eine Option anbieten, noch ein Buch hinzuzufügen, die den Benutzer sofort wieder bereit auf den *„Hinzufügen“*-Tab bringt.

### Ist-Zustand (im Code verifiziert)
- In `mobile/src/screens/AddBookScreen.tsx` (Zeilen 297–319) setzt `handleCreateBook` nach dem Speichern bereits alle lokalen Eingabezustände zurück (`setFormValues(createEmptyBookFormValues())`, `setSearchQuery('')`, `setResults(null)`, `setProviderStatuses([])`, `setLookupBanner(null)`, `setExistingMatch(null)`) und zeigt danach ein natives `Alert.alert`:
  - *„Details öffnen“*
  - *„Zur Bibliothek“*
- In `mobile/src/components/BookForm.tsx` (Zeilen 143–146) übernimmt ein `useEffect` Änderungen an `initialValues` automatisch und leert das Formular sauber.
- **Problem bei nativem Android-`Alert.alert`:** Mit 3 längeren deutschen Button-Texten (*„Noch ein Buch hinzufügen“*, *„Details öffnen“*, *„Zur Bibliothek“*) bricht das native Android-Dialog-Layout oft unübersichtlich um oder schneidet Texte ab.

### Konkrete Änderungen (`mobile/src/screens/AddBookScreen.tsx`)
1. **Themengerechtes Bestätigungs-`<Modal>` statt 2-Button-`Alert.alert`:**
   - Neuen State `savedEntry: { id: string; title: string } | null` anlegen.
   - `scrollViewRef = useRef<ScrollView>(null)` auf dem Haupt-`ScrollView` (Zeile 341) ergänzen.
   - `useSafeAreaInsets()` (aus `react-native-safe-area-context`) verwenden, damit das Modal am unteren Rand sauber oberhalb der Android-Navigationsleiste sitzt (`paddingBottom: Math.max(insets.bottom, 16) + 12`).
2. **Drei klar beschriftete Aktionen im Popup *„Buch gespeichert“*:**
   - Text: `„${savedEntry.title}“ wurde lokal in deiner Bibliothek gespeichert.` (plus kurzer Hinweis, ob vorgemerkt für Sync oder offline bereit).
   - **Primär-Button: `Noch ein Buch hinzufügen`**
     - Schließt das Modal (`setSavedEntry(null)`).
     - Setzt `setProviderFilter('all')` (neben den bereits zurückgesetzten States).
     - Bleibt auf `AddBookTab` und scrollt via `requestAnimationFrame(() => scrollViewRef.current?.scrollTo({ y: 0, animated: true }))` sofort ganz nach oben, sodass Barcode-Scanner und Suchfeld unmittelbar bereitstehen.
   - **Sekundär-Button: `Details öffnen`**
     - Schließt das Modal (`setSavedEntry(null)`) und navigiert zu `navigation.navigate('BookDetail', { userBookId: entryId })`.
   - **Sekundär-Button: `Zur Bibliothek`**
     - Schließt das Modal (`setSavedEntry(null)`) und navigiert zu `navigation.navigate('LibraryTab')`.
   - **Zurück-Taste / Backdrop-Close (`onRequestClose`):** Schließt das Modal sauber und scrollt auf `AddBookTab` nach oben (identisches sicheres Verhalten wie *„Noch ein Buch hinzufügen“*).

### Akzeptanzkriterien (#2)
- Nach dem Speichern eines Buches (online oder im Flugmodus) erscheint das Popup *„Buch gespeichert“* mit der Option **„Noch ein Buch hinzufügen“** sowie *„Details öffnen“* und *„Zur Bibliothek“*.
- Ein Tipp auf *„Noch ein Buch hinzufügen“* schließt das Popup, lässt alle Formularfelder, Suchergebnisse und Duplikat-Banner vollständig geleert und scrollt sofort an den Anfang des *„Hinzufügen“*-Tabs.

---

## 2. Issue #6 — Webapp: „Synchron“-Anzeige auf Home & manueller Sync-Button in Einstellungen

**GitHub-Issue:** `michpese/Bibliolisa#6`

### Anforderung
> *„Als User möchte ich beim Öffnen der Webapp eine Anzeige sehen, die mir sagt, ob die Bibliothek mit der Handy-App synchron ist, und einen eigenen Button für die manuelle Synchronisation in den Einstellungen haben, welcher mir dann auch ein Feedback über den Synchronisationsstand der gesamten Bibliothek anzeigt.“*

### Architektur-Analyse & Systemgrenze (transparente Semantik)
- Die Webapp spricht direkt mit dem Server-Backend (SQLite), hält aber lokal einen TanStack-Query-Cache (`staleTime: 30_000`, `refetchOnWindowFocus: false` in `web/src/main.tsx`).
- Bisher speichert der Server bei `POST /api/sync` noch keinen Geräte-Sync-Fortschritt (nur Sessions in `refresh_tokens`), sodass die Webapp nicht weiß, bis zu welchem Server-Stand verknüpfte Android-Geräte bereits synchronisiert haben.
- **Was der Server exakt und ehrlich ermitteln kann:**
  1. Den aktuellen Gesamtstand der Benutzerbibliothek auf dem Server (`totalBooks`, `deletedBooks`, `libraryLastModifiedAt = MAX(server_updated_at)` über alle `user_books` des Benutzers sowie die von ihnen referenzierten `books`).
  2. Für jedes verknüpfte Android-Gerät des Benutzers: wann es zuletzt synchronisiert hat (`lastSyncAt`), ob sein letzter Lauf vollständig durchlief (`lastSyncCompleted`) und bis zu welchem Server-Stand (`lastSyncedServerUpdatedAt`) es gepullt hat.
  3. **Ableitung des Gesamtstatus (`WebSyncOverallStatus`):**
     - `synced` (**„Synchron“**, grün): Mindestens ein aktives Android-Gerät existiert, alle aktiven Android-Geräte haben `lastSyncCompleted === true` und `lastSyncedServerUpdatedAt >= libraryLastModifiedAt` (oder die Bibliothek wurde ohne offene Server-Änderungen seit dem letzten Sync nicht verändert).
     - `server_ahead` (**„Handy ausstehend (N)“**, gelb/amber): Auf dem Server/in der Webapp gibt es `N` neuere Änderungen nach `lastSyncedServerUpdatedAt`, die mindestens ein aktives Android-Gerät noch nicht abgeholt hat.
     - `never_synced` (**„Handy noch nicht synchronisiert“**, gelb): Mindestens eine aktive Android-Session ist angemeldet, hat aber noch keinen vollständigen `POST /api/sync`-Lauf abgeschlossen.
     - `no_mobile_device` (**„Kein Mobilgerät verknüpft“**, grau): Es existiert aktuell keine aktive Android-Session für diesen Benutzer.
- **Wichtige Ehrlichkeit gegenüber dem Benutzer:** Offline-Änderungen, die ausschließlich lokal auf einem gerade nicht im WLAN befindlichen Handy liegen, kann der Server technisch erst nach dem nächsten App-Sync sehen. Deshalb zeigt die Detailansicht in den Einstellungen neben dem konkreten Sync-Stand einen kurzen erklärenden Hinweis dazu an.

### Konkrete Änderungen über die betroffenen Workspaces

#### 2.1 `@bibliolisa/shared` (`shared/src/schemas/sync.ts` & `shared/src/index.ts`)
1. `SyncRequestSchema` (Zeile 12–23) um ein optionales Feld erweitern (100 % abwärtskompatibel für ältere Mobile-Builds):
   ```ts
   deviceName: z.string().trim().min(1).max(128).nullable().optional(),
   ```
2. Neue gemeinsame Schemas & Typen für den Sync-Status definieren (keine duplizierten DTOs in `/server` oder `/web`!):
   - `WebSyncOverallStatusSchema`: `z.enum(['synced', 'server_ahead', 'never_synced', 'no_mobile_device'])`
   - `SyncDeviceStatusSchema`:
     - `deviceId: z.string()`
     - `deviceName: z.string().nullable()`
     - `lastSyncAt: IsoUtcTimestampSchema.nullable()`
     - `lastSyncCompleted: z.boolean()`
     - `isUpToDate: z.boolean()`
     - `pendingServerChanges: z.number().int().min(0)`
     - `lastPushedCount: z.number().int().min(0)`
     - `lastPulledCount: z.number().int().min(0)`
     - `clockSkewWarning: z.boolean()`
     - `sessionActive: z.boolean()`
   - `SyncStatusResponseSchema`:
     - `status: WebSyncOverallStatusSchema`
     - `serverTime: IsoUtcTimestampSchema`
     - `totalBooks: z.number().int().min(0)`
     - `deletedBooks: z.number().int().min(0)`
     - `libraryLastModifiedAt: IsoUtcTimestampSchema.nullable()`
     - `pendingForMobileCount: z.number().int().min(0)` (Maximum ausstehender Server-Änderungen über aktive Mobilgeräte)
     - `devices: z.array(SyncDeviceStatusSchema)`

#### 2.2 `@bibliolisa/server`
1. **Datenbank-Schema & Migration:**
   - In `server/src/db/schema.ts` neue Tabelle `syncDevices` (`sync_devices`) anlegen:
     - `id: text('id').primaryKey()` (UUIDv4)
     - `userId: text('user_id').notNull().references(() => users.id, { onDelete: 'cascade' })`
     - `deviceId: text('device_id').notNull()`
     - `deviceName: text('device_name')`
     - `lastSyncAt: text('last_sync_at').notNull()`
     - `lastSyncedServerUpdatedAt: text('last_synced_server_updated_at')`
     - `lastSyncCompleted: integer('last_sync_completed').notNull().default(0)` (0/1)
     - `lastPushedCount: integer('last_pushed_count').notNull().default(0)`
     - `lastPulledCount: integer('last_pulled_count').notNull().default(0)`
     - `clockSkewWarning: integer('clock_skew_warning').notNull().default(0)` (0/1)
     - `updatedAt: text('updated_at').notNull()`
     - Unique-Index `idx_sync_devices_user_device` auf `(user_id, device_id)` sowie Index auf `(user_id, last_sync_at)`.
   - Neue SQL-Migration `server/src/db/migrations/0001_sync_devices.sql` generieren bzw. inklusive `server/src/db/migrations/meta/_journal.json` bereitstellen, damit `runMigrations()` in `server/src/db/migrate.ts` bestehende `/data/bibliolisa.sqlite`-Instanzen automatisch und verlustfrei migriert.
2. **`server/src/services/sync.service.ts`:**
   - In `sync(userId, request)` innerhalb derselben SQLite-Transaktion am Ende einen `INSERT ... ON CONFLICT(user_id, device_id) DO UPDATE` in `sync_devices` ausführen:
     - `device_name`: `request.deviceName`, sonst Fallback auf zuletzt genutzten Namen aus `refresh_tokens` (`WHERE user_id = ? AND device_id = ?`).
     - `last_sync_at = serverTimeIso`
     - `last_sync_completed = hasMore ? 0 : 1`
     - `last_synced_server_updated_at`: Falls `nextCursor` existiert, dessen `serverUpdatedAt`-Anteil verwenden; falls `hasMore === false` und weder Cursor noch Änderungen vorlagen, `serverTimeIso` setzen (damit ein leerer initialer Sync auf aktuellem Stand als `synced` gilt).
     - `last_pushed_count = acceptedBooks + acceptedUserBooks`, `last_pulled_count = pullBooks.length + pullUserBooks.length`, `clock_skew_warning = clockSkewWarning ? 1 : 0`.
   - Neue Methode `getSyncStatus(userId: string): SyncStatusResponse`:
     - Strikt nach `user_id = ?` isoliert!
     - Ermittelt `totalBooks` (`deleted_at IS NULL`), `deletedBooks` (`deleted_at IS NOT NULL`) und `libraryLastModifiedAt` = Maximum aus `MAX(ub.server_updated_at)` (über alle `user_books` von `userId`) und `MAX(b.server_updated_at)` (über alle über `user_books` von `userId` referenzierten `books`).
     - Lädt aktive mobile Sessions aus `refresh_tokens` (`WHERE user_id = ? AND client_type = 'mobile' AND revoked_at IS NULL AND expires_at > ?`) sowie gespeicherte Einträge aus `sync_devices` (`WHERE user_id = ?`).
     - Führt beide Listen je `device_id` zusammen:
       - Geräte mit aktiver mobiler Session (`sessionActive: true`) bestimmen den Gesamtstatus (`synced` vs. `server_ahead` vs. `never_synced`).
       - Abgemeldete/widerrufene alte Geräte werden sauber getrennt bzw. blockieren den Gesamtstatus nicht dauerhaft.
     - Zählt für jedes aktive Gerät `pendingServerChanges`: Anzahl der `user_books` von `userId` mit `server_updated_at > lastSyncedServerUpdatedAt` plus referenzierte `books` mit `server_updated_at > lastSyncedServerUpdatedAt` (wenn `lastSyncedServerUpdatedAt === null`, zählt der komplette Server-Bestand).
3. **`server/src/routes/sync.ts`:**
   - Authentifizierte Route `GET /api/sync/status` registrieren -> ruft `syncService.getSyncStatus(request.user.id)` auf und gibt `200 OK` zurück.
4. **`server/tests/sync.test.ts`:**
   - Neue Tests für:
     - `GET /api/sync/status` ohne Authentifizierung -> `401`.
     - `no_mobile_device`, wenn nur Web-Sessions existieren.
     - `never_synced`, wenn eine Android-Session existiert, aber noch kein `POST /api/sync` lief.
     - `synced` nach vollständigem Mobile-Sync (`hasMore: false`).
     - `server_ahead` + präziser `pendingForMobileCount` nach Änderung eines Buches auf dem Server/Web, Rückkehr auf `synced` nach erneutem Mobile-Sync.
     - Multi-User-Isolation (Benutzer B sieht niemals Geräte oder Status von Benutzer A).

#### 2.3 `@bibliolisa/mobile` (optionale Verbesserung)
- In `mobile/src/sync/sync-engine.ts` beim Aufbau des `SyncRequest` optional `deviceName` (sofern über `Platform` / AppContext verfügbar) mitsenden, damit ein Gerät auch dann sauber benannt bleibt, wenn `refresh_tokens` rotiert wurde. Bestehende APKs ohne dieses Feld bleiben durch `.optional()` vollständig kompatibel.

#### 2.4 `@bibliolisa/web`
1. **`web/src/api/client.ts`:**
   - Methode `syncStatus: (): Promise<SyncStatusResponse> => request<SyncStatusResponse>('/api/sync/status')` ergänzen.
2. **Neuer Hook `web/src/hooks/useSyncStatus.ts`:**
   - Query `['sync', 'status']` mit `refetchInterval: 30_000` und `refetchOnWindowFocus: true`, damit die Webapp im Hintergrund/beim Tab-Wechsel neue Handy-Syncs erkennt.
   - Merkt sich `libraryLastModifiedAt` in einem `useRef`: Sobald sich der Server-Zeitstempel durch einen externen Handy-Sync gegenüber dem zuletzt bekannten Stand ändert, werden automatisch `libraryKeys.all` und `libraryKeys.recommendations` invalidiert (Live-Abgleich der angezeigten Bibliothek).
   - Exportiert `triggerManualSync()`:
     - Führt `await queryClient.invalidateQueries({ queryKey: libraryKeys.all })`, `libraryKeys.recommendations`, `['sessions']` sowie `const fresh = await syncQuery.refetch()` parallel aus und wartet auf alle Aktualisierungen.
     - Hält `lastCheckedAt` und `lastSyncFeedback` für die Einstellungsseite fest.
     - Zeigt ein klares Toast-Feedback passend zum Gesamtstand (z. B. *„Bibliothek aktualisiert (42 Bücher) – mit Handy synchron.“* oder *„Bibliothek aktualisiert (42 Bücher) – 3 Änderungen warten noch auf Sync durch die Handy-App.“*).
3. **`web/src/hooks/useLibrary.ts`:**
   - In `useUpdateEntry`, `useDeleteEntry`, `useRestoreEntry` sowie `useInvalidateLibrary()` (was auch von `BookFormDialog.tsx` und `BackupPage.tsx` genutzt wird) zusätzlich `void client.invalidateQueries({ queryKey: ['sync', 'status'] })` aufrufen, damit das Badge sofort nach jeder Web-Änderung aktualisiert wird.
4. **Neue Komponente `web/src/components/WebSyncBadge.tsx`:**
   - Kompakte, klickbare Status-Pill (visuell passend zu `SyncStatusBadge` in der Android-App):
     - `synced` -> Grün: **„Synchron“**
     - `server_ahead` -> Gelb/Amber: **„Handy ausstehend (N)“**
     - `never_synced` -> Gelb: **„Handy nicht gesynct“**
     - `no_mobile_device` -> Neutral/Grau: **„Kein Handy“**
     - Ladend/Fehler -> Blau **„Synct…“** bzw. Rot **„Sync-Fehler“**
   - Klick auf die Pill öffnet ein übersichtliches Status-Dialogfenster (mit Gesamtanzahl Bücher, Status pro Gerät, letztem Sync-Zeitpunkt, Button *„Jetzt synchronisieren“* und Link *„Einstellungen öffnen“* -> `/settings#sync`).
5. **`web/src/pages/LibraryPage.tsx` (Home):**
   - `<WebSyncBadge />` direkt beim Öffnen sichtbar im Header neben Titel/Ansichtsschalter platzieren (responsive, sodass es auf Desktop und Mobilbrowsern sauber umbricht).
6. **`web/src/pages/SettingsPage.tsx`:**
   - Neue `SyncStatusCard` (mit `id="sync"` und `<WebSyncBadge />` im Card-Header) prominent oberhalb von `SessionsCard` einfügen:
     - **Übersicht des Bibliotheksstands:** Aktive Bücher gesamt, letzte Änderung auf dem Server, letzte Prüfung durch die Webapp, Gesamtstatus in Klartext.
     - **Geräte-Synchronisation:** Liste der verknüpften Mobilgeräte mit letztem Sync-Zeitpunkt, ausstehenden Server-Änderungen und letztem Transfer (`↑ gepusht / ↓ gepullt`), inkl. Hinweis auf reine Offline-Änderungen am Handy bis zum nächsten App-Sync.
     - **Eigener Button *„Jetzt synchronisieren“*** mit Lade-Spinner (`Loader2`) während des Abgleichs sowie sichtbarem Inline-Feedback-Kasten unter dem Button (Erfolg, Ausstehend-Zähler oder Fehlermeldung).

#### 2.5 Dokumentation (`docs/ARCHITECTURE.md`)
- In `docs/ARCHITECTURE.md` die neue Tabelle `sync_devices` (Kapitel 3) sowie den Endpunkt `GET /api/sync/status` (Kapitel 6) dokumentieren, damit Code und Spezifikation deckungsgleich bleiben.

### Akzeptanzkriterien (#6)
1. Beim Öffnen der Webapp (Home) zeigt ein sichtbares Badge sofort an, ob die Bibliothek mit der verknüpften Android-App synchron ist (*Synchron*, *Handy ausstehend (N)*, *Handy nicht gesynct* oder *Kein Mobilgerät*).
2. Nach einer Bearbeitung oder Neuanlage auf der Webapp wechselt das Badge auf *Handy ausstehend*; nach einem erfolgreichen Sync der Android-App wechselt es auf grün *Synchron* und aktualisiert angezeigte Listen automatisch.
3. In den Web-Einstellungen existiert ein eigener Bereich zur Synchronisation mit dem Button **„Jetzt synchronisieren“**, der nach Klick die Bibliothek + Sync-Status frisch vom Server abruft und klares Feedback zum Synchronisationsstand der gesamten Bibliothek und der verknüpften Geräte gibt.
4. Bestehende Server-SQLite-Datenbanken migrieren beim Start automatisch über `0001_sync_devices.sql`, und `GET /api/sync/status` bleibt strikt auf den jeweils angemeldeten Benutzer (`request.user.id`) isoliert.

---

## 3. Verifikation vor Abschluss

Nach Umsetzung beider Enhancements im neuen Chat müssen alle Workspaces getestet und gebaut werden:

```bash
pnpm --filter @bibliolisa/shared test && pnpm --filter @bibliolisa/shared build
pnpm --filter @bibliolisa/server test && pnpm --filter @bibliolisa/server build
pnpm --filter @bibliolisa/web typecheck && pnpm --filter @bibliolisa/web build
pnpm --filter @bibliolisa/mobile typecheck && pnpm --filter @bibliolisa/mobile test && pnpm --filter @bibliolisa/mobile export:android
```

*(Optional zusätzlich `pnpm docker:build` / `pnpm docker:smoke`, falls Docker lokal verfügbar ist.)*

---

## Fertiger Start-Prompt für den neuen Enhancement-Chat

```text
Beachte alle Regeln in `.antigravity/rules.md`.

Setze den vollständigen Enhancement-Plan aus `docs/PLAN_ENHANCEMENTS.md` (GitHub-Issues #2 und #6) Schritt für Schritt um.

Arbeitsweise:
1. Lies zuerst `docs/PLAN_ENHANCEMENTS.md` sowie bei Bedarf die relevanten Stellen in `docs/ARCHITECTURE.md` und arbeite zuerst Issue #2 (Mobile) und anschließend Issue #6 (Shared -> Server + Migration -> Mobile -> Webapp -> Doku) um.
2. Halte strikt ein: Alle geteilten DTOs/Schemas nach `@bibliolisa/shared`, keine duplizierten Typen, strikte Authentifizierung und `user_id`-Isolation auf `GET /api/sync/status`, saubere Drizzle-Migration (`0001_sync_devices.sql` + `_journal.json`) für bestehende SQLite-Datenbanken.
3. Ergänze die beschriebenen Server-Integrationstests in `server/tests/sync.test.ts` und ziehe `sync_devices` + `GET /api/sync/status` in `docs/ARCHITECTURE.md` nach.
4. Führe nach Abschluss aller Änderungen `test`, `typecheck` und `build` über alle betroffenen Workspaces (`shared`, `server`, `web`, `mobile`) aus und stelle sicher, dass alles grün ist.
```
