"""Build the Apple Silicon app using the project's installed, locked dependencies."""
from pathlib import Path
import argparse
from datetime import date
import hashlib
import json
import plistlib
import shutil
import subprocess
import sys
import sysconfig
from PIL import Image

BUILD = Path(__file__).resolve().parent
parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('--source', type=Path, default=BUILD.parents[1])
parser.add_argument('--python-runtime', type=Path, default=Path(sys.base_prefix))
parser.add_argument('--browsers', type=Path, default=BUILD / 'browsers')
parser.add_argument('--stage', type=Path, default=Path.home() / 'Library/Caches/Engineering Smart System Build/stage')
args = parser.parse_args()
SOURCE = args.source.resolve()
BASE_PYTHON = args.python_runtime.resolve()
SITE_PACKAGES = Path(sysconfig.get_paths()['purelib']).resolve()
APP = args.stage.resolve() / 'Engineering Smart System.app'
version = json.loads((SOURCE / 'frontend/package.json').read_text())['version']
commit = subprocess.check_output(['git', 'rev-parse', 'HEAD'], cwd=SOURCE, text=True).strip()
if subprocess.check_output(['git', 'status', '--porcelain', '--untracked-files=no'], cwd=SOURCE, text=True).strip():
    raise SystemExit('Commit source before packaging so release.json identifies this build precisely.')
if BASE_PYTHON == SITE_PACKAGES or not (BASE_PYTHON / 'bin/python3.12').is_file():
    raise SystemExit('Use a Python 3.12 virtual environment backed by a standalone Python runtime.')
browsers = [p for p in args.browsers.iterdir() if p.is_dir() and (p.name.startswith('chromium-') or p.name.startswith('ffmpeg-'))]
if not any(p.name.startswith('chromium-') for p in browsers):
    raise SystemExit('Install the locked Playwright Chromium into --browsers before building.')

def copy_tree(source, destination):
    shutil.copytree(source, destination, symlinks=True,
                    ignore=shutil.ignore_patterns('__pycache__', '*.pyc', '.DS_Store'))

args.stage.mkdir(parents=True, exist_ok=True)
binary = args.stage / 'Engineering Smart System'
print('Compiling the native AppKit / WebKit shell', flush=True)
subprocess.run(['xcrun', 'swiftc', '-swift-version', '5', '-O', '-target', 'arm64-apple-macosx15.0',
                '-framework', 'AppKit', '-framework', 'WebKit', '-module-cache-path', str(args.stage / 'swift-module-cache'),
                str(BUILD / 'Main.swift'), '-o', str(binary)], check=True)
if APP.exists(): shutil.rmtree(APP)
resources = APP / 'Contents/Resources'
(APP / 'Contents/MacOS').mkdir(parents=True)
resources.mkdir()
shutil.copy2(binary, APP / 'Contents/MacOS/Engineering Smart System')
print('Copying standalone Python and installed libraries', flush=True)
copy_tree(BASE_PYTHON, resources / 'python')
packaged_site = resources / 'python/lib/python3.12/site-packages'
if packaged_site.exists(): shutil.rmtree(packaged_site)
copy_tree(SITE_PACKAGES, packaged_site)
for pattern in ['__editable__*', '_virtualenv.pth', '_virtualenv.py']:
    for path in packaged_site.glob(pattern):
        if path.is_file(): path.unlink()
copy_tree(SOURCE / 'backend/ess', resources / 'backend/ess')
copy_tree(SOURCE / 'frontend/dist', resources / 'frontend')
print('Copying the document browser', flush=True)
(resources / 'browsers').mkdir()
for browser in browsers: copy_tree(browser, resources / 'browsers' / browser.name)
shutil.copy2(BUILD / 'engine.py', resources / 'engine.py')
(resources / 'build-source').mkdir()
for name in ['Main.swift', 'engine.py', 'build.py', 'README.md', 'requirements-macos.txt']:
    shutil.copy2(BUILD / name, resources / 'build-source' / name)
if (SOURCE / 'LICENSE').exists(): shutil.copy2(SOURCE / 'LICENSE', resources / 'LICENSE')
release = {'name': 'Engineering Smart System', 'version': version, 'desktop_build': '3',
           'commit': commit, 'repository': 'https://github.com/Mohamed3042/engineering-smart-system',
           'distribution': 'local macOS redesign build', 'architecture': 'arm64',
           'built_on': date.today().isoformat(), 'minimum_macos': '15.0',
           'native_shell_sha256': hashlib.sha256((BUILD / 'Main.swift').read_bytes()).hexdigest(),
           'engine_entrypoint_sha256': hashlib.sha256((BUILD / 'engine.py').read_bytes()).hexdigest()}
(resources / 'release.json').write_text(json.dumps(release, indent=2) + '\n')
with Image.open(SOURCE / 'scripts/app.ico') as icon:
    icon.convert('RGBA').save(resources / 'AppIcon.icns', format='ICNS')
info = {'CFBundleDevelopmentRegion': 'en', 'CFBundleExecutable': 'Engineering Smart System',
        'CFBundleIdentifier': 'com.mohamed3042.engineeringsmartsystem',
        'CFBundleInfoDictionaryVersion': '6.0', 'CFBundleName': 'Engineering Smart System',
        'CFBundleDisplayName': 'Engineering Smart System', 'CFBundlePackageType': 'APPL',
        'CFBundleShortVersionString': version, 'CFBundleVersion': '3', 'CFBundleIconFile': 'AppIcon',
        'LSMinimumSystemVersion': '15.0', 'LSApplicationCategoryType': 'public.app-category.business',
        'NSHighResolutionCapable': True, 'NSPrincipalClass': 'NSApplication',
        'NSAppTransportSecurity': {'NSAllowsLocalNetworking': True},
        'NSHumanReadableCopyright': 'Engineering Smart System. Local macOS build 3.'}
(APP / 'Contents/Info.plist').write_bytes(plistlib.dumps(info))
broken_links = [str(p) for p in APP.rglob('*') if p.is_symlink() and
                (not p.exists() or not p.resolve().is_relative_to(APP.resolve()))]
if broken_links: raise RuntimeError('Nonportable symlinks: ' + '\n'.join(broken_links))
print('Signing the native application', flush=True)
# Build outside iCloud-backed Documents, which can recreate FinderInfo during signing.
for attribute in ['com.apple.FinderInfo', 'com.apple.ResourceFork']:
    subprocess.run(['/usr/bin/xattr', '-dr', attribute, str(APP)], capture_output=True)
subprocess.run(['/usr/bin/codesign', '--force', '--deep', '--sign', '-', str(APP)], check=True)
subprocess.run(['/usr/bin/codesign', '--verify', '--deep', '--strict', '--verbose=2', str(APP)], check=True)
print(APP, flush=True)
