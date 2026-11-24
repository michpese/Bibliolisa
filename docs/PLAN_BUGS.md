# Umsetzungsplan: Bug-Issues (`#1`, `#3`, `#4`, `#5`)

> **Ziel:** Strukturiertes Beheben aller 4 offenen Bug-Issues aus `michpese/Bibliolisa` in einem dedizierten neuen Umsetzungs-Chat.  
> **Grundlage:** Alle Regeln aus `.antigravity/rules.md` sowie die Spezifikation in `docs/ARCHITECTURE.md` bleiben verbindlich.

---

## Übersicht & empfohlene Reihenfolge

| Reihenfolge | Issue | Bereich | Kernproblem | Betroffene Dateien |
| :---: | :--- | :--- | :--- | :--- |
| **1** | **#4** | Mobile (Android) | Grünes „Synchron“-Badge ragt in den Einstellungen rechts aus der Card | `mobile/src/screens/SettingsScreen.tsx`, `mobile/src/screens/LibraryScreen.tsx` |
| **2** | **#1** | Mobile (Android) | Android-Systemnavigationsleiste überdeckt untere Buttons in Screens & Modals | `mobile/src/utils/safe-area.ts` (neu), `mobile/src/screens/BookDetailScreen.tsx`, `mobile/src/screens/LibraryScreen.tsx`, `mobile/src/components/SyncStatusBadge.tsx`, `mobile/src/components/UpdateModal.tsx`, `mobile/src/components/BarcodeScanner.tsx`, `mobile/src/App.tsx` |
| **3** | **#5** | Mobile (Android) | „Neu laden“-Button im Tab „Empfehlungen“ liefert kein Feedback und würfelt/aktualisiert nicht sichtbar | `mobile/src/screens/RecommendationsScreen.tsx` |
| **4** | **#3** | Webapp | Rückkehr über „<- Bibliothek“ springt nach ganz oben und verliert Status, Filter & Sortierung | `web/src/lib/libraryNavigation.ts` (neu), `web/src/pages/LibraryPage.tsx`, `web/src/pages/BookDetailPage.tsx`, `web/src/components/BookCard.tsx`, `web/src/components/SeriesCard.tsx` |

*Hinweis zur Reihenfolge:* Zuerst werden die drei Mobile-Bugs (`#4`, `#1`, `#5`) gebündelt erledigt und gemeinsam über Typecheck/Tests/Export verifiziert; anschließend folgt der Webapp-Fix (`#3`) mit eigenem Build und vollständiger Rücknavigation-Prüfung.

---

## 1. Issue #4 — App: „Synchron“ in Einstellungen out-of-bounds

**GitHub-Issue:** `michpese/Bibliolisa#4`

### Problem & Ursache (im Code verifiziert)
- In `mobile/src/screens/SettingsScreen.tsx` (Zeilen 532–537) stehen der Titel und das Status-Badge nebeneinander in `styles.cardHeaderRow` (Zeilen 775–780):
  ```tsx
  <View style={styles.cardHeaderRow}>
    <Text style={[styles.cardTitle, { color: theme.text }]}>
      Synchronisation & Gerätestatus
    </Text>
    <SyncStatusBadge compact />
  </View>
  ```
- Weil `cardTitle` kein `flex: 1` / `flexShrink: 1` hat und der Titel „Synchronisation & Gerätestatus“ recht breit ist, schiebt er `<SyncStatusBadge compact />` auf schmalen Android-Displays rechts über den Rand der Card hinaus.

### Konkrete Änderungen
1. **`mobile/src/screens/SettingsScreen.tsx`:**
   - Den Header-Bereich im Abschnitt *Synchronisation & Gerätestatus* von horizontalem Layout (`cardHeaderRow`) auf einen vertikalen Block (`cardHeaderStack`: `gap: 8, alignItems: 'flex-start'`) umstellen, sodass `<SyncStatusBadge compact />` linksbündig in einer **eigenen Zeile direkt unter der Überschrift** steht (entspricht dem Fix-Vorschlag im Issue).
   - Das nicht mehr benötigte oder anderweitig genutzte `cardHeaderRow`-Style bereinigen bzw. auf `cardHeaderStack` umstellen.
