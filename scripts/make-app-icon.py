#!/usr/bin/env python3
# SPDX-License-Identifier: Apache-2.0
"""Draw the 1024px app-icon master, then regenerate every platform size from it.

The mark is a square-wave pulse: what an engineer sees on a scope, in the same
two-colour language as the rest of the interface. It is drawn rather than painted
so the master is exactly three RGBA values with no partial alpha -- the smaller
sizes are the only ones that get antialiasing, and `tauri icon` adds that.

    python3 scripts/make-app-icon.py            # write src-tauri/icons/app-icon.png
    pnpm tauri icon src-tauri/icons/app-icon.png -o src-tauri/icons

Needs Pillow, which the system Python usually lacks; any venv with it will do.
"""

from pathlib import Path

from PIL import Image, ImageDraw

SIDE = 1024
CORNER_RADIUS = 184  # 18% of the side
BLACK = (0, 0, 0, 255)
WHITE = (255, 255, 255, 255)
CLEAR = (0, 0, 0, 0)

# One pulse, low-high-low, 120px stroke. Axis-aligned rectangles only: the
# verticals overlap the horizontals, so the mark is one connected silhouette.
PULSE = [
    (225, 555, 405, 675),  # left low
    (345, 345, 465, 675),  # rising edge
    (405, 345, 620, 465),  # high
    (560, 345, 680, 675),  # falling edge
    (620, 555, 800, 675),  # right low
]


def render() -> Image.Image:
    tile = Image.new("L", (SIDE, SIDE), 0)
    ImageDraw.Draw(tile).rounded_rectangle(
        (0, 0, SIDE - 1, SIDE - 1), radius=CORNER_RADIUS, fill=255
    )

    icon = Image.new("RGBA", (SIDE, SIDE), CLEAR)
    draw = ImageDraw.Draw(icon)
    draw.rectangle((0, 0, SIDE - 1, SIDE - 1), fill=BLACK)
    for box in PULSE:
        draw.rectangle(box, fill=WHITE)

    # The tile mask is applied last and hard-thresholded: a rounded corner must
    # cut the black field, never leave a half-transparent fringe behind.
    icon.putalpha(tile.point(lambda v: 255 if v > 127 else 0))
    return icon


def main() -> None:
    out = Path(__file__).resolve().parent.parent / "src-tauri" / "icons" / "app-icon.png"
    icon = render()

    colours = set(icon.get_flattened_data())
    if colours != {BLACK, WHITE, CLEAR}:
        raise SystemExit(f"expected exactly three RGBA values, got {sorted(colours)}")

    icon.save(out, optimize=True)
    print(f"wrote {out} ({icon.width}x{icon.height}, {len(colours)} RGBA values)")
    print("now run: pnpm tauri icon src-tauri/icons/app-icon.png -o src-tauri/icons")


if __name__ == "__main__":
    main()
