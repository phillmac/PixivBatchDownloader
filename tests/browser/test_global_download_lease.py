from pathlib import Path
import shutil
import tempfile
import time

from playwright.sync_api import sync_playwright

HERE = Path(__file__).resolve().parent
REPO = HERE.parents[1]


def call(page, method, *args):
    return page.evaluate(
        "([method,args]) => window.leaseTest[method](...args)",
        [method, list(args)],
    )


def require(condition, message):
    if not condition:
        raise AssertionError(message)


def make_extension_copy():
    root = Path(tempfile.mkdtemp(prefix="ppd-extension-"))
    extension = root / "dist"
    shutil.copytree(REPO / "dist", extension)
    shutil.copy2(HERE / "lease-harness.html", extension / "lease-harness.html")
    shutil.copy2(HERE / "lease-harness.js", extension / "lease-harness.js")
    return root, extension


def main():
    temp_root, extension = make_extension_copy()
    profile = Path(tempfile.mkdtemp(prefix="ppd-browser-profile-"))

    try:
        with sync_playwright() as p:
            context = p.chromium.launch_persistent_context(
                str(profile),
                channel="chromium",
                headless=True,
                args=[
                    f"--disable-extensions-except={extension}",
                    f"--load-extension={extension}",
                    "--no-sandbox",
                ],
            )

            workers = context.service_workers
            worker = workers[0] if workers else context.wait_for_event("serviceworker")
            extension_id = worker.url.split("/")[2]
            harness = f"chrome-extension://{extension_id}/lease-harness.html"

            tab_a = context.new_page()
            tab_b = context.new_page()
            for page in (tab_a, tab_b):
                page.goto(harness)
                page.wait_for_function("window.leaseTest !== undefined")

            first = call(tab_a, "acquire", "req-a", "file-a")
            require(first.get("granted") is True, f"first acquire failed: {first}")
            lease_a = first["leaseId"]

            blocked = call(tab_b, "acquire", "req-b", "file-b")
            require(
                blocked.get("granted") is False,
                f"second tab was not blocked: {blocked}",
            )

            renewed = call(tab_a, "renew", "req-a", lease_a)
            require(renewed.get("granted") is True, f"renew failed: {renewed}")

            released = call(tab_a, "release", "req-a", lease_a)
            require(released.get("granted") is True, f"release failed: {released}")

            second = call(tab_b, "acquire", "req-b", "file-b")
            require(
                second.get("granted") is True,
                f"handoff after release failed: {second}",
            )

            tab_b.close()
            deadline = time.time() + 3
            after_close = {"granted": False}
            while time.time() < deadline:
                after_close = call(tab_a, "acquire", "req-c", "file-c")
                if after_close.get("granted"):
                    break
                time.sleep(0.1)

            require(
                after_close.get("granted") is True,
                f"owner close handoff failed: {after_close}",
            )
            call(tab_a, "release", "req-c", after_close["leaseId"])

            tab_d = context.new_page()
            tab_d.goto(harness)
            tab_d.wait_for_function("window.leaseTest !== undefined")
            stuck = call(tab_d, "acquire", "req-d", "file-d")
            require(stuck.get("granted") is True, f"stuck owner acquire failed: {stuck}")
            stale_lease_id = stuck["leaseId"]

            time.sleep(46)
            after_expiry = call(tab_a, "acquire", "req-e", "file-e")
            require(
                after_expiry.get("granted") is True,
                f"expired lease did not hand off: {after_expiry}",
            )

            stale_renew = call(tab_d, "renew", "req-d", stale_lease_id)
            require(
                stale_renew.get("granted") is False,
                f"stale fencing token was accepted: {stale_renew}",
            )
            call(tab_a, "release", "req-e", after_expiry["leaseId"])

            print(f"extension_id={extension_id}")
            print("PASS mutual-exclusion renew release close-handoff expiry-fencing")
            context.close()
    finally:
        shutil.rmtree(temp_root, ignore_errors=True)
        shutil.rmtree(profile, ignore_errors=True)


if __name__ == "__main__":
    main()
