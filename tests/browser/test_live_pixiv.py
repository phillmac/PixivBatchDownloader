from pathlib import Path
import os
import shutil
import tempfile
import time

from playwright.sync_api import sync_playwright

HERE = Path(__file__).resolve().parent
REPO = HERE.parents[1]
WORK_A = os.environ.get('PIXIV_LIVE_A', '150032372')
WORK_B = os.environ.get('PIXIV_LIVE_B', '150017153')
KIBPS = int(os.environ.get('PIXIV_TEST_KIBPS', '1024'))
MODE = os.environ.get('PIXIV_LIVE_MODE', 'serialize')
MAIN_SUFFIX = '_ugoira1920x1080.zip'


def require(condition, message):
    if not condition:
        raise AssertionError(message)


def make_extension_copy():
    root = Path(tempfile.mkdtemp(prefix='ppd-live-extension-'))
    extension = root / 'dist'
    shutil.copytree(REPO / 'dist', extension)
    return root, extension


def attach_network(context, page, label, events):
    cdp = context.new_cdp_session(page)
    cdp.send('Network.enable')
    cdp.send('Network.setBlockedURLs', {'urls': ['*ugoira600x600.zip*']})

    def started(ev):
        url = ev['request']['url']
        if url.endswith(MAIN_SUFFIX):
            now = time.monotonic()
            events[label]['start'] = now
            events[label]['url'] = url
            events[label]['requestId'] = ev['requestId']
            print(f'{label}_START {now:.3f} {url}', flush=True)

    def finished(ev):
        if ev['requestId'] == events[label].get('requestId'):
            now = time.monotonic()
            events[label]['done'] = now
            events[label]['bytes'] = ev.get('encodedDataLength', 0)
            print(f'{label}_DONE {now:.3f} {events[label]["bytes"]}', flush=True)

    cdp.on('Network.requestWillBeSent', started)
    cdp.on('Network.loadingFinished', finished)
    return cdp


def trigger(page):
    page.evaluate("window.dispatchEvent(new CustomEvent('commandQuickDownload'))")


def wait_for(page, selector, timeout=30000):
    page.locator(selector).wait_for(state='attached', timeout=timeout)


def main():
    temp_root, extension = make_extension_copy()
    profile = Path(tempfile.mkdtemp(prefix='ppd-live-profile-'))
    downloads = Path(tempfile.mkdtemp(prefix='ppd-live-downloads-'))
    events = {'A': {}, 'B': {}}

    try:
        with sync_playwright() as p:
            context = p.chromium.launch_persistent_context(
                str(profile), channel='chromium', headless=True,
                downloads_path=str(downloads),
                args=[
                    f'--disable-extensions-except={extension}',
                    f'--load-extension={extension}',
                    '--no-sandbox',
                ],
            )
            page_a = context.new_page()
            page_b = context.new_page()
            page_a.goto(f'https://www.pixiv.net/artworks/{WORK_A}', wait_until='domcontentloaded', timeout=60000)
            page_b.goto(f'https://www.pixiv.net/artworks/{WORK_B}', wait_until='domcontentloaded', timeout=60000)
            wait_for(page_a, '#quickCrawlBtn')
            wait_for(page_b, '#quickCrawlBtn')
            print('pages_ready', WORK_A, WORK_B, flush=True)

            cdp_a = attach_network(context, page_a, 'A', events)
            cdp_b = attach_network(context, page_b, 'B', events)
            throughput = KIBPS * 1024
            conditions = {
                'offline': False,
                'latency': 100,
                'downloadThroughput': throughput,
                'uploadThroughput': throughput,
            }
            cdp_a.send('Network.emulateNetworkConditions', conditions)
            cdp_b.send('Network.emulateNetworkConditions', conditions)
            print(f'throttle={KIBPS}KiB/s', flush=True)

            trigger(page_a)
            deadline = time.monotonic() + 60
            while 'start' not in events['A'] and time.monotonic() < deadline:
                page_a.wait_for_timeout(100)
            require('start' in events['A'], 'tab A main media request never started')
            page_a.wait_for_timeout(1000)
            trigger(page_b)
            b_triggered = time.monotonic()
            print(f'B_TRIGGER {b_triggered:.3f}', flush=True)

            if MODE == 'close':
                page_b.wait_for_timeout(5000)
                require('start' not in events['B'], 'tab B started before tab A was closed')
                closed_at = time.monotonic()
                page_a.close()
                deadline = time.monotonic() + 5
                while 'start' not in events['B'] and time.monotonic() < deadline:
                    page_b.wait_for_timeout(100)
                require('start' in events['B'], 'tab B did not start after tab A closed')
                handoff = events['B']['start'] - closed_at
                require(handoff <= 2.5, f'close handoff was too slow: {handoff:.2f}s')
                print(f'CLOSE_HANDOFF {handoff:.3f}s', flush=True)
                print(f'PASS live-pixiv-close workA={WORK_A} workB={WORK_B}', flush=True)
                context.close()
                return

            guard_until = time.monotonic() + 5
            while time.monotonic() < guard_until:
                require('start' not in events['B'], 'tab B started while tab A held the lease')
                page_b.wait_for_timeout(100)

            deadline = time.monotonic() + 90
            while 'done' not in events['A'] and time.monotonic() < deadline:
                require('start' not in events['B'], 'tab B overlapped tab A network fetch')
                page_a.wait_for_timeout(100)
            require('done' in events['A'], 'tab A main media request did not finish')

            duration = events['A']['done'] - events['A']['start']
            require(duration >= 15, f'CDP throttle ineffective; A finished in {duration:.2f}s')
            print(f'A_DURATION {duration:.3f}s', flush=True)

            deadline = time.monotonic() + 5
            while 'start' not in events['B'] and time.monotonic() < deadline:
                page_b.wait_for_timeout(100)
            require('start' in events['B'], 'tab B did not start after tab A released the lease')
            require(events['B']['start'] >= events['A']['done'], 'tab B started before tab A EOF')
            handoff = events['B']['start'] - events['A']['done']
            require(handoff <= 2.5, f'tab B handoff was too slow: {handoff:.2f}s')
            print(f'HANDOFF {handoff:.3f}s', flush=True)
            print(
                f'PASS live-pixiv workA={WORK_A} workB={WORK_B} '
                f'throttle={KIBPS}KiB/s',
                flush=True,
            )
            context.close()
    finally:
        shutil.rmtree(temp_root, ignore_errors=True)
        shutil.rmtree(profile, ignore_errors=True)
        shutil.rmtree(downloads, ignore_errors=True)


if __name__ == '__main__':
    main()
