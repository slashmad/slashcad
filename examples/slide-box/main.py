"""Example: a box with a sliding lid. Open the Checks tab to see the rules, the motion study
(SLIDE moves the lid) and printability (the groove roofs overhang when the base prints upright)."""
from build123d import Align, Axis, Box, BuildPart, Locations, Mode, fillet
from slashcad import show

LENGTH = 120      # outer length (mm)
WIDTH = 60        # outer width (mm)
HEIGHT = 30       # outer height (mm)
WALL = 3          # wall and floor thickness (mm)
GROOVE = 1.5      # groove depth into each long wall (mm)
LID = 2.0         # lid thickness (mm)
FIT = 0.2         # sliding clearance per side (mm)
SLIDE = 0         # how far the lid is pulled out (mm)

z_groove = HEIGHT - 4.5                      # groove floor
inner_w = WIDTH - 2 * WALL

with BuildPart() as base:
    Box(LENGTH, WIDTH, HEIGHT, align=(Align.CENTER, Align.CENTER, Align.MIN))
    fillet(base.edges().filter_by(Axis.Z), radius=6)
    # cavity
    with Locations((0, 0, WALL)):
        Box(LENGTH - 2 * WALL, inner_w, HEIGHT, align=(Align.CENTER, Align.CENTER, Align.MIN), mode=Mode.SUBTRACT)
    # grooves for the lid in both long walls, open at the +X end
    with Locations((WALL / 2, 0, z_groove)):
        Box(LENGTH - WALL, inner_w + 2 * GROOVE, LID + 2 * FIT, align=(Align.CENTER, Align.CENTER, Align.MIN), mode=Mode.SUBTRACT)
    # lower the +X end wall so the lid can slide out over it
    with Locations((LENGTH / 2 - WALL / 2, 0, z_groove)):
        Box(WALL + 1, inner_w, HEIGHT, align=(Align.CENTER, Align.CENTER, Align.MIN), mode=Mode.SUBTRACT)

lid_x0 = -LENGTH / 2 + WALL + FIT        # closed end, clear of the end wall
lid_len = LENGTH / 2 - lid_x0             # flush with the open end
lid_cx = lid_x0 + lid_len / 2
with BuildPart() as lid:
    with Locations((lid_cx + SLIDE, 0, z_groove + FIT)):
        Box(lid_len, inner_w + 2 * GROOVE - 2 * FIT, LID, align=(Align.CENTER, Align.CENTER, Align.MIN))
    # thumb grip near the open end
    with Locations((lid_cx + SLIDE + lid_len / 2 - 12, 0, z_groove + FIT + LID)):
        for dx in (-4, 0, 4):
            with Locations((dx, 0, 0)):
                Box(1.6, 20, 1.2, align=(Align.CENTER, Align.CENTER, Align.MIN))

with BuildPart() as divider:
    with Locations((-20, 0, WALL)):
        Box(2, inner_w - 2 * FIT, HEIGHT - 12, align=(Align.CENTER, Align.CENTER, Align.MIN))

show(base, name="base", material="petg", color="#5b8db8")
show(lid, name="lid", material="pla", color="#e9e4d6")
show(divider, name="divider", material="tpu", color="#3a3d44")
