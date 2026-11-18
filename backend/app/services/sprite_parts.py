"""Split full-canvas sprite layers into offset parts.

Every sprite layer starts out as a full-canvas PNG (1024x1536), most of
it transparent. This module converts a character directory into the
*parts format* by trimming alone:

- Each layer image is trimmed to the bounding box of its non-transparent
  pixels and the layers definition entry becomes an offset object
  ``{"path": ..., "x": ..., "y": ...}`` — the cropped image drawn with
  its top-left corner at that offset. Trimming is exact for
  alpha-composited stacks, so the recomposed sprite is pixel-identical.
- Nothing is split by image differences. An expression base is one
  painting that includes the closed mouth, with the open-mouth variants
  as small overlay patches on top; cutting the base apart risks seams,
  and the measured opaque areas are already small (a face base is a few
  percent of the canvas, a mouth patch a fraction of a percent), so the
  trim captures nearly all of the win.
- A reference written in object form to carry extra keys (such as
  ``depth``) keeps those keys through the conversion; only path/x/y
  are replaced by the trimmed entry.

The source directory is never modified. Verification renders full
stacks from the original and the converted definitions and compares
them pixel by pixel: alpha must match everywhere and color must match
wherever alpha is non-zero. (The RGB stored in fully transparent
pixels is not part of the comparison — canvas compositing is
premultiplied, so such pixels carry no color and contribute nothing;
real layer files do store stray RGB there.)
"""

import json
import sys
from array import array
from collections.abc import Iterable
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

from PIL import Image

from app.services.character_service import resolve_character_asset_directory

# In an RGBA byte string read as native uint32s, alpha is the top byte
# on little-endian machines and the bottom byte on big-endian ones.
_ALPHA_SHIFT = 24 if sys.byteorder == "little" else 0


@dataclass
class ConvertedFile:
    path: str
    original_bytes: int
    converted_bytes: int


@dataclass
class ConversionReport:
    files: list[ConvertedFile] = field(default_factory=list)
    warnings: list[str] = field(default_factory=list)
    layers_verified: int = 0
    stacks_verified: int = 0


def collect_image_paths(layers: dict[str, Any]) -> set[str]:
    paths: set[str] = set()

    def collect(value: Any) -> None:
        if isinstance(value, str):
            if value.endswith(".png"):
                paths.add(value)
            return
        if isinstance(value, list):
            for item in value:
                collect(item)
            return
        if isinstance(value, dict):
            for item in value.values():
                collect(item)

    collect(layers)
    return paths


def trim_to_content(image: Image.Image) -> tuple[Image.Image, int, int]:
    """Crop to the non-transparent bounding box; return (image, x, y).

    A fully transparent layer collapses to a 1x1 transparent image at
    the origin, which draws nothing exactly like the original.
    """
    rgba = image.convert("RGBA")
    bbox = rgba.getchannel("A").getbbox()
    if bbox is None:
        return Image.new("RGBA", (1, 1), (0, 0, 0, 0)), 0, 0
    left, upper, right, lower = bbox
    return rgba.crop(bbox), left, upper


def _entry(path: str, image: Image.Image) -> tuple[dict[str, Any], Image.Image]:
    trimmed, x, y = trim_to_content(image)
    return {"path": path, "x": x, "y": y}, trimmed


def _load_images(images_directory: Path, paths: set[str]) -> dict[str, Image.Image | None]:
    images: dict[str, Image.Image | None] = {}
    for relative in sorted(paths):
        path = images_directory / relative
        if not path.is_file():
            images[relative] = None
            continue
        with Image.open(path) as opened:
            images[relative] = opened.convert("RGBA")
    return images


def _rewrite_refs(value: Any, entries: dict[str, dict[str, Any]]) -> Any:
    if isinstance(value, str):
        return entries.get(value, value)
    if isinstance(value, list):
        return [_rewrite_refs(item, entries) for item in value]
    if isinstance(value, dict):
        path = value.get("path")
        if isinstance(path, str) and path in entries:
            # A layer reference in object form: the trimmed entry
            # replaces path/x/y, and any other keys the reference
            # carries (such as `depth`) are preserved as-is.
            merged = dict(entries[path])
            for key, item in value.items():
                if key not in ("path", "x", "y"):
                    merged[key] = _rewrite_refs(item, entries)
            return merged
        return {key: _rewrite_refs(item, entries) for key, item in value.items()}
    return value


def pose_layer_refs(pose_value: Any) -> Any:
    """Layer list of one pose.

    A pose is either an array of layer references, or
    ``{"label": "...", "layers": [...]}``. An offset entry is also a
    dict, so the object form is recognized only when it has ``layers``
    and no ``path``.
    """
    if isinstance(pose_value, dict) and "layers" in pose_value and "path" not in pose_value:
        return pose_value.get("layers") or []
    return pose_value or []


def _frame_refs(frames: list[Any], index: int) -> list[Any]:
    return frames[index] if index < len(frames) else []


