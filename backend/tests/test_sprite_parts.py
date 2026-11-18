import json
from pathlib import Path

import pytest
from PIL import Image

from app.services.sprite_parts import (
    _canonical_bytes,
    convert_character,
    render_stack,
    trim_to_content,
)

WIDTH, HEIGHT = 64, 96


def solid(width: int, height: int, color: tuple[int, int, int, int]) -> Image.Image:
    return Image.new("RGBA", (width, height), color)


def canvas_with(box: tuple[int, int, int, int], color: tuple[int, int, int, int]) -> Image.Image:
    image = Image.new("RGBA", (WIDTH, HEIGHT), (0, 0, 0, 0))
    image.paste(solid(box[2] - box[0], box[3] - box[1], color), (box[0], box[1]))
    return image


def with_invisible_rgb(image: Image.Image) -> Image.Image:
    # Real layer files store stray RGB in fully transparent pixels;
    # those pixels carry no color when drawn and must not fail or
    # change the conversion.
    pixels = image.load()
    for y in range(image.height):
        for x in range(image.width):
            if pixels[x, y][3] == 0:
                pixels[x, y] = (255, 254, 255, 0)
    return image


def face_base(mouth_color: tuple[int, int, int, int]) -> Image.Image:
    image = canvas_with((16, 8, 48, 40), (200, 180, 160, 255))
    image.paste(solid(12, 4, mouth_color), (26, 30))
    return image


def write_character(source: Path) -> dict:
    images = source / "layers"
    images.mkdir(parents=True)
    files: dict[str, Image.Image] = {
        "body/lower.png": canvas_with((8, 48, 56, 96), (40, 40, 90, 255)),
        "body/upper.png": canvas_with((8, 0, 56, 56), (60, 60, 120, 255)),
        "arms/left.png": canvas_with((0, 40, 12, 80), (80, 80, 140, 255)),
        "arms/right.png": canvas_with((52, 40, 64, 80), (80, 80, 140, 255)),
        "face/smile.png": face_base((220, 60, 60, 255)),
        "face/grin.png": face_base((60, 220, 60, 255)),
        "face/mouth1.png": canvas_with((28, 30, 36, 33), (10, 10, 10, 255)),
        "face/mouth2.png": canvas_with((27, 30, 37, 34), (10, 10, 10, 255)),
        "eyes/half.png": canvas_with((20, 16, 44, 20), (30, 30, 30, 255)),
        "eyes/closed.png": canvas_with((20, 18, 44, 21), (30, 30, 30, 255)),
        "fx/tears.png": canvas_with((14, 24, 20, 36), (120, 180, 255, 255)),
        "fx/sweat.png": canvas_with((48, 10, 54, 18), (120, 180, 255, 255)),
        "fx/mark.png": with_invisible_rgb(canvas_with((50, 2, 60, 12), (255, 120, 120, 255))),
        "fx/blank.png": Image.new("RGBA", (WIDTH, HEIGHT), (0, 0, 0, 0)),
    }
    for relative, image in files.items():
        path = images / relative
        path.parent.mkdir(parents=True, exist_ok=True)
        image.save(path)
    layers = {
        "image": {"width": WIDTH, "height": HEIGHT},
        "root": "/api/character/assets",
        "paint": ["pose", "expression", "mouth", "eyes", "tears", "extras", "mark"],
        "poses": {
            "arms-down": ["body/lower.png", "body/upper.png", "arms/left.png", "arms/right.png"],
            "left-only": ["body/lower.png", "body/upper.png", "arms/left.png"],
        },
        "expressions": {
            "smile": {
                "base": "face/smile.png",
                "mouth": [None, "face/mouth1.png", "face/mouth2.png"],
            },
            "grin": {
                "base": "face/grin.png",
                "mouth": [None, "face/mouth1.png", "face/mouth2.png"],
            },
            "plain": {"base": None, "mouth": [None, None, None]},
        },
        "eyes": [[], ["eyes/half.png"], ["eyes/closed.png"]],
        "tears": [["fx/tears.png"], ["fx/tears.png"], ["fx/tears.png"]],
        "extras": {"sweat": "fx/sweat.png"},
        "marks": {"sign": "fx/mark.png", "blank": "fx/blank.png", "gone": "fx/missing.png"},
        "blink": {
            "cycle": [1, 2, 1],
            "stepMs": 80,
            "perMinute": 20,
            "hurriedPerMinute": 30,
            "minGapMs": 400,
            "hurriedExpressions": [],
        },
        "talk": {"cycle": [1, 2, 1, 0], "intervalMs": 90},
        "emotions": {
            "neutral": {
                "pose": "arms-down",
                "expression": "smile",
                "mark": None,
                "extras": [],
                "tears": False,
            },
        },
    }
    (source / "layers.json").write_text(json.dumps(layers), encoding="utf-8")
    (source / "character.json").write_text('{"name":"Parts Test"}', encoding="utf-8")
    return layers


