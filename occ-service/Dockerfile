# QuoteScout OCC geometry microservice — Google Cloud Run.
# OCC topology extraction needs system libGL + libX11 at runtime (the rest —
# fontconfig/freetype/OpenMP — is bundled inside the cadquery-ocp wheel).
FROM python:3.12-slim

ENV PYTHONUNBUFFERED=1 PIP_NO_CACHE_DIR=1

RUN apt-get update && apt-get install -y --no-install-recommends \
      libgl1 libx11-6 \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY occ_probe.py main.py ./
COPY fixture_holes.step ./

# Cloud Run injects $PORT (default 8080). One worker: OCCT is CPU-heavy and not
# thread-safe; scale with Cloud Run instances, not in-process workers.
ENV PORT=8080
CMD exec uvicorn main:app --host 0.0.0.0 --port ${PORT} --workers 1
