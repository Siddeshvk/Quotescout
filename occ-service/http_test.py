import os
from fastapi.testclient import TestClient

p=0; f=0
def ok(n,c,e=""):
    global p,f; p+=c; f+=(not c); print(("ok   " if c else "FAIL ")+n+(("  — "+e) if e else ""))

import main
client = TestClient(main.app)

# health
r = client.get("/health"); ok("GET /health 200", r.status_code==200 and r.json().get("ok"), str(r.status_code))
# selftest (real OCC on bundled fixture)
r = client.get("/selftest"); j=r.json()
ok("GET /selftest 200 + passes", r.status_code==200 and j.get("ok"), str(j.get("checks")))
# probe a real STEP
with open("fixture_holes.step","rb") as fh:
    r = client.post("/probe", files={"file": ("fixture_holes.step", fh, "application/step")})
j = r.json()
ok("POST /probe 200", r.status_code==200, str(r.status_code))
ok("  bbox 50x30x20", j.get("bbox_mm")==[50.0,30.0,20.0])
ok("  2 holes, max d:d 2.0", j.get("hole_count")==2 and j.get("max_depth_to_dia")==2.0)
# min_wall skip flag
with open("fixture_holes.step","rb") as fh:
    r = client.post("/probe?min_wall=0", files={"file":("fixture_holes.step",fh,"application/step")})
ok("POST /probe?min_wall=0 skips wall", r.status_code==200 and r.json().get("min_wall_mm") is None)
# non-step rejected 415
r = client.post("/probe", files={"file":("notes.txt", b"hello", "text/plain")})
ok("POST non-step -> 415", r.status_code==415, str(r.status_code))
# empty filename / garbage step content -> 422 (valid request, bad geometry)
r = client.post("/probe", files={"file":("junk.step", b"not really a step", "application/step")})
ok("POST junk .step -> 422", r.status_code==422, str(r.status_code))

# auth gate: enable secret, reload app
os.environ["OCC_SHARED_SECRET"]="s3cret"
import importlib; importlib.reload(main); c2=TestClient(main.app)
with open("fixture_holes.step","rb") as fh:
    r = c2.post("/probe", files={"file":("fixture_holes.step",fh,"application/step")})
ok("auth on: no token -> 401", r.status_code==401, str(r.status_code))
with open("fixture_holes.step","rb") as fh:
    r = c2.post("/probe", files={"file":("fixture_holes.step",fh,"application/step")}, headers={"X-OCC-Token":"s3cret"})
ok("auth on: good token -> 200", r.status_code==200, str(r.status_code))
os.environ.pop("OCC_SHARED_SECRET",None)

print(f"\n{p} passed, {f} failed"); raise SystemExit(1 if f else 0)