def test_trim_to_content_returns_offsets() -> None:
    image = canvas_with((10, 20, 30, 44), (255, 0, 0, 255))
    trimmed, x, y = trim_to_content(image)
    assert (x, y) == (10, 20)
    assert trimmed.size == (20, 24)
    blank, x, y = trim_to_content(Image.new("RGBA", (8, 8), (0, 0, 0, 0)))
    assert blank.size == (1, 1)
    assert (x, y) == (0, 0)


def test_convert_character_produces_verified_parts(tmp_path: Path) -> None:
    source = tmp_path / "hero"
    source.mkdir()
    write_character(source)
    output = tmp_path / "hero-parts"
    report = convert_character(source, output)

    assert report.layers_verified > 0
    assert report.stacks_verified > 0
    assert any("fx/missing.png" in warning for warning in report.warnings)

    converted = json.loads((output / "layers.json").read_text(encoding="utf-8"))
    assert converted["parts"] is True
    # Every layer — poses and expression bases alike — is a single
    # trimmed offset entry; nothing is split into multiple images.
    pose_entry = converted["poses"]["arms-down"][0]
    assert pose_entry == {"path": "body/lower.png", "x": 8, "y": 48}
    assert (output / "layers" / "body/lower.png").is_file()
    with Image.open(output / "layers" / "body/lower.png") as part:
        assert part.size == (48, 48)
    base = converted["expressions"]["smile"]["base"]
    assert base == {"path": "face/smile.png", "x": 16, "y": 8}
    with Image.open(output / "layers" / "face/smile.png") as face:
        assert face.size == (32, 32)
    with Image.open(output / "layers" / "fx/blank.png") as blank:
        assert blank.size == (1, 1)

    # And the converted stack still renders the same sprite directly
    # (equal under the canonical comparison: alpha exact everywhere,
    # color exact wherever alpha is non-zero).
    original_layers = json.loads((source / "layers.json").read_text(encoding="utf-8"))
    combo = {
        "pose": "arms-down",
        "expression": "grin",
        "eye_frame": 2,
        "mouth_frame": 2,
        "tears": True,
        "extras": ["sweat"],
        "mark": "sign",
    }
    assert _canonical_bytes(
        render_stack(original_layers, source / "layers", **combo)
    ) == _canonical_bytes(render_stack(converted, output / "layers", **combo))


def test_render_stack_reads_a_labeled_pose(tmp_path: Path) -> None:
    images = tmp_path / "layers"
    images.mkdir()
    Image.new("RGBA", (4, 4), (255, 0, 0, 255)).save(images / "body.png")
    layers = {
        "image": {"width": 4, "height": 4},
        "paint": ["pose"],
        "poses": {"still": {"label": "静止", "layers": ["body.png"]}},
        "expressions": {},
        "eyes": [],
    }
    rendered = render_stack(layers, images, pose="still", expression="normal")
    assert rendered.getpixel((0, 0)) == (255, 0, 0, 255)


