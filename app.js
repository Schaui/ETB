/* Einsatztagebuch – FGr Wasserschäden/Pumpen
 * Offline-PWA, Daten in IndexedDB auf dem Gerät. Export als PDF, CSV und JSON.
 */
'use strict';

const APP_VERSION = '1.1.0';

/* ---------- Hilfsfunktionen ---------- */
const $ = (s, r = document) => r.querySelector(s);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const uid = () => (crypto.randomUUID ? crypto.randomUUID() : Date.now().toString(36) + Math.random().toString(36).slice(2));
const pad = (n) => String(n).padStart(2, '0');
const fmtD = (ms) => { const d = new Date(ms); return `${pad(d.getDate())}.${pad(d.getMonth() + 1)}.${d.getFullYear()}`; };
const fmtT = (ms) => { const d = new Date(ms); return `${pad(d.getHours())}:${pad(d.getMinutes())}`; };
const fmtDT = (ms) => (ms ? `${fmtD(ms)} ${fmtT(ms)}` : '–');
const toInput = (ms) => { const d = new Date(ms); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`; };
const fromInput = (s) => (s ? new Date(s).getTime() : null);
const fmtDur = (min) => { const t = Math.max(0, Math.round(min)); return `${Math.floor(t / 60)}:${pad(t % 60)} h`; };
const fmtNum = (n, d = 0) => Number(n).toLocaleString('de-DE', { minimumFractionDigits: d, maximumFractionDigits: d });
const slug = (s) => String(s || 'Einsatz').normalize('NFKD').replace(/[̀-ͯ]/g, '').replace(/[^A-Za-z0-9]+/g, '_').replace(/^_|_$/g, '').slice(0, 40) || 'Einsatz';
const fileStamp = (ms = Date.now()) => { const d = new Date(ms); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}_${pad(d.getHours())}${pad(d.getMinutes())}`; };

function toast(msg) {
  const t = $('#toast');
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(toast._t);
  toast._t = setTimeout(() => t.classList.remove('show'), 2600);
}

/* ---------- Datenbank (IndexedDB) ---------- */
const DB = (() => {
  let dbp;
  function open() {
    if (!dbp) {
      dbp = new Promise((res, rej) => {
        const r = indexedDB.open('etb-thw', 1);
        r.onupgradeneeded = () => {
          const db = r.result;
          db.createObjectStore('einsaetze', { keyPath: 'id' });
          const s = db.createObjectStore('eintraege', { keyPath: 'id' });
          s.createIndex('einsatzId', 'einsatzId');
          db.createObjectStore('meta', { keyPath: 'key' });
        };
        r.onsuccess = () => res(r.result);
        r.onerror = () => rej(r.error);
      });
    }
    return dbp;
  }
  async function tx(stores, mode, fn) {
    const db = await open();
    return new Promise((res, rej) => {
      const t = db.transaction(stores, mode);
      let out;
      const r = fn(t);
      if (r) r.onsuccess = () => { out = r.result; };
      t.oncomplete = () => res(out);
      t.onerror = () => rej(t.error);
      t.onabort = () => rej(t.error || new Error('Transaktion abgebrochen'));
    });
  }
  return {
    get: (st, k) => tx(st, 'readonly', (t) => t.objectStore(st).get(k)),
    put: (st, v) => tx(st, 'readwrite', (t) => t.objectStore(st).put(v)),
    all: (st) => tx(st, 'readonly', (t) => t.objectStore(st).getAll()),
    byEinsatz: (id) => tx('eintraege', 'readonly', (t) => t.objectStore('eintraege').index('einsatzId').getAll(id)),
    /* Einsatz + Eintrag gemeinsam speichern (atomar) */
    putBoth: (einsatz, eintraege) => tx(['einsaetze', 'eintraege'], 'readwrite', (t) => {
      t.objectStore('einsaetze').put(einsatz);
      for (const e of eintraege) t.objectStore('eintraege').put(e);
    }),
    deleteEinsatz: (id, entryIds) => tx(['einsaetze', 'eintraege'], 'readwrite', (t) => {
      t.objectStore('einsaetze').delete(id);
      for (const k of entryIds) t.objectStore('eintraege').delete(k);
    }),
  };
})();

/* ---------- Stammdaten ---------- */
const KATS = ['Status', 'Lage', 'Auftrag', 'Meldung', 'Funk/Telefon', 'Maßnahme', 'Pumpe', 'Messung/Pegel', 'Personal', 'Material/Fahrzeug', 'Verpflegung', 'Unfall/Schaden', 'Sonstiges'];
const STATI = ['Alarmierung', 'Abmarsch Unterkunft', 'Eintreffen Einsatzstelle', 'Einsatzbereit', 'Abrücken Einsatzstelle', 'Eintreffen Unterkunft', 'Wieder einsatzbereit'];
const SCHNELL = [
  { label: 'Lagemeldung', kat: 'Lage', text: 'Lage: ' },
  { label: 'Auftrag erhalten', kat: 'Auftrag', text: 'Auftrag: ' },
  { label: 'Meldung abgesetzt', kat: 'Meldung', text: 'Meldung: ' },
  { label: 'Pegel/Messung', kat: 'Messung/Pegel', text: 'Wasserstand: ' },
  { label: 'Material', kat: 'Material/Fahrzeug', text: '' },
];
const FUNKTIONEN = ['Truppführer/in', 'Helfer/in', 'Kraftfahrer/in', 'Gruppenführer/in', 'Zugführer/in', 'Maschinist/in'];
const DEFAULT_SETTINGS = {
  name: '',
  einheit: 'OV …, TZ, FGr WP (A)',
  pumpen: [],
  helfer: [],
  fahrzeuge: [],
};

const S = { settings: { ...DEFAULT_SETTINGS }, einsatz: null, eintraege: [], tab: 'etb', fotoFilter: null };
let timer = null;
const view = $('#view');

async function loadSettings() {
  const m = await DB.get('meta', 'settings');
  S.settings = { ...DEFAULT_SETTINGS, ...(m ? m.value : {}) };
}
async function saveSettings() {
  await DB.put('meta', { key: 'settings', value: S.settings });
}

/* ---------- Dialog ---------- */
function dialog(title, body, { ok = 'Speichern', okClass = 'primary', cancel = 'Abbrechen', onOpen } = {}) {
  return new Promise((resolve) => {
    const d = $('#dlg');
    d.innerHTML = `<form method="dialog" class="dlg" novalidate>
      <h3>${esc(title)}</h3>
      <div class="dlg-body">${body}</div>
      <div class="dlg-actions">
        ${cancel ? `<button type="button" class="btn" data-cancel>${esc(cancel)}</button>` : ''}
        <button type="submit" class="btn ${okClass}">${esc(ok)}</button>
      </div></form>`;
    const f = d.querySelector('form');
    let done = false;
    const finish = (v) => { if (done) return; done = true; resolve(v); };
    f.addEventListener('submit', (ev) => {
      ev.preventDefault();
      if (!f.checkValidity()) { f.reportValidity(); return; }
      const data = Object.fromEntries(new FormData(f));
      finish({ data, form: f });
      d.close();
    });
    const c = f.querySelector('[data-cancel]');
    if (c) c.addEventListener('click', () => { d.close(); });
    d.onclose = () => finish(null);
    d.showModal();
    if (onOpen) onOpen(f);
  });
}
const confirmDlg = async (title, text, ok = 'OK', okClass = 'primary') => !!(await dialog(title, `<p>${text}</p>`, { ok, okClass }));

/* ---------- Bilder ---------- */
function compressImage(file, max = 1600, q = 0.75) {
  return new Promise((res, rej) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      const s = Math.min(1, max / Math.max(img.naturalWidth, img.naturalHeight));
      const w = Math.round(img.naturalWidth * s);
      const h = Math.round(img.naturalHeight * s);
      const c = document.createElement('canvas');
      c.width = w; c.height = h;
      c.getContext('2d').drawImage(img, 0, 0, w, h);
      URL.revokeObjectURL(url);
      res({ data: c.toDataURL('image/jpeg', q), w, h });
    };
    img.onerror = () => { URL.revokeObjectURL(url); rej(new Error('Bild konnte nicht gelesen werden')); };
    img.src = url;
  });
}

/* ---------- Auswertungen ---------- */
const aktiv = (list) => list.filter((x) => !x.storno);
const sortAsc = (list) => [...list].sort((a, b) => a.zeit - b.zeit || a.lfd - b.lfd);

