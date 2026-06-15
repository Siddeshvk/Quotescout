"""
QuoteScout — occ-service / main.py
HTTP wrapper around occ_probe.probe_step. Designed for Google Cloud Run.

Endpoints
  GET  /            → service info (+ link to /docs)
  GET  /health      → {ok, version}                     (Cloud Run health check)
  GET  /selftest    → runs the probe on a bundled known part; lets you confirm
                      OpenCascade actually works on the deployed instance
  POST /probe       → multipart field "file" = a .step/.stp; returns topology JSON
                      query: ?min_wall=0 to skip the (slower) min-wall estimate

Security / privacy
  - Nothing is stored. The upload is written to a temp file, probed, and deleted.
  - Optional shared-secret gate: set env OCC_SHARED_SECRET and callers must send
    header `X-OCC-Token: <that value>`. If the env var is unset, the gate is off.
  - CORS is intentionally NOT enabled — this is meant to be called server-to-server
    from QuoteScout's Vercel function (analyze.js), not from the browser.
"""

import os
import tempfile

from fastapi import FastAPI, UploadFile, File, Header, Query, HTTPException, Request
from fastapi.responses import JSONResponse, HTMLResponse

from occ_probe import probe_step, OCC_PROBE_VERSION

MAX_BYTES = int(os.environ.get("OCC_MAX_BYTES", str(50 * 1024 * 1024)))  # 50 MB default
ALLOWED_EXT = (".step", ".stp")
SHARED_SECRET = os.environ.get("OCC_SHARED_SECRET", "")  # empty => auth disabled
SELFTEST_FIXTURE = os.path.join(os.path.dirname(__file__), "fixture_holes.step")

app = FastAPI(
    title="QuoteScout OCC geometry probe",
    version=OCC_PROBE_VERSION,
    description="Deterministic OpenCascade topology extraction for STEP files "
                "(bbox, volume, hole depth:diameter, min wall, removal ratio).",
)


def _check_auth(token):
    if SHARED_SECRET and token != SHARED_SECRET:
        raise HTTPException(status_code=401, detail="Missing or invalid X-OCC-Token.")


async def _save_upload(file: UploadFile) -> str:
    fd, path = tempfile.mkstemp(suffix=".step")
    size = 0
    try:
        with os.fdopen(fd, "wb") as out:
            while True:
                chunk = await file.read(1024 * 1024)
                if not chunk:
                    break
                size += len(chunk)
                if size > MAX_BYTES:
                    raise HTTPException(status_code=413,
                                        detail=f"File exceeds {MAX_BYTES // (1024*1024)} MB limit.")
                out.write(chunk)
    except HTTPException:
        try:
            os.unlink(path)
        except OSError:
            pass
        raise
    if size == 0:
        try:
            os.unlink(path)
        except OSError:
            pass
        raise HTTPException(status_code=400, detail="Empty upload.")
    return path


@app.get("/", response_class=HTMLResponse)
def root():
    return (
        f"<h2>QuoteScout OCC geometry probe v{OCC_PROBE_VERSION}</h2>"
        "<p>POST a STEP file to <code>/probe</code> (multipart field <code>file</code>). "
        "See <a href='/docs'>/docs</a>. Health at <code>/health</code>, "
        "self-test at <code>/selftest</code>.</p>"
    )


@app.get("/health")
def health():
    return {"ok": True, "version": OCC_PROBE_VERSION}


@app.get("/selftest")
def selftest():
    """Probe a bundled known part so you can confirm OCC works on this instance."""
    if not os.path.exists(SELFTEST_FIXTURE):
        return JSONResponse(status_code=500, content={"ok": False, "error": "selftest fixture missing from image."})
    result = probe_step(SELFTEST_FIXTURE)
    # quick built-in expectations (the fixture is a 50×30×20 block, Ø10 through + Ø6 blind 8 deep)
    checks = {
        "bbox_50x30x20": result.get("bbox_mm") == [50.0, 30.0, 20.0],
        "two_holes": result.get("hole_count") == 2,
        "max_depth_to_dia_2": result.get("max_depth_to_dia") == 2.0,
    }
    return {"ok": result.get("ok") and all(checks.values()), "checks": checks, "result": result}


@app.post("/probe")
async def probe(
    request: Request,
    file: UploadFile = File(...),
    min_wall: int = Query(1, description="1 = estimate min wall (slower), 0 = skip"),
    x_occ_token: str = Header(default=""),
):
    _check_auth(x_occ_token)

    name = (file.filename or "").lower()
    if not name.endswith(ALLOWED_EXT):
        raise HTTPException(status_code=415,
                            detail=f'"{file.filename}" is not a STEP file (expected .step/.stp).')

    path = await _save_upload(file)
    try:
        result = probe_step(path, {"min_wall": bool(min_wall)})
    finally:
        try:
            os.unlink(path)
        except OSError:
            pass

    if not result.get("ok"):
        # a valid request but the STEP couldn't be reconstructed
        return JSONResponse(status_code=422, content=result)
    return result
