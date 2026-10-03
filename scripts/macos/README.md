# macOS desktop build

Engineering Smart System 0.3.0, local redesign build 2. Apple Silicon; macOS 15 or later.
AppKit owns the window, menus, file dialogs and lifecycle. WKWebView renders the local UI.
The bundled Python engine and Chromium PDF renderer run without Homebrew, Node, a source
checkout, or the user's web browser. Workspace data lives outside the app in Application
Support/Engineering Smart System/data and is preserved when the app is replaced.

## Build

Use Xcode Command Line Tools, Node 22, and a standalone CPython 3.12 runtime (for example
uv's managed Python). Create backend/.venv with it. Install requirements-macos.txt into
that environment and install backend editable. From frontend, run npm ci and npm run
build. Then use that environment's Python to run:

```sh
PLAYWRIGHT_BROWSERS_PATH=/absolute/build/browsers python -m playwright install chromium
python scripts/macos/build.py --browsers /absolute/build/browsers
```

The builder compiles Swift and stages the application in Library/Caches. It refuses
uncommitted tracked source. Each bundle includes its source commit and build manifest.
The signature is local ad hoc; this is not an Apple-notarized public distribution.
No company data or credentials belong in the app, source archive or disk image.

## Acceptance

Run the packaged python/bin/python3.12 -s engine.py --verify-runtime with PYTHONHOME
pointing to the packaged Python and ESS_DATA_DIR pointing to a disposable directory.
This creates a database and real quotation PDF and checks Python dependencies are
inside the bundle. Then launch the installed app, quit, and reopen. Confirm the own
engine stops on quit and saved data survives. Verify deep strict codesigning after
copying the application to /Applications.

## Interface scope

The October 3 UI collection at Mohamed3042/ui-reimagination-skill, commit 259fbbab,
was a completed design collection, not an application release. This implementation
applies its dark architectural direction, mint accents, desktop navigation, responsive
layouts and evidence-adjacent Home decision view to the existing product workflows.
The attention list keeps old unresolved work visible and separates sent quotations
awaiting customers from explicitly closed projects. Existing inbox, project, quote,
customer, knowledge and settings actions retain real backend state.
The collection's 22 proposed future product screens are not additional shipped modules.
