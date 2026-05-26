import { useState, useEffect } from "react";

// ── constants ────────────────────────────────────────────────────────────────
const TANK_VOLUME_L = 485;

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

// Dosing solution concentrations (mg of parameter per ml of solution)
// Alkalinity: anhydrous Na₂CO₃ at 133.1 g/L in RO water → 125.7 mg CaCO₃-equiv per ml
// Calcium:    CaCl₂·2H₂O at 348 g/L in RO water        →  94.9 mg Ca per ml
// Magnesium:  MgCl₂·6H₂O 247 g + MgSO₄·7H₂O 175 g in 2 L RO water → 23.4 mg Mg per ml
const DOSE_CONC = {
  alk: 125.7,
  ca:   94.9,
  mg:   23.4,
};

// Maximum safe daily adjustment per parameter
const MAX_DAILY = {
  alk: 1.2,   // dKH per day
  ca:  20,    // ppm per day
  mg:  10,    // ppm per day
};

const PARAM_KEYS = Object.keys(TARGETS);
const DOSED_PARAMS = ["alk", "ca", "mg"];

const STORAGE_KEY = "reeftank_v1";

function load() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw ? JSON.parse(raw) : { readings: [], doses: { alk: 5, ca: 5, mg: 5 } };
  } catch { return { readings: [], doses: { alk: 5, ca: 5, mg: 5 } }; }
}

function save(data) {
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(data)); } catch {}
}

// ── helpers ──────────────────────────────────────────────────────────────────
function statusColor(key, val) {
  if (val === "" || val === null || val === undefined) return "#B8ADA0";
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
  if (val === "" || val === null || val === undefined) return "—";
  const t = TARGETS[key];
  const v = parseFloat(val);
  if (v < t.min) return "LOW";
  if (v > t.max) return "HIGH";
  return "OK";
}

// Maximum safe dose volume in ml for one day
function maxSafeDoseMl(key, concMgPerMl, volumeL) {
  if (key === "alk") {
    return (MAX_DAILY[key] * 17.848 * volumeL) / concMgPerMl;
  }
  return (MAX_DAILY[key] * volumeL) / concMgPerMl;
}

function calcConsumption(readings, key) {
  const valid = readings.filter(r => r[key] !== "" && r[key] !== undefined && r[key] !== null);
  if (valid.length < 2) return null;
  const latest = valid[valid.length - 1];
  const prev   = valid[valid.length - 2];
  const days = (new Date(latest.date) - new Date(prev.date)) / 86400000;
  if (days <= 0) return null;
  const delta = parseFloat(prev[key]) - parseFloat(latest[key]);
  return { delta, days, perDay: delta / days, latest: parseFloat(latest[key]), prev: parseFloat(prev[key]) };
}

function calcBolus(key, currentVal, targetVal, volumeL, concMgPerMl) {
  const t = TARGETS[key];
  const target = targetVal || t.ideal;
  const current = parseFloat(currentVal);
  if (isNaN(current)) return null;
  const deficit = target - current;
  if (deficit <= 0) return null;

  let mgNeeded;
  if (key === "alk") {
    mgNeeded = deficit * 17.848 * volumeL;
  } else {
    mgNeeded = deficit * volumeL;
  }
  const mlNeeded = mgNeeded / concMgPerMl;
  const safePerDay = maxSafeDoseMl(key, concMgPerMl, volumeL);
  const daysNeeded = Math.ceil(mlNeeded / safePerDay);
  return {
    deficit: deficit.toFixed(2),
    ml: mlNeeded.toFixed(1),
    daysNeeded,
    mlPerDay: daysNeeded > 1 ? (mlNeeded / daysNeeded).toFixed(1) : null,
  };
}

function calcDoseAdj(key, consumptionPerDay, currentDoseMl, concMgPerMl, volumeL) {
  if (!consumptionPerDay) return null;
  const t = TARGETS[key];
  let deliveredPerDay;
  if (key === "alk") {
    deliveredPerDay = (currentDoseMl * concMgPerMl) / (17.848 * volumeL);
  } else {
    deliveredPerDay = (currentDoseMl * concMgPerMl) / volumeL;
  }
  const diff = consumptionPerDay - deliveredPerDay;
  const newDose = currentDoseMl + (diff / concMgPerMl) * (key === "alk" ? 17.848 * volumeL : volumeL);
  const safeDose = maxSafeDoseMl(key, concMgPerMl, volumeL);
  const suggested = Math.max(0, newDose);
  return {
    deliveredPerDay: deliveredPerDay.toFixed(3),
    consumedPerDay: consumptionPerDay.toFixed(3),
    suggestedDose: suggested.toFixed(1),
    exceedsLimit: suggested > safeDose,
    safeDose: safeDose.toFixed(1),
    unit: t.unit,
  };
}

