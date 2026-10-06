<p align="center">
  <img src="icons/icon-96.png" width="80" height="80" alt="PAYBACK Coupon Activation">
</p>

# PAYBACK Coupon Activation

**PAYBACK-Coupons gesammelt aktivieren – mit einem Klick und übersichtlichem Live-Fortschritt.**

Diese Firefox-Erweiterung erkennt offene Coupons auf der PAYBACK-Couponseite und aktiviert sie automatisch in kleinen Batches. Sie nutzt deine bestehende Anmeldung im Browser und zeigt dir während des Laufs, wie viele Coupons bereits aktiviert sind, noch offen sind oder nicht bestätigt werden konnten.

**[Für Firefox installieren](https://addons.mozilla.org/de/firefox/addon/payback-coupon-activation/)** · [PAYBACK-Couponseite öffnen](https://www.payback.de/coupons)

## Funktionen

- **Gesammelt aktivieren:** Verarbeitet bis zu fünf Coupons gleichzeitig mit kurzem Abstand zwischen den Klicks und prüft das Ergebnis für jeden Coupon einzeln.
- **Nachgeladene Coupons finden:** Scrollt automatisch durch die Seite, um weitere Coupon-Karten zu erfassen. Auch gleichartige Coupons werden als getrennte Angebote behandelt.
- **Fortschritt live verfolgen:** Zeigt einen Fortschrittsbalken sowie Zähler für aktivierte, offene und neu aktivierte Coupons und Fehler. Während des Laufs sind außerdem verarbeitete, erfolgreiche und nicht bestätigte Aktivierungen sichtbar.
- **Teilnahme-Angebote erkennen:** Unterstützt neben „Jetzt aktivieren“ und „Aktivieren“ auch „Jetzt teilnehmen“ und „Teilnehmen“, sofern diese im Coupon-Kontext stehen.
- **Code-Angebote berücksichtigen:** Öffnet „Zur Code-Eingabe“ einmal pro Angebot und Seitenaufruf. Die Eingabe des Codes bleibt manuell; das Öffnen zählt nicht als erfolgreiche Aktivierung.
- **Automatisch abschließen:** Beendet den Lauf, sobald keine offenen Aktivierungen mehr erkannt werden. Ein Lauf lässt sich über „Stoppen“ abbrechen und hat eine Zeitgrenze von vier Minuten.
- **Seitenzähler aktualisieren:** Lädt die Seite 1,5 Sekunden nach einem fehlerfreien Abschluss automatisch ohne Cache neu. Bei Abbruch, Fehlern oder ohne erkannte Angebote erfolgt kein automatisches Neuladen.

## Installation

### Über Mozilla Add-ons

1. Öffne [PAYBACK Coupon Activation auf Mozilla Add-ons](https://addons.mozilla.org/de/firefox/addon/payback-coupon-activation/).
2. Füge die Erweiterung zu Firefox hinzu und bestätige die angezeigten Berechtigungen.

Die Mindestversionen des Quellstands in diesem Repository sind **Firefox 140** auf dem Desktop und **Firefox 142** auf Android. Die auf Mozilla Add-ons angebotene Version kann vom Quellstand abweichen.

### Lokal zum Entwickeln oder Testen

1. Lade das Repository herunter und entpacke es oder klone es auf deinen Rechner.
2. Öffne in Firefox auf dem Desktop `about:debugging#/runtime/this-firefox`.
3. Wähle **„Temporäres Add-on laden…“** und öffne die Datei `manifest.json` im Projektordner.

Die temporäre Installation gilt bis zum nächsten Firefox-Neustart. Für eine dauerhafte Installation verwende die Version von Mozilla Add-ons. Die Datei mit der Endung `-unsigned.xpi` im Ordner `dist/` ist ein unsigniertes Paket.

## Verwendung

1. Öffne die [PAYBACK-Couponseite](https://www.payback.de/coupons) und melde dich bei PAYBACK an.
2. Lass den PAYBACK-Tab geöffnet und klicke auf das Symbol der Erweiterung.
3. Klicke auf **„Coupons aktivieren“**. Die Erweiterung durchsucht die Seite und startet die Aktivierung.
4. Verfolge den Fortschritt im Popup. Mit **„Stoppen“** kannst du den laufenden Vorgang abbrechen.
5. Nach einem fehlerfreien Abschluss wird die Seite automatisch neu geladen, damit auch PAYBACKs eigene Zähler aktualisiert werden.

Über **„Zur PAYBACK-Couponseite“** im Popup kannst du die Coupon-Übersicht direkt in einem neuen Tab öffnen.

Ein Lauf startet nur durch deinen Klick. Auch nach dem automatischen Neuladen beginnt keine neue Aktivierung von selbst. Mit **„Erneut prüfen“** kannst du einen weiteren Lauf anstoßen.

### Angebote mit Code-Eingabe

Bei Angeboten mit **„Zur Code-Eingabe“** öffnet die Erweiterung die Eingabe einmal. Du musst den benötigten Code selbst eingeben. Diese Angebote werden vom automatischen Aktivierungsziel abgezogen und im Abschlussstatus separat genannt. Bis zum Neuladen wird dieselbe Code-Eingabe auch bei einem erneuten Lauf nicht nochmals geöffnet.

## Datenschutz und Berechtigungen

Die Erweiterung arbeitet innerhalb der PAYBACK-Webseite und nutzt deine bestehende Browser-Sitzung. Sie liest oder speichert keine Zugangsdaten, enthält kein Tracking und sendet keine persönlichen Daten an externe Dienste. Die Aktivierung selbst erfolgt über die PAYBACK-Webseite.

Die Berechtigungen sind in [`manifest.json`](manifest.json) festgelegt:

| Berechtigung | Zweck |
| --- | --- |
| Zugriff auf `https://www.payback.de/*` und `https://payback.de/*` | Coupon-Karten und Status auf PAYBACK lesen sowie die Aktivierungsbuttons betätigen. |
| `scripting` | Das Inhaltsskript bei Bedarf in den geöffneten PAYBACK-Tab laden, wenn es dort noch nicht erreichbar ist. |

Das Manifest deklariert ausdrücklich, dass keine Datenerhebung erforderlich ist (`data_collection_permissions.required: ["none"]`).

## Häufige Fragen

### Warum ändern sich PAYBACKs Zähler während des Laufs nicht?

PAYBACK aktualisiert seine Zähler teilweise erst nach einem Neuladen. Die Erweiterung verwendet deshalb die beim Start erkannten Werte als Ausgangsbasis und berechnet ihren Fortschritt selbst. Nach einem fehlerfreien Abschluss aktualisiert das automatische Neuladen die Webseite.

### Das Popup meldet „PAYBACK ist nicht geöffnet“.

Wechsle zur PAYBACK-Couponseite und öffne das Popup dort erneut. Die Erweiterung bezieht sich auf den aktuell ausgewählten Tab.

### Eine Aktivierung wurde nicht bestätigt oder die Verbindung ist fehlgeschlagen.

Prüfe, ob du noch angemeldet bist und die Couponseite vollständig geladen ist. Lade den PAYBACK-Tab neu und starte anschließend erneut. Falls das automatische Neuladen fehlschlägt, kannst du die Seite auf dem Desktop mit **Strg + F5** manuell neu laden.

Die Erkennung hängt von der Struktur und den Beschriftungen der PAYBACK-Webseite ab. Änderungen an der Webseite können Anpassungen an der Erweiterung erforderlich machen.

## Entwicklung

Die Erweiterung verwendet **JavaScript, HTML und CSS** mit **WebExtension Manifest V3**. Es gibt keinen Build-Schritt, keinen Bundler und keine Minifizierung. Die Erweiterungsdateien können direkt als temporäres Add-on geladen werden.

### Projektstruktur

```text
.
├── manifest.json       # Metadaten, Berechtigungen und Skriptregistrierung
├── content.js          # Coupon-Erkennung, Aktivierung und Fortschrittsanzeige
├── background.js       # Symbol-Badge und kontrolliertes Neuladen des Tabs
├── popup.html          # Oberfläche der Erweiterung
├── popup.css           # Gestaltung des Popups
├── popup.js            # Popup-Steuerung und Kommunikation mit dem Tab
├── icons/              # Erweiterungssymbole
├── tests/              # Automatisierte Tests mit Node.js
└── dist/               # Gepackte Erweiterung
```

### Tests ausführen

Die Tests verwenden den integrierten Test-Runner von Node.js und benötigen keine zusätzlichen npm-Pakete. Führe im Projektordner aus:

```sh
node --test tests/background.test.cjs tests/content.test.cjs tests/popup.test.cjs
```

Die Tests simulieren unter anderem unveränderte PAYBACK-Zähler, nachgeladene Coupons und Code-Angebote, fehlgeschlagene Aktivierungen, Abbrüche und das automatische Neuladen. Sie prüfen außerdem die Kommunikation zwischen Popup, Inhaltsskript und Hintergrundskript. Ein Test auf der echten PAYBACK-Webseite bleibt für Änderungen an der Coupon-Erkennung sinnvoll.

### Fehler melden und beitragen

Beschreibe bei einer Fehlermeldung deine Firefox-Version, die Version der Erweiterung, die angezeigte Statusmeldung und die Schritte, mit denen sich das Problem nachstellen lässt. Screenshots können helfen; entferne vorher persönliche Angaben wie Name oder Kundennummer.

Verbesserungen und Fehlerkorrekturen sind willkommen. Prüfe Änderungen mit den automatisierten Tests und, sofern sie die Webseite betreffen, zusätzlich mit dem temporär geladenen Add-on.

---

PAYBACK Coupon Activation ist eine inoffizielle Erweiterung und steht in keiner Verbindung zu PAYBACK oder der PAYBACK GROUP.