2. **Präventiver Audit aller weiteren `<SyncStatusBadge />`-Einsatzstellen:**
   - In `mobile/src/screens/LibraryScreen.tsx` (Zeilen 204–233, `styles.topHeader` / `styles.headerActions`) prüfen, dass das linke Titel-Container-`<View style={{ flex: 1, minWidth: 0 }}>` sauber schrumpft und `headerActions` (`flexShrink: 0`) auch bei längeren Badge-Zuständen wie `Offline (12)` oder `Sync-Fehler` nicht abgeschnitten wird.

### Akzeptanzkriterien (#4)
- In *Einstellungen → Synchronisation & Gerätestatus* steht das Sync-Badge in einer eigenen Zeile direkt unter der Überschrift und ragt auf keinem schmalen Smartphone (z. B. 360 dp Breite) über den Card-Rand hinaus.
- Alle Sync-Zustände (`Synchron`, `Offline (X)`, `X offen`, `Sync-Fehler`, `Anmelden`) bleiben vollständig innerhalb der Card.

---

## 2. Issue #1 — App: Handy-Navigation überdeckt App-Buttons

**GitHub-Issue:** `michpese/Bibliolisa#1` (inkl. Kommentar von *ElisaPesel* zum Sync-Modal)

### Problem & Ursache (im Code verifiziert)
- Die App läuft unter Expo SDK 54 (`react-native 0.81.5`, `react-native-safe-area-context ~5.6.0`) mit Android Edge-to-Edge. Bei Android-3-Button-Navigation (typisch `48 dp` Höhe) oder Gestenleiste werden untere Aktionen verdeckt oder abgeschnitten, weil Screens und Bottom-Sheets feste, zu kleine Bottom-Abstände nutzen statt `useSafeAreaInsets().bottom`:
  - `mobile/src/screens/BookDetailScreen.tsx`: `styles.content` hat nur `paddingBottom: 32` (Zeile 574), sodass *„Metadaten bearbeiten“* und *„Entfernen“* abgeschnitten werden; das Bearbeiten-`<Modal>` (Zeilen 502–542) nutzt `<SafeAreaView>` innerhalb eines `<Modal>`.
  - `mobile/src/screens/LibraryScreen.tsx`: Im Filter-`<Modal>` (`styles.filterSheet` & `styles.filterFooter`, Zeilen 655–910, 1186–1238) fehlen Bottom-Safe-Area-Insets vollständig, wodurch *„Leeren“* und *„Anwenden“* abgeschnitten werden. Auch das Sortier-`<Modal>` (`styles.modalSheet`, Zeile 1163) nutzt statisches `marginBottom: 28`.
  - `mobile/src/components/SyncStatusBadge.tsx`: Das Sync-Status-`<Modal>` (`styles.sheet`, Zeilen 212–424, 484–490) nutzt statisches `paddingBottom: 24`, sodass der Button *„Server & Konto in Einstellungen öffnen“* von der Navigationsleiste überdeckt wird.
  - `mobile/src/components/UpdateModal.tsx` (`styles.footer`, Zeile 875: `paddingBottom: 22`) und `mobile/src/components/BarcodeScanner.tsx` (`<Modal>` mit innerem `<SafeAreaView>`, Zeile 80) sind derselben Ursache ausgesetzt.
- **Wichtiger Android-Pitfall bei `<Modal>`:** In React Native öffnet `<Modal>` unter Android ein eigenes natives `Dialog`-Window außerhalb des Root-`<SafeAreaProvider>`-Kontexts. Ein dort eingebettetes `<SafeAreaView>` erhält unter Android oft `insets.bottom === 0`.
- **Architekturentscheidung:** Die Android-Systemnavigation wird **nicht** per Immersive Mode ausgeblendet (schlechte UX für Zurück-/Home-Bedienung), sondern konsistent über die echten Safe-Area-Insets aus der Elternkomponente (unterhalb des Root-`<SafeAreaProvider>` in `mobile/src/App.tsx`) geschützt.

### Konkrete Änderungen
1. **Neue Hilfsdatei `mobile/src/utils/safe-area.ts`:**
   - Exportiert `useBottomSafePadding(extra = 16): number` -> `Math.max(insets.bottom, 16) + extra` und `useSafeAreaInsets` (Wrapper um `react-native-safe-area-context`).
   - Hinweis: Modals erhalten ihre Insets immer per Hook aus der Elternkomponente (unterhalb `<SafeAreaProvider>`), niemals blind aus einem `<SafeAreaView>` innerhalb eines `<Modal>`.
