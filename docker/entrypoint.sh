#!/bin/sh
# Bibliolisa Container-Entrypoint
#
# - Standardfall: Container läuft als Non-Root (UID 10001). Das Datenverzeichnis muss für diese UID
#   beschreibbar sein. Ist es das nicht (typisch bei Bind-Mounts, die Docker als root angelegt hat),
#   bricht der Start mit einer klaren Anleitung ab, statt später mit SQLITE_CANTOPEN zu scheitern.
# - Optional: Wird der Container explizit als root gestartet (`user: "0:0"`), korrigiert dieses Skript
#   die Besitzrechte von DATA_DIR und startet den Server danach per setpriv als UID/GID 10001.
set -eu

APP_UID="${APP_UID:-10001}"
APP_GID="${APP_GID:-10001}"
DATA_DIR="${DATA_DIR:-/data}"

if [ "$(id -u)" = "0" ]; then
  mkdir -p "$DATA_DIR/covers"
  chown -R "$APP_UID:$APP_GID" "$DATA_DIR"
  exec setpriv --reuid="$APP_UID" --regid="$APP_GID" --clear-groups "$@"
fi

mkdir -p "$DATA_DIR/covers" 2>/dev/null || true

probe="$DATA_DIR/.write-test.$$"
if ! (touch "$probe" && rm -f "$probe") 2>/dev/null; then
  echo "FEHLER: DATA_DIR '$DATA_DIR' ist für UID $(id -u) nicht beschreibbar." >&2
  echo "        Lösung (Host): sudo chown -R $APP_UID:$APP_GID <host-data-verzeichnis>" >&2
  echo "        oder Container einmalig mit 'user: \"0:0\"' starten (Entrypoint korrigiert die Rechte)." >&2
  exit 1
fi

if [ ! -w "$DATA_DIR/covers" ]; then
  echo "FEHLER: '$DATA_DIR/covers' ist nicht beschreibbar (Besitzer: $(stat -c '%u:%g' "$DATA_DIR/covers" 2>/dev/null || echo '?'))." >&2
  echo "        Lösung (Host): sudo chown -R $APP_UID:$APP_GID <host-data-verzeichnis>" >&2
  exit 1
fi

exec "$@"
