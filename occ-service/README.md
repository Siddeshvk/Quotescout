# QuoteScout — OCC Geometry Microservice (Stage B)

Deterministic OpenCascade topology extraction for STEP files. This is the
geometry layer the AI **cannot** produce: real volumes, an exact *assembled*
bounding box, hole **depths** (so depth:diameter), internal-vs-external
discrimination, a material-removal proxy, and an approximate min wall — all from
the actual B-rep. It feeds `lib/rules.js`.

It runs as a separate container (Google Cloud Run), **not** on Vercel —
OpenCascade is hundreds of MB and exceeds Vercel's 250 MB function limit. Your
Vercel `analyze.js` will call this service (wired next step).

---

## Why this is separate from `api/step-probe.js`

`step-probe.js` is a pure-text STEP parser (runs anywhere, no deps) — it gives a
fast, cheap read but only sees what the text says. It cannot place assembly
components, cannot measure hole depth, and cannot compute volume or min wall.
This service does the real topology. They complement each other: step-probe for
the cheap inline read, this for the deep features.

---

## Endpoints

| Method | Path | Purpose |
|--------|------|---------|
| `POST` | `/probe` | multipart field **`file`** = a `.step`/`.stp`; returns the JSON contract below. Query `?min_wall=0` to skip the (slower) min-wall estimate. |
| `GET` | `/health` | `{ok, version}` — Cloud Run health check. |
| `GET` | `/selftest` | Runs the probe on a **bundled known part** and asserts expected numbers — confirm OpenCascade actually works on the deployed instance with one click. |
| `GET` | `/` and `/docs` | Info + interactive Swagger UI. |

### Auth (optional, recommended for a public URL)
Set env `OCC_SHARED_SECRET`. Callers must then send `X-OCC-Token: <that value>`;
otherwise `401`. If the env var is unset, the gate is off.

### Privacy
Nothing is stored. The upload is written to a temp file, probed, deleted. CORS is
intentionally off — call it **server-to-server** from `analyze.js`, not the browser.

---

## The JSON contract (what `/probe` returns)

```jsonc
{
  "ok": true,
  "version": "occ-probe 1.0.0",
  "num_solids": 1,
  "is_assembly": false,
  "bbox_mm": [50.0, 30.0, 20.0],          // exact, assembled (assemblies placed correctly)
  "bbox_volume_mm3": 30000.0,
  "aspect_ratio": 2.5,
  "volume_mm3": 28203.0,                   // exact (GProp)
  "surface_area_mm2": 4710.2,
  "removal_ratio": 0.06,                   // approx stock-removal proxy = 1 - vol/bbox_vol
  "faces": { "total": 9, "planar": 7, "cylindrical": 2, "conical": 0,
             "spherical": 0, "toroidal": 0, "swept": 0, "freeform": 0, "other": 0 },
  "edges_total": 18,
  "holes": [                               // sorted by depth:diameter, worst first
    { "diameter_mm": 10.0, "depth_mm": 20.0, "depth_to_dia": 2.0, "kind": "hole" },
    { "diameter_mm": 6.0,  "depth_mm": 8.0,  "depth_to_dia": 1.33, "kind": "hole" }
  ],
  "hole_count": 2,                         // excludes bosses
  "max_depth_to_dia": 2.0,                 // the deep-hole signal for the rules engine
  "distinct_setup_normals": 3,            // cheap setup-count proxy (NOT pocket recognition)
  "min_wall_mm": 5.994,                    // approximate (sampled inward ray-cast); null if skipped/failed
  "min_wall_method": "sampled_inward_raycast",
  "min_wall_confidence": "approximate",
  "units": "mm",                           // output always normalized to mm
  "native_unit_declared": "inch",          // the file's declared unit (for the scale-bug check)
  "warnings": [ "..." ],                   // unit mislabel, assembly caveat, per-field failures
  "timing_ms": { "...": 0 },
  "elapsed_ms": 210
}
```

**Confidence labeling (matches the rest of QuoteScout):** `bbox_mm`, `volume_mm3`,
`surface_area_mm2`, hole `diameter_mm`/`depth_mm`/`depth_to_dia`, and the faces
histogram are **exact**. `removal_ratio`, `min_wall_mm`, `distinct_setup_normals`,
and hole `kind` (through/blind is not yet reported) are **approximate** — the
rules engine should treat them conservatively. On any per-field failure the field
is `null` and a line is added to `warnings`; a valid STEP never returns an error.

