"""Compare tracked npm resolutions with the Cobenian compromise feed, without installing packages."""

import argparse
import hashlib
import json
import re
import subprocess
import sys
from pathlib import Path


LOCK_NAMES = {"package-lock.json", "npm-shrinkwrap.json"}
DEPENDENCIES = ("dependencies", "devDependencies", "optionalDependencies", "peerDependencies")
VERSION = re.compile(r"[0-9]+\.[0-9]+\.[0-9]+(?:-[a-zA-Z0-9.-]+)?(?:\+[a-zA-Z0-9.-]+)?")
NAME = re.compile(r"(?:@[\w.~-]+/)?[\w.~-]+", re.ASCII)


def npm_pair(name, version):
    if not isinstance(version, str) or not VERSION.fullmatch(version):
        raise ValueError(f"expected an exact npm version, got {version!r} for {name!r}")
    if not isinstance(name, str) or not NAME.fullmatch(name):
        raise ValueError(f"invalid npm name {name!r}")
    return name, version


def parse_feed(raw):
    compromised = set()
    expected = None
    count = 0
    for number, row in enumerate(raw.decode("utf-8-sig").splitlines(), 1):
        row = row.strip()
        if not row or row.startswith(("#", "//")):
            header = re.search(r"contains ([0-9,]+) confirmed compromised package versions", row)
            if header:
                expected = int(header[1].replace(",", ""))
            continue
        fields = row.split(":")
        if len(fields) == 2:
            ecosystem, (name, version) = "npm", fields
        elif len(fields) == 3 and all(fields):
            ecosystem, name, version = fields
        else:
            raise ValueError(f"invalid feed record on line {number}")
        if ecosystem == "npm":
            compromised.add(npm_pair(name, version))
        count += 1
    if not compromised or expected is None or count != expected:
        raise ValueError(f"incomplete or unrecognised feed: {count} records, header declares {expected}")
    return compromised


def mapping(value, label):
    if not isinstance(value, dict):
        raise ValueError(f"expected an object for {label}")
    return value


def resolved_pair(name, info):
    version = info.get("version")
    if isinstance(version, str) and version.startswith("npm:"):
        name, sep, version = version[4:].rpartition("@")
        if not sep:
            raise ValueError("npm alias lacks an exact target version")
    else:
        name = info.get("name", name)
    return npm_pair(name, version)


def require_resolutions(location, info, packages):
    # Normal dependencies may be hoisted to any ancestor node_modules.
    base = Path(location)
    required = set(mapping(info.get("dependencies", {}), "dependencies"))
    if "node_modules" not in base.parts:
        required.update(mapping(info.get("devDependencies", {}), "devDependencies"))
    required.difference_update(mapping(info.get("optionalDependencies", {}), "optionalDependencies"))
    for name in required:
        if not NAME.fullmatch(name):
            raise ValueError(f"invalid dependency name {name!r}")
        if not any((ancestor / "node_modules" / name).as_posix() in packages
                   for ancestor in (base, *base.parents) if ancestor.name != "node_modules"):
            raise ValueError(f"missing resolution for {name!r} required by {location or '(root)'!r}")


def lock_graph(lock):
    pairs = set()
    manifests = {}
    fmt = lock.get("lockfileVersion")
    if type(fmt) is not int or fmt not in (1, 2, 3):
        raise ValueError(f"unsupported npm lockfileVersion {fmt!r}")
    if fmt == 1:
        pending = [mapping(lock.get("dependencies", {}), "dependencies")]
        while pending:
            for name, info in pending.pop().items():
                info = mapping(info, name)
                pairs.add(resolved_pair(name, info))
                if "dependencies" in info:
                    pending.append(mapping(info["dependencies"], name))
        return pairs, {".": None}

    packages = mapping(lock.get("packages"), "packages")
    if "" not in packages:
        raise ValueError("missing root metadata in packages")
    for location, info in packages.items():
        info = mapping(info, location)
        parts = location.split("/")
        if location and (location.startswith("/") or any(x in ("", ".", "..") for x in parts)):
            raise ValueError(f"invalid package location {location!r}")
        require_resolutions(location, info, packages)
        if "node_modules" not in parts:
            manifests[location or "."] = info
            continue
        if info.get("link") is True:
            target = info.get("resolved")
            record = packages.get(target) if isinstance(target, str) else None
            if not isinstance(record, dict) or record.get("link"):
                raise ValueError(f"unresolved link at {location!r}")
            continue
        name = ("/" + location).rsplit("/node_modules/", 1)[1]
        pairs.add(resolved_pair(name, info))
    return pairs, manifests


