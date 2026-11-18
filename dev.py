"""Start the Remorise backend and frontend dev servers together.

Usage:
    python dev.py [--host ADDRESS] [--character ID] [--profile NAME]
"""

import argparse
import ipaddress
import os
import shutil
import signal
import subprocess
import sys
import threading
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parent
IS_WINDOWS = sys.platform == "win32"

DEFAULT_HOST = "127.0.0.1"
HOST_ENV_VAR = "REMORISE_DEV_HOST"
CHARACTER_ENV_VAR = "REMORISE_CHARACTER_ID"
PROFILE_ENV_VAR = "REMORISE_PROFILE"
BACKEND_PORT = 8000
FRONTEND_PORT = 5173


def validate_host(host: str) -> str:
    if host == "localhost":
        return host
    try:
        ipaddress.ip_address(host)
    except ValueError:
        raise ValueError(
            f"{host!r} is not a usable address: use localhost or an IP "
            "address assigned to this machine"
        ) from None
    return host


def resolve_host(cli_host: str | None, environ: dict | None = None) -> str:
    env = os.environ if environ is None else environ
    for candidate in (cli_host, env.get(HOST_ENV_VAR)):
        if candidate and candidate.strip():
            return validate_host(candidate.strip())
    return DEFAULT_HOST


def resolve_character_id(
    cli_character: str | None, environ: dict | None = None
) -> str | None:
    """The command line wins over the environment. None means "no
    selection made here": the backend then reads the variable (or
    the .env file) itself and defaults to remora. The id is passed
    through unvalidated — the backend checks it against the
    characters folder and falls back with an error log.
    """
    env = os.environ if environ is None else environ
    for candidate in (cli_character, env.get(CHARACTER_ENV_VAR)):
        if candidate and candidate.strip():
            return candidate.strip()
    return None


def resolve_profile(cli_profile: str | None, environ: dict | None = None) -> str | None:
    """The command line wins over the environment. None means "no
    profile": the backend then uses the character's plain
    remorise.db (or reads the variable / the .env file itself).
    Like the character id, the name is passed through unvalidated —
    the backend checks it and refuses to start on an unusable name.
    """
    env = os.environ if environ is None else environ
    for candidate in (cli_profile, env.get(PROFILE_ENV_VAR)):
        if candidate and candidate.strip():
            return candidate.strip()
    return None


def is_loopback_host(host: str) -> bool:
    if host == "localhost":
        return True
    return ipaddress.ip_address(host).is_loopback


def exposure_warning(host: str) -> str | None:
    if is_loopback_host(host):
        return None
    return "\n".join(
        [
            "",
            (
                f"WARNING: both dev servers will listen on {host} "
                f"(frontend port {FRONTEND_PORT}, backend port {BACKEND_PORT})."
            ),
            (
                "The app has no authentication: anyone who can reach this address "
                "can use it and read its conversations and memories."
            ),
            (
                "Prefer binding this machine's Tailscale address so only your "
                "tailnet can reach the servers, or restrict these ports with the "
                "Windows Firewall. See README.md, '他の端末から開く場合'."
            ),
        ]
    )


def startup_lines(host: str) -> list[str]:
    if host == "0.0.0.0":
        return [
            (
                "Listening on all network interfaces (0.0.0.0). Open the frontend "
                f"via this machine's LAN or Tailscale address, port {FRONTEND_PORT}."
            )
        ]
    shown = "127.0.0.1" if host == "localhost" else host
    return [
        (
            f"Frontend: http://{shown}:{FRONTEND_PORT} "
            f"(backend: http://{shown}:{BACKEND_PORT})"
        )
    ]


def uvicorn_command(host: str = DEFAULT_HOST, *, reload: bool = False) -> list[str]:
    venv_python = (
        ROOT
        / "backend"
        / ".venv"
        / ("Scripts/python.exe" if IS_WINDOWS else "bin/python")
    )
    server = ["uvicorn", "app.main:app"]
    if reload:
        server.append("--reload")
    server += [
        "--host",
        host,
        "--port",
        str(BACKEND_PORT),
    ]
    if venv_python.exists():
        return [str(venv_python), "-m", *server]
    return ["uv", "run", *server]


def backend_command(host: str = DEFAULT_HOST) -> list[str]:
    return uvicorn_command(host, reload=True)


def frontend_command() -> list[str]:
    if IS_WINDOWS:
        # Run Vite through node directly: going through the pnpm command
        # shim would open a console window of its own.
        node = shutil.which("node") or "node"
        vite_cli = ROOT / "frontend" / "node_modules" / "vite" / "bin" / "vite.js"
        return [node, str(vite_cli)]
    return ["pnpm", "dev"]


