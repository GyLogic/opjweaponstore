/* =====================================================================
   OPJ SYNC - sinkronisasi online OPJMS + OPJBARHAM + benefit ke Firestore.
   Semua tab (iframe) berbagi localStorage yang sama. Modul ini:
     1. Menarik data dari Firestore ke localStorage SEBELUM iframe dimuat.
     2. Memantau perubahan localStorage lalu mengirim hanya BARIS yang berubah.
     3. Menerima perubahan orang lain secara realtime (gabung per baris).
   Admin online = akun Firebase Auth yang sama dengan WeaponStore.
   ===================================================================== */
import { initializeApp } from "https://www.gstatic.com/firebasejs/10.14.1/firebase-app.js";
import { getFirestore, collection, doc, onSnapshot, setDoc, deleteDoc, writeBatch } from "https://www.gstatic.com/firebasejs/10.14.1/firebase-firestore.js";
import { getAuth, setPersistence, browserSessionPersistence, signInWithEmailAndPassword, signOut, onAuthStateChanged } from "https://www.gstatic.com/firebasejs/10.14.1/firebase-auth.js";

const FIREBASE_CONFIG = {
  apiKey: "AIzaSyCPnZYCmliRcVirhAN1fGMCxHqq72ZtGdY",
  authDomain: "opjweaponstore.firebaseapp.com",
  projectId: "opjweaponstore",
  storageBucket: "opjweaponstore.firebasestorage.app",
  messagingSenderId: "668573730841",
  appId: "1:668573730841:web:07435c5188a5b0ad190288"
};
const ADMIN_EMAIL = "admin@tactical-armory.app";   // harus sama dengan firestore.rules

const BH_KEY = "BARHAM_UNDERGROUND_CARTEL_V7_STATE";
const BASE_KEY = "opj_sync_base_v1";
const EMPTY_BH = () => ({ isAdmin: false, batches: [], jualan: [], packing: [], weed: [], brangkas: [], mutasi: [] });

/* kind: array (daftar baris) | object (1 dokumen JSON) | claims (map memberId -> [kunci voucher])
   order: asc = baris baru di akhir, desc = baris baru di awal (Barham memakai unshift)
   adminOnly: user biasa tidak boleh mengubah */
const COLS = [
  { name: "opj_members",     ls: "opj_members",     kind: "array", order: "asc",  adminOnly: true,  tabs: ["ms", "bh"] },
  { name: "opj_deposits",    ls: "opj_deposits",    kind: "array", order: "asc",  adminOnly: true,  tabs: ["ms"] },
  { name: "opj_handovers",   ls: "opj_handovers",   kind: "array", order: "asc",  adminOnly: true,  tabs: ["ms"] },
  { name: "opj_submissions", ls: "opj_submissions", kind: "array", order: "asc",  adminOnly: false, tabs: ["ms"] },
  { name: "opj_config",      ls: "opj_benefit_settings", kind: "object",           adminOnly: true,  tabs: [] },
  { name: "opj_claims",      ls: "opj_voucher_claims",   kind: "claims", order: "asc", adminOnly: false, tabs: [] },
  { name: "bh_batches",  ls: BH_KEY, path: "batches",  kind: "array", order: "asc",  adminOnly: true,  tabs: ["bh"], idOf: r => r.name == null ? null : "b_" + r.name },
  { name: "bh_jualan",   ls: BH_KEY, path: "jualan",   kind: "array", order: "desc", adminOnly: false, tabs: ["bh"] },
  { name: "bh_packing",  ls: BH_KEY, path: "packing",  kind: "array", order: "desc", adminOnly: false, tabs: ["bh"] },
  { name: "bh_weed",     ls: BH_KEY, path: "weed",     kind: "array", order: "desc", adminOnly: false, tabs: ["bh"] },
  { name: "bh_mutasi",   ls: BH_KEY, path: "mutasi",   kind: "array", order: "desc", adminOnly: false, tabs: ["bh"] },
  { name: "bh_brangkas", ls: BH_KEY, path: "brangkas", kind: "array", order: "desc", adminOnly: true,  tabs: ["bh"] }
];