def tracked_files(root):
    names = sorted(LOCK_NAMES | {"package.json"})
    specs = [":(glob)**/" + name for name in names]
    output = subprocess.check_output(["git", "-C", str(root), "ls-files", "-z", "--", *specs])
    return {Path(name.decode("utf-8")) for name in output.split(b"\0") if name}


def read_project_json(root, relative):
    path = root / relative
    if path.resolve() != path or not path.is_file():
        raise ValueError(f"expected a regular tracked file at {str(relative)!r}")
    return mapping(json.loads(path.read_bytes()), str(relative))


def scan(root, feed, required, extra_packages):
    raw = feed.read_bytes()
    bad = parse_feed(raw)
    print(f"Feed SHA-256 {hashlib.sha256(raw).hexdigest()}, {len(bad)} npm package versions")
    tracked = {p for p in tracked_files(root) if "node_modules" not in p.parts}
    locks = {p for p in tracked if p.name in LOCK_NAMES}
    missing = set(map(Path, required)) - locks
    if missing or not locks:
        raise ValueError(f"missing tracked npm lockfiles: {sorted(map(str, missing))}")

    covered = {}
    extra = set()
    for value in extra_packages:
        name, _, version = value.rpartition("@")
        extra.add(npm_pair(name, version))
    tool_matches = sorted(bad.intersection(extra))
    found = bool(tool_matches)
    if extra:
        print(f"CI tools: {len(extra)} exact versions, {len(tool_matches)} matches")
        for name, version in tool_matches:
            print(f"  MATCH {name}@{version}")
    for path in sorted(locks):
        if path.with_name("package.json") not in tracked:
            raise ValueError(f"missing tracked package.json next to {str(path)!r}")
        try:
            pairs, manifests = lock_graph(read_project_json(root, path))
        except ValueError as error:
            raise ValueError(f"{str(path)!r}: {error}") from error
        for workspace, info in manifests.items():
            manifest = path.parent / workspace / "package.json"
            covered.setdefault(manifest, []).append((path, info, pairs))
        matches = sorted(bad.intersection(pairs))
        print(f"{str(path)!r}: {len(pairs)} distinct resolutions, {len(matches)} matches")
        for name, version in matches:
            print(f"  MATCH {name}@{version}")
        found |= bool(matches)

    for path in sorted(p for p in tracked if p.name == "package.json"):
        manifest = read_project_json(root, path)
        dependency_types = [key for key in DEPENDENCIES if manifest.get(key)]
        if path not in covered and (dependency_types or manifest.get("workspaces")):
            raise ValueError(f"no tracked npm lock covers {str(path)!r}")
        for lock, info, pairs in covered.get(path, []):
            if info is not None and any(manifest.get(k, {}) != info.get(k, {}) for k in DEPENDENCIES):
                raise ValueError(f"{str(lock)!r} disagrees with dependency declarations in {str(path)!r}")
            if info is None and dependency_types and not pairs:
                raise ValueError(f"{str(lock)!r} has no resolved dependencies")
    return int(found)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--feed", required=True, type=Path)
    parser.add_argument("--root", type=Path, default=Path("."))
    parser.add_argument("--require-lock", action="append", required=True)
    parser.add_argument("--package", action="append", default=[])
    args = parser.parse_args()
    try:
        return scan(args.root.resolve(), args.feed, args.require_lock, args.package)
    except (OSError, ValueError, subprocess.CalledProcessError) as error:
        print(f"Scan incomplete: {error}", file=sys.stderr)
        return 2


if __name__ == "__main__":
    sys.exit(main())
