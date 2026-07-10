import { useState, useEffect, useRef } from "react";

// ── constants ─────────────────────────────────────────────────────────────
const TANK_VOLUME_L = 485;
const ALK_FACTOR = 17.848; // mg CaCO3-equivalent per litre per dKH
const MAX_WINDOW = 6;      // consumption is calculated over up to this many tests

const TARGETS = {
  alk:  { label: "Alkalinity", unit: "dKH",  min: 8,      max: 12,    ideal: 9.5  },
  ca:   { label: "Calcium",    unit: "ppm",  min: 430,    max: 465,   ideal: 447  },
  mg:   { label: "Magnesium",  unit: "ppm",  min: 1250,   max: 1390,  ideal: 1320 },
  ph:   { label: "pH",         unit: "pH",   min: 7.8,    max: 8.5,   ideal: 8.2  },
  no3:  { label: "Nitrate",    unit: "ppm",  min: 1,      max: 4.5,   ideal: 2.5  },
  po4:  { label: "Phosphate",  unit: "ppm",  min: 0.02,   max: 0.10,  ideal: 0.05 },
  temp: { label: "Temperature",unit: "°C",   min: 24,     max: 26,    ideal: 25   },
  sal:  { label: "Salinity",   unit: "SG",   min: 1.025,  max: 1.027, ideal: 1.026},
};

// Default dosing solution concentrations (mg of parameter per ml of solution)
// Alkalinity: anhydrous Na₂CO₃ at 133.1 g/L in RO water → 125.7 mg CaCO₃-equiv per ml
// Calcium:    CaCl₂·2H₂O at 348 g/L in RO water        →  94.9 mg Ca per ml
// Magnesium:  MgCl₂·6H₂O 247 g + MgSO₄·7H₂O 175 g in 2 L RO water → 23.4 mg Mg per ml
const DOSE_CONC = { alk: 125.7, ca: 94.9, mg: 23.4 };

// Maximum safe daily adjustment per parameter
const MAX_DAILY = { alk: 1.2, ca: 20, mg: 10 };

// Ratio indicators
const RATIOS = {
  mgca: {
    label: "Mg : Ca ratio", top: "mg", bottom: "ca",
    ideal: 2.95, min: 2.7, max: 3.25,
    lowText: "Magnesium is low relative to calcium — check the magnesium dose before chasing calcium.",
    highText: "Magnesium is high relative to calcium — ease the magnesium dose or raise calcium.",
    okText: "Calcium and magnesium are in proportion.",
  },
  no3po4: {
    label: "NO₃ : PO₄ ratio", top: "no3", bottom: "po4",
    ideal: 50, min: 20, max: 100,
    lowText: "Nitrate is low relative to phosphate — the tank is nitrate-limited.",
    highText: "Phosphate is low relative to nitrate — phosphate-limited; watch for cyanobacteria.",
    okText: "Nutrients are in balance.",
  },
};

const PARAM_KEYS = Object.keys(TARGETS);
const DOSED_PARAMS = ["alk", "ca", "mg"];

const STORAGE_KEY = "reeftank_v2";
const LEGACY_KEY  = "reeftank_v1";
const SYNC_KEY    = "reeftank_sync";

// ── data layer ───────────────────────────────────────────────────────────────
function nowIso() { return new Date().toISOString(); }

function uid(prefix, date) {
  return `${prefix}-${date || ""}-${Math.random().toString(36).slice(2, 8)}`;
}

function emptyData() {
  return {
    readings: [],
    doseEvents: [],
    doses: { alk: 5, ca: 5, mg: 5 },
    conc: { ...DOSE_CONC },
    deleted: { readings: [], doseEvents: [] },
    updatedAt: nowIso(),
  };
}

function normalise(raw) {
  const d = emptyData();
  if (!raw || typeof raw !== "object") return d;
  if (Array.isArray(raw.readings)) {
    d.readings = raw.readings.map((r, i) => ({
      ...r,
      id: r.id || `r-${r.date}-${i}`,           // deterministic for old exports
      updatedAt: r.updatedAt || "1970-01-01T00:00:00.000Z",
    }));
  }
  if (Array.isArray(raw.doseEvents)) d.doseEvents = raw.doseEvents.filter(e => e && e.id);
  if (raw.doses) d.doses = { ...d.doses, ...raw.doses };
  if (raw.conc)  d.conc  = { ...d.conc,  ...raw.conc };
  if (raw.deleted) d.deleted = {
    readings:   Array.isArray(raw.deleted.readings)   ? raw.deleted.readings   : [],
    doseEvents: Array.isArray(raw.deleted.doseEvents) ? raw.deleted.doseEvents : [],
  };
  if (raw.updatedAt) d.updatedAt = raw.updatedAt;
  d.readings.sort((a, b) => (a.date < b.date ? -1 : 1));
  d.doseEvents.sort((a, b) => (a.date < b.date ? -1 : 1));
  return d;
}

function load() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) return normalise(JSON.parse(raw));
    const legacy = localStorage.getItem(LEGACY_KEY);
    if (legacy) return normalise(JSON.parse(legacy)); // migrate v1 → v2
    return emptyData();
  } catch { return emptyData(); }
}

function save(data) {
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(data)); } catch {}
}

function loadSync() {
  try { return JSON.parse(localStorage.getItem(SYNC_KEY)) || { token: "" }; }
  catch { return { token: "" }; }
}

function saveSync(s) {
  try { localStorage.setItem(SYNC_KEY, JSON.stringify(s)); } catch {}
}

// Union two datasets: newest version of each record wins, tombstones win over all.
function mergeById(listA, listB, deletedIds) {
  const map = new Map();
  [...(listA || []), ...(listB || [])].forEach(item => {
    if (!item || !item.id) return;
    const prev = map.get(item.id);
    if (!prev || (item.updatedAt || "") > (prev.updatedAt || "")) map.set(item.id, item);
  });
  deletedIds.forEach(id => map.delete(id));
  return [...map.values()].sort((a, b) => (a.date < b.date ? -1 : 1));
}

