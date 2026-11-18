"""prod.py is a stdlib-only script outside the backend package, so it is
loaded by path (it in turn loads dev.py by path for host validation).
Importing it must stay side-effect free: it only builds command lines
and resolves the bind host.
"""

import importlib.util
import sys
from pathlib import Path

import pytest

REPO_ROOT = Path(__file__).resolve().parents[2]


def _load_prod():
    spec = importlib.util.spec_from_file_location("prod_launcher", REPO_ROOT / "prod.py")
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    dont_write = sys.dont_write_bytecode
    sys.dont_write_bytecode = True
    try:
        spec.loader.exec_module(module)
    finally:
        sys.dont_write_bytecode = dont_write
    return module


prod = _load_prod()


def test_resolve_host_defaults_to_loopback():
    assert prod.resolve_host(None, {}) == "127.0.0.1"


def test_resolve_host_uses_environment_when_no_argument():
    env = {prod.HOST_ENV_VAR: "192.168.0.10"}
    assert prod.resolve_host(None, env) == "192.168.0.10"


def test_resolve_host_argument_wins_over_environment():
    env = {prod.HOST_ENV_VAR: "192.168.0.10"}
    assert prod.resolve_host("100.64.0.1", env) == "100.64.0.1"


def test_resolve_host_ignores_blank_values():
    env = {prod.HOST_ENV_VAR: "  "}
    assert prod.resolve_host("", env) == "127.0.0.1"
    assert prod.resolve_host("  10.0.0.2 ", {}) == "10.0.0.2"


def test_prod_host_env_var_is_not_the_dev_one():
    assert prod.HOST_ENV_VAR != "REMORISE_DEV_HOST"
    env = {"REMORISE_DEV_HOST": "192.168.0.10"}
    assert prod.resolve_host(None, env) == "127.0.0.1"


@pytest.mark.parametrize("bad", ["999.1.1.1", "example.com", "10.0.0", "dev.local"])
def test_resolve_host_rejects_unusable_addresses(bad):
    with pytest.raises(ValueError):
        prod.resolve_host(bad, {})


def test_server_command_has_no_reload_and_binds_the_host():
    command = prod.server_command("192.168.0.10")
    assert "--reload" not in command
    assert command[command.index("--host") + 1] == "192.168.0.10"
    assert command[command.index("--port") + 1] == "8000"
    assert "app.main:app" in command


def test_server_command_defaults_to_loopback():
    command = prod.server_command()
    assert command[command.index("--host") + 1] == "127.0.0.1"


def test_exposure_warning_is_absent_for_loopback():
    assert prod.exposure_warning("127.0.0.1") is None
    assert prod.exposure_warning("localhost") is None


def test_exposure_warning_names_the_exposure_and_the_safer_options():
    warning = prod.exposure_warning("192.168.0.10")
    assert warning is not None
    assert "192.168.0.10" in warning
    assert "8000" in warning
    assert "no authentication" in warning
    assert "Tailscale" in warning
    assert "Firewall" in warning


def test_startup_lines_for_a_specific_address_show_the_url():
    lines = prod.startup_lines("192.168.0.10")
    assert any("http://192.168.0.10:8000" in line for line in lines)


def test_startup_lines_for_all_interfaces_avoid_a_dead_url():
    lines = prod.startup_lines("0.0.0.0")
    assert any("all network interfaces" in line for line in lines)
    assert not any("http://0.0.0.0" in line for line in lines)


def test_frontend_build_commands_run_the_frontend_build():
    commands = prod.frontend_build_commands()
    flattened = [part for command in commands for part in command]
    if prod.IS_WINDOWS:
        assert any("vite.js" in part for part in flattened)
        assert any("tsc" in part for part in flattened)
    else:
        assert commands == [["pnpm", "build"]]


def test_parse_args():
    args = prod.parse_args([])
    assert args.host is None
    assert args.build is False
    args = prod.parse_args(["--host", "100.64.0.1", "--build"])
    assert args.host == "100.64.0.1"
    assert args.build is True


def test_main_rejects_an_invalid_host(capsys):
    assert prod.main(["--host", "not-an-address"]) == 2
    assert "Invalid --host value" in capsys.readouterr().err


def test_parse_args_accepts_a_character():
    assert prod.parse_args(["--character", "sample"]).character == "sample"
    assert prod.parse_args([]).character is None