function pumpStats(p, eintraege, einsatz) {
  const evs = sortAsc(aktiv(eintraege).filter((x) => x.kat === 'Pumpe' && x.pumpeId === p.id));
  let running = null; let total = 0; const laeufe = [];
  for (const ev of evs) {
    if (ev.aktion === 'start' && running == null) running = ev.zeit;
    else if (ev.aktion === 'stop' && running != null) { laeufe.push([running, ev.zeit]); total += ev.zeit - running; running = null; }
  }
  if (running != null) {
    const bis = einsatz.ende || Date.now();
    total += Math.max(0, bis - running);
  }
  const min = total / 60000;
  return { running, laeufe, min, menge: (Number(p.lpm) || 0) * min / 1000 /* m³ */ };
}

function personStunden(p, einsatz) {
  if (!p.kommt) return 0;
  const bis = p.geht || einsatz.ende || Date.now();
  return Math.max(0, (bis - p.kommt) / 60000);
}

/* ---------- Kopfzeile / Navigation ---------- */
function setTop(title, sub = '', back = null) {
  $('#title').textContent = title;
  $('#subtitle').textContent = sub;
  const b = $('#backBtn');
  b.hidden = !back;
  b.onclick = back ? () => { location.hash = back; } : null;
}
function setTabs(id, active) {
  const t = $('#tabs');
  if (!id) { t.hidden = true; t.innerHTML = ''; return; }
  const tabs = [['etb', 'Tagebuch'], ['pumpen', 'Pumpen'], ['personal', 'Personal'], ['daten', 'Einsatz'], ['export', 'Export']];
  t.hidden = false;
  t.innerHTML = tabs.map(([k, l]) => `<a href="#/e/${id}/${k}" class="${k === active ? 'active' : ''}">${l}</a>`).join('');
}
function setFab(fn) {
  const f = $('#fab');
  f.hidden = !fn;
  f.onclick = fn;
}

async function route() {
  clearInterval(timer);
  const d = $('#dlg');
  if (d.open) d.close();
  const h = location.hash.slice(1) || '/';
  const m = h.match(/^\/e\/([^/]+)(?:\/(\w+))?/);
  try {
    if (m) await showEinsatz(m[1], m[2] || 'etb');
    else if (h === '/einstellungen') showSettings();
    else await showHome();
  } catch (err) {
    console.error(err);
    view.innerHTML = `<div class="banner warn">Fehler: ${esc(err.message)}</div>`;
  }
  window.scrollTo(0, 0);
}

/* ---------- Startseite ---------- */
let installEvt = null;
window.addEventListener('beforeinstallprompt', (e) => { e.preventDefault(); installEvt = e; if (!location.hash || location.hash === '#/') showHome(); });

async function showHome() {
  S.einsatz = null;
  setTop('Einsatztagebuch', S.settings.einheit || '');
  setTabs(null);
  setFab(null);
  const list = (await DB.all('einsaetze')).sort((a, b) => b.beginn - a.beginn);
  const standalone = matchMedia('(display-mode: standalone)').matches || navigator.standalone;
  view.innerHTML = `
    ${!S.settings.name ? `<div class="banner info">Tipp: Trage unter <a href="#/einstellungen">⚙ Einstellungen</a> deinen Namen, die Einheit und eure Pumpen ein – dann sind neue Einsätze schneller angelegt.</div>` : ''}
    <button class="btn primary big block" id="newE">+ Neuer Einsatz</button>
    <h2>Einsätze</h2>
    ${list.length ? list.map((e) => `
      <a class="card" href="#/e/${e.id}">
        <div class="row"><strong>${esc(e.bezeichnung)}</strong><span class="badge ${e.ende ? 'done' : 'open'}">${e.ende ? 'abgeschlossen' : 'laufend'}</span></div>
        <div class="muted small">${esc(e.ort || '')}${e.ort ? ' · ' : ''}${fmtDT(e.beginn)}${e.nr ? ' · Nr. ' + esc(e.nr) : ''}</div>
      </a>`).join('') : '<div class="card empty">Noch keine Einsätze angelegt.</div>'}
    <h2>Datensicherung</h2>
    <div class="card stack">
      <div class="btns">
        <button class="btn" id="backupAll">Alle Einsätze sichern</button>
        <label class="btn filebtn">Sicherung einlesen<input type="file" id="importFile" accept=".json,application/json"></label>
      </div>
      <div class="muted small">Alle Daten liegen nur auf diesem Gerät. Sichere abgeschlossene Einsätze regelmäßig (Export → JSON) – z. B. per Messenger/E-Mail an dich selbst oder in die Cloud.</div>
    </div>
    ${!standalone ? `<h2>Als App installieren</h2>
    <div class="card small stack">
      ${installEvt ? '<button class="btn primary block" id="installBtn">Auf Startbildschirm installieren</button>' : ''}
      <div class="muted"><b>Android/Chrome:</b> Menü ⋮ → „App installieren“ bzw. „Zum Startbildschirm hinzufügen“.<br><b>iPhone/Safari:</b> Teilen-Symbol → „Zum Home-Bildschirm“.<br>Danach funktioniert die App auch ohne Netz.</div>
    </div>` : ''}
    <p class="muted small" style="text-align:center;margin-top:24px">Einsatztagebuch v${APP_VERSION}</p>`;
  $('#newE').onclick = newEinsatz;
  $('#backupAll').onclick = backupAll;
  $('#importFile').onchange = (ev) => importBackup(ev.target.files[0]);
  if ($('#installBtn')) $('#installBtn').onclick = async () => { installEvt.prompt(); await installEvt.userChoice; installEvt = null; showHome(); };
}

function einsatzForm(e = {}) {
  const s = S.settings;
  return `
    <label>Einsatz / Stichwort *<input name="bezeichnung" required value="${esc(e.bezeichnung || '')}" placeholder="z. B. Hochwasser Musterfluss – Keller lenzen"></label>
    <div class="grid2">
      <label>Einsatz-Nr.<input name="nr" value="${esc(e.nr || '')}"></label>
      <label>Alarmierung<input type="datetime-local" name="beginn" value="${toInput(e.beginn || Date.now())}" required></label>
    </div>
    <label>Einsatzort / Abschnitt<input name="ort" value="${esc(e.ort || '')}" placeholder="Adresse, Abschnitt, Koordinaten"></label>
    <label>Anfordernde Stelle / Auftraggeber<input name="auftraggeber" value="${esc(e.auftraggeber || '')}" placeholder="z. B. FF Musterstadt, EAL, Landkreis"></label>
    <label>Unterstellt / Führung durch<input name="fuehrung" value="${esc(e.fuehrung || '')}" placeholder="z. B. ZTr TZ, EA-Leiter"></label>
    <label>Einheit<input name="einheit" value="${esc(e.einheit ?? s.einheit ?? '')}"></label>
    <div class="grid2">
      <label>Truppführer/in<input name="fuehrer" value="${esc(e.fuehrer ?? s.name ?? '')}"></label>
      <label>Stärke (Fü/UF/H/Ges.)<input name="staerke" value="${esc(e.staerke || '')}" placeholder="0/1/5/6" inputmode="numeric"></label>
    </div>
    ${!e.id && s.fahrzeuge?.length ? `
    <label>Fahrzeuge</label>
    ${s.fahrzeuge.map((f, i) => `<label class="inline"><input type="checkbox" name="fzg_${i}" checked> ${esc(fahrzeugLabel(f))}</label>`).join('')}
    <label>Weitere Fahrzeuge<input name="fahrzeuge" placeholder="z. B. zusätzlicher Anhänger"></label>`
    : `<label>Fahrzeuge / Funkrufnamen<input name="fahrzeuge" value="${esc(e.fahrzeuge || '')}" placeholder="z. B. MzGW, LKW-K, Anhänger"></label>`}
    <label>Bemerkung<textarea name="bemerkung" rows="2">${esc(e.bemerkung || '')}</textarea></label>`;
}
const fahrzeugLabel = (f) => {
  const extra = [f.funk, f.kennz].filter(Boolean).join(', ');
  return f.typ ? f.typ + (extra ? ` (${extra})` : '') : extra;
};
const FELD_LABEL = { bezeichnung: 'Einsatz', nr: 'Einsatz-Nr.', ort: 'Einsatzort', auftraggeber: 'Anfordernde Stelle', fuehrung: 'Unterstellt', einheit: 'Einheit', fuehrer: 'Truppführer/in', staerke: 'Stärke', fahrzeuge: 'Fahrzeuge', bemerkung: 'Bemerkung' };
const EINSATZ_FELDER = Object.keys(FELD_LABEL);