function mergeData(a, b) {
  const delR = [...new Set([...(a.deleted?.readings || []), ...(b.deleted?.readings || [])])];
  const delD = [...new Set([...(a.deleted?.doseEvents || []), ...(b.deleted?.doseEvents || [])])];
  const newer = (a.updatedAt || "") >= (b.updatedAt || "") ? a : b;
  return {
    readings:   mergeById(a.readings, b.readings, delR),
    doseEvents: mergeById(a.doseEvents, b.doseEvents, delD),
    doses: { alk: 5, ca: 5, mg: 5, ...(newer.doses || {}) },
    conc:  { ...DOSE_CONC, ...(newer.conc || {}) },
    deleted: { readings: delR, doseEvents: delD },
    updatedAt: (a.updatedAt || "") >= (b.updatedAt || "") ? (a.updatedAt || nowIso()) : (b.updatedAt || nowIso()),
  };
}

// ── chemistry helpers ────────────────────────────────────────────────────────
function hasVal(v) {
  return v !== "" && v !== null && v !== undefined && !isNaN(parseFloat(v));
}

// ml of solution → change in parameter (dKH or ppm) across the whole tank
function mlToUnits(param, ml, conc) {
  if (param === "alk") return (ml * conc) / (ALK_FACTOR * TANK_VOLUME_L);
  return (ml * conc) / TANK_VOLUME_L;
}

// desired change in parameter → ml of solution required
function unitsToMl(param, units, conc) {
  if (param === "alk") return (units * ALK_FACTOR * TANK_VOLUME_L) / conc;
  return (units * TANK_VOLUME_L) / conc;
}

function maxSafeDoseMl(param, conc) {
  return unitsToMl(param, MAX_DAILY[param], conc);
}

function statusColor(key, val) {
  if (!hasVal(val)) return "#B8ADA0";
  const t = TARGETS[key];
  const v = parseFloat(val);
  if (v < t.min || v > t.max) return "#B84A2E";
  const mid = (t.min + t.max) / 2;
  const range = (t.max - t.min) / 2;
  const dist = Math.abs(v - mid) / range;
  if (dist < 0.4) return "#5F6B42";
  return "#c9a84c";
}

function statusLabel(key, val) {
  if (!hasVal(val)) return "—";
  const t = TARGETS[key];
  const v = parseFloat(val);
  if (v < t.min) return "LOW";
  if (v > t.max) return "HIGH";
  return "OK";
}

// Consumption over an adaptive window of tests, corrected for logged doses.
// Uses up to MAX_WINDOW most recent tests: two when only two exist, three when
// three exist, and so on. A least-squares fit over bolus-corrected values gives
// the decline per day (net of the daily pump dose). A dose logged on the same
// date as a test is treated as given AFTER that test.
function calcConsumption(readings, doseEvents, key) {
  const valid = readings
    .filter(r => hasVal(r[key]))
    .slice()
    .sort((a, b) => (a.date < b.date ? -1 : 1));
  if (valid.length < 2) return null;

  const win = valid.slice(-Math.min(valid.length, MAX_WINDOW));
  const start = win[0], end = win[win.length - 1];
  const events = (doseEvents || []).filter(e =>
    e.param === key && e.date >= start.date && e.date < end.date
  );

  const t0 = new Date(start.date).getTime();
  const pts = win.map(r => {
    const x = (new Date(r.date).getTime() - t0) / 86400000;
    const bolus = events
      .filter(e => e.date < r.date)
      .reduce((s, e) => s + (e.delta || 0), 0);
    return { x, y: parseFloat(r[key]) - bolus };
  });

  const n = pts.length;
  const mx = pts.reduce((s, p) => s + p.x, 0) / n;
  const my = pts.reduce((s, p) => s + p.y, 0) / n;
  let num = 0, den = 0;
  pts.forEach(p => { num += (p.x - mx) * (p.y - my); den += (p.x - mx) * (p.x - mx); });
  if (den === 0) return null;

  return {
    perDay: -(num / den),                 // fall per day, net of daily dosing
    days: pts[n - 1].x,
    n,
    bolusCount: events.length,
    bolusTotal: events.reduce((s, e) => s + (e.delta || 0), 0),
    latest: parseFloat(end[key]),
  };
}

// One-off correction to bring the latest value up to ideal
function calcBolus(key, currentVal, conc) {
  const t = TARGETS[key];
  const current = parseFloat(currentVal);
  if (isNaN(current)) return null;
  const deficit = t.ideal - current;
  if (deficit <= 0) return null;
  const mlNeeded = unitsToMl(key, deficit, conc);
  const safePerDay = maxSafeDoseMl(key, conc);
  const daysNeeded = Math.ceil(mlNeeded / safePerDay);
  return {
    deficit: deficit.toFixed(2),
    ml: mlNeeded.toFixed(1),
    daysNeeded,
    mlPerDay: daysNeeded > 1 ? (mlNeeded / daysNeeded).toFixed(1) : null,
  };
}

// Suggested change to the daily pump dose
function calcDoseAdj(key, perDay, currentDoseMl, conc) {
  if (perDay === null || perDay === undefined) return null;
  const t = TARGETS[key];
  const deliveredPerDay = mlToUnits(key, currentDoseMl, conc);
  const suggested = Math.max(0, currentDoseMl + unitsToMl(key, perDay, conc));
  const safeDose = maxSafeDoseMl(key, conc);
  return {
    deliveredPerDay: deliveredPerDay.toFixed(3),
    consumedPerDay: (perDay + deliveredPerDay).toFixed(3),
    suggestedDose: suggested.toFixed(1),
    exceedsLimit: suggested > safeDose,
    safeDose: safeDose.toFixed(1),
    unit: t.unit,
  };
}

// ── sync layer ───────────────────────────────────────────────────────────────
const API = "/api/state";

async function apiPull(token) {
  const res = await fetch(API, { headers: { Authorization: `Bearer ${token}` } });
  if (res.status === 401) throw new Error("Sync token rejected — check it in Settings");
  if (!res.ok) throw new Error(`Server error ${res.status}`);
  return res.json(); // null if the server has no data yet
}