---

## Deploy to Cloud Run

Put this `occ-service/` folder in your repo (it can live in the same
`Siddeshvk/quotescout` repo — Cloud Run only builds this subdirectory).

### Option A — Google Cloud Console (mostly browser, closest to your Vercel flow)
1. Push `occ-service/` to GitHub (via the web UI, same as your other files).
2. Cloud Console → **Cloud Run** → **Deploy container** → **Continuously deploy from a repository** → **Set up with Cloud Build**.
3. Connect the repo, set **Build type = Dockerfile**, **Source location = `/occ-service`** (or wherever you put it).
4. Region: pick one near your Vercel region. **Allow unauthenticated** (you'll gate with `OCC_SHARED_SECRET`).
5. Under **Variables & Secrets**, add `OCC_SHARED_SECRET` = a long random string (save it — `analyze.js` will use it next step).
6. **Memory ≥ 2 GiB**, **CPU = 1**, **Request timeout = 120s**, **Min instances = 0** (free scale-to-zero; see cold-start note).
7. Deploy. You get a URL like `https://occ-xxxxx-uc.a.run.app`.

### Option B — gcloud CLI (one command)
```bash
cd occ-service
gcloud run deploy quotescout-occ \
  --source . \
  --region us-central1 \
  --memory 2Gi --cpu 1 --timeout 120 --min-instances 0 \
  --allow-unauthenticated \
  --set-env-vars OCC_SHARED_SECRET=$(openssl rand -hex 24)
```

### Verify (do this before wiring anything)
- Open `https://<your-url>/selftest` → should return `{"ok": true, "checks": {...all true...}, ...}`. That proves OCC runs on the instance.
- Open `https://<your-url>/docs` → try `/probe` with a real STEP.

**Cold start:** the image is large (OCCT). With `min-instances=0` the first call after idle can take ~10–30 s to spin up. That's fine for the batch-adjacent flow, but `analyze.js` will call it with a timeout and fall back gracefully if it's slow/cold (wired next step). If you want it always warm, set `--min-instances 1` (small always-on cost).

**Cost:** scale-to-zero means you pay only per request-second. A 2 GiB / 1 vCPU instance is well within Cloud Run's free tier for low volume.

---

## Local development / re-validation

```bash
pip install -r requirements.txt httpx
python make_fixtures.py     # regenerate the known-geometry fixtures
python validate_occ.py      # 20 assertions: ground-truth + real assemblies
python http_test.py         # 10 assertions: the HTTP layer
uvicorn main:app --reload   # run locally on :8000
```

---

## Validation evidence (this build)

- **Ground-truth part** (50×30×20 block, Ø10 through-hole + Ø6 blind 8 deep, built with OCP):
  bbox `[50,30,20]`, volume `28203 mm³`, both holes detected with depths `20`/`8`,
  depth:diameter `2.0`/`1.33`, both classified internal, removal ratio `0.06`. **Exact.**
- **Thin-plate part** (40×40×2): min-wall estimate `1.994 mm` (true 2.0). Validated.
- **Real AS1 assemblies** (AP203 + AP214): load and place correctly (AP214 → `200×150×84 mm`);
  the AP203 file's inch declaration converts to a 5 m envelope and the service **flags the
  scale mislabel** — independent confirmation of the same issue `step-probe.js` caught.
- **HTTP layer:** `/health`, `/selftest`, `/probe` (exact numbers), `?min_wall=0`, `415` for
  non-STEP, `422` for unreadable STEP, and the `X-OCC-Token` gate (401/200) all pass.

---

## Next step (the wiring — not done yet)

Once you've deployed and confirmed `/selftest`, the next turn wires it in:
1. `analyze.js` calls `POST {OCC_URL}/probe` for STEP files (with `X-OCC-Token`, a timeout, and graceful fallback), injects a richer geometry block into the prompt, and persists the features to the job row in a new `rules_context` JSONB column.
2. `job-status.js` reads `rules_context`, runs `lib/rules.js` over the OCC features + AI output, and merges the deterministic flags (source-tagged) with the AI flags.
3. `lib/rules.js` gains real geometry rules now that it has real inputs: deep-hole (`max_depth_to_dia`), thin-wall (`min_wall_mm`), high material removal (`removal_ratio`), setup-count (`distinct_setup_normals`), envelope-vs-capacity (`bbox_mm`).
4. One-line Supabase migration: `alter table analysis_jobs add column if not exists rules_context jsonb;`