async function newEinsatz() {
  const r = await dialog('Neuer Einsatz', einsatzForm(), { ok: 'Einsatz anlegen' });
  if (!r) return;
  const d = r.data;
  const e = {
    id: uid(), created: Date.now(), beginn: fromInput(d.beginn), ende: null, nextLfd: 1,
    pumpen: (S.settings.pumpen || []).map((p) => ({ id: uid(), name: p.name, lpm: Number(p.lpm) || 0 })),
    personal: (S.settings.helfer || []).map((p) => ({ id: uid(), name: p.name, funktion: p.funktion, kommt: null, geht: null })),
  };
  for (const k of EINSATZ_FELDER) e[k] = (d[k] || '').trim();
  if (S.settings.fahrzeuge?.length) {
    const gew = S.settings.fahrzeuge.filter((f, i) => d[`fzg_${i}`]).map(fahrzeugLabel);
    if (e.fahrzeuge) gew.push(e.fahrzeuge);
    e.fahrzeuge = gew.join('; ');
  }
  const first = mkEntry(e, { zeit: e.beginn, kat: 'Status', text: `Alarmierung: ${e.bezeichnung}${e.ort ? ' – ' + e.ort : ''}${e.auftraggeber ? ' (Anforderung: ' + e.auftraggeber + ')' : ''}` });
  await DB.putBoth(e, [first]);
  location.hash = `#/e/${e.id}`;
}

/* ---------- Einträge ---------- */
function mkEntry(einsatz, f) {
  return {
    id: uid(), einsatzId: einsatz.id, lfd: einsatz.nextLfd++, zeit: f.zeit || Date.now(), erfasst: Date.now(),
    kat: f.kat || 'Sonstiges', von: f.von || '', an: f.an || '', text: f.text || '', autor: S.settings.name || '',
    fotos: f.fotos || [], storno: null, pumpeId: f.pumpeId || null, aktion: f.aktion || null,
  };
}
async function addEntries(...fs) {
  const e = S.einsatz;
  const neu = fs.map((f) => mkEntry(e, f));
  await DB.putBoth(e, neu);
  S.eintraege.push(...neu);
  return neu;
}

function vonAnListe() {
  const set = new Set(['Einsatzleitung', 'Abschnittsleitung', 'ZTr', 'FüSt', 'Auftraggeber', 'Feuerwehr', 'Polizei', 'Eigentümer/Anwohner']);
  if (S.einsatz?.fuehrer) set.add(S.einsatz.fuehrer);
  for (const x of S.eintraege) { if (x.von) set.add(x.von); if (x.an) set.add(x.an); }
  return [...set].map((v) => `<option value="${esc(v)}">`).join('');
}

async function entryDialog(pre = {}) {
  if (S.einsatz.ende && !(await confirmDlg('Einsatz abgeschlossen', 'Der Einsatz ist bereits abgeschlossen. Trotzdem einen Nachtrag erfassen?', 'Nachtrag erfassen'))) return;
  const body = `
    <div class="grid2">
      <label>Zeitpunkt<input type="datetime-local" name="zeit" value="${toInput(pre.zeit || Date.now())}" required></label>
      <label>Kategorie<select name="kat">${KATS.map((k) => `<option ${k === (pre.kat || 'Lage') ? 'selected' : ''}>${k}</option>`).join('')}</select></label>
    </div>
    <div class="grid2">
      <label>Von<input name="von" list="dlVA" value="${esc(pre.von || '')}" autocomplete="off"></label>
      <label>An<input name="an" list="dlVA" value="${esc(pre.an || '')}" autocomplete="off"></label>
    </div>
    <datalist id="dlVA">${vonAnListe()}</datalist>
    <label>Inhalt *<textarea name="text" rows="5" required placeholder="Was ist passiert? Lage, Auftrag, Maßnahme …">${esc(pre.text || '')}</textarea></label>
    <label class="btn filebtn">📷 Foto(s) anhängen<input type="file" name="foto" accept="image/*" multiple></label>
    <div class="preview" id="fotoPrev"></div>`;
  const r = await dialog('Neuer Eintrag', body, {
    ok: 'Eintragen',
    onOpen: (f) => {
      const ta = f.querySelector('textarea');
      ta.focus(); ta.setSelectionRange(ta.value.length, ta.value.length);
      const fi = f.elements.namedItem('foto');
      fi.onchange = () => {
        $('#fotoPrev').innerHTML = [...fi.files].map((fl) => `<img src="${URL.createObjectURL(fl)}" alt="">`).join('');
      };
    },
  });
  if (!r) return;
  const fotos = [];
  for (const fl of r.form.elements.namedItem('foto').files) {
    try { fotos.push(await compressImage(fl)); } catch (err) { toast(err.message); }
  }
  const d = r.data;
  await addEntries({ zeit: fromInput(d.zeit), kat: d.kat, von: d.von.trim(), an: d.an.trim(), text: d.text.trim(), fotos });
  toast('Eintrag gespeichert');
  renderTab();
}

async function stornoEntry(id) {
  const x = S.eintraege.find((y) => y.id === id);
  if (!x || x.storno) return;
  const r = await dialog(`Eintrag Nr. ${x.lfd} stornieren`, `
    <p class="small muted">Einträge im Einsatztagebuch werden nicht gelöscht. Der Eintrag bleibt durchgestrichen sichtbar und wird mit Begründung im Export ausgewiesen. Lege bei Bedarf anschließend einen korrigierten Eintrag an.</p>
    <label>Begründung *<input name="grund" required placeholder="z. B. Uhrzeit falsch, Schreibfehler"></label>`, { ok: 'Stornieren', okClass: 'danger' });
  if (!r) return;
  x.storno = { zeit: Date.now(), grund: r.data.grund.trim(), autor: S.settings.name || '' };
  await DB.put('eintraege', x);
  toast(`Eintrag ${x.lfd} storniert`);
  renderTab();
}

function showFoto(id, i) {
  const x = S.eintraege.find((y) => y.id === id);
  if (!x) return;
  dialog(`Foto zu Eintrag Nr. ${x.lfd}`, `<img class="imgview" src="${x.fotos[i].data}" alt="Foto">`, { ok: 'Schließen', cancel: null });
}

/* ---------- Einsatz-Ansicht ---------- */
async function showEinsatz(id, tab) {
  if (!S.einsatz || S.einsatz.id !== id) {
    const e = await DB.get('einsaetze', id);
    if (!e) { location.hash = '#/'; return; }
    S.einsatz = e;
    S.eintraege = await DB.byEinsatz(id);
  }
  S.tab = tab;
  const e = S.einsatz;
  setTop(e.bezeichnung, `${e.ort || ''}${e.ort ? ' · ' : ''}seit ${fmtDT(e.beginn)}${e.ende ? ' · abgeschlossen' : ''}`, '#/');
  setTabs(id, tab);
  renderTab();
}

function renderTab() {
  clearInterval(timer);
  const t = S.tab;
  setFab(t === 'etb' ? () => entryDialog() : null);
  if (t === 'etb') renderETB();
  else if (t === 'pumpen') { renderPumpen(); timer = setInterval(renderPumpen, 30000); }
  else if (t === 'personal') { renderPersonal(); timer = setInterval(renderPersonal, 60000); }
  else if (t === 'daten') renderDaten();
  else if (t === 'export') renderExport();
}

function entryHtml(x) {
  const nachtr = x.erfasst - x.zeit > 5 * 60000 ? ` · nachgetragen ${fmtDT(x.erfasst)}` : '';
  return `<div class="card entry ${x.storno ? 'storno' : ''}">
    <div class="entry-head">
      <span class="nr">#${x.lfd}</span>
      <span class="time">${fmtT(x.zeit)}</span><span>${fmtD(x.zeit)}</span>
      <span class="kat kat-${esc(x.kat.split('/')[0])}">${esc(x.kat)}</span>
    </div>
    ${x.von || x.an ? `<div class="entry-meta">${x.von ? 'Von: <b>' + esc(x.von) + '</b>' : ''}${x.von && x.an ? ' → ' : ''}${x.an ? 'An: <b>' + esc(x.an) + '</b>' : ''}</div>` : ''}
    <div class="entry-text">${esc(x.text)}</div>
    ${x.fotos?.length ? `<div class="thumbs">${x.fotos.map((f, i) => `<img src="${f.data}" alt="Foto ${i + 1}" data-foto="${x.id}" data-i="${i}">`).join('')}</div>` : ''}
    ${x.storno ? `<div class="storno-note">Storniert ${fmtDT(x.storno.zeit)}${x.storno.autor ? ' durch ' + esc(x.storno.autor) : ''}: ${esc(x.storno.grund)}</div>` : ''}
    <div class="entry-meta">${x.autor ? 'Erfasst von ' + esc(x.autor) : ''}${nachtr}</div>
    ${!x.storno ? `<div class="entry-menu"><button data-storno="${x.id}" aria-label="Eintrag stornieren" title="Stornieren">⋯</button></div>` : ''}
  </div>`;
}