async function apiPush(token, data) {
  const res = await fetch(API, {
    method: "PUT",
    headers: { Authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify(data),
  });
  if (res.status === 401) throw new Error("Sync token rejected — check it in Settings");
  if (!res.ok) throw new Error(`Push failed (${res.status})`);
}

// ── small components ─────────────────────────────────────────────────────────
function Pill({ color, label }) {
  return (
    <span style={{
      display: "inline-block", padding: "2px 8px", borderRadius: 99,
      background: color + "22", color, fontSize: 11, fontWeight: 600,
      letterSpacing: "0.05em", fontFamily: "monospace",
    }}>{label}</span>
  );
}

function GaugeBar({ paramKey, value }) {
  const t = TARGETS[paramKey];
  const v = parseFloat(value);
  if (isNaN(v)) return null;
  const pct = Math.min(100, Math.max(0, ((v - t.min) / (t.max - t.min)) * 100));
  const color = statusColor(paramKey, v);
  return (
    <div style={{ width: "100%", height: 4, background: "#2A242022", borderRadius: 2, marginTop: 4 }}>
      <div style={{ width: `${pct}%`, height: "100%", background: color, borderRadius: 2, transition: "width 0.4s" }} />
    </div>
  );
}

function ReadingCard({ paramKey, value }) {
  const t = TARGETS[paramKey];
  const color = statusColor(paramKey, value);
  const label = statusLabel(paramKey, value);
  return (
    <div style={{
      background: "#2A242015", borderRadius: 10, padding: "12px 14px",
      borderLeft: `3px solid ${color}`,
    }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
        <span style={{ fontSize: 12, color: "#B8ADA0", fontFamily: "serif" }}>{t.label}</span>
        <Pill color={color} label={label} />
      </div>
      <div style={{ fontSize: 22, fontWeight: 600, color: "#2A2420", fontFamily: "serif", marginTop: 2 }}>
        {hasVal(value)
          ? `${value} ${t.unit}`
          : <span style={{ color: "#B8ADA0", fontSize: 16 }}>not recorded</span>}
      </div>
      <div style={{ fontSize: 10, color: "#B8ADA0", marginTop: 2 }}>
        range: {t.min}–{t.max} {t.unit}
      </div>
      {hasVal(value) && <GaugeBar paramKey={paramKey} value={value} />}
    </div>
  );
}

function RatioCard({ ratioKey, reading }) {
  const r = RATIOS[ratioKey];
  const top = parseFloat(reading?.[r.top]);
  const bottom = parseFloat(reading?.[r.bottom]);
  const ok = !isNaN(top) && !isNaN(bottom) && bottom > 0;
  const ratio = ok ? top / bottom : null;
  let color = "#B8ADA0", text = "Needs both values recorded.";
  if (ratio !== null) {
    if (ratio < r.min)      { color = "#B84A2E"; text = r.lowText; }
    else if (ratio > r.max) { color = "#B84A2E"; text = r.highText; }
    else                    { color = "#5F6B42"; text = r.okText; }
  }
  return (
    <div style={{
      background: "#2A242015", borderRadius: 10, padding: "12px 14px",
      borderLeft: `3px solid ${color}`,
    }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
        <span style={{ fontSize: 12, color: "#B8ADA0", fontFamily: "serif" }}>{r.label}</span>
        {ratio !== null && (
          <Pill color={color} label={ratio < r.min ? "LOW" : ratio > r.max ? "HIGH" : "OK"} />
        )}
      </div>
      <div style={{ fontSize: 22, fontWeight: 600, color: "#2A2420", fontFamily: "serif", marginTop: 2 }}>
        {ratio !== null
          ? `${ratio.toFixed(ratioKey === "mgca" ? 2 : 0)} : 1`
          : <span style={{ color: "#B8ADA0", fontSize: 16 }}>—</span>}
      </div>
      <div style={{ fontSize: 10, color: "#B8ADA0", marginTop: 2 }}>
        target ~{r.ideal} : 1 (band {r.min}–{r.max})
      </div>
      <div style={{ fontSize: 11, color, marginTop: 4, lineHeight: 1.4 }}>{text}</div>
    </div>
  );
}

function TrendSparkline({ readings, paramKey }) {
  const valid = readings.filter(r => hasVal(r[paramKey])).slice(-10);
  if (valid.length < 2) return <div style={{ color: "#B8ADA0", fontSize: 12 }}>Not enough data yet</div>;
  const t = TARGETS[paramKey];
  const vals = valid.map(r => parseFloat(r[paramKey]));
  const allMin = Math.min(...vals, t.min) * 0.98;
  const allMax = Math.max(...vals, t.max) * 1.02;
  const W = 280, H = 70;
  const x = (i) => (i / (valid.length - 1)) * W;
  const y = (v) => H - ((v - allMin) / (allMax - allMin)) * H;
  const rangeY1 = y(t.max), rangeY2 = y(t.min);
  const path = vals.map((v, i) => `${i === 0 ? "M" : "L"}${x(i).toFixed(1)},${y(v).toFixed(1)}`).join(" ");
  return (
    <svg width={W} height={H} style={{ display: "block", overflow: "visible" }}>
      <rect x={0} y={rangeY1} width={W} height={rangeY2 - rangeY1} fill="#5F6B4220" rx={2} />
      <path d={path} fill="none" stroke="#B84A2E" strokeWidth={2} strokeLinejoin="round" />
      {vals.map((v, i) => (
        <circle key={i} cx={x(i)} cy={y(v)} r={3} fill="#B84A2E" />
      ))}
    </svg>
  );
}

const inputStyle = {
  display: "block", width: "100%", marginTop: 4,
  background: "#2A242010", border: "1px solid #B8ADA040",
  borderRadius: 8, padding: "10px 12px", fontSize: 15,
  color: "#2A2420", fontFamily: "inherit",
};

const smallInputStyle = {
  display: "block", width: "90px", marginTop: 3,
  background: "#2A242015", border: "1px solid #B8ADA040",
  borderRadius: 6, padding: "6px 10px", fontSize: 15,
  color: "#2A2420", fontFamily: "inherit",
};

// ── main app ─────────────────────────────────────────────────────────────────
export default function ReefApp() {
  const [data, setData] = useState(load);
  const [view, setView] = useState("dashboard");
  const [editingId, setEditingId] = useState(null);
  const [form, setForm] = useState(() => blankForm());
  const [doseForm, setDoseForm] = useState({
    param: "alk", ml: "", date: new Date().toISOString().slice(0, 10), note: "",
  });
  const [sync, setSync] = useState(loadSync);
  const [syncStatus, setSyncStatus] = useState(() =>
    loadSync().token ? { state: "syncing", msg: "" } : { state: "off", msg: "" });
  const [saved, setSaved] = useState(false);

  const pushTimer = useRef(null);
  const firstRender = useRef(true);
  const dataRef = useRef(data);
  dataRef.current = data;

  function blankForm() {
    const f = { date: new Date().toISOString().slice(0, 10), notes: "" };
    PARAM_KEYS.forEach(k => f[k] = "");
    return f;
  }

  // persist locally + debounce a push to the server
  useEffect(() => {
    save(data);
    if (firstRender.current) { firstRender.current = false; return; }
    if (!sync.token) return;
    clearTimeout(pushTimer.current);
    pushTimer.current = setTimeout(async () => {
      try {
        setSyncStatus({ state: "syncing", msg: "" });
        await apiPush(sync.token, dataRef.current);
        setSyncStatus({ state: "ok", msg: `Synced ${new Date().toLocaleTimeString()}` });
      } catch (e) {
        setSyncStatus({
          state: "error",
          msg: e.message === "Failed to fetch" ? "Offline — changes saved on this device" : (e.message || "Sync failed"),
        });
      }
    }, 1500);
  }, [data, sync.token]);

  // pull-and-merge on load and on demand
  async function pullNow(token) {
    const t = token ?? sync.token;
    if (!t) { setSyncStatus({ state: "off", msg: "" }); return; }
    try {
      setSyncStatus({ state: "syncing", msg: "" });
      const server = await apiPull(t);
      const merged = server ? mergeData(normalise(server), dataRef.current) : dataRef.current;
      setData(merged);
      await apiPush(t, merged);
      setSyncStatus({ state: "ok", msg: `Synced ${new Date().toLocaleTimeString()}` });
    } catch (e) {
      setSyncStatus({
        state: "error",
        msg: e.message === "Failed to fetch"
          ? "Offline — using this device's data"
          : (e.message || "Sync failed"),
      });
    }
  }

  useEffect(() => { if (sync.token) pullNow(sync.token); }, []); // eslint-disable-line

  const lastReading = data.readings.length > 0 ? data.readings[data.readings.length - 1] : null;

  function touch(d) { return { ...d, updatedAt: nowIso() }; }

  function submitReading() {
    const entry = {
      id: editingId || uid("r", form.date),
      date: form.date,
      notes: form.notes || "",
      updatedAt: nowIso(),
      ...Object.fromEntries(PARAM_KEYS.map(k => [k, form[k]])),
    };
    setData(d => touch({
      ...d,
      readings: [...d.readings.filter(r => r.id !== entry.id), entry]
        .sort((a, b) => (a.date < b.date ? -1 : 1)),
    }));
    setEditingId(null);
    setForm(blankForm());
    setSaved(true);
    setTimeout(() => setSaved(false), 2000);
    setView("dashboard");
  }

  function editReading(r) {
    const f = { date: r.date, notes: r.notes || "" };
    PARAM_KEYS.forEach(k => f[k] = r[k] ?? "");
    setForm(f);
    setEditingId(r.id);
    setView("test");
  }

  function deleteReading(id) {
    if (!window.confirm("Delete this reading?")) return;
    setData(d => touch({
      ...d,
      readings: d.readings.filter(r => r.id !== id),
      deleted: { ...d.deleted, readings: [...d.deleted.readings, id] },
    }));
  }

  function logDose(param, ml, date, note) {
    const mlNum = parseFloat(ml);
    if (isNaN(mlNum) || mlNum <= 0) return;
    const conc = data.conc[param];
    const ev = {
      id: uid("d", date),
      date, param, ml: mlNum, conc,
      delta: mlToUnits(param, mlNum, conc),
      note: note || "",
      updatedAt: nowIso(),
    };
    setData(d => touch({
      ...d,
      doseEvents: [...d.doseEvents, ev].sort((a, b) => (a.date < b.date ? -1 : 1)),
    }));
  }

  function deleteDose(id) {
    if (!window.confirm("Delete this dose entry?")) return;
    setData(d => touch({
      ...d,
      doseEvents: d.doseEvents.filter(e => e.id !== id),
      deleted: { ...d.deleted, doseEvents: [...d.deleted.doseEvents, id] },
    }));
  }

  function updateDose(key, val) {
    setData(d => touch({ ...d, doses: { ...d.doses, [key]: parseFloat(val) || 0 } }));
  }

  function updateConc(key, val) {
    setData(d => touch({ ...d, conc: { ...d.conc, [key]: parseFloat(val) || 0 } }));
  }

  function exportData() {
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url; a.download = `reef-data-${new Date().toISOString().slice(0, 10)}.json`;
    a.click();
  }

  function importData(file) {
    const reader = new FileReader();
    reader.onload = () => {
      try {
        const imported = normalise(JSON.parse(reader.result));
        if (!imported.readings.length && !imported.doseEvents.length) {
          window.alert("That file contains no readings or dose entries.");
          return;
        }
        setData(d => touch(mergeData(d, imported)));
        window.alert(`Imported and merged: ${imported.readings.length} readings, ${imported.doseEvents.length} dose entries.`);
      } catch {
        window.alert("Could not read that file — it doesn't look like a reef-tank export.");
      }
    };
    reader.readAsText(file);
  }

  function clearAll() {
    if (!window.confirm("Delete all readings and dose entries? This also removes them from the sync server. This cannot be undone.")) return;
    setData(d => touch({
      ...d,
      readings: [],
      doseEvents: [],
      deleted: {
        readings: [...d.deleted.readings, ...d.readings.map(r => r.id)],
        doseEvents: [...d.deleted.doseEvents, ...d.doseEvents.map(e => e.id)],
      },
    }));
  }

  // ── nav ────────────────────────────────────────────────────────────────────
  const navItems = [
    { id: "dashboard", label: "Dashboard" },
    { id: "test",      label: "Test Session" },
    { id: "dose",      label: "Dosing" },
    { id: "history",   label: "History" },
    { id: "trends",    label: "Trends" },
    { id: "settings",  label: "Settings" },
  ];

  const syncDot = {
    off: "#B8ADA0", syncing: "#c9a84c", ok: "#5F6B42", error: "#B84A2E",
  }[syncStatus.state];

  // ── render ─────────────────────────────────────────────────────────────────
  return (
    <div style={{
      fontFamily: "'Georgia', serif",
      background: "linear-gradient(160deg, #F4EEE1 0%, #ede5d4 100%)",
      minHeight: "100vh", color: "#2A2420",
      maxWidth: 500, margin: "0 auto",
    }}>
      {/* Header */}
      <div style={{
        background: "#2A2420", color: "#F4EEE1",
        padding: "20px 20px 0", position: "sticky", top: 0, zIndex: 10,
      }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
          <div style={{ fontSize: 11, letterSpacing: "0.15em", color: "#B8ADA0", textTransform: "uppercase" }}>
            South Kent Reef
          </div>
          <div title={syncStatus.msg || syncStatus.state} style={{
            width: 8, height: 8, borderRadius: 99, background: syncDot,
          }} />
        </div>
        <div style={{ fontSize: 22, fontWeight: 600, marginBottom: 12 }}>
          485L Red Sea Tank
        </div>
        <div style={{ display: "flex", gap: 4, overflowX: "auto", paddingBottom: 0 }}>
          {navItems.map(n => (
            <button key={n.id} onClick={() => setView(n.id)} style={{
              background: view === n.id ? "#B84A2E" : "transparent",
              color: view === n.id ? "#F4EEE1" : "#B8ADA0",
              border: "none", borderRadius: "8px 8px 0 0",
              padding: "8px 12px", fontSize: 12, cursor: "pointer",
              fontFamily: "inherit", whiteSpace: "nowrap",
              transition: "all 0.2s",
            }}>{n.label}</button>
          ))}
        </div>
      </div>

      <div style={{ padding: "20px 16px", paddingBottom: 40 }}>

        {/* ── DASHBOARD ── */}
        {view === "dashboard" && (
          <div>
            <div style={{ marginBottom: 16 }}>
              <div style={{ fontSize: 13, color: "#B8ADA0" }}>
                {lastReading ? `Last test: ${lastReading.date}` : "No readings yet — run a test session to begin"}
              </div>
              {data.readings.length >= 2 && (
                <div style={{ fontSize: 12, color: "#5F6B42", marginTop: 4 }}>
                  {data.readings.length} readings, {data.doseEvents.length} logged doses
                </div>
              )}
              {lastReading?.notes && (
                <div style={{
                  fontSize: 12, color: "#2A2420", marginTop: 8,
                  background: "#5F6B4215", borderLeft: "2px solid #5F6B42",
                  borderRadius: 6, padding: "6px 10px", fontStyle: "italic",
                }}>
                  {lastReading.notes}
                </div>
              )}
            </div>

            {lastReading ? (
              <>
                <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
                  {PARAM_KEYS.map(k => (
                    <div key={k}>
                      <ReadingCard paramKey={k} value={lastReading[k]} />
                    </div>
                  ))}
                </div>
                <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10, marginTop: 10 }}>
                  <RatioCard ratioKey="mgca" reading={lastReading} />
                  <RatioCard ratioKey="no3po4" reading={lastReading} />
                </div>
              </>
            ) : (
              <div style={{
                background: "#2A242008", borderRadius: 12, padding: 32,
                textAlign: "center", color: "#B8ADA0",
              }}>
                <div>Tap <strong style={{ color: "#B84A2E" }}>Test Session</strong> to log your first reading</div>
              </div>
            )}
          </div>
        )}

        {/* ── TEST SESSION ── */}
        {view === "test" && (
          <div>
            <div style={{ fontSize: 16, fontWeight: 600, marginBottom: 16 }}>
              {editingId ? "Edit Reading" : "Test Session"}
            </div>

            <div style={{ marginBottom: 16 }}>
              <label style={{ fontSize: 12, color: "#B8ADA0" }}>Test date</label>
              <input type="date" value={form.date}
                onChange={e => setForm(f => ({ ...f, date: e.target.value }))}
                style={inputStyle} />
            </div>

            {PARAM_KEYS.map(k => {
              const t = TARGETS[k];
              return (
                <div key={k} style={{ marginBottom: 14 }}>
                  <label style={{ fontSize: 12, color: "#B8ADA0" }}>
                    {t.label} <span style={{ color: "#B8ADA090" }}>({t.unit}) — range: {t.min}–{t.max}</span>
                  </label>
                  <input
                    type="number" inputMode="decimal"
                    placeholder={`ideal: ${t.ideal}`}
                    value={form[k]}
                    onChange={e => setForm(f => ({ ...f, [k]: e.target.value }))}
                    style={{
                      ...inputStyle, fontSize: 16,
                      border: `1px solid ${form[k] !== "" ? statusColor(k, form[k]) + "80" : "#B8ADA040"}`,
                    }} />
                  {form[k] !== "" && (
                    <div style={{ fontSize: 11, marginTop: 3, color: statusColor(k, form[k]) }}>
                      {statusLabel(k, form[k])} — target {t.ideal} {t.unit}
                    </div>
                  )}
                </div>
              );
            })}

            <div style={{ marginBottom: 16 }}>
              <label style={{ fontSize: 12, color: "#B8ADA0" }}>Notes (optional)</label>
              <textarea
                value={form.notes}
                onChange={e => setForm(f => ({ ...f, notes: e.target.value }))}
                placeholder="e.g. changed 50L, algae on front glass, new frag added"
                rows={2}
                style={{ ...inputStyle, resize: "vertical" }} />
            </div>

            <button onClick={submitReading} style={{
              width: "100%", padding: "14px", background: "#B84A2E",
              color: "#F4EEE1", border: "none", borderRadius: 10,
              fontSize: 16, fontFamily: "inherit", cursor: "pointer",
              marginTop: 8,
            }}>
              {saved ? "Saved" : editingId ? "Update Reading" : "Save Reading"}
            </button>

            {editingId && (
              <button onClick={() => { setEditingId(null); setForm(blankForm()); setView("history"); }} style={{
                width: "100%", padding: "12px", background: "transparent",
                color: "#B8ADA0", border: "1px solid #B8ADA040", borderRadius: 10,
                fontSize: 14, fontFamily: "inherit", cursor: "pointer", marginTop: 8,
              }}>
                Cancel edit
              </button>
            )}
          </div>
        )}

        {/* ── DOSING ── */}
        {view === "dose" && (
          <div>
            <div style={{ fontSize: 16, fontWeight: 600, marginBottom: 4 }}>Dosing Analysis</div>
            <div style={{ fontSize: 12, color: "#B8ADA0", marginBottom: 16 }}>
              Consumption is measured over up to {MAX_WINDOW} recent tests and corrected
              for any one-off doses you log below.
            </div>

            {/* Manual dose logger */}
            <div style={{
              background: "#5F6B4212", borderRadius: 12, padding: 16, marginBottom: 20,
              borderLeft: "3px solid #5F6B42",
            }}>
              <div style={{ fontSize: 14, fontWeight: 600, marginBottom: 10 }}>Log a one-off dose</div>
              <div style={{ display: "flex", gap: 8, marginBottom: 8 }}>
                <div style={{ flex: 1 }}>
                  <label style={{ fontSize: 11, color: "#B8ADA0" }}>Parameter</label>
                  <select value={doseForm.param}
                    onChange={e => setDoseForm(f => ({ ...f, param: e.target.value }))}
                    style={{ ...inputStyle, marginTop: 3, padding: "8px 10px" }}>
                    {DOSED_PARAMS.map(k => <option key={k} value={k}>{TARGETS[k].label}</option>)}
                  </select>
                </div>
                <div style={{ width: 90 }}>
                  <label style={{ fontSize: 11, color: "#B8ADA0" }}>ml</label>
                  <input type="number" inputMode="decimal" value={doseForm.ml}
                    onChange={e => setDoseForm(f => ({ ...f, ml: e.target.value }))}
                    style={{ ...inputStyle, marginTop: 3, padding: "8px 10px" }} />
                </div>
              </div>
              <div style={{ marginBottom: 8 }}>
                <label style={{ fontSize: 11, color: "#B8ADA0" }}>Date</label>
                <input type="date" value={doseForm.date}
                  onChange={e => setDoseForm(f => ({ ...f, date: e.target.value }))}
                  style={{ ...inputStyle, marginTop: 3, padding: "8px 10px" }} />
              </div>
              {hasVal(doseForm.ml) && parseFloat(doseForm.ml) > 0 && (
                <div style={{ fontSize: 11, color: "#5F6B42", marginBottom: 8 }}>
                  = raises {TARGETS[doseForm.param].label.toLowerCase()} by{" "}
                  {mlToUnits(doseForm.param, parseFloat(doseForm.ml), data.conc[doseForm.param]).toFixed(2)}{" "}
                  {TARGETS[doseForm.param].unit}
                  {mlToUnits(doseForm.param, parseFloat(doseForm.ml), data.conc[doseForm.param]) > MAX_DAILY[doseForm.param] &&
                    <span style={{ color: "#B84A2E" }}> — exceeds the daily safety limit of {MAX_DAILY[doseForm.param]} {TARGETS[doseForm.param].unit}</span>}
                </div>
              )}
              <button
                onClick={() => {
                  logDose(doseForm.param, doseForm.ml, doseForm.date, doseForm.note);
                  setDoseForm(f => ({ ...f, ml: "", note: "" }));
                }}
                disabled={!hasVal(doseForm.ml) || parseFloat(doseForm.ml) <= 0}
                style={{
                  width: "100%", padding: "10px", background: "#5F6B42",
                  color: "#F4EEE1", border: "none", borderRadius: 8,
                  fontSize: 14, fontFamily: "inherit", cursor: "pointer",
                  opacity: (!hasVal(doseForm.ml) || parseFloat(doseForm.ml) <= 0) ? 0.5 : 1,
                }}>
                Log dose
              </button>
              <div style={{ fontSize: 10, color: "#B8ADA090", marginTop: 6, lineHeight: 1.5 }}>
                Log any dose given by hand outside the daily pump schedule — including corrections
                made right after testing. This keeps the consumption calculation honest.
              </div>
            </div>

            {DOSED_PARAMS.map(key => {
              const t = TARGETS[key];
              const cons = calcConsumption(data.readings, data.doseEvents, key);
              const latest = data.readings.filter(r => hasVal(r[key])).slice(-1)[0];
              const bolus = latest ? calcBolus(key, latest[key], data.conc[key]) : null;
              const adj = cons ? calcDoseAdj(key, cons.perDay, data.doses[key], data.conc[key]) : null;
              const today = new Date().toISOString().slice(0, 10);

              return (
                <div key={key} style={{
                  background: "#2A242008", borderRadius: 12,
                  padding: "16px", marginBottom: 16,
                  borderLeft: `3px solid ${latest ? statusColor(key, latest[key]) : "#B8ADA0"}`,
                }}>
                  <div style={{ fontSize: 15, fontWeight: 600, marginBottom: 10 }}>
                    {t.label}
                    {latest && <span style={{ fontWeight: 400, fontSize: 13, color: "#B8ADA0", marginLeft: 8 }}>
                      current: {latest[key]} {t.unit}
                    </span>}
                  </div>

                  <div style={{ marginBottom: 10 }}>
                    <label style={{ fontSize: 11, color: "#B8ADA0" }}>Current daily dose (ml)</label>
                    <input type="number" inputMode="decimal" value={data.doses[key]}
                      onChange={e => updateDose(key, e.target.value)}
                      style={smallInputStyle} />
                  </div>

                  {cons ? (
                    <div style={{ fontSize: 12, marginBottom: 10 }}>
                      <div style={{ color: "#5F6B42" }}>
                        Measured consumption: <strong>{(cons.perDay * 7).toFixed(2)} {t.unit}/week</strong>
                        <span style={{ color: "#B8ADA0" }}>
                          {" "}({cons.perDay.toFixed(3)}/day over {cons.n} tests, {cons.days.toFixed(0)} days
                          {cons.bolusCount > 0 && `, corrected for ${cons.bolusCount} logged dose${cons.bolusCount > 1 ? "s" : ""}`})
                        </span>
                      </div>
                      {adj && (
                        <div style={{
                          marginTop: 8, padding: "8px 10px",
                          background: "#B84A2E15", borderRadius: 8,
                          borderLeft: "2px solid #B84A2E",
                        }}>
                          <div style={{ color: "#B84A2E", fontWeight: 600, fontSize: 13 }}>
                            Suggested dose: {adj.suggestedDose} ml/day
                          </div>
                          <div style={{ color: "#B8ADA0", marginTop: 3 }}>
                            Current dose delivers {adj.deliveredPerDay} {t.unit}/day; tank consuming {adj.consumedPerDay} {t.unit}/day
                          </div>
                          {adj.exceedsLimit && (
                            <div style={{
                              marginTop: 6, padding: "6px 8px",
                              background: "#B84A2E22", borderRadius: 6,
                              color: "#B84A2E", fontSize: 12, fontWeight: 500,
                            }}>
                              Warning: exceeds the {MAX_DAILY[key]} {t.unit}/day safety limit — increase gradually over several days, not all at once. Maximum safe dose: {adj.safeDose} ml/day.
                            </div>
                          )}
                        </div>
                      )}
                    </div>
                  ) : (
                    <div style={{ fontSize: 12, color: "#B8ADA0" }}>Need at least two readings to calculate consumption</div>
                  )}

                  {bolus && (
                    <div style={{
                      marginTop: 8, padding: "8px 10px",
                      background: "#5F6B4215", borderRadius: 8,
                      borderLeft: "2px solid #5F6B42",
                    }}>
                      <div style={{ color: "#5F6B42", fontWeight: 600, fontSize: 13 }}>
                        One-off correction: {bolus.ml} ml total
                      </div>
                      <div style={{ color: "#B8ADA0", fontSize: 11, marginTop: 2 }}>
                        to raise by {bolus.deficit} {t.unit} to ideal ({t.ideal} {t.unit})
                      </div>
                      {bolus.daysNeeded > 1 && (
                        <div style={{
                          marginTop: 6, padding: "6px 8px",
                          background: "#B84A2E22", borderRadius: 6,
                          color: "#B84A2E", fontSize: 12, fontWeight: 500,
                        }}>
                          Warning: exceeds daily safety limit — administer over {bolus.daysNeeded} days ({bolus.mlPerDay} ml/day)
                        </div>
                      )}
                      <button
                        onClick={() => logDose(key, bolus.daysNeeded > 1 ? bolus.mlPerDay : bolus.ml, today, "correction after test")}
                        style={{
                          marginTop: 8, padding: "8px 12px",
                          background: "#5F6B42", color: "#F4EEE1",
                          border: "none", borderRadius: 8,
                          fontSize: 13, fontFamily: "inherit", cursor: "pointer",
                        }}>
                        I dosed {bolus.daysNeeded > 1 ? bolus.mlPerDay : bolus.ml} ml today — log it
                      </button>
                    </div>
                  )}

                  <div style={{ marginTop: 10 }}>
                    <label style={{ fontSize: 11, color: "#B8ADA0" }}>
                      Solution concentration (mg/ml)
                    </label>
                    <input type="number" inputMode="decimal" value={data.conc[key]}
                      onChange={e => updateConc(key, e.target.value)}
                      style={smallInputStyle} />
                  </div>
                </div>
              );
            })}
          </div>
        )}

        {/* ── HISTORY ── */}
        {view === "history" && (
          <div>
            <div style={{ fontSize: 16, fontWeight: 600, marginBottom: 16 }}>History</div>

            <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 8, color: "#5F6B42" }}>
              Test readings
            </div>
            {data.readings.length === 0 && (
              <div style={{ fontSize: 12, color: "#B8ADA0", marginBottom: 16 }}>No readings yet.</div>
            )}
            {[...data.readings].reverse().map(r => (
              <div key={r.id} style={{
                background: "#2A242008", borderRadius: 10, padding: "12px 14px",
                marginBottom: 10,
              }}>
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                  <span style={{ fontSize: 13, fontWeight: 600 }}>{r.date}</span>
                  <span>
                    <button onClick={() => editReading(r)} style={{
                      background: "transparent", border: "1px solid #B8ADA040",
                      color: "#5F6B42", borderRadius: 6, padding: "4px 10px",
                      fontSize: 12, cursor: "pointer", fontFamily: "inherit", marginRight: 6,
                    }}>Edit</button>
                    <button onClick={() => deleteReading(r.id)} style={{
                      background: "transparent", border: "1px solid #B84A2E40",
                      color: "#B84A2E", borderRadius: 6, padding: "4px 10px",
                      fontSize: 12, cursor: "pointer", fontFamily: "inherit",
                    }}>Delete</button>
                  </span>
                </div>
                <div style={{ fontSize: 11, color: "#B8ADA0", marginTop: 6, lineHeight: 1.7 }}>
                  {PARAM_KEYS.filter(k => hasVal(r[k])).map(k =>
                    `${TARGETS[k].label} ${r[k]}`
                  ).join(" · ") || "no values recorded"}
                </div>
                {r.notes && (
                  <div style={{ fontSize: 11, color: "#2A2420", marginTop: 4, fontStyle: "italic" }}>
                    {r.notes}
                  </div>
                )}
              </div>
            ))}

            <div style={{ fontSize: 13, fontWeight: 600, margin: "20px 0 8px", color: "#5F6B42" }}>
              Logged doses
            </div>
            {data.doseEvents.length === 0 && (
              <div style={{ fontSize: 12, color: "#B8ADA0" }}>
                No one-off doses logged. Log them from the Dosing tab whenever you dose by hand.
              </div>
            )}
            {[...data.doseEvents].reverse().map(e => (
              <div key={e.id} style={{
                background: "#5F6B420A", borderRadius: 10, padding: "10px 14px",
                marginBottom: 8, display: "flex", justifyContent: "space-between", alignItems: "center",
              }}>
                <div>
                  <div style={{ fontSize: 13 }}>
                    <strong>{e.date}</strong> — {TARGETS[e.param].label}, {e.ml} ml
                    <span style={{ color: "#B8ADA0" }}> (+{(e.delta || 0).toFixed(2)} {TARGETS[e.param].unit})</span>
                  </div>
                  {e.note && <div style={{ fontSize: 11, color: "#B8ADA0", fontStyle: "italic" }}>{e.note}</div>}
                </div>
                <button onClick={() => deleteDose(e.id)} style={{
                  background: "transparent", border: "1px solid #B84A2E40",
                  color: "#B84A2E", borderRadius: 6, padding: "4px 10px",
                  fontSize: 12, cursor: "pointer", fontFamily: "inherit",
                }}>Delete</button>
              </div>
            ))}
          </div>
        )}

        {/* ── TRENDS ── */}
        {view === "trends" && (
          <div>
            <div style={{ fontSize: 16, fontWeight: 600, marginBottom: 16 }}>Parameter Trends</div>
            {data.readings.length < 2 ? (
              <div style={{ color: "#B8ADA0", fontSize: 13 }}>Need at least two readings to show trends.</div>
            ) : (
              PARAM_KEYS.map(k => (
                <div key={k} style={{
                  marginBottom: 24, background: "#2A242008",
                  borderRadius: 12, padding: 16,
                }}>
                  <div style={{ fontSize: 14, fontWeight: 600, marginBottom: 8 }}>
                    {TARGETS[k].label}
                    <span style={{ fontWeight: 400, fontSize: 11, color: "#B8ADA0", marginLeft: 8 }}>
                      target {TARGETS[k].min}–{TARGETS[k].max} {TARGETS[k].unit}
                    </span>
                  </div>
                  <TrendSparkline readings={data.readings} paramKey={k} />
                </div>
              ))
            )}
          </div>
        )}

        {/* ── SETTINGS ── */}
        {view === "settings" && (
          <div>
            <div style={{ fontSize: 16, fontWeight: 600, marginBottom: 16 }}>Settings & Data</div>

            {/* Sync */}
            <div style={{
              background: "#2A242008", borderRadius: 12, padding: 16, marginBottom: 16,
              borderLeft: `3px solid ${syncDot}`,
            }}>
              <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 4 }}>Cross-device sync</div>
              <div style={{ fontSize: 12, color: "#B8ADA0", marginBottom: 8 }}>
                {syncStatus.state === "off" && "Not connected — data stays on this device only."}
                {syncStatus.state === "syncing" && "Syncing…"}
                {syncStatus.state === "ok" && syncStatus.msg}
                {syncStatus.state === "error" && syncStatus.msg}
              </div>
              <label style={{ fontSize: 11, color: "#B8ADA0" }}>Sync token</label>
              <input type="password" value={sync.token}
                onChange={e => {
                  const s = { ...sync, token: e.target.value.trim() };
                  setSync(s); saveSync(s);
                }}
                placeholder="paste the sync token"
                style={inputStyle} />
              <button onClick={() => pullNow()} disabled={!sync.token} style={{
                marginTop: 10, padding: "10px 16px",
                background: sync.token ? "#5F6B42" : "#B8ADA0",
                color: "#F4EEE1", border: "none", borderRadius: 8,
                fontSize: 13, fontFamily: "inherit", cursor: sync.token ? "pointer" : "default",
              }}>
                Sync now
              </button>
              <div style={{ fontSize: 10, color: "#B8ADA090", marginTop: 8, lineHeight: 1.5 }}>
                Enter the same token on each device (phone and PC). Readings and doses merge
                automatically; nothing is lost if a device has been offline.
              </div>
            </div>

            <div style={{
              background: "#2A242008", borderRadius: 12, padding: 16, marginBottom: 16,
            }}>
              <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 4 }}>Tank</div>
              <div style={{ fontSize: 12, color: "#B8ADA0" }}>Red Sea 525XL — 485 L effective volume</div>
              <div style={{ fontSize: 12, color: "#B8ADA0", marginTop: 4 }}>
                {data.readings.length} readings, {data.doseEvents.length} logged doses
              </div>
            </div>

            <div style={{
              background: "#2A242008", borderRadius: 12, padding: 16, marginBottom: 16,
            }}>
              <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 8 }}>Dosing solutions</div>
              <div style={{ fontSize: 12, color: "#B8ADA0", lineHeight: 1.8 }}>
                <div>Alkalinity: Na₂CO₃ 133.1 g/L → {data.conc.alk} mg/ml</div>
                <div>Calcium: CaCl₂·2H₂O 348 g/L → {data.conc.ca} mg/ml</div>
                <div>Magnesium: MgCl₂·6H₂O 247 g + MgSO₄·7H₂O 175 g / 2 L → {data.conc.mg} mg/ml</div>
              </div>
              <div style={{ fontSize: 11, color: "#B8ADA090", marginTop: 8, lineHeight: 1.6 }}>
                Concentration values can be adjusted in the Dosing tab if you change your mix
                recipe. They are saved permanently and sync across devices.
              </div>
            </div>

            <div style={{
              background: "#2A242008", borderRadius: 12, padding: 16, marginBottom: 16,
            }}>
              <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 8 }}>Daily safety limits</div>
              <div style={{ fontSize: 12, color: "#B8ADA0", lineHeight: 1.8 }}>
                <div>Alkalinity: max {MAX_DAILY.alk} dKH/day</div>
                <div>Calcium: max {MAX_DAILY.ca} ppm/day</div>
                <div>Magnesium: max {MAX_DAILY.mg} ppm/day</div>
              </div>
            </div>

            <button onClick={exportData} style={{
              width: "100%", padding: "12px",
              background: "#2A2420", color: "#F4EEE1",
              border: "none", borderRadius: 10,
              fontSize: 14, fontFamily: "inherit", cursor: "pointer",
              marginBottom: 12,
            }}>
              Export all data (JSON)
            </button>

            <label style={{
              display: "block", width: "100%", padding: "12px",
              background: "#5F6B42", color: "#F4EEE1",
              border: "none", borderRadius: 10, textAlign: "center",
              fontSize: 14, fontFamily: "inherit", cursor: "pointer",
              marginBottom: 12, boxSizing: "border-box",
            }}>
              Import data (JSON) — merges with existing
              <input type="file" accept="application/json,.json"
                onChange={e => {
                  if (e.target.files?.[0]) importData(e.target.files[0]);
                  e.target.value = "";
                }}
                style={{ display: "none" }} />
            </label>

            <button onClick={clearAll} style={{
              width: "100%", padding: "12px",
              background: "#B84A2E22", color: "#B84A2E",
              border: "1px solid #B84A2E40", borderRadius: 10,
              fontSize: 14, fontFamily: "inherit", cursor: "pointer",
            }}>
              Clear all readings and doses
            </button>
          </div>
        )}

      </div>
    </div>
  );
}