def frontend_environment(host: str, base: dict | None = None) -> dict:
    env = dict(os.environ if base is None else base)
    if host != DEFAULT_HOST:
        env[HOST_ENV_VAR] = host
    return env


def backend_environment(
    character_id: str | None, base: dict | None = None, *, profile: str | None = None
) -> dict:
    env = dict(os.environ if base is None else base)
    if character_id:
        env[CHARACTER_ENV_VAR] = character_id
    if profile:
        env[PROFILE_ENV_VAR] = profile
    return env


def build_services(
    host: str, character_id: str | None = None, profile: str | None = None
) -> list[tuple[str, list[str], Path, dict | None]]:
    return [
        (
            "backend",
            backend_command(host),
            ROOT / "backend",
            backend_environment(character_id, profile=profile),
        ),
        (
            "frontend",
            frontend_command(),
            ROOT / "frontend",
            frontend_environment(host),
        ),
    ]


def pump(name: str, stream) -> None:
    for line in stream:
        sys.stdout.write(f"[{name}] {line}")
        sys.stdout.flush()


def stop_tree(proc: subprocess.Popen) -> None:
    if proc.poll() is not None:
        return
    if IS_WINDOWS:
        subprocess.run(
            ["taskkill", "/pid", str(proc.pid), "/t", "/f"],
            check=False,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
        )
    else:
        try:
            os.killpg(proc.pid, signal.SIGTERM)
        except ProcessLookupError:
            return
        try:
            proc.wait(timeout=5)
        except subprocess.TimeoutExpired:
            os.killpg(proc.pid, signal.SIGKILL)


def parse_args(argv: list[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Start the Remorise backend and frontend dev servers."
    )
    parser.add_argument(
        "--host",
        default=None,
        help=(
            "address both servers bind (default: 127.0.0.1, or the "
            f"{HOST_ENV_VAR} environment variable). Use this machine's "
            "Tailscale or LAN address to open the dev UI from another "
            "device; anything non-loopback is exposed to the network."
        ),
    )
    parser.add_argument(
        "--character",
        default=None,
        help=(
            "character id to run: the folder name under the data "
            f"directory's characters/ folder (default: the "
            f"{CHARACTER_ENV_VAR} environment variable, or remora). "
            "An unavailable id falls back to remora with an error "
            "in the backend log."
        ),
    )
    parser.add_argument(
        "--profile",
        default=None,
        help=(
            "database profile to run: the backend uses "
            "remorise.<profile>.db in the character's folder instead "
            f"of remorise.db (default: the {PROFILE_ENV_VAR} "
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
    character_id = resolve_character_id(args.character)
    profile = resolve_profile(args.profile)

    warning = exposure_warning(host)
    if warning is not None:
        print(warning, flush=True)
    for line in startup_lines(host):
        print(line, flush=True)

    creationflags = subprocess.CREATE_NO_WINDOW if IS_WINDOWS else 0
    procs: dict[str, subprocess.Popen] = {}
    try:
        for name, command, cwd, env in build_services(host, character_id, profile):
            proc = subprocess.Popen(
                command,
                cwd=cwd,
                env=env,
                stdout=subprocess.PIPE,
                stderr=subprocess.STDOUT,
                text=True,
                encoding="utf-8",
                errors="replace",
                creationflags=creationflags,
                start_new_session=not IS_WINDOWS,
            )
            procs[name] = proc
            threading.Thread(target=pump, args=(name, proc.stdout), daemon=True).start()
            print(f"[{name}] started (pid {proc.pid})", flush=True)
    except OSError as error:
        print(f"Failed to start: {error}", flush=True)
        for proc in procs.values():
            stop_tree(proc)
        return 1

    print("Running. Press Ctrl+C to stop both servers.", flush=True)
    if not IS_WINDOWS:
        # A plain SIGTERM (kill, timeout, a supervisor) bypasses the
        # finally below; take both servers down with us instead of
        # leaving them orphaned on their ports (same fix as prod.py).
        def _on_sigterm(_signum, _frame):
            for proc in procs.values():
                stop_tree(proc)
            raise SystemExit(0)

        signal.signal(signal.SIGTERM, _on_sigterm)
    reported: set[str] = set()
    try:
        while True:
            running = 0
            for name, proc in procs.items():
                code = proc.poll()
                if code is None:
                    running += 1
                elif name not in reported:
                    reported.add(name)
                    print(
                        f"[{name}] exited (code {code}). "
                        "The other server keeps running; Ctrl+C stops it.",
                        flush=True,
                    )
            if running == 0:
                return 0
            time.sleep(0.5)
    except KeyboardInterrupt:
        print("\nStopping both servers...", flush=True)
        return 0
    finally:
        for proc in procs.values():
            stop_tree(proc)


if __name__ == "__main__":
    sys.exit(main())