function renderETB() {
  const e = S.einsatz;
  const list = sortAsc(S.eintraege).reverse();
  view.innerHTML = `
    ${e.ende ? `<div class="banner warn">Einsatz abgeschlossen am ${fmtDT(e.ende)}. Nachträge sind möglich, werden aber als solche gekennzeichnet.</div>` : ''}
    <div class="chips" aria-label="Status">${STATI.map((s) => `<button class="chip" data-status="${esc(s)}">${esc(s)}</button>`).join('')}</div>
    <div class="chips" aria-label="Schnelleinträge">${SCHNELL.map((s, i) => `<button class="chip" data-schnell="${i}">${esc(s.label)}</button>`).join('')}</div>
    <h2>${list.length} Einträge · neueste oben</h2>
    ${list.map(entryHtml).join('') || '<div class="card empty">Noch keine Einträge.</div>'}`;
  view.querySelectorAll('[data-status]').forEach((b) => { b.onclick = () => entryDialog({ kat: 'Status', text: b.dataset.status }); });
  view.querySelectorAll('[data-schnell]').forEach((b) => { const s = SCHNELL[b.dataset.schnell]; b.onclick = () => entryDialog({ kat: s.kat, text: s.text }); });
  view.querySelectorAll('[data-storno]').forEach((b) => { b.onclick = () => stornoEntry(b.dataset.storno); });
  view.querySelectorAll('[data-foto]').forEach((b) => { b.onclick = () => showFoto(b.dataset.foto, +b.dataset.i); });
}

/* ---------- Pumpen ---------- */
function renderPumpen() {
  const e = S.einsatz;
  let gesMenge = 0; let gesMin = 0; let laufend = 0; let lpmLaufend = 0;
  const cards = e.pumpen.map((p) => {
    const st = pumpStats(p, S.eintraege, e);
    gesMenge += st.menge; gesMin += st.min;
    if (st.running != null) { laufend++; lpmLaufend += Number(p.lpm) || 0; }
    return `<div class="card stack">
      <div class="row"><strong>${esc(p.name)}</strong>
        <span class="badge ${st.running != null ? 'run' : 'stop'}">${st.running != null ? 'läuft seit ' + fmtT(st.running) : 'steht'}</span></div>
      <div class="muted small">${p.lpm ? 'Nennleistung ' + fmtNum(p.lpm) + ' l/min' : 'Nennleistung nicht angegeben'}${p.standort ? ' · ' + esc(p.standort) : ''}</div>
      <div class="grid2">
        <div><div class="muted small">Betriebszeit</div><div class="big-num">${fmtDur(st.min)}</div></div>
        <div><div class="muted small">rechn. Fördermenge</div><div class="big-num">${p.lpm ? fmtNum(st.menge) + ' m³' : '–'}</div></div>
      </div>
      <div class="btns">
        ${st.running != null
          ? `<button class="btn danger" data-pstop="${p.id}">■ Pumpe aus</button>`
          : `<button class="btn ok" data-pstart="${p.id}">▶ Pumpe an</button>`}
        <button class="btn sm" data-pedit="${p.id}">Bearbeiten</button>
      </div>
    </div>`;
  }).join('');
  view.innerHTML = `
    <div class="card">
      <div class="grid2">
        <div><div class="muted small">Pumpen in Betrieb</div><div class="big-num">${laufend} / ${e.pumpen.length}</div><div class="muted small">${lpmLaufend ? fmtNum(lpmLaufend) + ' l/min nominal' : ''}</div></div>
        <div><div class="muted small">Gesamt rechn. Fördermenge</div><div class="big-num">${fmtNum(gesMenge)} m³</div><div class="muted small">${fmtDur(gesMin)} Betriebszeit gesamt</div></div>
      </div>
      <div class="muted small" style="margin-top:8px">Fördermenge = Nennleistung × Laufzeit. Die tatsächliche Leistung hängt von Förderhöhe, Schlauchlänge und Medium ab – Wert nur als Richtgröße.</div>
    </div>
    ${cards || '<div class="card empty">Noch keine Pumpen erfasst.</div>'}
    <button class="btn block" id="addPumpe">+ Pumpe hinzufügen</button>`;
  $('#addPumpe').onclick = () => pumpeDialog();
  view.querySelectorAll('[data-pstart]').forEach((b) => { b.onclick = () => pumpeSchalten(b.dataset.pstart, 'start'); });
  view.querySelectorAll('[data-pstop]').forEach((b) => { b.onclick = () => pumpeSchalten(b.dataset.pstop, 'stop'); });
  view.querySelectorAll('[data-pedit]').forEach((b) => { b.onclick = () => pumpeDialog(b.dataset.pedit); });
}

async function pumpeDialog(id) {
  const e = S.einsatz;
  const p = id ? e.pumpen.find((x) => x.id === id) : {};
  const r = await dialog(id ? 'Pumpe bearbeiten' : 'Pumpe hinzufügen', `
    <label>Bezeichnung *<input name="name" required value="${esc(p.name || '')}" placeholder="z. B. Schmutzwasserpumpe 1"></label>
    <label>Nennleistung (l/min)<input name="lpm" type="number" inputmode="numeric" min="0" step="1" value="${esc(p.lpm || '')}"></label>
    <label>Standort / Förderstrecke<input name="standort" value="${esc(p.standort || '')}" placeholder="z. B. Keller Hauptstr. 3 → Kanal, 3 B-Längen"></label>`,
  { ok: 'Speichern' });
  if (!r) return;
  const neu = { name: r.data.name.trim(), lpm: Number(r.data.lpm) || 0, standort: r.data.standort.trim() };
  if (id) {
    const alt = { ...p };
    Object.assign(p, neu);
    const diff = [];
    if (alt.name !== p.name) diff.push(`Bezeichnung „${alt.name}“ → „${p.name}“`);
    if ((alt.lpm || 0) !== p.lpm) diff.push(`Nennleistung ${alt.lpm || 0} → ${p.lpm} l/min`);
    if ((alt.standort || '') !== p.standort) diff.push(`Standort: ${p.standort || '–'}`);
    if (diff.length) await addEntries({ kat: 'Pumpe', text: `${p.name}: ${diff.join('; ')}` });
    else await DB.put('einsaetze', e);
  } else {
    const np = { id: uid(), ...neu };
    e.pumpen.push(np);
    await addEntries({ kat: 'Pumpe', text: `Pumpe erfasst: ${np.name}${np.lpm ? ' (' + np.lpm + ' l/min)' : ''}${np.standort ? ', ' + np.standort : ''}` });
  }
  renderPumpen();
}

async function pumpeSchalten(id, aktion) {
  const e = S.einsatz;
  const p = e.pumpen.find((x) => x.id === id);
  const r = await dialog(`${p.name} ${aktion === 'start' ? 'in Betrieb nehmen' : 'außer Betrieb nehmen'}`, `
    <label>Zeitpunkt<input type="datetime-local" name="zeit" value="${toInput(Date.now())}" required></label>
    <label>Bemerkung<input name="text" placeholder="${aktion === 'start' ? 'Standort, Ansaugstelle, Förderstrecke …' : 'Grund: Ziel erreicht, Störung, Tanken …'}"></label>`,
  { ok: aktion === 'start' ? '▶ Pumpe an' : '■ Pumpe aus', okClass: aktion === 'start' ? 'ok' : 'danger' });
  if (!r) return;
  const bem = r.data.text.trim();
  await addEntries({
    zeit: fromInput(r.data.zeit), kat: 'Pumpe', pumpeId: id, aktion,
    text: `${p.name} ${aktion === 'start' ? 'in Betrieb genommen' : 'außer Betrieb genommen'}${bem ? ' – ' + bem : ''}`,
  });
  toast(aktion === 'start' ? `${p.name} läuft` : `${p.name} aus`);
  renderPumpen();
}

/* ---------- Personal ---------- */
function renderPersonal() {
  const e = S.einsatz;
  const anwesend = e.personal.filter((p) => p.kommt && !p.geht).length;
  const summe = e.personal.reduce((s, p) => s + personStunden(p, e), 0);
  view.innerHTML = `
    <div class="card grid2">
      <div><div class="muted small">Aktuell im Einsatz</div><div class="big-num">${anwesend}</div></div>
      <div><div class="muted small">Einsatzstunden gesamt</div><div class="big-num">${fmtDur(summe)}</div></div>
    </div>
    ${e.personal.map((p) => `
      <div class="card stack">
        <div class="row"><div><strong>${esc(p.name)}</strong><div class="muted small">${esc(p.funktion || '')}</div></div>
          <span class="badge ${p.kommt && !p.geht ? 'run' : 'stop'}">${!p.kommt ? 'nicht im Einsatz' : p.geht ? 'abgemeldet' : 'im Einsatz'}</span></div>
        <div class="small">Beginn: <b>${fmtDT(p.kommt)}</b> · Ende: <b>${fmtDT(p.geht)}</b> · <b>${fmtDur(personStunden(p, e))}</b></div>
        <div class="btns">
          ${!p.kommt ? `<button class="btn ok" data-kommt="${p.id}">Anmelden</button>` : !p.geht ? `<button class="btn" data-geht="${p.id}">Abmelden</button>` : ''}
          <button class="btn sm" data-pzeit="${p.id}">Zeiten korrigieren</button>
        </div>
      </div>`).join('') || '<div class="card empty">Noch kein Personal erfasst.</div>'}
    <div class="btns">
      <button class="btn block" id="addPers">+ Helfer/in hinzufügen</button>
      ${e.personal.some((p) => !p.kommt) ? '<button class="btn block" id="alleKommen">Alle anmelden</button>' : ''}
    </div>`;
  $('#addPers').onclick = addPerson;
  if ($('#alleKommen')) $('#alleKommen').onclick = alleAnmelden;
  view.querySelectorAll('[data-kommt]').forEach((b) => { b.onclick = () => personZeit(b.dataset.kommt, 'kommt'); });
  view.querySelectorAll('[data-geht]').forEach((b) => { b.onclick = () => personZeit(b.dataset.geht, 'geht'); });
  view.querySelectorAll('[data-pzeit]').forEach((b) => { b.onclick = () => personKorrektur(b.dataset.pzeit); });
}