def test_render_stack_resolves_split_eyes_and_tears_per_side(tmp_path: Path) -> None:
    images = tmp_path / "layers"
    images.mkdir()
    Image.new("RGBA", (4, 4), (10, 0, 0, 255)).save(images / "left-closed.png")
    Image.new("RGBA", (4, 4), (20, 0, 0, 255)).save(images / "shared-half.png")
    Image.new("RGBA", (4, 4), (30, 0, 0, 255)).save(images / "left-tears.png")
    layers = {
        "image": {"width": 4, "height": 4},
        "paint": ["eyes", "tears"],
        "poses": {},
        "expressions": {},
        "eyes": [["shared-open.png"], ["shared-half.png"], ["shared-closed.png"]],
        "eyes_left": [["left-open.png"], ["left-half.png"], ["left-closed.png"]],
        "eyes_right": [["right-open.png"]],
        "tears_left": [[], [], ["left-tears.png"]],
        "tears_right": [[], [], ["right-tears.png"]],
    }
    rendered = render_stack(layers, images, pose="still", expression="normal", eye_frame=2)
    assert rendered.getpixel((0, 0)) == (10, 0, 0, 255)
    # Frame 1: the left split image is missing on disk and the right
    # side has no frame 1; the shared list is never read in split
    # mode, so nothing draws (the shared frame 1 stays unused).
    rendered = render_stack(layers, images, pose="still", expression="normal", eye_frame=1)
    assert rendered.getpixel((0, 0)) == (0, 0, 0, 0)
    rendered = render_stack(
        layers, images, pose="still", expression="normal", eye_frame=2, tears=True
    )
    assert rendered.getpixel((0, 0)) == (30, 0, 0, 255)


def test_render_stack_rejects_a_group_with_no_definition(tmp_path: Path) -> None:
    images = tmp_path / "layers"
    images.mkdir()
    layers = {
        "image": {"width": 4, "height": 4},
        "paint": ["eyes"],
        "poses": {},
        "expressions": {},
    }
    with pytest.raises(ValueError, match="eyes"):
        render_stack(layers, images, pose="still", expression="normal", eye_frame=0)


def test_render_stack_stacks_frames_in_stack_mode(tmp_path: Path) -> None:
    images = tmp_path / "layers"
    images.mkdir()
    Image.new("RGBA", (4, 4), (10, 0, 0, 255)).save(images / "eye-open.png")
    Image.new("RGBA", (4, 4), (20, 0, 0, 255)).save(images / "eye-half.png")
    layers = {
        "image": {"width": 4, "height": 4},
        "paint": ["eyes"],
        "poses": {},
        "expressions": {},
        "eyes": [["eye-open.png"], ["eye-half.png"], []],
    }
    rendered = render_stack(layers, images, pose="still", expression="normal", eye_frame=2)
    assert rendered.getpixel((0, 0)) == (0, 0, 0, 0)
    stacked = {**layers, "frame_mode": {"eyes": "stack"}}
    rendered = render_stack(stacked, images, pose="still", expression="normal", eye_frame=2)
    assert rendered.getpixel((0, 0)) == (20, 0, 0, 255)
    rendered = render_stack(stacked, images, pose="still", expression="normal", eye_frame=0)
    assert rendered.getpixel((0, 0)) == (10, 0, 0, 255)
    # The mode is per slot group: the mouth stacks only when its own
    # entry says so, not when another group's does.
    Image.new("RGBA", (4, 4), (40, 0, 0, 255)).save(images / "mouth-closed.png")
    mouth_layers = {
        "image": {"width": 4, "height": 4},
        "paint": ["mouth"],
        "poses": {},
        "expressions": {"normal": {"base": None, "mouth": ["mouth-closed.png", None]}},
        "eyes": [],
    }
    rendered = render_stack(mouth_layers, images, pose="still", expression="normal", mouth_frame=1)
    assert rendered.getpixel((0, 0)) == (0, 0, 0, 0)
    rendered = render_stack(
        {**mouth_layers, "frame_mode": {"eyes": "stack"}},
        images,
        pose="still",
        expression="normal",
        mouth_frame=1,
    )
    assert rendered.getpixel((0, 0)) == (0, 0, 0, 0)
    rendered = render_stack(
        {**mouth_layers, "frame_mode": {"mouth": "stack"}},
        images,
        pose="still",
        expression="normal",
        mouth_frame=1,
    )
    assert rendered.getpixel((0, 0)) == (40, 0, 0, 255)


