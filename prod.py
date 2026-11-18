"""Start Remorise in production mode: one backend process, no reload.

Usage:
    python prod.py [--host ADDRESS] [--build] [--character ID] [--profile NAME]
"""

import argparse
import importlib.util
import os
import shutil
import signal
import subprocess
import sys
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parent
IS_WINDOWS = sys.platform == "win32"

DEFAULT_HOST = "127.0.0.1"
HOST_ENV_VAR = "REMORISE_PROD_HOST"
BACKEND_PORT = 8000


def _load_dev():
    """dev.py is a stdlib-only sibling script and importing it is
    side-effect free; loading it by path keeps that true no matter how
    prod.py itself was invoked.
    """
    spec = importlib.util.spec_from_file_location("dev_launcher", ROOT / "dev.py")
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    dont_write = sys.dont_write_bytecode
    sys.dont_write_bytecode = True
    try:
        spec.loader.exec_module(module)
    finally:
        sys.dont_write_bytecode = dont_write
    return module


_dev = _load_dev()


def resolve_host(cli_host: str | None, environ: dict | None = None) -> str:
    env = os.environ if environ is None else environ
    for candidate in (cli_host, env.get(HOST_ENV_VAR)):
        if candidate and candidate.strip():
            return _dev.validate_host(candidate.strip())
    return DEFAULT_HOST


def exposure_warning(host: str) -> str | None:
    if _dev.is_loopback_host(host):
        return None
    return "\n".join(
        [
            "",
            (
                f"WARNING: the production server will listen on {host} "
                f"(port {BACKEND_PORT})."
            ),
            (
                "The app has no authentication: anyone who can reach this address "
                "can use it and read its conversations and memories."
            ),
            (
                "Prefer binding this machine's Tailscale address so only your "
                "tailnet can reach the server, or restrict this port with the "
                "Windows Firewall. See README.md, '本番運用'."
            ),
        ]
    )


def startup_lines(host: str) -> list[str]:
    if host == "0.0.0.0":
        return [
            (
                "Listening on all network interfaces (0.0.0.0). Open the app "
                f"via this machine's LAN or Tailscale address, port {BACKEND_PORT}."
            )
        ]
    shown = "127.0.0.1" if host == "localhost" else host
    return [f"Remorise: http://{shown}:{BACKEND_PORT} (UI and API, one origin)"]


def server_command(host: str = DEFAULT_HOST) -> list[str]:
    return _dev.uvicorn_command(host)


def frontend_build_commands() -> list[list[str]]:
    if IS_WINDOWS:
        # Mirror dev.py: run the toolchain through node directly, because
        # going through the pnpm command shim would open a console window.
        node = shutil.which("node") or "node"
        modules = ROOT / "frontend" / "node_modules"
        return [
            [node, str(modules / "typescript" / "bin" / "tsc"), "-b"],
            [node, str(modules / "vite" / "bin" / "vite.js"), "build"],
        ]
    return [["pnpm", "build"]]


def run_build() -> int:
    creationflags = subprocess.CREATE_NO_WINDOW if IS_WINDOWS else 0
    for command in frontend_build_commands():
        print(f"[build] {' '.join(command)}", flush=True)
        try:
            completed = subprocess.run(
                command,
                cwd=ROOT / "frontend",
                creationflags=creationflags,
                check=False,
            )
        except OSError as error:
            print(f"Build failed to start: {error}", flush=True)
            return 1
        if completed.returncode != 0:
            print(f"Build failed (code {completed.returncode}).", flush=True)
            return completed.returncode
    return 0


def parse_args(argv: list[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Start the Remorise production server (backend only, no reload)."
    )
    parser.add_argument(
        "--host",
        default=None,
        help=(
            "address the server binds (default: 127.0.0.1, or the "
            f"{HOST_ENV_VAR} environment variable). Use this machine's "
            "Tailscale or LAN address to open the app from another "
            "device; anything non-loopback is exposed to the network."
        ),
    )
    parser.add_argument(
        "--build",
        action="store_true",
        help="build the frontend (pnpm build) before starting the server.",
    )
    parser.add_argument(
        "--character",
        default=None,
        help=(
            "character id to run: the folder name under the data "
            "directory's characters/ folder (default: the "
            "REMORISE_CHARACTER_ID environment variable, or remora). "
            "An unavailable id falls back to remora with an error "
            "in the backend log."
        ),
    )
    parser.add_argument(
        "--profile",
        default=None,
        help=(
            "database profile to run: the server uses "
            "remorise.<profile>.db in the character's folder instead "
            "of remorise.db (default: the REMORISE_PROFILE "
            "environment variable, or no profile). Names are "
            "half-width alphanumerics; upper-case letters are "
            "folded to lower case."
        ),
    )
    return parser.parse_args(argv)


def main(argv: list[str] | None = None) -> int:
    args = parse_args(argv)
    try:
        host = resolve_host(args.host)
    except ValueError as error:
        print(f"Invalid --host value: {error}", file=sys.stderr, flush=True)
        return 2
    character_id = _dev.resolve_character_id(args.character)
    profile = _dev.resolve_profile(args.profile)

    if args.build:
        code = run_build()
        if code != 0:
            return code

    warning = exposure_warning(host)
    if warning is not None:
        print(warning, flush=True)
    for line in startup_lines(host):
        print(line, flush=True)

    creationflags = subprocess.CREATE_NO_WINDOW if IS_WINDOWS else 0
    try:
        proc = subprocess.Popen(
            server_command(host),
            cwd=ROOT / "backend",
            env=_dev.backend_environment(character_id, profile=profile),
            creationflags=creationflags,
            start_new_session=not IS_WINDOWS,
        )
    except OSError as error:
        print(f"Failed to start: {error}", flush=True)
        return 1
    print("Running. Press Ctrl+C to stop.", flush=True)
    if not IS_WINDOWS:
        # A plain SIGTERM (kill, timeout, a supervisor) bypasses the
        # finally below; take the server down with us instead of
        # leaving it orphaned on the port.
        def _on_sigterm(_signum, _frame):
            _dev.stop_tree(proc)
            raise SystemExit(0)

        signal.signal(signal.SIGTERM, _on_sigterm)
    try:
        # Poll instead of proc.wait(): on Windows a blocking wait does
        # not surface Ctrl+C as KeyboardInterrupt, so the launcher
        # could never be stopped from the console. Sleeping in a loop
        # keeps the interpreter responsive to it (same pattern as
        # dev.py).
        while proc.poll() is None:
            time.sleep(0.5)
        return proc.returncode if proc.returncode is not None else 0
    except KeyboardInterrupt:
        print("\nStopping...", flush=True)
        return 0
    finally:
        _dev.stop_tree(proc)


if __name__ == "__main__":
    sys.exit(main())
