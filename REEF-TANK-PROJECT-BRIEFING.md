# REEF TANK MANAGEMENT APP — PROJECT BRIEFING (v2, July 2026)
*For handover to a new Claude instance. Everything needed to continue the work is here.*

---

## Project summary

A mobile-first React web app for tracking and managing water chemistry in a Red Sea 525XL
reef aquarium. As of July 2026 it is deployed to **Cloudflare Workers** with a **D1 database**
providing cross-device sync between Adrian's Android phone and Windows PC. Data is held in
browser localStorage on each device and merged through the sync API; the server copy is the
shared source. The previous deployment (GitHub Pages, localStorage only) is retired.

**Live URL:** https://reef-tank.<subdomain>.workers.dev (printed by `npm run deploy`)

**Old URL (retired):** https://AdrianRoux.github.io/reef-tank/

**GitHub repository:** https://github.com/AdrianRoux/reef-tank

**Owner:** Adrian Roux (adrianroux@outlook.com), Methodist minister, South Kent.

---

## Tank details

- Model: Red Sea 525XL
- Effective water volume: 485 litres (after rock and substrate displacement)
- Dosing system: three-part, with separate dedicated pumps for alkalinity, calcium, magnesium
- Solutions mixed by hand from raw chemicals in reverse osmosis water
- Testing cadence: roughly every Saturday, sometimes fortnightly; the app handles
  irregular intervals

---

## Target parameters

| Parameter   | Unit | Min   | Max   | Ideal |
|-------------|------|-------|-------|-------|
| Alkalinity  | dKH  | 8.0   | 12.0  | 9.5   |
| Calcium     | ppm  | 430   | 465   | 447   |
| Magnesium   | ppm  | 1250  | 1390  | 1320  |
| pH          | pH   | 7.8   | 8.5   | 8.2   |
| Nitrate     | ppm  | 1.00  | 4.50  | 2.5   |
| Phosphate   | ppm  | 0.02  | 0.10  | 0.05  |
| Temperature | °C   | 24    | 26    | 25    |
| Salinity    | SG   | 1.025 | 1.027 | 1.026 |

Source: Red Sea Reef Care Programme.

Ratio indicators (Dashboard):
- **Mg : Ca** — ideal ~2.95 : 1, acceptable band 2.7–3.25 (derived from the min/max targets)
- **NO₃ : PO₄** — ideal ~50 : 1 (2.5 / 0.05), acceptable band 20–100. High = phosphate-limited
  (cyanobacteria risk); low = nitrate-limited. Computed from the latest reading, so it works
  from the very first test.

---

## Dosing solution recipes and concentrations

All solutions use reverse osmosis water. Do not substitute tap water.

### Alkalinity
- **Chemical:** Anhydrous sodium carbonate, Na₂CO₃ (NOT sodium bicarbonate)
- **Recipe:** 133.1 g in 1 litre RO water
- **App concentration:** 125.7 mg/ml (CaCO₃-equivalent per ml)
- **Notes:** Na₂CO₃ raises pH as well as alkalinity; solution pH ~11.5, dose into high flow
  away from coral. Within room-temperature solubility.
- **Maximum daily adjustment:** 1.2 dKH/day

### Alkalinity — 50/50 blend option (not currently in use)
- **Recipe:** 66.5 g Na₂CO₃ + 66.5 g NaHCO₃ in 1 litre RO water
- **App concentration if adopted:** 102.5 mg/ml — must be changed in the Dosing tab
  (the value now persists and syncs, so change it once)

### Calcium
- **Chemical:** Calcium chloride dihydrate, CaCl₂·2H₂O
- **Recipe:** 348 g in 1 litre RO water
- **App concentration:** 94.9 mg Ca/ml
- **Notes:** Exothermic on dissolving; hygroscopic — keep sealed, weigh carefully.
- **Maximum daily adjustment:** 20 ppm/day

### Magnesium
- **Chemicals:** MgCl₂·6H₂O + MgSO₄·7H₂O (Epsom salt)
- **Recipe:** 247 g MgCl₂·6H₂O + 175 g MgSO₄·7H₂O in 2 litres RO water
- **App concentration:** 23.4 mg Mg/ml
- **Notes:** Two-salt approach keeps sulphate:chloride ratio right. Same salts in 1 L gives
  ~46.8 mg/ml if a stronger mix is wanted — update the app concentration if so.
- **Maximum daily adjustment:** 10 ppm/day

---

## Dosing mathematics (for verification)

**Unit conversions** (`mlToUnits` / `unitsToMl` in App.jsx):
- Ca, Mg: `ppm = ml × conc / volume_L`
- Alk: `dKH = ml × conc / (17.848 × volume_L)` (17.848 = mg CaCO₃-equiv per litre per dKH)