2. **`mobile/src/screens/BookDetailScreen.tsx`:**
   - `insets = useSafeAreaInsets()` verwenden.
   - Haupt-`ScrollView` (`contentContainerStyle`, Zeile 247): `[styles.content, { paddingBottom: Math.max(insets.bottom, 16) + 24 }]`.
   - Bearbeiten-`<Modal>` (Zeilen 502–542): Inneres `<SafeAreaView>` durch `<View>` mit `paddingTop: insets.top` ersetzen und `modalScroll` (`contentContainerStyle`, Zeile 528) mit `{ paddingBottom: Math.max(insets.bottom, 16) + 24 }` versehen.
3. **`mobile/src/screens/LibraryScreen.tsx`:**
   - `insets = useSafeAreaInsets()` verwenden.
   - **Filter-`<Modal>` (`filterSheet` & `filterFooter`):** `filterSheet` (oder `filterFooter`, Zeilen 884–907) erhält dynamisch `paddingBottom: Math.max(insets.bottom, 12)` zusätzlich zum normalen Padding sowie `maxHeight: '85%'`, sodass *„Leeren“* und *„Anwenden“* immer komplett frei über der Navigationsleiste liegen. `<Modal>` zusätzlich prüfen bzgl. `statusBarTranslucent` / Backdrop-Positionierung.
   - **Sortier-`<Modal>` (`modalSheet`, Zeile 607):** Dynamisches `marginBottom: Math.max(insets.bottom, 16) + 12` setzen.
4. **`mobile/src/components/SyncStatusBadge.tsx`:**
   - `insets = useSafeAreaInsets()` in `SyncStatusBadge` lesen.
   - `styles.sheet` (Zeile 227) mit `{ paddingBottom: Math.max(insets.bottom, 16) + 12 }` ergänzen, damit *„Server & Konto in Einstellungen öffnen“* sowie der Re-Login-Button vollständig sichtbar sind.
5. **Präventive Absicherung weiterer Modals & Tabs:**
   - **`mobile/src/components/UpdateModal.tsx`:** `insets = useSafeAreaInsets()` an `styles.footer` (`paddingBottom: Math.max(insets.bottom, 16) + 12`) übergeben.
   - **`mobile/src/components/BarcodeScanner.tsx`:** `insets = useSafeAreaInsets()` auf Top-Header (`paddingTop: insets.top + 12`) und Overlay/Permission-Box (`paddingBottom: Math.max(insets.bottom, 16)`) anwenden statt nur `<SafeAreaView>` im `<Modal>`.
   - **`mobile/src/App.tsx`:** Prüfen, dass `MainTabs` (`tabBarStyle`, Zeilen 37–40) weiterhin keine fixe `height` erzwingt und die Bottom-Tab-Bar über `@react-navigation/bottom-tabs` die `SafeAreaProvider`-Insets korrekt einhält. Ebenso `AddBookScreen.tsx` und `SettingsScreen.tsx` stichprobenartig auf untere Button-Abstände prüfen.

### Akzeptanzkriterien (#1)
- Auf Android sowohl mit **3-Button-Navigationsleiste** als auch mit **Gestennavigation** gilt:
  - In `BookDetailScreen` sind *„Metadaten bearbeiten“* und *„Entfernen“* komplett sichtbar und antippbar.
  - Im Filter-Sheet der Bibliothek sind *„Leeren“* und *„Anwenden“* komplett sichtbar und antippbar.
  - Im Sync-Status-Modal (Tipp auf oberes Sync-Badge) ist *„Server & Konto in Einstellungen öffnen“* komplett sichtbar und antippbar.
  - Bearbeiten-Modal, Sortier-Modal, `UpdateModal` und `BarcodeScanner` weisen am oberen/unteren Rand keine Überlappung mit Status- oder Navigationsleiste auf.

---

## 3. Issue #5 — App: Empfehlungen „Neu laden“-Button funktioniert nicht

**GitHub-Issue:** `michpese/Bibliolisa#5`

