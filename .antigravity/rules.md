\# Projekt-Regeln: Self-Hosted Bücher-Index



\## Architektur \& Stack

\- Monorepo-Struktur: `/shared`, `/server`, `/web`, `/mobile`, `/docs`.

\- Geteilte Typen, Zod-Schemas und Sync-Contracts gehören zwingend nach `/shared` – keine duplizierten DTOs.

\- Backend: Node.js, TypeScript, Fastify, SQLite (WAL-Mode) mit Drizzle ORM.

\- Webapp: React, Vite, TypeScript, Tailwind CSS, shadcn/ui.

\- Mobile (Android): React Native (Expo, TypeScript), `expo-sqlite`, `expo-secure-store`, `expo-camera`.



\## Unveränderliche Sync- \& Datenmodell-Regeln

\- Strikt getrenntes Datenmodell: globale `books`-Tabelle (Metadaten/Cover) und nutzerspezifische `user\_books`-Tabelle (`user\_id`, `book\_id`, Status, Rating, Notizen).

\- Jeder Benutzer hat strikt 1 eigenen Index; Queries auf `user\_books` MÜSSEN immer nach `user\_id` filtern.

\- Alle synchronisierbaren Entitäten nutzen client-generierte UUIDv4-IDs (keine Auto-Increment-IDs).

\- Keine Hard Deletes bei synchronisierten Tabellen: Immer Soft Deletes via `deleted\_at` (ISO-UTC-Timestamp).

\- Delta-Sync nutzt `updated\_at` (UTC) und Last-Write-Wins (LWW) pro Datensatz.

\- Alle API-Routen außer `/api/health` und Auth-Login/Register sind strikt authentifiziert.



\## Docker \& Reverse Proxy

\- Webapp und Backend werden als EIN Docker-Container (Multi-Stage-Build) ausgeliefert: API unter `/api/\*`, statische Webapp unter `/`.

\- Ein Reverse Proxy existiert bereits auf dem Host: keinen eigenen Proxy bündeln, nicht an Port 80/443 binden.

\- Fastify muss mit `trustProxy: true` konfiguriert sein und `X-Forwarded-\*`-Header respektieren.

\- Alle persistenten Daten (SQLite-DB + gecachte Buchcover) liegen ausschließlich unter `DATA\_DIR` (Standard `/data`).



\## Arbeitsweise

\- `docs/ARCHITECTURE.md` und `docs/ROADMAP.md` sind die Single Source of Truth.

\- Nach jeder abgeschlossenen Phase: Tests und Build ausführen, `docs/ROADMAP.md` aktualisieren und Abweichungen dokumentieren.

\- Keine Secrets, Tokens oder echte LAN-IPs hart in den Code schreiben (immer `.env` / App-Settings).

