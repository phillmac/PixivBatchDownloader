"""Isolated extension test; never uses the live Chromium profile or Pixiv APIs."""
from pathlib import Path
import shutil
import tempfile
from playwright.sync_api import sync_playwright

REPO = Path(__file__).resolve().parents[2]
SEND = """async (msg) => {
  const port = chrome.runtime.connect({name: 'ppbd-crawl-rate'});
  return await new Promise((resolve, reject) => {
    port.onMessage.addListener(reply => { resolve(reply); port.disconnect(); });
    port.onDisconnect.addListener(() => reject(new Error('disconnected')));
    port.postMessage({...msg, request: crypto.randomUUID()});
  });
}"""

def main():
    with tempfile.TemporaryDirectory(prefix='ppbd-rate-test-') as tmp:
        extension = Path(tmp) / 'extension'
        shutil.copytree(REPO / 'dist', extension)
        (extension / 'rate.html').write_text('<html><body>Rate test</body></html>')
        with sync_playwright() as p:
            context = p.chromium.launch_persistent_context(
                str(Path(tmp) / 'profile'), channel='chromium', headless=True,
                ignore_default_args=['--disable-extensions'],
                args=[f'--disable-extensions-except={extension}', f'--load-extension={extension}', '--no-sandbox'])
            worker = context.service_workers[0] if context.service_workers else context.wait_for_event('serviceworker')
            url = f'chrome-extension://{worker.url.split("/")[2]}/rate.html'
            a, b = context.new_page(), context.new_page()
            a.goto(url)
            b.goto(url)
            def send(page, action, identity, **fields):
                return page.evaluate(SEND, dict(action=action, id=identity, **fields))
            for page, identity in [(a, 'a'), (b, 'b')]:
                assert send(page, 'register', identity, account='123', workCount=51)['granted']
            assert send(a, 'permit', 'a')['granted']
            assert not send(b, 'permit', 'b')['granted']
            assert send(b, 'register', 'other', account='456', workCount=51)['granted']
            assert send(b, 'permit', 'other')['granted']
            b.wait_for_timeout(1850)
            assert send(b, 'permit', 'b')['granted']
            assert not send(a, 'permit', 'a')['granted']
            assert send(a, 'finish', 'a')['granted']
            assert 'error' in send(a, 'permit', 'a')
            b.reload()
            assert 'error' in send(b, 'permit', 'b')
            context.close()
    print('crawl rate browser tests passed')

if __name__ == '__main__':
    main()