async function addPerson() {
  const e = S.einsatz;
  const r = await dialog('Helfer/in hinzufügen', `
    <label>Name *<input name="name" required autocomplete="off"></label>
    <label>Funktion<input name="funktion" list="dlFkt" value="Helfer/in"></label>
    <datalist id="dlFkt">${FUNKTIONEN.map((f) => `<option value="${esc(f)}">`).join('')}</datalist>
    <label class="inline"><input type="checkbox" name="jetzt" checked> sofort anmelden</label>
    <label>Beginn<input type="datetime-local" name="kommt" value="${toInput(Date.now())}"></label>`);
  if (!r) return;
  const p = { id: uid(), name: r.data.name.trim(), funktion: r.data.funktion.trim(), kommt: r.data.jetzt ? fromInput(r.data.kommt) : null, geht: null };
  e.personal.push(p);
  if (p.kommt) await addEntries({ zeit: p.kommt, kat: 'Personal', text: `${p.name} (${p.funktion}) angemeldet / im Einsatz` });
  else await DB.put('einsaetze', e);
  renderPersonal();
}

async function alleAnmelden() {
  const e = S.einsatz;
  const offen = e.personal.filter((p) => !p.kommt);
  const r = await dialog('Alle anmelden', `<p>${offen.map((p) => esc(p.name)).join(', ')}</p><label>Beginn<input type="datetime-local" name="zeit" value="${toInput(Date.now())}" required></label>`, { ok: 'Anmelden' });
  if (!r) return;
  const z = fromInput(r.data.zeit);
  offen.forEach((p) => { p.kommt = z; });
  await addEntries({ zeit: z, kat: 'Personal', text: `Angemeldet / im Einsatz: ${offen.map((p) => `${p.name} (${p.funktion})`).join(', ')}` });
  renderPersonal();
}

async function personZeit(id, feld) {
  const p = S.einsatz.personal.find((x) => x.id === id);
  const r = await dialog(`${p.name} ${feld === 'kommt' ? 'anmelden' : 'abmelden'}`, `<label>Zeitpunkt<input type="datetime-local" name="zeit" value="${toInput(Date.now())}" required></label>`, { ok: feld === 'kommt' ? 'Anmelden' : 'Abmelden' });
  if (!r) return;
  p[feld] = fromInput(r.data.zeit);
  await addEntries({ zeit: p[feld], kat: 'Personal', text: `${p.name} (${p.funktion}) ${feld === 'kommt' ? 'angemeldet / im Einsatz' : 'abgemeldet / aus dem Einsatz entlassen'}` });
  renderPersonal();
}

async function personKorrektur(id) {
  const p = S.einsatz.personal.find((x) => x.id === id);
  const r = await dialog(`Zeiten ${p.name}`, `
    <label>Funktion<input name="funktion" value="${esc(p.funktion || '')}" list="dlFkt"></label>
    <datalist id="dlFkt">${FUNKTIONEN.map((f) => `<option value="${esc(f)}">`).join('')}</datalist>
    <label>Beginn<input type="datetime-local" name="kommt" value="${p.kommt ? toInput(p.kommt) : ''}"></label>
    <label>Ende<input type="datetime-local" name="geht" value="${p.geht ? toInput(p.geht) : ''}"></label>
    <p class="small muted">Die Korrektur wird im Tagebuch protokolliert.</p>`);
  if (!r) return;
  const alt = `${fmtDT(p.kommt)}–${fmtDT(p.geht)}`;
  p.funktion = r.data.funktion.trim();
  p.kommt = fromInput(r.data.kommt);
  p.geht = fromInput(r.data.geht);
  await addEntries({ kat: 'Personal', text: `Korrektur Einsatzzeiten ${p.name}: ${alt} → ${fmtDT(p.kommt)}–${fmtDT(p.geht)}` });
  renderPersonal();
}

/* ---------- Einsatzdaten ---------- */
function renderDaten() {
  const e = S.einsatz;
  const rows = [
    ['Einsatz', e.bezeichnung], ['Einsatz-Nr.', e.nr], ['Einsatzort', e.ort], ['Anfordernde Stelle', e.auftraggeber],
    ['Unterstellt', e.fuehrung], ['Einheit', e.einheit], ['Truppführer/in', e.fuehrer], ['Stärke', e.staerke],
    ['Fahrzeuge', e.fahrzeuge], ['Alarmierung', fmtDT(e.beginn)], ['Einsatzende', fmtDT(e.ende)],
    ['Dauer', fmtDur(((e.ende || Date.now()) - e.beginn) / 60000)], ['Bemerkung', e.bemerkung],
  ];
  view.innerHTML = `
    <div class="card"><dl class="kv">${rows.map(([k, v]) => `<dt>${k}</dt><dd>${esc(v || '–')}</dd>`).join('')}</dl></div>
    <div class="stack">
      <button class="btn block" id="editE">Einsatzdaten bearbeiten</button>
      ${e.ende ? '<button class="btn block" id="reopen">Einsatz wieder öffnen</button>' : '<button class="btn primary block" id="closeE">Einsatz abschließen</button>'}
    </div>
    <h2>Gefahrenbereich</h2>
    <button class="btn ghost-danger block" id="delE">Einsatz von diesem Gerät löschen</button>`;
  $('#editE').onclick = editEinsatz;
  if ($('#closeE')) $('#closeE').onclick = closeEinsatz;
  if ($('#reopen')) $('#reopen').onclick = reopenEinsatz;
  $('#delE').onclick = deleteEinsatz;
}

async function editEinsatz() {
  const e = S.einsatz;
  const r = await dialog('Einsatzdaten', einsatzForm(e));
  if (!r) return;
  const diff = [];
  for (const k of EINSATZ_FELDER) {
    const v = (r.data[k] || '').trim();
    if ((e[k] || '') !== v) { diff.push(`${FELD_LABEL[k]}: „${v}“`); e[k] = v; }
  }
  const b = fromInput(r.data.beginn);
  if (b !== e.beginn) { diff.push(`Alarmierung: ${fmtDT(b)}`); e.beginn = b; }
  if (diff.length) await addEntries({ kat: 'Sonstiges', text: `Einsatzdaten geändert – ${diff.join('; ')}` });
  setTop(e.bezeichnung, `${e.ort || ''}${e.ort ? ' · ' : ''}seit ${fmtDT(e.beginn)}`, '#/');
  renderDaten();
}

async function closeEinsatz() {
  const e = S.einsatz;
  const laufend = e.pumpen.filter((p) => pumpStats(p, S.eintraege, e).running != null);
  const imEinsatz = e.personal.filter((p) => p.kommt && !p.geht);
  const r = await dialog('Einsatz abschließen', `
    <label>Einsatzende<input type="datetime-local" name="zeit" value="${toInput(Date.now())}" required></label>
    ${laufend.length ? `<label class="inline"><input type="checkbox" name="pumpen" checked> ${laufend.length} laufende Pumpe(n) zu diesem Zeitpunkt als „aus“ eintragen</label>` : ''}
    ${imEinsatz.length ? `<label class="inline"><input type="checkbox" name="personal" checked> ${imEinsatz.length} Helfer/in(nen) zu diesem Zeitpunkt abmelden</label>` : ''}
    <label>Abschlussbemerkung<textarea name="text" rows="3" placeholder="z. B. Einsatzstelle übergeben an …, Material vollständig, keine Verletzten"></textarea></label>`,
  { ok: 'Abschließen' });
  if (!r) return;
  const z = fromInput(r.data.zeit);
  const neu = [];
  if (r.data.pumpen) for (const p of laufend) neu.push({ zeit: z, kat: 'Pumpe', pumpeId: p.id, aktion: 'stop', text: `${p.name} außer Betrieb genommen – Einsatzende` });
  if (r.data.personal) {
    imEinsatz.forEach((p) => { p.geht = z; });
    neu.push({ zeit: z, kat: 'Personal', text: `Abgemeldet: ${imEinsatz.map((p) => p.name).join(', ')}` });
  }
  neu.push({ zeit: z, kat: 'Status', text: `Einsatzende${r.data.text.trim() ? ' – ' + r.data.text.trim() : ''}` });
  e.ende = z;
  await addEntries(...neu);
  toast('Einsatz abgeschlossen – jetzt exportieren');
  location.hash = `#/e/${e.id}/export`;
}

