"""Convert a character's full-canvas sprite layers into offset parts.

Usage (from the backend directory):

    uv run python tools/split_sprite_layers.py <character_dir> [--out <dir>]

Reads ``layers.json`` and the ``layers/`` directory from the character directory and
writes a converted copy (trimmed part images with offsets, plus a
parts-format ``layers.json``) to the output directory — by default a
sibling named ``<character>-parts``. The source is never modified.

Every layer is trimmed to its non-transparent bounding box; nothing is
split by image differences (an expression base stays one painting, so
no seams can open). The conversion verifies, per layer and over full
rendered stacks, that the recomposition is pixel-identical to the
original, and fails if any check fails (see
``app.services.sprite_parts``).
"""

import argparse
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from app.services.sprite_parts import convert_character


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("character_dir", type=Path)
    parser.add_argument("--out", type=Path, default=None)
    args = parser.parse_args()

    source = args.character_dir
    output = args.out or source.with_name(source.name + "-parts")
    if output.exists() and any(output.iterdir()):
        print(f"output directory is not empty: {output}", file=sys.stderr)
        return 2
    try:
        report = convert_character(source, output)
    except (OSError, ValueError) as exc:
        print(f"conversion failed: {exc}", file=sys.stderr)
        return 1
    for warning in report.warnings:
        print(f"warning: {warning}")
    original_total = sum(item.original_bytes for item in report.files)
    converted_total = sum(item.converted_bytes for item in report.files)
    for item in report.files:
        print(f"  {item.path}: {item.original_bytes} -> {item.converted_bytes} bytes")
    print(f"converted {len(report.files)} files: {original_total} -> {converted_total} bytes")
    print(
        f"verified {report.layers_verified} layers and {report.stacks_verified} "
        "full stacks pixel-identical"
    )
    print(f"output: {output}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