def _frame_indices(frame: int, mode: object) -> list[int]:
    """Frame indices a frame resolves to: just itself in ``switch``
    mode, or every frame up to it in ``stack`` mode."""
    return list(range(frame + 1)) if mode == "stack" else [frame]


def _slot_frame_mode(layers: dict[str, Any], slot: str) -> object:
    """The ``frame_mode`` entry for one slot group (eyes / tears /
    mouth), or None when unset (which resolves as ``switch``)."""
    modes = layers.get("frame_mode")
    if isinstance(modes, dict):
        return modes.get(slot)
    return None


def _eye_slot_refs(
    layers: dict[str, Any], shared_key: str, left_key: str, right_key: str, eye_frame: int
) -> list[Any]:
    """Eye-area refs for one frame, mirroring the frontend resolver.

    Split definitions (``eyes_left`` / ``eyes_right`` and their tear
    counterparts) and the shared list are alternatives: when either
    split list is defined, only the split lists are read, each side
    at the shared frame here; otherwise the shared list alone is
    read. A group with neither definition is an error. The
    ``frame_mode`` rule (switch / stack) applies per frame index.
    """
    shared = layers.get(shared_key)
    left = layers.get(left_key)
    right = layers.get(right_key)
    indices = _frame_indices(eye_frame, _slot_frame_mode(layers, shared_key))
    if left is not None or right is not None:
        return [
            ref
            for side in (left, right)
            for index in indices
            for ref in _frame_refs(side or [], index)
        ]
    if shared is not None:
        return [ref for index in indices for ref in _frame_refs(shared, index)]
    raise ValueError(
        f"layers.json has no {shared_key} definition: "
        f"define {shared_key} or {left_key} / {right_key}"
    )


def _expression_eye_additions(expression_config: dict[str, Any], eye_frame: int) -> list[Any]:
    """One expression's own eye additions at one frame, mirroring
    the frontend resolver.

    The expression may carry ``eyes`` / ``eyes_left`` / ``eyes_right``
    frame lists of extra layers drawn over the shared eye layers.
    Additions resolve at the current frame only (they never follow
    the eyes frame mode), so each frame's list is the complete
    addition for that eye state; the either/or split rule mirrors
    ``_eye_slot_refs`` (an expression with no eye additions at all
    adds nothing).
    """
    shared = expression_config.get("eyes")
    left = expression_config.get("eyes_left")
    right = expression_config.get("eyes_right")
    if left is not None or right is not None:
        return _frame_refs(left or [], eye_frame) + _frame_refs(right or [], eye_frame)
    if shared is not None:
        return _frame_refs(shared, eye_frame)
    return []


def render_stack(
    layers: dict[str, Any],
    images_directory: Path,
    *,
    pose: str,
    expression: str,
    eye_frame: int = 0,
    mouth_frame: int = 0,
    tears: bool = False,
    extras: Iterable[str] = (),
    mark: str | None = None,
    thinking: bool = False,
) -> Image.Image:
    """Composite one sprite the way the frontend renderer does.

    Understands both layer formats: plain path strings (full-canvas
    images at the origin) and parts-format offset entries.
    """
    width = int(layers["image"]["width"])
    height = int(layers["image"]["height"])
    canvas = Image.new("RGBA", (width, height), (0, 0, 0, 0))
    cache: dict[str, Image.Image | None] = {}

    def load(relative: str) -> Image.Image | None:
        if relative not in cache:
            path = images_directory / relative
            if path.is_file():
                with Image.open(path) as opened:
                    cache[relative] = opened.convert("RGBA")
            else:
                cache[relative] = None
        return cache[relative]

    def draw(ref: Any) -> None:
        if isinstance(ref, list):
            for item in ref:
                draw(item)
            return
        if isinstance(ref, str):
            relative, x, y = ref, 0, 0
        elif isinstance(ref, dict):
            relative = str(ref["path"])
            x, y = int(ref.get("x", 0)), int(ref.get("y", 0))
        else:
            return
        image = load(relative)
        if image is not None:
            canvas.alpha_composite(image, dest=(x, y))

    expressions = layers.get("expressions") or {}
    expression_config = expressions.get(expression) or {}
    mouth_frames = expression_config.get("mouth") or []
    marks = layers.get("marks") or {}
    slots: dict[str, Any] = {
        "pose": pose_layer_refs((layers.get("poses") or {}).get(pose)),
        "expression": expression_config.get("base"),
        "mouth": [
            mouth_frames[index]
            for index in _frame_indices(mouth_frame, _slot_frame_mode(layers, "mouth"))
            if index < len(mouth_frames)
        ],
        "eyes": _eye_slot_refs(layers, "eyes", "eyes_left", "eyes_right", eye_frame)
        + _expression_eye_additions(expression_config, eye_frame),
        "tears": _eye_slot_refs(layers, "tears", "tears_left", "tears_right", eye_frame)
        if tears
        else [],
        "extras": [(layers.get("extras") or {}).get(name) for name in extras],
        "mark": [
            marks.get(mark) if mark else None,
            marks.get("thinking") if thinking and mark != "thinking" else None,
        ],
    }
    for slot in layers.get("paint") or []:
        draw(slots.get(slot))
    return canvas