**Consumption (adaptive window, bolus-corrected)** — `calcConsumption`:
Takes up to the 6 most recent tests with a value for the parameter (2 when only 2 exist,
3 when 3 exist, and so on). Each reading is corrected by subtracting the cumulative effect
of logged one-off doses given since the window start; a least-squares fit over the corrected
values gives the fall per day, **net of the daily pump dose**. A dose logged on the same date
as a test counts as given AFTER that test (Adrian tests first, then doses). With two tests
the fit reduces exactly to the old endpoint method.

**Dose-event logging:** each event stores date, parameter, ml, the concentration at the time,
and the computed delta in parameter units — so later recipe changes never rewrite history.
Events are logged from the Dosing tab (a manual form, plus a one-tap button on the app's own
correction suggestion).

**Suggested daily dose:** `current_dose_ml + unitsToMl(net_fall_per_day)`, floored at 0,
flagged when it exceeds the daily safety limit.

**Bolus correction:** `deficit × volume (× 17.848 for alk) / conc`; split over days when it
exceeds the daily limit.

All of the above verified against hand-worked cases (13 assertions) in July 2026.

---

## App architecture

- **Framework:** React 18, single component file (src/App.jsx), JSX
- **Build tool:** Vite 5 (`base: "/"`)
- **Hosting:** Cloudflare Workers with static assets (config in wrangler.jsonc);
  `worker/index.js` serves ./dist and the sync API
- **Database:** Cloudflare D1, single-row table `state(id, body, updated_at)` holding the
  whole dataset as JSON — ample for one user testing weekly
- **Auth:** one shared token, Worker secret `SYNC_TOKEN`, sent as a Bearer header; the user
  enters it once per device in Settings (kept in localStorage key `reeftank_sync`)
- **Persistence:** localStorage key `reeftank_v2` (auto-migrates from `reeftank_v1`);
  server merge on load, debounced push ~1.5 s after each change, manual "Sync now" in Settings
- **Merge model:** union by record id, newest `updatedAt` wins, deletions carried as
  tombstones in `data.deleted` so they propagate across devices

### Data shape (v2)
```json
{
  "readings":   [{ "id", "date", "alk", "...", "notes", "updatedAt" }],
  "doseEvents": [{ "id", "date", "param", "ml", "conc", "delta", "note", "updatedAt" }],
  "doses":   { "alk": 5, "ca": 5, "mg": 5 },
  "conc":    { "alk": 125.7, "ca": 94.9, "mg": 23.4 },
  "deleted": { "readings": [], "doseEvents": [] },
  "updatedAt": "ISO"
}
```

### Six tabs
1. **Dashboard** — latest readings, colour-coded cards, gauge bars, Mg:Ca and NO₃:PO₄
   ratio cards, latest session note
2. **Test Session** — date-stamped entry, blank fields allowed, notes field; doubles as
   the edit form for existing readings
3. **Dosing** — one-off dose logger (top), then per-parameter: consumption (adaptive,
   bolus-corrected), suggested daily dose, bolus correction with "log it" button,
   persisted concentration
4. **History** — all readings (edit/delete) and all logged doses (delete)
5. **Trends** — sparklines, last 10 readings, target range shaded
6. **Settings** — sync token + status, tank info, solutions, safety limits, JSON export,
   JSON import (merge), clear-all (tombstoned so it syncs)

### Deployment
```
npm run deploy        → vite build + wrangler deploy (Cloudflare)
npm run deploy:github → legacy GitHub Pages deploy (builds with base /reef-tank/)
```
Run from Command Prompt, not PowerShell (execution policy blocks npm scripts on Adrian's PC).
One-time Cloudflare setup is in CLOUDFLARE-SETUP.md.

---

## Icons and branding

Clownfish icon (orange, three white bands, ocean-blue disc) across favicon
(clownfish.svg), Android manifest icons (icon-192/512.png), and a Windows
desktop ICO kept separately. Manifest start_url and scope are now "/".

---

## Reference document

**Manual/Reef-Tank-Guide.docx** — six-section guide styled in the Roux ministry palette.
Predates the v2 app: it does not yet cover dose logging, ratios, History, or sync.
Update it when convenient.

---

## Possible future enhancements (not yet built)

1. Dose-event markers on the Trends sparklines
2. Water-change logging as a first-class event (currently a session note)
3. Nitrite/ammonia fields (monitored manually, not tracked)
4. Editing dose events (currently delete-and-relog)

---

## Environment notes

- **Adrian's PC:** Windows; Command Prompt preferred over PowerShell
- **Node.js:** v24.16.0; npm v11.13.0; Git v2.47.x authenticated to GitHub
- **Cloudflare:** same account as the pastoral system; wrangler ^4 in devDependencies
- **Android:** Chrome standalone PWA — must be re-added from the new workers.dev URL