// ── components ───────────────────────────────────────────────────────────────
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
        {value !== "" && value !== undefined
          ? `${value} ${t.unit}`
          : <span style={{ color: "#B8ADA0", fontSize: 16 }}>not recorded</span>}
      </div>
      <div style={{ fontSize: 10, color: "#B8ADA0", marginTop: 2 }}>
        range: {t.min}–{t.max} {t.unit}
      </div>
      {value !== "" && <GaugeBar paramKey={paramKey} value={value} />}
    </div>
  );
}

function TrendSparkline({ readings, paramKey }) {
  const valid = readings.filter(r => r[paramKey] !== "" && r[paramKey] !== undefined).slice(-10);
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

// ── main app ─────────────────────────────────────────────────────────────────
export default function ReefApp() {
  const [data, setData] = useState(load);
  const [view, setView] = useState("dashboard");
  const [form, setForm] = useState(() => {
    const f = { date: new Date().toISOString().slice(0, 10) };
    PARAM_KEYS.forEach(k => f[k] = "");
    return f;
  });
  const [concForm, setConcForm] = useState({ ...DOSE_CONC });
  const [saved, setSaved] = useState(false);

  useEffect(() => { save(data); }, [data]);

  const lastReading = data.readings.length > 0 ? data.readings[data.readings.length - 1] : null;

  function submitReading() {
    const entry = { date: form.date, ...Object.fromEntries(PARAM_KEYS.map(k => [k, form[k]])) };
    const newData = { ...data, readings: [...data.readings, entry] };
    setData(newData);
    setSaved(true);
    setTimeout(() => setSaved(false), 2000);
    setView("dashboard");
  }

  function updateDose(key, val) {
    setData(d => ({ ...d, doses: { ...d.doses, [key]: parseFloat(val) || 0 } }));
  }

  function exportData() {
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url; a.download = `reef-data-${new Date().toISOString().slice(0,10)}.json`;
    a.click();
  }

  // ── nav ────────────────────────────────────────────────────────────────────
  const navItems = [
    { id: "dashboard", label: "Dashboard" },
    { id: "test",      label: "Test Session" },
    { id: "dose",      label: "Dosing" },
    { id: "trends",    label: "Trends" },
    { id: "settings",  label: "Settings" },
  ];

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
        <div style={{ fontSize: 11, letterSpacing: "0.15em", color: "#B8ADA0", textTransform: "uppercase" }}>
          South Kent Reef
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
                  {data.readings.length} readings recorded
                </div>
              )}
            </div>

            {lastReading ? (
              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
                {PARAM_KEYS.map(k => (
                  <div key={k}>
                    <ReadingCard paramKey={k} value={lastReading[k]} />
                  </div>
                ))}
              </div>
            ) : (
              <div style={{
                background: "#2A242008", borderRadius: 12, padding: 32,
                textAlign: "center", color: "#B8ADA0",
              }}>
                <div style={{ fontSize: 40, marginBottom: 8 }}>🪸</div>
                <div>Tap <strong style={{ color: "#B84A2E" }}>Test Session</strong> to log your first reading</div>
              </div>
            )}
          </div>
        )}

        {/* ── TEST SESSION ── */}
        {view === "test" && (
          <div>
            <div style={{ fontSize: 16, fontWeight: 600, marginBottom: 16 }}>Saturday Test Session</div>

            <div style={{ marginBottom: 16 }}>
              <label style={{ fontSize: 12, color: "#B8ADA0" }}>Test date</label>
              <input type="date" value={form.date}
                onChange={e => setForm(f => ({ ...f, date: e.target.value }))}
                style={{
                  display: "block", width: "100%", marginTop: 4,
                  background: "#2A242010", border: "1px solid #B8ADA040",
                  borderRadius: 8, padding: "10px 12px", fontSize: 15,
                  color: "#2A2420", fontFamily: "inherit",
                }} />
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
                      display: "block", width: "100%", marginTop: 4,
                      background: "#2A242010",
                      border: `1px solid ${form[k] !== "" ? statusColor(k, form[k]) + "80" : "#B8ADA040"}`,
                      borderRadius: 8, padding: "10px 12px", fontSize: 16,
                      color: "#2A2420", fontFamily: "inherit",
                    }} />
                  {form[k] !== "" && (
                    <div style={{ fontSize: 11, marginTop: 3, color: statusColor(k, form[k]) }}>
                      {statusLabel(k, form[k])} — target {t.ideal} {t.unit}
                    </div>
                  )}
                </div>
              );
            })}

            <button onClick={submitReading} style={{
              width: "100%", padding: "14px", background: "#B84A2E",
              color: "#F4EEE1", border: "none", borderRadius: 10,
              fontSize: 16, fontFamily: "inherit", cursor: "pointer",
              marginTop: 8,
            }}>
              {saved ? "✓ Saved" : "Save Reading"}
            </button>
          </div>
        )}

        {/* ── DOSING ── */}
        {view === "dose" && (
          <div>
            <div style={{ fontSize: 16, fontWeight: 600, marginBottom: 4 }}>Dosing Analysis</div>
            <div style={{ fontSize: 12, color: "#B8ADA0", marginBottom: 20 }}>
              Based on last two readings. Update daily dose rates below to recalculate.
            </div>

            {DOSED_PARAMS.map(key => {
              const t = TARGETS[key];
              const cons = calcConsumption(data.readings, key);
              const latest = data.readings.filter(r => r[key] !== "" && r[key] !== undefined).slice(-1)[0];
              const bolus = latest ? calcBolus(key, latest[key], t.ideal, TANK_VOLUME_L, concForm[key]) : null;
              const adj = cons ? calcDoseAdj(key, cons.perDay, data.doses[key], concForm[key], TANK_VOLUME_L) : null;

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
                      style={{
                        display: "block", width: "80px", marginTop: 3,
                        background: "#2A242015", border: "1px solid #B8ADA040",
                        borderRadius: 6, padding: "6px 10px", fontSize: 15,
                        color: "#2A2420", fontFamily: "inherit",
                      }} />
                  </div>

                  {cons ? (
                    <div style={{ fontSize: 12, marginBottom: 10 }}>
                      <div style={{ color: "#5F6B42" }}>
                        Measured consumption: <strong>{(cons.perDay * 7).toFixed(2)} {t.unit}/week</strong>
                        <span style={{ color: "#B8ADA0" }}> ({cons.perDay.toFixed(3)}/day over {cons.days.toFixed(0)} days)</span>
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
                              ⚠ Exceeds the {MAX_DAILY[key]} {t.unit}/day safety limit — increase gradually over several days, not all at once. Maximum safe dose: {adj.safeDose} ml/day.
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
                          ⚠ Exceeds daily safety limit — administer over {bolus.daysNeeded} days ({bolus.mlPerDay} ml/day)
                        </div>
                      )}
                    </div>
                  )}

                  <div style={{ marginTop: 10 }}>
                    <label style={{ fontSize: 11, color: "#B8ADA0" }}>
                      Solution concentration (mg/ml)
                    </label>
                    <input type="number" inputMode="decimal" value={concForm[key]}
                      onChange={e => setConcForm(f => ({ ...f, [key]: parseFloat(e.target.value) || 0 }))}
                      style={{
                        display: "block", width: "80px", marginTop: 3,
                        background: "#2A242015", border: "1px solid #B8ADA040",
                        borderRadius: 6, padding: "6px 10px", fontSize: 15,
                        color: "#2A2420", fontFamily: "inherit",
                      }} />
                  </div>
                </div>
              );
            })}
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

            <div style={{
              background: "#2A242008", borderRadius: 12, padding: 16, marginBottom: 16,
            }}>
              <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 4 }}>Tank</div>
              <div style={{ fontSize: 12, color: "#B8ADA0" }}>Red Sea 525XL — 485 L effective volume</div>
              <div style={{ fontSize: 12, color: "#B8ADA0", marginTop: 4 }}>
                {data.readings.length} readings stored
              </div>
            </div>

            <div style={{
              background: "#2A242008", borderRadius: 12, padding: 16, marginBottom: 16,
            }}>
              <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 8 }}>Dosing solutions</div>
              <div style={{ fontSize: 12, color: "#B8ADA0", lineHeight: 1.8 }}>
                <div>Alkalinity: Na₂CO₃ 133.1 g/L → 125.7 mg/ml</div>
                <div>Calcium: CaCl₂·2H₂O 348 g/L → 94.9 mg/ml</div>
                <div>Magnesium: MgCl₂·6H₂O 247 g + MgSO₄·7H₂O 175 g / 2 L → 23.4 mg/ml</div>
              </div>
              <div style={{ fontSize: 11, color: "#B8ADA090", marginTop: 8, lineHeight: 1.6 }}>
                Concentration values can be adjusted in the Dosing tab if you change your mix recipe.
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

            <button onClick={() => {
              if (window.confirm("Delete all readings? This cannot be undone.")) {
                setData(d => ({ ...d, readings: [] }));
              }
            }} style={{
              width: "100%", padding: "12px",
              background: "#B84A2E22", color: "#B84A2E",
              border: "1px solid #B84A2E40", borderRadius: 10,
              fontSize: 14, fontFamily: "inherit", cursor: "pointer",
            }}>
              Clear all readings
            </button>
          </div>
        )}

      </div>
    </div>
  );
}