def _canonical_bytes(image: Image.Image) -> bytes:
    """Pixel bytes with the RGB of fully transparent pixels zeroed.

    Compositing is premultiplied, so a pixel with alpha 0 carries no
    color: (255, 255, 255, 0) and (0, 0, 0, 0) are the same pixel when
    drawn. Equality for verification is exact alpha everywhere plus
    exact color wherever alpha is non-zero.
    """
    pixels = array("I", image.convert("RGBA").tobytes())
    for index, pixel in enumerate(pixels):
        if (pixel >> _ALPHA_SHIFT) & 0xFF == 0:
            pixels[index] = 0
    return pixels.tobytes()


def _images_equal(first: Image.Image, second: Image.Image) -> bool:
    return first.size == second.size and _canonical_bytes(first) == _canonical_bytes(second)


def convert_character(
    source_directory: Path,
    output_directory: Path,
) -> ConversionReport:
    """Convert one character directory to the parts format.

    Reads ``layers.json`` and the character's ``layers/`` directory
    under ``source_directory`` and writes the converted pair under
    ``output_directory`` (plus a copy of any other top-level files,
    e.g. ``character.json``). The source is never modified. Raises
    ``ValueError`` when the recomposition verification fails, in which
    case the caller should not use the output.
    """
    source_directory = Path(source_directory)
    output_directory = Path(output_directory)
    layers = json.loads((source_directory / "layers.json").read_text(encoding="utf-8"))
    images_directory = resolve_character_asset_directory(source_directory)
    output_images = output_directory / "layers"
    report = ConversionReport()

    paths = collect_image_paths(layers)
    images = _load_images(images_directory, paths)
    for relative, image in images.items():
        if image is None:
            report.warnings.append(f"referenced image is missing, left as-is: {relative}")

    entries: dict[str, dict[str, Any]] = {}
    written: dict[str, Image.Image] = {}
    for relative, image in images.items():
        if image is None:
            continue
        entry, trimmed = _entry(relative, image)
        entries[relative] = entry
        written[relative] = trimmed

    converted_layers = _rewrite_refs(layers, entries)
    converted_layers["parts"] = True

    width = int(layers["image"]["width"])
    height = int(layers["image"]["height"])
    for relative, image in images.items():
        if image is None or relative not in entries:
            continue
        entry = entries[relative]
        rebuilt = Image.new("RGBA", (width, height), (0, 0, 0, 0))
        rebuilt.alpha_composite(written[relative], dest=(entry["x"], entry["y"]))
        if not _images_equal(rebuilt, image):
            raise ValueError(f"trim verification failed for {relative}")
        report.layers_verified += 1

    output_directory.mkdir(parents=True, exist_ok=True)
    output_images.mkdir(parents=True, exist_ok=True)
    for relative, image in written.items():
        target = output_images / relative
        target.parent.mkdir(parents=True, exist_ok=True)
        image.save(target)
        source_path = images_directory / relative
        report.files.append(
            ConvertedFile(
                path=relative,
                original_bytes=source_path.stat().st_size if source_path.is_file() else 0,
                converted_bytes=target.stat().st_size,
            )
        )
    (output_directory / "layers.json").write_text(
        json.dumps(converted_layers, ensure_ascii=False, indent=2), encoding="utf-8"
    )
    for item in source_directory.iterdir():
        if item.is_file() and item.name != "layers.json":
            target = output_directory / item.name
            if not target.exists():
                target.write_bytes(item.read_bytes())

    poses = list((layers.get("poses") or {}).keys()) or ["arms-down"]
    expressions = list((layers.get("expressions") or {}).keys()) or ["normal"]
    marks = list((layers.get("marks") or {}).keys())
    combos: list[dict[str, Any]] = [
        {"pose": pose, "expression": expression} for pose in poses for expression in expressions
    ]
    sample_pose, sample_expression = poses[0], expressions[0]
    eye_frame_count = max(len(layers.get(key) or []) for key in ("eyes", "eyes_left", "eyes_right"))
    for eye_frame in range(eye_frame_count):
        for mouth_frame in range(3):
            combos.append(
                {
                    "pose": sample_pose,
                    "expression": sample_expression,
                    "eye_frame": eye_frame,
                    "mouth_frame": mouth_frame,
                    "tears": True,
                    "extras": sorted((layers.get("extras") or {}).keys()),
                    "mark": marks[0] if marks else None,
                    "thinking": True,
                }
            )
    for combo in combos:
        original_render = render_stack(layers, images_directory, **combo)
        converted_render = render_stack(converted_layers, output_images, **combo)
        if not _images_equal(original_render, converted_render):
            raise ValueError(f"stack verification failed for {combo}")
        report.stacks_verified += 1
    return report