### Problem & Ursache (im Code verifiziert)
- In `mobile/src/screens/RecommendationsScreen.tsx` (Zeilen 92–163):
  - Der Button oben rechts (Zeilen 154–162) ruft lediglich `onPress={() => void compute()}` auf.
  - `compute()` liest mit unverändertem `seed` (anfangs `undefined`, was innerhalb von `generateRecommendations()` einen festen Tages-Seed `Math.floor(now.getTime() / 86_400_000)` verwendet). Ohne Datenänderung liefert ein Klick exakt dasselbe Ergebnis zurück.
  - Zudem hat der Button kein `pressed`-Feedback, keinen Lade-State (`refreshing` / `ActivityIndicator`), keinen Sync-Abgleich bei bestehender Verbindung und kein Feedback-Banner/Toast.

### Konkrete Änderungen (`mobile/src/screens/RecommendationsScreen.tsx`)
1. **Sync-Kontext & Reload-States einbinden:**
   - `useSyncContext()` importieren (`{ snapshot: syncSnapshot, syncNow }`).
   - Neue States ergänzen: `refreshing: boolean`, `lastReloadedAt: Date | null`, `feedbackText: string | null`.
2. **`compute` um optionalen `overrideSeed` erweitern:**
   - `compute(overrideSeed?: number)` verwendet `const effectiveSeed = overrideSeed ?? seed`, sodass der neue Zufalls-Seed direkt im selben Durchlauf wirkt und nicht erst auf das nächste React-Re-Render warten muss.
3. **Robuste `handleReload()`-Funktion implementieren:**
   - Mehrfachtipp während laufender Berechnung über `if (refreshing) return;` blockieren.
   - Startzeit messen, `setRefreshing(true)` setzen.
   - Wenn `syncSnapshot.isConfigured && syncSnapshot.isAuthenticated`: vor der Neuberechnung optional `await syncNow('pull_to_refresh')` anstoßen (dank `1,5 s` `/api/health`-Pre-Check hängt dies offline nicht).
   - Neuen Zufalls-Seed erzeugen (`let nextSeed = Math.floor(Math.random() * 1_000_000_000); if (nextSeed === seed) nextSeed += 1;`), `setSeed(nextSeed)` und `await compute(nextSeed)` ausführen.
   - Mindestens `300 ms` Ladeanzeige sicherstellen, damit der Benutzer visuell erkennt, dass neu geladen wurde; danach `setLastReloadedAt(new Date())` und ein für ~2,5 s sichtbares Status-Feedback setzen (z. B. *„Empfehlungen neu ausgewertet (HH:MM:SS)“*).
   - Timer sauber per `useRef` + `useEffect`-Cleanup abräumen.
4. **Refresh-Button & Pull-to-Refresh aufwerten:**
   - Refresh-Button (Zeilen 154–162):
     - `onPress={() => void handleReload()}`, `disabled={refreshing}`, `hitSlop={8}`, `accessibilityRole="button"`, `accessibilityLabel="Empfehlungen neu laden"`.
     - `style={({ pressed }) => [styles.refreshBtn, { backgroundColor: theme.card, borderColor: theme.border, opacity: pressed ? 0.65 : refreshing ? 0.8 : 1 }]}`.
     - Während `refreshing`: `<ActivityIndicator size="small" color={theme.primary} />` anzeigen statt des statischen Refresh-Icons.
   - Am `ScrollView` (Zeile 144) `<RefreshControl refreshing={refreshing} onRefresh={() => void handleReload()} tintColor={theme.primary} />` ergänzen.
   - Unterhalb des Headers bei gesetztem `feedbackText` einen kompakten Feedback-Chip/Hinweis rendern.

### Akzeptanzkriterien (#5)
- Tipp auf den „Neu laden“-Button gibt sofortiges visuelles Drück- und Lade-Feedback (Spinner).
- Die Empfehlungen werden frisch aus der lokalen SQLite-DB (und bei erreichbarem Server nach kurzem Sync) neu ausgewertet – inklusive neuer Zufallsauswahl unter „Überrasch mich“.
- Nach Abschluss erscheint eine sichtbare Rückmeldung („Empfehlungen aktualisiert“), auch im reinen Offline-Modus.

---

## 4. Issue #3 — Webapp: Webseite aktualisiert immer zum Anfang & verliert Filter/Sortierung

**GitHub-Issue:** `michpese/Bibliolisa#3` (inkl. Kommentar von *ElisaPesel* zu Sortierung & beliebigen Filtern)

