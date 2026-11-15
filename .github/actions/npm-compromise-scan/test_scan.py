import json
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

from scan import lock_graph, parse_feed


BAD = ("@example/bad", "1.2.3-rc.1")
FEED = b"""# This file contains 3 confirmed compromised package versions
# comment
// comment
npm:@example/bad:1.2.3-rc.1
old-style:1.0.0
pypi:only-python:2.0.0
"""


class FormatTests(unittest.TestCase):
    def test_ecosystems_and_prereleases(self):
        self.assertEqual(parse_feed(FEED), {BAD, ("old-style", "1.0.0")})
        for partial in (b"", FEED.rsplit(b"\n", 2)[0], FEED.replace(b"1.0.0", b"^1.0.0")):
            with self.subTest(partial=partial), self.assertRaises(ValueError):
                parse_feed(partial)

    def test_old_locks_with_nested_alias(self):
        lock = {"lockfileVersion": 1, "dependencies": {"parent": {
            "version": "1.0.0", "dependencies": {"alias": {"version": "npm:@example/bad@1.2.3-rc.1"}}
        }}}
        self.assertIn(BAD, lock_graph(lock)[0])

    def test_modern_locks_with_nested_scopes_aliases_and_workspaces(self):
        for fmt in (2, 3):
            lock = {"lockfileVersion": fmt, "packages": {
                "": {}, "packages/local": {"version": "0.1.0"},
                "node_modules/local": {"link": True, "resolved": "packages/local"},
                "node_modules/parent/node_modules/alias": {"name": BAD[0], "version": BAD[1]},
                "node_modules/@example/bad": {"version": "1.2.3"},
            }}
            pairs, workspaces = lock_graph(lock)
            self.assertEqual(pairs, {BAD, (BAD[0], "1.2.3")})
            self.assertIn("packages/local", workspaces)


class CommandTests(unittest.TestCase):
    def setUp(self):
        temp = tempfile.TemporaryDirectory()
        self.addCleanup(temp.cleanup)
        self.root = Path(temp.name)
        subprocess.run(["git", "init", "--quiet", str(self.root)], check=True)
        (self.root / "feed").write_bytes(FEED)
        self.manifest = {"dependencies": {"alias": "npm:@example/bad@^1.2.3"}}
        self.lock = {"lockfileVersion": 3, "packages": {
            "": self.manifest, "node_modules/alias": {"name": BAD[0], "version": "1.2.3"}
        }}
        self.write("package.json", self.manifest)
        self.write("package-lock.json", self.lock)

    def write(self, name, obj):
        path = self.root / name
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(json.dumps(obj))
        subprocess.run(["git", "-C", str(self.root), "add", "--", name], check=True)

    def run_check(self, expected, message, *extra):
        result = subprocess.run([sys.executable, "-I", str(Path(__file__).with_name("scan.py")),
                                 "--root", str(self.root), "--feed", str(self.root / "feed"),
                                 "--require-lock", "package-lock.json", *extra], capture_output=True, text=True)
        out = result.stdout + result.stderr
        self.assertEqual(result.returncode, expected, out)
        self.assertIn(message, out)

    def test_neighbour_and_nested_match(self):
        self.run_check(0, "0 matches")
        self.lock["packages"]["node_modules/alias"]["version"] = BAD[1]
        self.write("nested/package.json", self.manifest)
        self.write("nested/npm-shrinkwrap.json", self.lock)
        self.run_check(1, "MATCH @example/bad@1.2.3-rc.1")

    def test_missing_or_invalid_lock_and_manifest_drift(self):
        self.write("package.json", {"dependencies": {"changed": "^2.0.0"}})
        self.run_check(2, "disagrees")
        self.write("package-lock.json", {"lockfileVersion": 3})
        self.run_check(2, "expected an object")
        subprocess.run(["git", "-C", str(self.root), "rm", "-f", "package-lock.json"], check=True)
        self.run_check(2, "missing tracked npm lockfiles")

    def test_unlocked_project(self):
        self.write("new/package.json", {"devDependencies": {"tool": "*"}})
        self.run_check(2, "no tracked npm lock")

    def test_missing_transitive_resolution(self):
        self.lock["packages"]["node_modules/alias"]["dependencies"] = {"missing": "1.0.0"}
        self.write("package-lock.json", self.lock)
        self.run_check(2, "missing resolution")

    def test_ci_tools_and_symlinked_inputs(self):
        self.run_check(1, "MATCH @example/bad@1.2.3-rc.1", "--package", "@example/bad@1.2.3-rc.1")
        (self.root / "package-lock.json").rename(self.root / "elsewhere")
        (self.root / "package-lock.json").symlink_to("elsewhere")
        self.run_check(2, "regular tracked file")


if __name__ == "__main__":
    unittest.main()