/* ---------- util ---------- */
const $ = id => document.getElementById(id);
const stable = v => {
  if (Array.isArray(v)) return "[" + v.map(stable).join(",") + "]";
  if (v && typeof v === "object") return "{" + Object.keys(v).filter(k => k !== "_ts").sort().map(k => JSON.stringify(k) + ":" + stable(v[k])).join(",") + "}";
  return JSON.stringify(v);
};
function hash(s) {                                   // cyrb53
  let h1 = 0xdeadbeef, h2 = 0x41c6ce57;
  for (let i = 0, ch; i < s.length; i++) { ch = s.charCodeAt(i); h1 = Math.imul(h1 ^ ch, 2654435761); h2 = Math.imul(h2 ^ ch, 1597334677); }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(36);
}
const sig = r => hash(stable(r));
const clean = o => JSON.parse(JSON.stringify(o));      // buang undefined / NaN (tidak diterima Firestore)
const docIdOf = (c, r) => {
  const raw = c.idOf ? c.idOf(r) : r && r.id;
  return raw == null || raw === "" ? null : String(raw).replace(/\//g, "_").slice(0, 400);
};
const readJson = k => { try { return JSON.parse(localStorage.getItem(k)); } catch (e) { return null; } };

/* ---------- baca / tulis localStorage ---------- */
function rowsOf(c) {
  const raw = readJson(c.ls);
  if (c.kind === "object") return raw && typeof raw === "object" && Object.keys(raw).length ? [{ id: "benefit", json: JSON.stringify(raw) }] : [];
  if (c.kind === "claims") {
    const out = [];
    Object.keys(raw || {}).forEach(m => (Array.isArray(raw[m]) ? raw[m] : []).forEach(k => out.push({ id: m + "__" + k, memberId: String(m), key: String(k) })));
    return out;
  }
  const arr = c.path ? (raw && raw[c.path]) : raw;
  return Array.isArray(arr) ? arr.filter(x => x && typeof x === "object") : [];
}
function writeRows(c, rows) {
  if (c.kind === "object") {
    if (rows.length) { try { localStorage.setItem(c.ls, rows[0].json); } catch (e) {} } else localStorage.removeItem(c.ls);
    return;
  }
  if (c.kind === "claims") {
    const obj = {};
    rows.forEach(r => { (obj[r.memberId] = obj[r.memberId] || []).push(r.key); });
    localStorage.setItem(c.ls, JSON.stringify(obj));
    return;
  }
  if (c.path) {
    let obj = readJson(c.ls);
    if (!obj || typeof obj !== "object") obj = EMPTY_BH();
    obj[c.path] = rows;                              // field lain (termasuk isAdmin lokal) dibiarkan
    localStorage.setItem(c.ls, JSON.stringify(obj));
  } else localStorage.setItem(c.ls, JSON.stringify(rows));
}
function localMap(c) {
  const m = new Map(), order = [];
  rowsOf(c).forEach(r => { const id = docIdOf(c, r); if (id && !m.has(id)) { m.set(id, r); order.push(id); } });
  return { map: m, order };
}
function localAdminFlag(c) {
  if (c.ls === BH_KEY) { const o = readJson(BH_KEY); return !!(o && o.isAdmin); }
  return localStorage.getItem("opj_is_admin") === "true";
}
function anyLocalAdmin() { return localStorage.getItem("opj_is_admin") === "true" || !!(readJson(BH_KEY) || {}).isAdmin; }

/* ---------- state ---------- */
const S = {};
const baseStore = readJson(BASE_KEY) || {};
COLS.forEach(c => {
  const b = baseStore[c.name];
  S[c.name] = { cloud: new Map(), base: new Map(b ? Object.entries(b) : []), hasBase: !!b, loaded: false, busy: false, again: false, pend: new Map(), timer: null };
});
function saveBase() {
  const o = {};
  COLS.forEach(c => { o[c.name] = Object.fromEntries(S[c.name].base); });
  try { localStorage.setItem(BASE_KEY, JSON.stringify(o)); } catch (e) {}
}
let db, auth, isAdmin = false, seeded = false, metaLoaded = false, aligned = false, fatal = null, readyFired = false, loginShown = false;
const allLoaded = () => metaLoaded && COLS.every(c => S[c.name].loaded);
const markStale = c => { if (window.OPJ && window.OPJ.markStale) c.tabs.forEach(t => window.OPJ.markStale(t)); };
const fireReady = () => { if (!readyFired) { readyFired = true; window.dispatchEvent(new Event("opj-sync-ready")); } };

/* ---------- rekonsiliasi: gabung cloud + perubahan lokal per baris ---------- */
function reconcile(c, forceCloud) {
  const s = S[c.name], { map: L } = localMap(c);
  const out = [], base = new Map(s.base);
  const ids = new Set([...s.cloud.keys(), ...L.keys(), ...s.base.keys()]);
  ids.forEach(id => {
    const l = L.get(id), b = s.base.get(id), cl = s.cloud.get(id);
    const dirty = !forceCloud && ((l ? sig(l) : null) !== (b === undefined ? null : b));
    if (dirty) { if (l) out.push({ row: l, ts: cl ? cl.ts : (s.pend.has(id) ? s.pend.get(id) : Infinity) }); }   // perubahan lokal menunggu dikirim
    else if (cl) { out.push({ row: cl.row, ts: cl.ts }); base.set(id, sig(cl.row)); }
    else base.delete(id);
  });
  if (c.kind === "array") out.sort((a, b) => c.order === "desc" ? (b.ts - a.ts) : (a.ts - b.ts));
  const rows = out.map(o => o.row);
  const before = JSON.stringify(rowsOf(c)), after = JSON.stringify(rows);
  s.base = base; s.hasBase = true; saveBase();
  if (before === after) return false;
  if (forceCloud && isAdminFlagForBackup() && !localStorage.getItem("opj_presync_backup_" + c.name) && rowsOf(c).length)
    try { localStorage.setItem("opj_presync_backup_" + c.name, JSON.stringify({ at: new Date().toISOString(), rows: rowsOf(c) })); } catch (e) {}
  writeRows(c, rows);
  return true;
}
const isAdminFlagForBackup = () => anyLocalAdmin();

function onCloud(c) {
  if (!allLoaded()) return;
  if (!seeded) { ui(); trySeed(); return; }
  if (!aligned) {
    aligned = true;
    COLS.forEach(x => { if (reconcile(x, !S[x.name].hasBase)) markStale(x); });
    fireReady(); ui();
    COLS.forEach(schedulePush);
    return;
  }
  if (c && reconcile(c)) markStale(c);
  ui();
}

/* ---------- kirim perubahan lokal ke cloud ---------- */
function schedulePush(c, delay = 300) {
  const s = S[c.name];
  clearTimeout(s.timer);
  s.timer = setTimeout(() => push(c), delay);
}
async function push(c, seed) {
  const s = S[c.name];
  if (s.busy) { s.again = true; return; }
  s.busy = true;
  try { do { s.again = false; await pushOnce(c, seed); } while (s.again); }
  catch (e) { console.warn("[sync] push", c.name, e); }
  finally { s.busy = false; ui(); }
}
async function pushOnce(c, seed) {
  const s = S[c.name];
  if (!db || !s.loaded || !allLoaded()) return;
  if (!isAdmin && !seeded) return;                  // database kosong hanya boleh diisi admin
  const { map: L, order } = localMap(c);
  const ops = [], fresh = [];
  order.forEach(id => {
    const b = s.base.get(id);
    if (sig(L.get(id)) !== (b === undefined ? null : b)) { ops.push({ t: "set", id, row: L.get(id) }); if (!s.cloud.has(id)) fresh.push(id); }
  });
  s.base.forEach((_, id) => { if (!L.has(id)) ops.push({ t: "del", id }); });
  if (!ops.length) return;

  if (!isAdmin && c.adminOnly) {                    // user biasa tidak boleh mengubah koleksi ini
    if (localAdminFlag(c)) return;                  // admin lokal yang belum login online: tahan sebagai perubahan tertunda
    ops.forEach(op => revertOp(s, op));
    if (reconcile(c)) markStale(c);
    return;
  }

  const n = fresh.length, now = seed ? (c.order === "desc" ? Date.now() - n - 5 : 0) : Date.now();
  fresh.forEach((id, j) => s.pend.set(id, c.order === "desc" ? now + (n - 1 - j) : now + j));
  const dataOf = op => ({ ...clean(op.row), _ts: (s.cloud.get(op.id) || {}).ts ?? s.pend.get(op.id) ?? Date.now() });
  const fail = [];

  if (isAdmin) {
    for (let i = 0; i < ops.length; i += 400) {
      const part = ops.slice(i, i + 400), batch = writeBatch(db);
      part.forEach(op => { const ref = doc(db, c.name, op.id); op.t === "set" ? batch.set(ref, dataOf(op)) : batch.delete(ref); });
      try { await batch.commit(); part.forEach(op => ack(s, op)); }
      catch (e) { part.forEach(op => fail.push({ op, e })); }
    }
  } else {
    const res = await Promise.allSettled(ops.map(op => op.t === "set" ? setDoc(doc(db, c.name, op.id), dataOf(op)) : deleteDoc(doc(db, c.name, op.id))));
    res.forEach((r, i) => { if (r.status === "fulfilled") ack(s, ops[i]); else fail.push({ op: ops[i], e: r.reason }); });
  }
  let reverted = false;
  fail.forEach(({ op, e }) => {
    if (e && e.code === "permission-denied" && !isAdmin) { revertOp(s, op); reverted = true; }
    else { console.warn("[sync] gagal kirim", c.name, op.id, e); fatal = fatal || (e && e.code) || "error"; }
  });
  saveBase();
  if (reverted && reconcile(c)) { markStale(c); toast("Sebagian perubahan ditolak server (tidak punya izin) dan dikembalikan."); }
  if (!fail.length) fatal = null;
}
const ack = (s, op) => { if (op.t === "set") s.base.set(op.id, sig(op.row)); else s.base.delete(op.id); };
const revertOp = (s, op) => { if (op.t === "set") s.base.set(op.id, sig(op.row)); else s.base.delete(op.id); };   // anggap sudah selaras -> rekonsiliasi mengambil versi cloud

/* ---------- seeding pertama (admin saja) ---------- */
let seedAsked = false;
async function trySeed() {
  if (!isAdmin || seeded || !allLoaded() || seedAsked) return;
  seedAsked = true;
  if (!confirm("Database online masih kosong.\n\nKirim data OPJMS, Barham & pengaturan benefit yang ada di perangkat ini ke online?\n\n(Lakukan ini dari perangkat yang berisi data asli. Disarankan backup JSON dulu.)")) { seedAsked = false; return; }
  try {
    for (const c of COLS) { S[c.name].base = new Map(); await push(c, true); }
    await setDoc(doc(db, "opj_meta", "state"), { seeded: true, at: Date.now() });
    toast("Data berhasil dikirim ke database online.");
  } catch (e) { fatal = e.code || "error"; seedAsked = false; toast("Gagal mengisi database: " + (e.message || e)); }
  ui();
}

/* ---------- deteksi perubahan localStorage (dari iframe) ---------- */
const lastRaw = {};
function checkLocal() {
  const keys = [...new Set(COLS.map(c => c.ls))];
  keys.forEach(k => {
    const raw = localStorage.getItem(k);
    if (lastRaw[k] !== raw) { lastRaw[k] = raw; COLS.filter(c => c.ls === k).forEach(c => schedulePush(c)); }
  });
  // Dialog login admin online TIDAK muncul otomatis; hanya lewat tombol ☁ di bar atas.
}
window.addEventListener("storage", checkLocal);
setInterval(checkLocal, 1500);
setInterval(() => { if (allLoaded()) COLS.forEach(c => schedulePush(c, 0)); }, 12000);   // coba ulang yang gagal

/* ---------- UI: badge, tombol, dialog login ---------- */
function dirtyCount() {
  let n = 0;
  COLS.forEach(c => {
    const s = S[c.name], { map: L } = localMap(c);
    L.forEach((r, id) => { if (sig(r) !== (s.base.has(id) ? s.base.get(id) : null)) n++; });
    s.base.forEach((_, id) => { if (!L.has(id)) n++; });
  });
  return n;
}
function ui() {
  const badge = $("syncBadge"), btn = $("btnOnline");
  if (badge) {
    let t, col;
    const dirty = (aligned || !seeded) && allLoaded() ? dirtyCount() : 0;
    if (fatal) { t = "⚠️ Gagal sinkron" + (fatal === "permission-denied" ? " (cek Firestore Rules)" : ""); col = "#f87171"; }
    else if (!allLoaded()) { t = "⏳ Menghubungkan..."; col = "#fbbf24"; }
    else if (!seeded) { t = isAdmin ? "🟡 Database kosong" : "🟡 Mode lokal (database online kosong)"; col = "#fbbf24"; }
    else if (!isAdmin && dirty && anyLocalAdmin()) { t = "🟠 " + dirty + " perubahan belum tersimpan - login online"; col = "#fb923c"; }
    else if (dirty) { t = "🔄 Menyimpan " + dirty + " perubahan..."; col = "#fbbf24"; }
    else { t = "🟢 Online & tersinkron"; col = "#34d399"; }
    badge.textContent = t; badge.style.color = col;
  }
  if (btn) btn.textContent = isAdmin ? "🔓 Admin Online (Logout)" : "🔐 Login Online";
}
function toast(msg) {
  let t = $("syncToast");
  if (!t) { t = document.createElement("div"); t.id = "syncToast"; t.style.cssText = "position:fixed;bottom:16px;right:16px;z-index:9999;background:#121a2a;border:1px solid #2d3a52;color:#e2e8f0;padding:10px 14px;border-radius:10px;font-size:12px;max-width:340px"; document.body.appendChild(t); }
  t.textContent = msg; t.style.display = "block";
  clearTimeout(t._h); t._h = setTimeout(() => { t.style.display = "none"; }, 5000);
}
function showLogin(msg) {
  let ov = $("syncLogin");
  if (!ov) {
    ov = document.createElement("div"); ov.id = "syncLogin";
    ov.style.cssText = "position:fixed;inset:0;z-index:9998;background:#000c;display:none;align-items:center;justify-content:center;padding:16px";
    ov.innerHTML = '<form style="background:#121a2a;border:1px solid #2d3a52;border-radius:14px;padding:18px;width:100%;max-width:340px;color:#cbd5e1;font-size:13px">' +
      '<h3 style="margin:0 0 6px;color:#f59e0b;font-size:15px">Login Admin Online</h3><p id="syncLoginMsg" style="margin:0 0 10px;color:#94a3b8;font-size:11px"></p>' +
      '<input type="password" id="syncPwd" placeholder="Password admin (sama dengan WeaponStore)" style="width:100%;box-sizing:border-box;background:#0b0f19;border:1px solid #2d3a52;border-radius:8px;color:#fff;padding:8px 10px">' +
      '<p id="syncLoginErr" style="display:none;margin:6px 0 0;color:#fda4af;font-size:11px"></p>' +
      '<div style="display:flex;gap:8px;justify-content:flex-end;margin-top:12px"><button type="button" id="syncCancel" style="background:#0b0f19;border:1px solid #2d3a52;color:#9fb0cc;border-radius:8px;padding:7px 14px;cursor:pointer">Batal</button>' +
      '<button type="submit" style="background:#f59e0b;border:0;color:#000;font-weight:700;border-radius:8px;padding:7px 16px;cursor:pointer">Masuk</button></div></form>';
    document.body.appendChild(ov);
    ov.querySelector("#syncCancel").onclick = () => { ov.style.display = "none"; };
    ov.querySelector("form").onsubmit = async e => {
      e.preventDefault();
      const err = ov.querySelector("#syncLoginErr"), pwd = ov.querySelector("#syncPwd").value;
      err.style.display = "none";
      if (!auth) { err.textContent = "Belum terhubung ke Firebase."; err.style.display = "block"; return; }
      try {
        await signInWithEmailAndPassword(auth, ADMIN_EMAIL, pwd);
        ov.style.display = "none"; ov.querySelector("#syncPwd").value = "";
        reloadWeaponStoreIfIdle();
      } catch (ex) {
        err.textContent = ex.code === "auth/network-request-failed" ? "Tidak ada koneksi internet." : ex.code === "auth/too-many-requests" ? "Terlalu banyak percobaan, coba lagi nanti." : "Password salah.";
        err.style.display = "block";
      }
    };
  }
  ov.querySelector("#syncLoginMsg").textContent = msg || "Dibutuhkan agar perubahan data tersimpan ke database online.";
  ov.style.display = "flex";
  setTimeout(() => ov.querySelector("#syncPwd").focus(), 50);
}
// Sesi login dibagi lewat sessionStorage, jadi WeaponStore otomatis ikut admin setelah dimuat ulang (jika keranjang kosong)
function reloadWeaponStoreIfIdle() {
  try {
    const f = $("f-ws"), cnt = f.contentDocument.getElementById("cartCountBadge");
    if (cnt && /^0\b/.test(cnt.textContent.trim()) && window.OPJ) window.OPJ.reload("ws");
  } catch (e) {}
}

/* ---------- start ---------- */
(async function start() {
  const bt = $("btnOnline");
  if (bt) bt.onclick = async () => { if (isAdmin && auth) { try { await signOut(auth); } catch (e) {} } else showLogin(); };
  try {
    const app = initializeApp(FIREBASE_CONFIG);
    db = getFirestore(app); auth = getAuth(app);
    await setPersistence(auth, browserSessionPersistence);
    onAuthStateChanged(auth, u => {
      isAdmin = !!u && u.email === ADMIN_EMAIL;
      if (u && !isAdmin) { signOut(auth); return; }
      if (isAdmin) { trySeed(); COLS.forEach(c => schedulePush(c, 0)); }
      ui();
    });
    COLS.forEach(c => onSnapshot(collection(db, c.name), snap => {
      const m = new Map();
      snap.forEach(d => { const { _ts, ...row } = d.data(); m.set(d.id, { row, ts: typeof _ts === "number" ? _ts : 0 }); });
      const s = S[c.name]; s.cloud = m; s.loaded = true; fatal = fatal === "permission-denied" ? null : fatal;
      onCloud(c);
    }, e => { fatal = e.code || "error"; console.warn("[sync] snapshot", c.name, e); ui(); fireReady(); }));
    onSnapshot(doc(db, "opj_meta", "state"), snap => {
      seeded = !!(snap.exists() && snap.data().seeded); metaLoaded = true;
      onCloud(null);
    }, e => { fatal = e.code || "error"; ui(); fireReady(); });
  } catch (e) {
    fatal = e.code || "error"; console.warn("[sync] start", e); ui(); fireReady();
  }
  ui();
  setTimeout(() => { if (!readyFired) { fireReady(); } }, 4500);
})();

window.OPJSync = { status: () => ({ isAdmin, seeded, aligned, dirty: dirtyCount(), fatal }), pushAll: () => COLS.forEach(c => schedulePush(c, 0)) };
