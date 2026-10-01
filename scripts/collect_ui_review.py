"""Capture the review fixture at real desktop/phone viewports; never read owner data.

Run review_fixture.py first, then this script. Output is docs/ui-review/.
One browser handles both devices. Capture failures make this command fail.
"""
from __future__ import annotations

import json
import re
import sys
from pathlib import Path

from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / "docs" / "ui-review"


def main() -> None:
    sys.stdout.reconfigure(encoding="utf-8")
    fixture = json.loads((ROOT / "data/review-fixture.json").read_text(encoding="utf-8"))
    assert Path(fixture["data"]).name.startswith("review-"), "Only an invented review fixture may be captured."
    routes = fixture["routes"]
    states = [
        ("home", "/", None),
        ("inbox", "/inbox", None),
        ("arabic-email", "/inbox/demo-a1", None),
        ("projects", "/projects", None),
        ("project-brief", "/projects/{marina}", None),
        ("inputs", "/projects/{crescent}/inputs", None),
        ("drawing-viewer", "/files/{file_pdf}", None),
        ("boq-evidence", "/files/{file_boq}", None),
        ("engineering-review", "/projects/{marina}/review", None),
        ("deadline-change", "/projects/{marina}/changes/0", None),
        ("quotation-editor", "/quotations/{q_harbor}", None),
        ("quotation-builder", "/quotations/{q_harbor}#document", None),
        ("quotation-preview", "/quotations/{q_harbor}/preview", None),
        ("quotation-papers", "/quotations/setup/papers", None),
        ("quotation-signatories", "/quotations/setup/signatories", None),
        ("quotation-letterhead", "/quotations/setup/letterhead", None),
        ("template-rules", "/quotations/setup/rules", None),
        ("customers", "/customers", None),
        ("customer-lessons", "/customers/{customer}/lessons", None),
        ("workspace-learning", "/settings/learning", None),
        ("automations", "/automations", None),
        ("automation-details", "/automations/{automation}", None),
        ("workflow-create", "/automations", {"button": "^New workflow$", "editor": "create"}),
        ("workflow-edit", "/automations/{automation}", {"button": "^Edit workflow$", "editor": "edit"}),
        ("quotation-defaults", "/settings/workspace#quotation-defaults", None),
        ("mail-project-picker", "/inbox/demo-a1", "^File under a project$"),
        ("mail-new-project", "/inbox/demo-a1", {"button": "^File under a project$", "project": "new"}),
        ("reply-draft", "/inbox/demo-a1", "^Reply$"),
        ("forward-draft", "/inbox/demo-a1", "^Forward$"),
        ("stamp-position", "/quotations/{q_harbor}#document", "^Edit stamp placement"),
        ("photo-import", "/quotations/{q_harbor}#photos", "^Add photo"),
        ("template-rule-dialog", "/quotations/{q_harbor}#document", "^Save as template rule"),
    ]
    results, failures = [], []
    OUT.mkdir(exist_ok=True)
    with sync_playwright() as pw:
        browser = pw.chromium.launch()
        for device, width, height in (("desktop", 1440, 900), ("phone", 390, 844)):
            context = browser.new_context(viewport={"width": width, "height": height},
                                          device_scale_factor=1, is_mobile=device == "phone",
                                          has_touch=device == "phone", reduced_motion="reduce")
            page = context.new_page()
            errors = []
            page.on("pageerror", lambda error: errors.append(str(error)))
            for name, template, action in states:
                path = template.format(**routes)
                try:
                    # Fragment-only navigation retains open drawers in the SPA. Each capture starts
                    # independently, so a preceding stamp sheet cannot cover the photo import.
                    page.goto("about:blank")
                    page.goto(fixture["url"] + path)
                    page.wait_for_load_state("networkidle")
                    page.locator("h1:visible").first.wait_for(state="visible")
                    page.wait_for_timeout(150)
                    if isinstance(action, dict):
                        page.get_by_role("button", name=re.compile(action["button"], re.I)).first.click()
                        if action.get("editor"):
                            creating = action["editor"] == "create"
                            page.get_by_role("heading", name="New workflow" if creating else "Edit workflow", exact=True).wait_for(state="visible")
                            # These are unsaved edits to invented data. Never start or save a workflow.
                            if creating:
                                page.get_by_label("Workflow name", exact=False).fill("Sample enquiry check")
                                page.get_by_label("Description", exact=False).fill("Read new mail, classify enquiries and stop for an engineer to review.")
                            page.get_by_label("Starts", exact=True).select_option("schedule")
                            page.get_by_label("Minutes between runs", exact=True).fill("60")
                            if creating:
                                for step in ("sync_mail", "classify", "request_review"):
                                    page.get_by_label("Add a step", exact=True).select_option(step)
                                    page.get_by_role("button", name="Add step", exact=True).click()
                                page.get_by_label("Required engineer review", exact=True).wait_for(state="visible")
                            page.evaluate("window.scrollTo(0, 0)")
                            page.wait_for_timeout(150)
                        elif action.get("project") == "new":
                            dialog = page.get_by_role("dialog").first
                            dialog.wait_for(state="visible")
                            dialog.get_by_role("radio", name="New project", exact=True).click()
                            dialog.get_by_label("Project name", exact=False).wait_for(state="visible")
                    elif action:
                        page.get_by_role("button", name=re.compile(action, re.I)).first.click()
                        page.get_by_role("dialog").first.wait_for(state="visible")
                        page.wait_for_timeout(200)
                    measurements = page.evaluate("""() => ({ width: innerWidth, height: innerHeight,
                        scrollWidth: document.documentElement.scrollWidth,
                        scrollHeight: document.documentElement.scrollHeight })""")
                    assert measurements["width"] == width, f"Viewport expanded: {measurements}"
                    assert measurements["scrollWidth"] <= width + 1, f"Horizontal page overflow: {measurements}"
                    file = f"{name}-{device}.png"
                    page.screenshot(path=str(OUT / file))
                    if name in ("quotation-editor", "projects", "home") and not action:
                        page.screenshot(path=str(OUT / f"{name}-{device}-full.png"), full_page=True)
                    if name in ("workflow-create", "workflow-edit"):
                        page.screenshot(path=str(OUT / f"{name}-{device}-full.png"), full_page=True)
                    results.append({"name": name, "device": device, "route": template,
                                    "viewport": [width, height], "measurements": measurements, "file": file})
                except Exception as exc:
                    failures.append({"name": name, "device": device, "error": str(exc)})
                    page.screenshot(path=str(OUT / f"failed-{name}-{device}.png"))
            failures.extend({"device": device, "error": error} for error in errors)
            context.close()
        browser.close()
    report = {"fixture": "Invented workspace only; no mailbox or AI provider connected. Workflow forms are unsaved; no workflow is run or mail sent.",
              "captures": results, "failures": failures}
    (OUT / "verification.json").write_text(json.dumps(report, indent=2), encoding="utf-8")
    lines = ["# UI review", "", "Rendered application, 1 October 2026. Invented companies and sample assets only.",
             "Desktop 1440 x 900; phone 390 x 844. Images use the normal viewport; selected pages also have full-page captures.",
             "No physical phone, real mailbox, live AI provider or actual send was exercised. Workflow form captures contain unsaved sample edits.", "",
             "| Screen | Route | Desktop | Phone |", "|---|---|---|---|"]
    for name, route, _ in states:
        lines.append(f"| {name.replace('-', ' ')} | `{route}` | [desktop]({name}-desktop.png) | [phone]({name}-phone.png) |")
    (OUT / "INDEX.md").write_text("\n".join(lines) + "\n", encoding="utf-8")
    print(json.dumps({"captures": len(results), "failures": failures}, indent=2))
    if failures:
        raise SystemExit(1)


if __name__ == "__main__":
    main()