async function reopenEinsatz() {
  const e = S.einsatz;
  if (!(await confirmDlg('Einsatz wieder öffnen', 'Der Einsatz wird wieder als laufend geführt. Das wird im Tagebuch protokolliert.'))) return;
  e.ende = null;
  await addEntries({ kat: 'Status', text: 'Einsatz wieder geöffnet' });
  renderDaten();
}

async function deleteEinsatz() {
  const e = S.einsatz;
  const r = await dialog('Einsatz löschen', `
    <p>Der Einsatz <b>${esc(e.bezeichnung)}</b> mit ${S.eintraege.length} Einträgen wird <b>unwiderruflich</b> von diesem Gerät gelöscht. Exportiere vorher PDF und JSON!</p>
    <label>Zur Bestätigung „LÖSCHEN“ eingeben<input name="ok" required autocomplete="off" pattern="LÖSCHEN|löschen|Löschen"></label>`, { ok: 'Endgültig löschen', okClass: 'danger' });
  if (!r) return;
  await DB.deleteEinsatz(e.id, S.eintraege.map((x) => x.id));
  S.einsatz = null; S.eintraege = [];
  toast('Einsatz gelöscht');
  location.hash = '#/';
}

/* ---------- Export ---------- */
function renderExport() {
  const e = S.einsatz;
  const nFotos = S.eintraege.reduce((s, x) => s + (x.fotos?.length || 0), 0);
  const canShare = !!(navigator.canShare && navigator.canShare({ files: [new File(['x'], 'x.txt', { type: 'text/plain' })] }));
  const fmt = (key, titel, text) => `
    <div class="card stack">
      <div><strong>${titel}</strong><div class="muted small">${text}</div></div>
      <div class="btns">
        ${canShare ? `<button class="btn primary" data-exp="${key}" data-mode="share">Teilen …</button>` : ''}
        <button class="btn ${canShare ? '' : 'primary'}" data-exp="${key}" data-mode="save">Herunterladen</button>
      </div>
    </div>`;
  view.innerHTML = `
    ${!e.ende ? '<div class="banner warn">Der Einsatz läuft noch. Du kannst trotzdem jederzeit einen Zwischenstand exportieren.</div>' : ''}
    ${fmt('pdf', 'PDF – Einsatztagebuch', 'Druckfertiges Tagebuch mit Kopfdaten, allen Einträgen (inkl. Stornos), Pumpenprotokoll, Personal/Einsatzstunden und Unterschriftsfeld.')}
    ${nFotos ? `<label class="inline card"><input type="checkbox" id="mitFotos" checked> ${nFotos} Foto(s) als Anlage ins PDF übernehmen</label>` : ''}
    ${fmt('csv', 'CSV – Tabelle', 'Alle Einträge als Tabelle für Excel/LibreOffice (Trennzeichen Semikolon).')}
    ${fmt('json', 'JSON – Datensicherung', 'Vollständige Sicherung inkl. Fotos. Kann auf jedem Gerät mit dieser App wieder eingelesen werden.')}
    <p class="muted small">„Teilen“ öffnet das Teilen-Menü des Handys (Mail, Messenger, Cloud, Drucken …).</p>`;
  view.querySelectorAll('[data-exp]').forEach((b) => { b.onclick = () => doExport(b.dataset.exp, b.dataset.mode, b); });
}

async function doExport(kind, mode, btn) {
  const e = S.einsatz;
  const base = `ETB_${fileStamp(e.beginn)}_${slug(e.bezeichnung)}`;
  btn.disabled = true;
  const old = btn.textContent; btn.textContent = 'Erstelle …';
  try {
    let blob; let name;
    if (kind === 'pdf') { blob = await buildPDF(!!$('#mitFotos')?.checked); name = base + '.pdf'; }
    else if (kind === 'csv') { blob = buildCSV(); name = base + '.csv'; }
    else { blob = new Blob([JSON.stringify(exportObj([e]), null, 1)], { type: 'application/json' }); name = base + '.json'; }
    await deliver(blob, name, mode);
  } catch (err) {
    console.error(err);
    toast('Export fehlgeschlagen: ' + err.message);
  } finally {
    btn.disabled = false; btn.textContent = old;
  }
}

async function deliver(blob, name, mode = 'save') {
  if (mode === 'share') {
    const file = new File([blob], name, { type: blob.type });
    if (navigator.canShare && navigator.canShare({ files: [file] })) {
      try { await navigator.share({ files: [file], title: name }); return; } catch (err) {
        if (err.name === 'AbortError') return;
        console.warn('Teilen fehlgeschlagen, lade herunter', err);
      }
    }
  }
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = name;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 30000);
  toast(`${name} gespeichert`);
}

function exportObj(einsaetze, eintraegeMap) {
  return {
    format: 'etb-thw-fgr-wp', version: 1, appVersion: APP_VERSION, exportiert: new Date().toISOString(),
    einsaetze: einsaetze.map((e) => ({ einsatz: e, eintraege: sortAsc(eintraegeMap ? eintraegeMap[e.id] : S.eintraege) })),
  };
}

