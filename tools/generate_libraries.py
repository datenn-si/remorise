"""Generate the third-party library list shown on the About page.

The list covers direct dependencies only, taken from the actual
dependency definitions and the installed packages' metadata —
nothing is guessed:

- frontend: ``frontend/package.json`` (dependencies /
  devDependencies), with version and license read from each
  package's installed ``node_modules/<name>/package.json``.
- backend: ``backend/pyproject.toml`` ([project] dependencies and
  the dev dependency group), with version and license read from
  the installed distributions' metadata. Run this script through
  the backend project (``cd backend``, then
  ``uv run python ../tools/generate_libraries.py``) so the
  metadata is the backend's own.

Output: ``frontend/src/libraries.json`` (static data; the page
never fetches anything at runtime — and not ``src/data/``, which
the repository's ``**/data/`` ignore rule would keep out of git).
Entries whose metadata carries no license keep an empty string
and are reported here. Each entry also carries a ``licenseUrl``:
the canonical license text on spdx.org, filled only when the
license string resolves to exactly one known SPDX identifier —
compound expressions and unresolvable names stay unlinked
instead of guessing a target.
"""

import json
import re
import sys
import tomllib
from importlib import metadata
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent

_SPDX_TEXT_URL = "https://spdx.org/licenses/{}.html"
_LINKABLE_LICENSES = {
    "AGPL-3.0-only",
    "Apache-2.0",
    "BSD-2-Clause",
    "BSD-3-Clause",
    "CC0-1.0",
    "GPL-3.0-only",
    "ISC",
    "LGPL-2.1-only",
    "MIT",
    "MIT-0",
    "MIT-CMU",
    "MPL-2.0",
    "PSF-2.0",
    "Unlicense",
    "Zlib",
}
_LICENSE_ALIASES = {"mit license": "MIT"}


def license_url(license_text: str) -> str:
    candidate = _LICENSE_ALIASES.get(license_text.strip().lower(), license_text.strip())
    if candidate in _LINKABLE_LICENSES:
        return _SPDX_TEXT_URL.format(candidate)
    return ""


def normalize_name(name: str) -> str:
    return re.sub(r"[-_.]+", "-", name).lower()


def frontend_group(field: str) -> list[dict[str, str]]:
    package_json = json.loads((ROOT / "frontend/package.json").read_text(encoding="utf-8"))
    entries = []
    for name in sorted(package_json.get(field, {})):
        installed = ROOT / "frontend/node_modules" / name / "package.json"
        version = ""
        license_text = ""
        if installed.exists():
            data = json.loads(installed.read_text(encoding="utf-8"))
            version = str(data.get("version", ""))
            raw = data.get("license")
            if isinstance(raw, str):
                license_text = raw
            elif isinstance(raw, dict):
                license_text = str(raw.get("type", ""))
            elif isinstance(raw, list):
                license_text = ", ".join(
                    str(item.get("type", "")) if isinstance(item, dict) else str(item)
                    for item in raw
                )
        entries.append(
            {
                "name": name,
                "version": version,
                "license": license_text,
                "licenseUrl": license_url(license_text),
            }
        )
    return entries


def backend_license(dist: metadata.Distribution) -> str:
    info = dist.metadata
    expression = info.get("License-Expression")
    if expression:
        return str(expression)
    license_field = (info.get("License") or "").strip()
    if license_field and "\n" not in license_field and len(license_field) <= 60:
        return license_field
    classifiers = [
        value.split("::")[-1].strip()
        for value in info.get_all("Classifier") or []
        if value.startswith("License :: OSI Approved ::")
    ]
    return classifiers[-1] if classifiers else ""


def backend_group(requirements: list[str]) -> list[dict[str, str]]:
    entries = []
    for requirement in requirements:
        name = re.split(r"[<>=!~;\[ ]", requirement, maxsplit=1)[0].strip()
        try:
            dist = metadata.distribution(name)
            version = dist.version
            license_text = backend_license(dist)
        except metadata.PackageNotFoundError:
            version = ""
            license_text = ""
        entries.append(
            {
                "name": normalize_name(name),
                "version": version,
                "license": license_text,
                "licenseUrl": license_url(license_text),
            }
        )
    return sorted(entries, key=lambda entry: entry["name"])


def main() -> None:
    pyproject = tomllib.loads((ROOT / "backend/pyproject.toml").read_text(encoding="utf-8"))
    data = {
        "frontend": {
            "runtime": frontend_group("dependencies"),
            "dev": frontend_group("devDependencies"),
        },
        "backend": {
            "runtime": backend_group(pyproject["project"]["dependencies"]),
            "dev": backend_group(pyproject["dependency-groups"]["dev"]),
        },
    }
    target = ROOT / "frontend/src/libraries.json"
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_text(
        json.dumps(data, ensure_ascii=False, indent=2) + "\n", encoding="utf-8"
    )
    missing = [
        f"{scope}/{entry['name']}"
        for scope, groups in data.items()
        for group, entries in groups.items()
        for entry in entries
        if not entry["version"] or not entry["license"]
    ]
    print(f"wrote {target}")
    for scope, groups in data.items():
        for group, entries in groups.items():
            print(f"{scope}/{group}: {len(entries)} entries")
    if missing:
        print("entries with missing version or license:", ", ".join(missing))
    else:
        print("all entries carry a version and a license")


if __name__ == "__main__":
    sys.exit(main())
