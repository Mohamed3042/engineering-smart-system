"""Start a review app using invented data only, without changing an existing workspace.

backend/.venv/Scripts/python scripts/review_fixture.py
Prints the private fixture URL, PID and route IDs to data/review-fixture.json.
The scheduler is off; no mailbox or AI provider is connected.
"""
from __future__ import annotations

import json
import io
import os
import sys
import tempfile
from pathlib import Path

import screenshots as fixtures


def main() -> None:
    sys.stdout.reconfigure(encoding="utf-8")
    root = Path(__file__).resolve().parents[1]
    (root / "data").mkdir(exist_ok=True)
    fixtures.DATA = Path(tempfile.mkdtemp(prefix="review-", dir=root / "data"))
    os.environ["ESS_DATA_DIR"] = str(fixtures.DATA)
    os.environ["ESS_SCHEDULER"] = "0"
    fixtures.seed()
    proc = fixtures.start_app()
    try:
        import httpx
        with httpx.Client(base_url=fixtures.BASE, timeout=120) as client:
            routes = fixtures.prepare(client)
            from PIL import Image, ImageDraw

            # An explicitly fictional illustration exercises the actual photo/PDF pipeline.
            sample = Image.new("RGB", (640, 360), "#edf3f1")
            draw = ImageDraw.Draw(sample)
            draw.rectangle((180, 95, 460, 245), outline="#176b61", width=5)
            draw.line((120, 250, 520, 250), fill="#176b61", width=5)
            draw.text((320, 35), "SAMPLE REFERENCE", anchor="mm", fill="#176b61", font_size=24)
            draw.text((320, 310), "Fictional illustration - not a real site", anchor="mm", fill="#344941", font_size=20)
            image = io.BytesIO()
            sample.save(image, format="PNG")
            response = client.post(f"/api/quotations/{routes['q_harbor']}/photos",
                                   files={"file": ("fictional-reference.png", image.getvalue(), "image/png")},
                                   data={"caption": "Fictional reference for the UI review", "placement": "annex"})
            response.raise_for_status()
            photos = response.json()["data"]["photos"]
            photos[0]["placement"] = {"mode": "page", "page": 1, "x_mm": 145, "y_mm": 225, "width_mm": 40}
            response = client.put(f"/api/quotations/{routes['q_harbor']}", json={"data": {"photos": photos}})
            response.raise_for_status()
        record = {"url": fixtures.BASE, "pid": proc.pid, "data": str(fixtures.DATA), "routes": routes}
        (root / "data" / "review-fixture.json").write_text(json.dumps(record, indent=2), encoding="utf-8")
        print(json.dumps(record, indent=2))
    except BaseException:
        proc.terminate()
        raise


if __name__ == "__main__":
    main()
