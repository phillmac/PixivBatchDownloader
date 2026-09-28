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

## Live Pixiv integration test

`test_live_pixiv.py` is intentionally manual because it downloads public media from Pixiv.
It loads two real artwork pages, triggers the extension's normal quick-download event, and throttles each tab with CDP network emulation.

```bash
python3 tests/browser/test_live_pixiv.py
PIXIV_LIVE_MODE=close python3 tests/browser/test_live_pixiv.py
```

Defaults use public ugoira works `150032372` and `150017153` at 1024 KiB/s.
Override them with `PIXIV_LIVE_A`, `PIXIV_LIVE_B`, and `PIXIV_TEST_KIBPS`.

The default mode asserts that tab B's 1920px ugoira ZIP cannot start before tab A reaches EOF, then checks prompt handoff. `PIXIV_LIVE_MODE=close` instead closes tab A mid-transfer and verifies tab B acquires the slot promptly.
