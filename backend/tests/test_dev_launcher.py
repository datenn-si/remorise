"""dev.py is a stdlib-only script outside the backend package, so it is
loaded by path. Importing it must stay side-effect free: it only builds
command lines and resolves the bind host.
"""

import importlib.util
import sys
from pathlib import Path

import pytest

REPO_ROOT = Path(__file__).resolve().parents[2]


def _load_dev():
    spec = importlib.util.spec_from_file_location("dev_launcher", REPO_ROOT / "dev.py")
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    # Keep the repository root free of __pycache__ for the imported script.
    dont_write = sys.dont_write_bytecode
    sys.dont_write_bytecode = True
    try:
        spec.loader.exec_module(module)
    finally:
        sys.dont_write_bytecode = dont_write
    return module


dev = _load_dev()


def test_resolve_host_defaults_to_loopback():
    assert dev.resolve_host(None, {}) == "127.0.0.1"


def test_resolve_host_uses_environment_when_no_argument():
    env = {dev.HOST_ENV_VAR: "192.168.0.10"}
    assert dev.resolve_host(None, env) == "192.168.0.10"


def test_resolve_host_argument_wins_over_environment():
    env = {dev.HOST_ENV_VAR: "192.168.0.10"}
    assert dev.resolve_host("100.64.0.1", env) == "100.64.0.1"


def test_resolve_host_ignores_blank_values():
    env = {dev.HOST_ENV_VAR: "  "}
    assert dev.resolve_host("", env) == "127.0.0.1"
    assert dev.resolve_host("  10.0.0.2 ", {}) == "10.0.0.2"


@pytest.mark.parametrize("bad", ["999.1.1.1", "example.com", "10.0.0", "dev.local"])
def test_resolve_host_rejects_unusable_addresses(bad):
    with pytest.raises(ValueError):
        dev.resolve_host(bad, {})


@pytest.mark.parametrize(
    "host,expected",
    [
        ("127.0.0.1", True),
        ("localhost", True),
        ("::1", True),
        ("192.168.0.10", False),
        ("100.64.0.1", False),
        ("0.0.0.0", False),
    ],
)
def test_is_loopback_host(host, expected):
    assert dev.is_loopback_host(host) is expected


def test_backend_command_binds_the_resolved_host():
    command = dev.backend_command("192.168.0.10")
    assert command[command.index("--host") + 1] == "192.168.0.10"
    assert command[command.index("--port") + 1] == "8000"


def test_backend_command_defaults_to_loopback():
    command = dev.backend_command()
    assert command[command.index("--host") + 1] == "127.0.0.1"


def test_frontend_environment_only_forwards_non_default_hosts():
    base = {"PATH": "/usr/bin"}
    assert dev.HOST_ENV_VAR not in dev.frontend_environment("127.0.0.1", base)
    env = dev.frontend_environment("192.168.0.10", base)
    assert env[dev.HOST_ENV_VAR] == "192.168.0.10"
    assert env["PATH"] == "/usr/bin"


def test_build_services_passes_the_host_to_both_servers():
    built = dev.build_services("100.64.0.1")
    services = {name: (command, env) for name, command, _cwd, env in built}
    backend_command, _ = services["backend"]
    assert backend_command[backend_command.index("--host") + 1] == "100.64.0.1"
    _, frontend_env = services["frontend"]
    assert frontend_env is not None
    assert frontend_env[dev.HOST_ENV_VAR] == "100.64.0.1"


def test_exposure_warning_is_absent_for_loopback():
    assert dev.exposure_warning("127.0.0.1") is None
    assert dev.exposure_warning("localhost") is None


def test_exposure_warning_names_the_exposure_and_the_safer_options():
    warning = dev.exposure_warning("192.168.0.10")
    assert warning is not None
    assert "192.168.0.10" in warning
    assert "5173" in warning
    assert "8000" in warning
    assert "no authentication" in warning
    assert "Tailscale" in warning
    assert "Firewall" in warning


def test_startup_lines_for_a_specific_address_show_the_url():
    lines = dev.startup_lines("192.168.0.10")
    assert any("http://192.168.0.10:5173" in line for line in lines)


def test_startup_lines_for_all_interfaces_avoid_a_dead_url():
    lines = dev.startup_lines("0.0.0.0")
    assert any("all network interfaces" in line for line in lines)
    assert not any("http://0.0.0.0" in line for line in lines)


def test_parse_args_host_defaults_to_none():
    assert dev.parse_args([]).host is None
    assert dev.parse_args(["--host", "100.64.0.1"]).host == "100.64.0.1"


def test_main_rejects_an_invalid_host(capsys):
    assert dev.main(["--host", "not-an-address"]) == 2
    assert "Invalid --host value" in capsys.readouterr().err


def test_resolve_character_id_prefers_the_argument():
    env = {dev.CHARACTER_ENV_VAR: "from-env"}
    assert dev.resolve_character_id("from-cli", env) == "from-cli"
    assert dev.resolve_character_id(None, env) == "from-env"
    assert dev.resolve_character_id(None, {}) is None
    assert dev.resolve_character_id("  ", env) == "from-env"
    assert dev.resolve_character_id(" sample ", {}) == "sample"


def test_backend_environment_sets_the_character_variable():
    base = {"PATH": "/usr/bin"}
    assert dev.CHARACTER_ENV_VAR not in dev.backend_environment(None, base)
    env = dev.backend_environment("sample", base)
    assert env[dev.CHARACTER_ENV_VAR] == "sample"
    assert env["PATH"] == "/usr/bin"


def test_build_services_passes_the_character_to_the_backend():
    built = dev.build_services("127.0.0.1", "sample")
    services = {name: env for name, _command, _cwd, env in built}
    backend_env = services["backend"]
    assert backend_env is not None
    assert backend_env[dev.CHARACTER_ENV_VAR] == "sample"


def test_parse_args_accepts_a_character():
    assert dev.parse_args(["--character", "sample"]).character == "sample"
    assert dev.parse_args([]).character is None


def test_resolve_profile_prefers_the_argument():
    env = {dev.PROFILE_ENV_VAR: "from-env"}
    assert dev.resolve_profile("from-cli", env) == "from-cli"
    assert dev.resolve_profile(None, env) == "from-env"
    assert dev.resolve_profile(None, {}) is None
    assert dev.resolve_profile("  ", env) == "from-env"
    assert dev.resolve_profile(" Shot ", {}) == "Shot"


def test_backend_environment_sets_the_profile_variable():
    base = {"PATH": "/usr/bin"}
    assert dev.PROFILE_ENV_VAR not in dev.backend_environment(None, base)
    env = dev.backend_environment(None, base, profile="Shot")
    assert env[dev.PROFILE_ENV_VAR] == "Shot"
    assert env["PATH"] == "/usr/bin"


def test_build_services_passes_the_profile_to_the_backend():
    built = dev.build_services("127.0.0.1", "sample", "Shot")
    services = {name: env for name, _command, _cwd, env in built}
    backend_env = services["backend"]
    assert backend_env is not None
    assert backend_env[dev.CHARACTER_ENV_VAR] == "sample"
    assert backend_env[dev.PROFILE_ENV_VAR] == "Shot"


def test_parse_args_accepts_a_profile():
    assert dev.parse_args(["--profile", "Shot"]).profile == "Shot"
    assert dev.parse_args([]).profile is None
