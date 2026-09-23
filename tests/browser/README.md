# Real-browser extension tests

These tests load the built `dist/` directory as an unpacked Manifest V3 extension in Playwright Chromium.
They exercise the extension service worker, tab sender identity, and extension storage in a real browser process.

## Setup

```bash
python3 -m pip install --user -r tests/browser/requirements.txt
python3 -m playwright install chromium
```

The host must also provide Chromium's shared-library dependencies.

## Run

```bash
python3 tests/browser/test_global_download_lease.py
```

The test copies `dist/` to a temporary directory, injects its test-only extension page there, and leaves tracked build artifacts unchanged.