def test_render_stack_draws_additions_extras_and_layered_marks(tmp_path: Path) -> None:
    images = tmp_path / "layers"
    images.mkdir()
    colors = {
        "face-back.png": (10, 0, 0, 255),
        "face-front.png": (20, 0, 0, 255),
        "eye.png": (30, 0, 0, 255),
        "cheek.png": (40, 0, 0, 255),
        "mark.png": (50, 0, 0, 255),
        "thinking.png": (60, 0, 0, 255),
        "sweat.png": (70, 0, 0, 255),
        "blush.png": (80, 0, 0, 255),
    }
    for name, color in colors.items():
        Image.new("RGBA", (4, 4), color).save(images / name)
    layers = {
        "image": {"width": 4, "height": 4},
        "paint": ["expression", "eyes", "extras", "mark"],
        "poses": {},
        "expressions": {
            "normal": {
                "base": ["face-back.png", "face-front.png"],
                "mouth": [None, None, None],
                "eyes": [[], ["cheek.png"], ["cheek.png"]],
            }
        },
        "eyes": [[], ["eye.png"], ["eye.png"]],
        "extras": {"sweat": "sweat.png", "blush": "blush.png"},
        "marks": {"sign": "mark.png", "thinking": "thinking.png"},
    }
    rendered = render_stack(layers, images, pose="still", expression="normal")
    assert rendered.getpixel((0, 0)) == (20, 0, 0, 255)
    rendered = render_stack(layers, images, pose="still", expression="normal", eye_frame=1)
    assert rendered.getpixel((0, 0)) == (40, 0, 0, 255)
    rendered = render_stack(
        layers, images, pose="still", expression="normal", extras=["sweat", "blush"]
    )
    assert rendered.getpixel((0, 0)) == (80, 0, 0, 255)
    rendered = render_stack(
        layers, images, pose="still", expression="normal", extras=["blush", "sweat"]
    )
    assert rendered.getpixel((0, 0)) == (70, 0, 0, 255)
    rendered = render_stack(layers, images, pose="still", expression="normal", mark="sign")
    assert rendered.getpixel((0, 0)) == (50, 0, 0, 255)
    rendered = render_stack(
        layers, images, pose="still", expression="normal", mark="sign", thinking=True
    )
    assert rendered.getpixel((0, 0)) == (60, 0, 0, 255)
    rendered = render_stack(layers, images, pose="still", expression="normal", thinking=True)
    assert rendered.getpixel((0, 0)) == (60, 0, 0, 255)


def test_convert_character_preserves_depth_on_object_refs(tmp_path: Path) -> None:
    source = tmp_path / "hero"
    source.mkdir()
    write_character(source)
    layers_path = source / "layers.json"
    layers = json.loads(layers_path.read_text(encoding="utf-8"))
    layers["poses"]["arms-down"][1] = {"path": "body/upper.png", "depth": "rear"}
    layers_path.write_text(json.dumps(layers), encoding="utf-8")

    output = tmp_path / "hero-parts"
    report = convert_character(source, output)
    assert report.stacks_verified > 0

    converted = json.loads((output / "layers.json").read_text(encoding="utf-8"))
    assert converted["poses"]["arms-down"][1] == {
        "path": "body/upper.png",
        "x": 8,
        "y": 0,
        "depth": "rear",
    }
    assert converted["poses"]["arms-down"][0] == {"path": "body/lower.png", "x": 8, "y": 48}