### Problem & Ursache (im Code verifiziert)
- `web/src/pages/LibraryPage.tsx` hält alle Status-, Filter-, Such- und Sortierparameter bereits sauber in URL-Search-Params (`useSearchParams()`: `q`, `status`, `genre`, `author`, `series`, `minRating`, `sort`, `order`).
- Beim Zurückwechseln aus der Buchdetailseite gehen dennoch sowohl Zustand als auch Scroll-Position aus zwei Gründen verloren:
  1. `web/src/pages/BookDetailPage.tsx` verweist beim *„<- Bibliothek“*-Button (Zeile 149), beim Not-Found-Button (Zeile 95) und im `navigate('/', { replace: true })` nach dem Löschen (Zeile 130) hart auf `/` ohne Query-Parameter. Dadurch werden Status-Auswahl (*Ungelesen*, *Lese ich gerade*, *Gelesen*, *Abgebrochen*), alle weiteren Filter und die gewählte Sortierung verworfen.
  2. `web/src/main.tsx` nutzt `<BrowserRouter>` ohne eigene Scroll-Positionsspeicherung für `LibraryPage`. Nach Navigation auf `/books/:id` und zurück startet `LibraryPage` wieder bei `scrollY = 0`.

### Konkrete Änderungen
1. **Neue Hilfsdatei `web/src/lib/libraryNavigation.ts`:**
   - Hält (im Arbeitsspeicher plus `sessionStorage`-Fallback für das aktuelle Tab) die letzte Bibliotheks-Query (`lastLibrarySearch`) sowie eine Map von Scroll-Positionen pro Query-String (`scrollBySearch: Record<string, number>`).
   - Exportierte Funktionen:
     - `saveLibrarySearch(search: string): void`
     - `getLastLibraryUrl(): string` (liefert `/${search}` oder `/`)
     - `saveLibraryScroll(search: string, scrollY: number): void`
     - `getSavedLibraryScroll(search: string): number | null`
   - Kapselt `sessionStorage`-Zugriffe sicher in `try/catch`.
2. **`web/src/components/BookCard.tsx` & `web/src/components/SeriesCard.tsx`:**
   - In `BookCard`, `BookRow` (`BookCard.tsx` Zeilen 26, 67) sowie `VolumeTile` und `SeriesCard` (`SeriesCard.tsx` Zeilen 43, 122) `useLocation()` nutzen und beim `<Link to={`/books/${entry.id}`}>` übergeben:
     `state={location.pathname === '/' ? { fromLibrary: `${location.pathname}${location.search}` } : undefined}`
3. **`web/src/pages/BookDetailPage.tsx`:**
   - `useLocation()` einbinden.
   - Beim Öffnen/Wechseln eines Buchs (`useEffect` auf `[id]`): `window.scrollTo({ top: 0, left: 0, behavior: 'instant' })`, damit die Detailseite selbst immer sauber oben startet.
   - Rückziel bestimmen:
     `const state = location.state as { fromLibrary?: string } | null;`
     `const backToLibrary = state?.fromLibrary ?? getLastLibraryUrl();`
   - Den *„<- Bibliothek“*-Button (Zeilen 148–152), den *„Zur Bibliothek“*-Button bei 404 (Zeilen 94–96) und `navigate(...)` nach dem Löschen (Zeile 130) auf `backToLibrary` mit `state={{ restoreScroll: true }}` umstellen.
   - *Wichtig:* Explizite neue Filter-Links in `BookDetailPage` (`/?series=...` in Zeile 187 und `/?genre=...` in Zeile 243) setzen bewusst **kein** `restoreScroll: true`, damit ein Klick auf ein neues Genre oder eine Reihe oben startet.
   - Vorteil des `getLastLibraryUrl()`-Fallbacks: Auch wenn man auf `BookDetailPage` in der Sektion *„Weitere Bände der Reihe“* noch zu Band 2 weiterklickt und erst dort *„<- Bibliothek“* drückt, bleiben die ursprünglichen Bibliotheks-Filter erhalten.