function csvCell(v) {
  const s = String(v ?? '');
  return /[;"\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}
function buildCSV() {
  const head = ['Lfd. Nr.', 'Datum', 'Uhrzeit', 'Kategorie', 'Von', 'An', 'Inhalt', 'Fotos', 'Erfasst von', 'Erfasst am', 'Storniert', 'Storno-Grund'];
  const rows = sortAsc(S.eintraege).map((x) => [
    x.lfd, fmtD(x.zeit), fmtT(x.zeit), x.kat, x.von, x.an, x.text, x.fotos?.length || '', x.autor, fmtDT(x.erfasst),
    x.storno ? fmtDT(x.storno.zeit) : '', x.storno ? x.storno.grund : '',
  ]);
  const csv = [head, ...rows].map((r) => r.map(csvCell).join(';')).join('\r\n');
  return new Blob(['﻿' + csv], { type: 'text/csv;charset=utf-8' });
}

/* jsPDF-Standardschriften können nur Latin-1 – andere Zeichen ersetzen */
function pdfTxt(s) {
  return String(s ?? '')
    .replace(/[‘’‚]/g, "'").replace(/[“”„]/g, '"')
    .replace(/[–—]/g, '-').replace(/→/g, '->').replace(/…/g, '...')
    .replace(/[▶■]/g, '').replace(/€/g, 'EUR')
    .replace(/[^\x09\x0A\x0D\x20-\x7E\xA0-\xFF]/g, '?');
}

async function buildPDF(mitFotos) {
  if (!window.jspdf) throw new Error('PDF-Bibliothek nicht geladen');
  const { jsPDF } = window.jspdf;
  const e = S.einsatz;
  const doc = new jsPDF({ unit: 'mm', format: 'a4' });
  const W = doc.internal.pageSize.getWidth();
  const H = doc.internal.pageSize.getHeight();
  const M = 14;
  const blau = [0, 51, 153];
  const list = sortAsc(S.eintraege);

  doc.setFillColor(...blau);
  doc.rect(0, 0, W, 22, 'F');
  doc.setTextColor(255);
  doc.setFont('helvetica', 'bold'); doc.setFontSize(17);
  doc.text('Einsatztagebuch', M, 11);
  doc.setFont('helvetica', 'normal'); doc.setFontSize(9.5);
  doc.text(pdfTxt(e.einheit || ''), M, 17);
  doc.text(pdfTxt(e.nr ? 'Einsatz-Nr. ' + e.nr : ''), W - M, 11, { align: 'right' });
  doc.text(`Stand: ${fmtDT(Date.now())}`, W - M, 17, { align: 'right' });
  doc.setTextColor(0);

  const dauer = fmtDur(((e.ende || Date.now()) - e.beginn) / 60000) + (e.ende ? '' : ' (laufend)');
  const kopf = [
    ['Einsatz', e.bezeichnung, 'Alarmierung', fmtDT(e.beginn)],
    ['Einsatzort', e.ort, 'Einsatzende', e.ende ? fmtDT(e.ende) : 'laufend'],
    ['Anfordernde Stelle', e.auftraggeber, 'Dauer', dauer],
    ['Unterstellt', e.fuehrung, 'Stärke', e.staerke],
    ['Truppführer/in', e.fuehrer, 'Fahrzeuge', e.fahrzeuge],
  ];
  if (e.bemerkung) kopf.push(['Bemerkung', { content: e.bemerkung, colSpan: 3 }]);
  doc.autoTable({
    startY: 27, margin: { left: M, right: M }, theme: 'grid',
    body: kopf.map((r) => r.map((c) => (typeof c === 'object' && c ? { ...c, content: pdfTxt(c.content) } : pdfTxt(c || '-')))),
    styles: { fontSize: 9, cellPadding: 1.6, lineColor: [180, 186, 200], lineWidth: 0.2 },
    columnStyles: { 0: { fontStyle: 'bold', fillColor: [236, 240, 248], cellWidth: 34 }, 2: { fontStyle: 'bold', fillColor: [236, 240, 248], cellWidth: 26 } },
  });

  // Einträge
  doc.setFont('helvetica', 'bold'); doc.setFontSize(12);
  let y = doc.lastAutoTable.finalY + 8;
  doc.text('Einträge', M, y);
  const stornoRows = new Set();
  const body = list.map((x, i) => {
    let inhalt = x.text;
    if (x.fotos?.length) inhalt += `\n[${x.fotos.length} Foto(s)${mitFotos ? ' - siehe Anlage' : ''}]`;
    if (x.storno) { stornoRows.add(i); inhalt += `\nSTORNIERT ${fmtDT(x.storno.zeit)}${x.storno.autor ? ' (' + x.storno.autor + ')' : ''}: ${x.storno.grund}`; }
    const erf = [x.autor, x.erfasst - x.zeit > 5 * 60000 ? 'nachgetr. ' + fmtDT(x.erfasst) : ''].filter(Boolean).join('\n');
    return [x.lfd, `${fmtD(x.zeit)}\n${fmtT(x.zeit)}`, x.kat, x.von, x.an, inhalt, erf].map(pdfTxt);
  });
  doc.autoTable({
    startY: y + 2, margin: { left: M, right: M, bottom: 16 }, theme: 'grid',
    head: [['Nr.', 'Zeit', 'Kategorie', 'Von', 'An', 'Inhalt', 'Erfasst']],
    body,
    headStyles: { fillColor: blau, textColor: 255, fontSize: 8.5 },
    styles: { fontSize: 8.5, cellPadding: 1.5, valign: 'top', lineColor: [180, 186, 200], lineWidth: 0.2, overflow: 'linebreak' },
    columnStyles: { 0: { cellWidth: 9, halign: 'right' }, 1: { cellWidth: 18 }, 2: { cellWidth: 21 }, 3: { cellWidth: 20 }, 4: { cellWidth: 20 }, 6: { cellWidth: 22, fontSize: 7 } },
    didParseCell: (d) => {
      if (d.section === 'body' && stornoRows.has(d.row.index)) { d.cell.styles.textColor = [150, 150, 150]; d.cell.styles.fontStyle = 'italic'; }
    },
    didDrawCell: (d) => {
      // Stornierte Einträge: Inhalt durchstreichen (erste Zeile), damit lesbar bleibt
      if (d.section === 'body' && d.column.index === 5 && stornoRows.has(d.row.index)) {
        doc.setDrawColor(180, 40, 30); doc.setLineWidth(0.3);
        doc.line(d.cell.x + 1, d.cell.y + 1, d.cell.x + d.cell.width - 1, d.cell.y + d.cell.height - 1);
      }
    },
  });

  // Pumpenprotokoll
  if (e.pumpen.length) {
    y = doc.lastAutoTable.finalY + 8;
    if (y > H - 40) { doc.addPage(); y = 20; }
    doc.setFont('helvetica', 'bold'); doc.setFontSize(12);
    doc.text('Pumpenprotokoll', M, y);
    let gm = 0; let gmin = 0;
    const rows = e.pumpen.map((p) => {
      const st = pumpStats(p, S.eintraege, e);
      gm += st.menge; gmin += st.min;
      const laeufe = st.laeufe.map(([a, b]) => `${fmtDT(a)} - ${fmtT(b)}`);
      if (st.running != null) laeufe.push(`${fmtDT(st.running)} - läuft`);
      return [p.name, p.lpm ? fmtNum(p.lpm) : '-', laeufe.join('\n') || '-', fmtDur(st.min), p.lpm ? fmtNum(st.menge) : '-'].map(pdfTxt);
    });
    rows.push([{ content: 'Summe', colSpan: 3, styles: { fontStyle: 'bold' } }, { content: fmtDur(gmin), styles: { fontStyle: 'bold' } }, { content: fmtNum(gm), styles: { fontStyle: 'bold' } }]);
    doc.autoTable({
      startY: y + 2, margin: { left: M, right: M, bottom: 16 }, theme: 'grid',
      head: [['Pumpe', 'l/min', 'Laufzeiten', 'Betriebszeit', 'rechn. m³']],
      body: rows,
      headStyles: { fillColor: blau, textColor: 255, fontSize: 8.5 },
      styles: { fontSize: 8.5, cellPadding: 1.5, lineColor: [180, 186, 200], lineWidth: 0.2 },
      columnStyles: { 1: { halign: 'right', cellWidth: 16 }, 3: { cellWidth: 22 }, 4: { halign: 'right', cellWidth: 20 } },
    });
    doc.setFont('helvetica', 'italic'); doc.setFontSize(7.5);
    doc.text('Rechnerische Fördermenge = Nennleistung x Betriebszeit; tatsächliche Förderleistung abhängig von Förderhöhe, Leitungslänge und Medium.', M, doc.lastAutoTable.finalY + 4);
  }

  // Personal
  if (e.personal.length) {
    y = doc.lastAutoTable.finalY + 11;
    if (y > H - 40) { doc.addPage(); y = 20; }
    doc.setFont('helvetica', 'bold'); doc.setFontSize(12);
    doc.text('Personal / Einsatzstunden', M, y);
    let sum = 0;
    const rows = e.personal.map((p) => { const m = personStunden(p, e); sum += m; return [p.name, p.funktion, fmtDT(p.kommt), p.geht ? fmtDT(p.geht) : (p.kommt ? 'im Einsatz' : '-'), fmtDur(m), fmtNum(m / 60, 2)].map(pdfTxt); });
    rows.push([{ content: `Summe (${e.personal.length} Pers.)`, colSpan: 4, styles: { fontStyle: 'bold' } }, { content: fmtDur(sum), styles: { fontStyle: 'bold' } }, { content: fmtNum(sum / 60, 2), styles: { fontStyle: 'bold' } }]);
    doc.autoTable({
      startY: y + 2, margin: { left: M, right: M, bottom: 16 }, theme: 'grid',
      head: [['Name', 'Funktion', 'Beginn', 'Ende', 'Dauer', 'Std. dez.']],
      body: rows,
      headStyles: { fillColor: blau, textColor: 255, fontSize: 8.5 },
      styles: { fontSize: 8.5, cellPadding: 1.5, lineColor: [180, 186, 200], lineWidth: 0.2 },
      columnStyles: { 4: { cellWidth: 18 }, 5: { halign: 'right', cellWidth: 18 } },
    });
  }

  // Unterschrift
  y = doc.lastAutoTable.finalY + 22;
  if (y > H - 30) { doc.addPage(); y = 40; }
  doc.setDrawColor(0); doc.setLineWidth(0.3);
  doc.line(M, y, M + 70, y); doc.line(W - M - 80, y, W - M, y);
  doc.setFont('helvetica', 'normal'); doc.setFontSize(8.5);
  doc.text('Ort, Datum', M, y + 4);
  doc.text(pdfTxt(`Unterschrift Truppführer/in${e.fuehrer ? ' (' + e.fuehrer + ')' : ''}`), W - M - 80, y + 4);

  // Fotoanlage
  if (mitFotos) {
    const fotos = list.flatMap((x) => (x.fotos || []).map((f, i) => ({ x, f, i })));
    if (fotos.length) {
      doc.addPage();
      let fy = 18;
      doc.setFont('helvetica', 'bold'); doc.setFontSize(12);
      doc.text('Anlage: Fotos', M, fy); fy += 6;
      const maxW = W - 2 * M; const maxH = 110;
      for (const { x, f, i } of fotos) {
        const s = Math.min(maxW / f.w, maxH / f.h);
        const w = f.w * s; const h = f.h * s;
        if (fy + h + 10 > H - 16) { doc.addPage(); fy = 18; }
        doc.setFont('helvetica', 'normal'); doc.setFontSize(8.5);
        doc.text(pdfTxt(`Eintrag Nr. ${x.lfd} - ${fmtDT(x.zeit)} - Foto ${i + 1}${x.storno ? ' (Eintrag storniert)' : ''}`), M, fy + 3);
        doc.addImage(f.data, 'JPEG', M, fy + 5, w, h, undefined, 'FAST');
        fy += h + 12;
      }
    }
  }

  // Fußzeile
  const n = doc.getNumberOfPages();
  for (let i = 1; i <= n; i++) {
    doc.setPage(i);
    doc.setFont('helvetica', 'normal'); doc.setFontSize(7.5); doc.setTextColor(110);
    doc.text(pdfTxt(`Einsatztagebuch - ${e.bezeichnung}`).slice(0, 90), M, H - 8);
    doc.text(`Seite ${i} von ${n}`, W - M, H - 8, { align: 'right' });
    doc.setTextColor(0);
  }
  return doc.output('blob');
}

/* ---------- Sicherung / Import ---------- */
async function backupAll() {
  const es = await DB.all('einsaetze');
  if (!es.length) { toast('Keine Einsätze vorhanden'); return; }
  const map = {};
  for (const e of es) map[e.id] = await DB.byEinsatz(e.id);
  const blob = new Blob([JSON.stringify(exportObj(es, map), null, 1)], { type: 'application/json' });
  await deliver(blob, `ETB_Sicherung_${fileStamp()}.json`, 'share');
}

async function importBackup(file) {
  if (!file) return;
  try {
    const obj = JSON.parse(await file.text());
    if (obj.format !== 'etb-thw-fgr-wp' || !Array.isArray(obj.einsaetze)) throw new Error('Keine gültige Einsatztagebuch-Sicherung');
    let n = 0;
    for (const { einsatz, eintraege } of obj.einsaetze) {
      if (!einsatz?.id || !Array.isArray(eintraege)) continue;
      const vorhanden = await DB.get('einsaetze', einsatz.id);
      if (vorhanden && !(await confirmDlg('Einsatz existiert bereits', `„${esc(einsatz.bezeichnung)}“ ist schon auf diesem Gerät. Mit der Version aus der Sicherung überschreiben?`, 'Überschreiben', 'danger'))) continue;
      if (vorhanden) await DB.deleteEinsatz(einsatz.id, (await DB.byEinsatz(einsatz.id)).map((x) => x.id));
      await DB.putBoth(einsatz, eintraege.map((x) => ({ ...x, einsatzId: einsatz.id })));
      n++;
    }
    toast(`${n} Einsatz/Einsätze eingelesen`);
    S.einsatz = null;
    showHome();
  } catch (err) {
    toast('Import fehlgeschlagen: ' + err.message);
  }
}

/* ---------- Einstellungen ---------- */
function showSettings() {
  S.einsatz = null;
  setTop('Einstellungen', '', '#/');
  setTabs(null); setFab(null);
  const s = S.settings;
  const pRow = (p = {}) => `<div class="row"><input name="pname" placeholder="Bezeichnung" value="${esc(p.name || '')}"><input name="plpm" type="number" inputmode="numeric" placeholder="l/min" style="max-width:110px" value="${esc(p.lpm || '')}"><button type="button" class="btn sm" data-del>✕</button></div>`;
  const fRow = (f = {}) => `<div class="row wrap fzg"><input name="ftyp" placeholder="Fahrzeug (z. B. MzGW)" value="${esc(f.typ || '')}" style="flex:1 1 140px"><input name="ffunk" placeholder="Funkrufname" value="${esc(f.funk || '')}" style="flex:1 1 140px"><input name="fkennz" placeholder="Kennzeichen" value="${esc(f.kennz || '')}" style="flex:1 1 110px"><button type="button" class="btn sm" data-del>✕</button></div>`;
  const hRow = (h = {}) => `<div class="row"><input name="hname" placeholder="Name" value="${esc(h.name || '')}"><input name="hfkt" placeholder="Funktion" list="dlFkt" style="max-width:150px" value="${esc(h.funktion || '')}"><button type="button" class="btn sm" data-del>✕</button></div>`;
  view.innerHTML = `
    <form id="setForm">
      <div class="card">
        <label>Mein Name (Truppführer/in)<input name="name" value="${esc(s.name)}" autocomplete="name"></label>
        <label>Einheit (Standard für neue Einsätze)<input name="einheit" value="${esc(s.einheit)}"></label>
      </div>
      <h2>Standard-Pumpen</h2>
      <div class="card list-edit"><div id="pList">${(s.pumpen.length ? s.pumpen : [{}]).map(pRow).join('')}</div>
        <button type="button" class="btn sm" id="pAdd">+ Pumpe</button>
        <div class="muted small" style="margin-top:8px">Werden bei jedem neuen Einsatz automatisch übernommen. Nennleistung laut Typenschild/Ausstattung eintragen.</div></div>
      <h2>Standard-Trupp</h2>
      <div class="card list-edit"><div id="hList">${(s.helfer.length ? s.helfer : [{}]).map(hRow).join('')}</div>
        <button type="button" class="btn sm" id="hAdd">+ Helfer/in</button>
        <div class="muted small" style="margin-top:8px">Diese Personen werden bei neuen Einsätzen vorbelegt (noch nicht angemeldet).</div></div>
      <h2>Standard-Fahrzeuge</h2>
      <div class="card list-edit"><div id="fList">${(s.fahrzeuge.length ? s.fahrzeuge : [{}]).map(fRow).join('')}</div>
        <button type="button" class="btn sm" id="fAdd">+ Fahrzeug</button>
        <div class="muted small" style="margin-top:8px">Werden bei neuen Einsätzen zum Ankreuzen angeboten (standardmäßig alle ausgewählt).</div></div>
      <datalist id="dlFkt">${FUNKTIONEN.map((f) => `<option value="${esc(f)}">`).join('')}</datalist>
      <button class="btn primary block big" type="submit">Speichern</button>
    </form>
    <h2>Speicher</h2>
    <div class="card small" id="storeInfo">…</div>`;
  const f = $('#setForm');
  const bindDel = () => f.querySelectorAll('[data-del]').forEach((b) => { b.onclick = () => b.parentElement.remove(); });
  $('#pAdd').onclick = () => { $('#pList').insertAdjacentHTML('beforeend', pRow()); bindDel(); };
  $('#fAdd').onclick = () => { $('#fList').insertAdjacentHTML('beforeend', fRow()); bindDel(); };
  $('#hAdd').onclick = () => { $('#hList').insertAdjacentHTML('beforeend', hRow()); bindDel(); };
  bindDel();
  f.onsubmit = async (ev) => {
    ev.preventDefault();
    s.name = f.elements.namedItem('name').value.trim();
    s.einheit = f.elements.namedItem('einheit').value.trim();
    s.pumpen = [...$('#pList').children].map((r) => ({ name: r.querySelector('[name=pname]').value.trim(), lpm: Number(r.querySelector('[name=plpm]').value) || 0 })).filter((p) => p.name);
    s.fahrzeuge = [...$('#fList').children].map((r) => ({ typ: r.querySelector('[name=ftyp]').value.trim(), funk: r.querySelector('[name=ffunk]').value.trim(), kennz: r.querySelector('[name=fkennz]').value.trim() })).filter((f) => f.typ || f.funk);
    s.helfer = [...$('#hList').children].map((r) => ({ name: r.querySelector('[name=hname]').value.trim(), funktion: r.querySelector('[name=hfkt]').value.trim() })).filter((h) => h.name);
    await saveSettings();
    toast('Einstellungen gespeichert');
    location.hash = '#/';
  };
  storageInfo();
}

async function storageInfo() {
  const el = $('#storeInfo');
  if (!el) return;
  let txt = '';
  try {
    if (navigator.storage?.estimate) {
      const { usage, quota } = await navigator.storage.estimate();
      txt += `Belegt: ${fmtNum(usage / 1048576, 1)} MB von ca. ${fmtNum(quota / 1048576)} MB. `;
    }
    if (navigator.storage?.persisted) {
      const p = await navigator.storage.persisted();
      txt += p ? 'Daten sind vor automatischem Löschen durch den Browser geschützt.' : 'Speicher ist nicht dauerhaft geschützt – App installieren und regelmäßig sichern.';
    }
  } catch { /* ignorieren */ }
  el.textContent = txt || 'Keine Speicherinformationen verfügbar.';
}

/* ---------- Start ---------- */
(async function init() {
  try {
    await loadSettings();
  } catch (err) {
    view.innerHTML = `<div class="banner warn">Der Gerätespeicher (IndexedDB) ist nicht verfügbar: ${esc(err.message)}. Bitte nicht im privaten Modus verwenden.</div>`;
    return;
  }
  try { if (navigator.storage?.persist) await navigator.storage.persist(); } catch { /* optional */ }
  window.addEventListener('hashchange', route);
  route();
  if ('serviceWorker' in navigator && location.protocol !== 'file:') {
    navigator.serviceWorker.register('sw.js').catch((err) => console.warn('Service Worker:', err));
  }
})();
