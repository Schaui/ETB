# Einsatztagebuch – FGr Wasserschäden/Pumpen

Handy-App (Progressive Web App) zum Führen eines Einsatztagebuchs für Trupps der
Fachgruppe Wasserschäden/Pumpen. Läuft komplett **offline**, die Daten bleiben
**auf dem Gerät**, am Ende wird als **PDF, CSV oder JSON** exportiert.

## Funktionen

- **Einsätze** anlegen mit Kopfdaten (Stichwort, Nr., Ort, anfordernde Stelle,
  Unterstellung, Einheit, Truppführer, Stärke, Fahrzeuge)
- **Tagebuch** mit laufender Nummer, Zeitpunkt, Kategorie, Von/An, Text und Fotos
  - Status-Schnelltasten (Alarmierung, Abmarsch, Eintreffen, Einsatzbereit, Abrücken …)
  - Einträge werden **nicht gelöscht**, sondern mit Begründung **storniert**
    (bleiben durchgestrichen sichtbar)
  - Nachträge (Zeitpunkt > 5 min vor Erfassung) werden automatisch gekennzeichnet
- **Pumpenprotokoll**: Pumpen an/aus per Tastendruck, Betriebszeit und
  rechnerische Fördermenge (Nennleistung × Laufzeit)
- **Personal**: An-/Abmeldung, Einsatzstunden je Helfer und gesamt
- **Einsatz abschließen**: laufende Pumpen und Personal werden auf Wunsch automatisch beendet
- **Export**
  - PDF (Kopfdaten, alle Einträge inkl. Stornos, Pumpenprotokoll, Einsatzstunden,
    Unterschriftsfeld, Fotoanlage)
  - CSV für Excel/LibreOffice
  - JSON als vollständige Sicherung, auf anderem Gerät wieder einlesbar
  - „Teilen …“ öffnet das Teilen-Menü des Handys (Mail, Messenger, Cloud, Drucken)
- **Einstellungen**: eigener Name, Einheit, Standard-Pumpen und Standard-Trupp

## Bereitstellen (GitHub Pages)

Die App besteht nur aus statischen Dateien, ein Server-Backend ist nicht nötig.

1. Repository auf GitHub → **Settings → Pages**
2. *Source*: „Deploy from a branch“, Branch wählen (z. B. `main`), Ordner `/ (root)` → Save
3. Nach ca. 1 Minute ist die App unter `https://<benutzer>.github.io/<repo>/` erreichbar

## Auf dem Handy installieren

- **Android (Chrome):** Seite öffnen → Menü ⋮ → „App installieren“
- **iPhone (Safari):** Seite öffnen → Teilen-Symbol → „Zum Home-Bildschirm“

Nach dem ersten Öffnen funktioniert die App auch ohne Netz.

## Wichtig zur Datenhaltung

- Alle Daten liegen im Browser-Speicher des Geräts (IndexedDB). Es wird nichts
  an einen Server übertragen.
- Wird die App bzw. der Browser-Speicher gelöscht, sind die Daten weg.
  **Nach jedem Einsatz PDF und JSON exportieren.**
- Unter iOS ist der Speicher von Web-Apps an die installierte Home-Bildschirm-App
  gebunden – immer über das App-Symbol öffnen, nicht abwechselnd über Safari.

## Updates

Bei Änderungen an den Dateien in `sw.js` die `CACHE`-Version erhöhen, damit die
Geräte die neue Version laden.

## Lizenzen

Verwendet [jsPDF](https://github.com/parallax/jsPDF) und
[jspdf-autotable](https://github.com/simonbengtsson/jsPDF-AutoTable) (MIT, siehe `vendor/`).