4. **`web/src/pages/LibraryPage.tsx`:**
   - `useLocation()` und `useNavigationType()` einbinden.
   - Aktuelle URL-Query über `useEffect(() => { saveLibrarySearch(location.search); }, [location.search])` sichern.
   - **Laufendes Tracking der Scroll-Position:** Einen passiven `scroll`-Event-Listener auf `window` (mit `requestAnimationFrame`-Throttling) registrieren, der `lastKnownScrollYRef.current = window.scrollY` aktualisiert und `saveLibraryScroll(location.search, window.scrollY)` speichert. *(Entscheidend: Nicht erst beim Unmount `window.scrollY` auslesen, da dieser Wert je nach Browser-Timing bereits zurückgesetzt sein kann.)*
   - **Scroll-Wiederherstellung:** Wenn `navigationType === 'POP'` (Browser-Zurück) **oder** `(location.state as { restoreScroll?: boolean } | null)?.restoreScroll === true`:
     - Sobald `!library.isLoading && library.data !== undefined`, stellt ein `useLayoutEffect` (mit einmaligem Guard per `location.key`, sodass anschließendes Filtern/Sortieren durch den Nutzer nicht zurückspringt) über `requestAnimationFrame` `window.scrollTo({ top: savedY, left: 0, behavior: 'instant' })` wieder her.
   - Prüfen, dass beim Zurückkehren mit `?q=suchwort` der `debouncedQ`-Effect (Zeilen 109–115) `urlQ` beim Mount nicht durch ein veraltetes State-Timing löscht (da `searchText` bereits mit `urlQ` initialisiert wird).
5. **Unit-Test ergänzen (falls möglich / sinnvoll):**
   - `web/src/lib/libraryNavigation.ts` als reines Modul ohne DOM-Abhängigkeit testen oder sauber in Typecheck/Build absichern.

### Akzeptanzkriterien (#3)
1. **Scroll -> Buch öffnen -> `<- Bibliothek`:** Die Bibliothek erscheint wieder exakt an der vorherigen Scroll-Position (kein Sprung an den Seitenanfang).
2. **Status-Tab (*Ungelesen*, *Lese ich gerade*, *Gelesen*, *Abgebrochen*) + Scroll -> Buch öffnen -> `<- Bibliothek`:** Der gewählte Status bleibt aktiv, die Liste ist weiterhin danach gefiltert und steht an derselben Scroll-Position.
3. **Sortierung + beliebige Filter (Genre, Autor, Reihe, Mindestbewertung, Suche) -> Buch öffnen -> `<- Bibliothek`:** Alle Sortier- und Filterkriterien sowie die Scroll-Position bleiben vollständig erhalten.
4. **Browser-Zurück-Button:** Verhält sich identisch konsistent zur `<- Bibliothek`-Schaltfläche.

---

## 5. Verifikation vor Abschluss

Nach Umsetzung aller 4 Bugs im neuen Chat müssen gemäß `.antigravity/rules.md` alle betroffenen Workspaces geprüft und gebaut werden:

```bash
pnpm --filter @bibliolisa/mobile typecheck
pnpm --filter @bibliolisa/mobile test
pnpm --filter @bibliolisa/mobile export:android

pnpm --filter @bibliolisa/web typecheck
pnpm --filter @bibliolisa/web build
```

*(Falls das Repo auch für Docker gebaut wird, optional `pnpm --filter @bibliolisa/server test` / `docker build` gegenprüfen.)*

---

## Fertiger Start-Prompt für den neuen Bug-Chat

```text
Beachte alle Regeln in `.antigravity/rules.md`.

Setze den vollständigen Bugfix-Plan aus `docs/PLAN_BUGS.md` (GitHub-Issues #4, #1, #5 und #3) Schritt für Schritt um.

Arbeitsweise:
1. Lies zuerst `docs/PLAN_BUGS.md` vollständig und arbeite die 4 Issues in der dort festgelegten Reihenfolge (#4 -> #1 -> #5 -> #3) sauber ab.
2. Halte dich strikt an die identifizierten Dateien, Safe-Area-Hinweise für Android-Modals (`useSafeAreaInsets` aus der Elternkomponente unter `<SafeAreaProvider>`) und die Scroll-/URL-Wiederherstellungslogik in der Webapp.
3. Führe nach Abschluss aller Änderungen für `@bibliolisa/mobile` (`typecheck`, `test`, `export:android`) und `@bibliolisa/web` (`typecheck`, `build`) vollständig aus und stelle sicher, dass alle Checks grün sind.
4. Fasse zum Schluss die geänderten Dateien, die Verifikationsergebnisse und eventuelle manuelle Prüfpunkte (z. B. Android 3-Button-Navigation) kurz und präzise zusammen.
```
