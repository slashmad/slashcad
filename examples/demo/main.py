"""Demo: a mounting bracket and a lid. Edit and save; the view updates live."""
from build123d import (Axis, Box, BuildPart, BuildSketch, CounterBoreHole, GridLocations, Locations, Mode,
                       Plane, RectangleRounded, SlotOverall, extrude, fillet)
from slashcad import show

WIDTH = 120
HOLES = 4

with BuildPart() as bracket:
    Box(WIDTH, 60, 12)
    fillet(bracket.edges().filter_by(Axis.Z), radius=5)
    with BuildSketch(bracket.faces().sort_by(Axis.Z)[-1]):
        RectangleRounded(WIDTH - 20, 40, 4)
    extrude(amount=-6, mode=Mode.SUBTRACT)
    with Locations(bracket.faces().sort_by(Axis.Z)[0]):
        with GridLocations((WIDTH - 16) / (HOLES - 1), 44, HOLES, 2):
            CounterBoreHole(radius=1.7, counter_bore_radius=3.0, counter_bore_depth=2.0)
    with BuildSketch(Plane.XZ):
        with Locations((0, 6)):
            SlotOverall(WIDTH * 0.5, 5)
    extrude(amount=40, both=True, mode=Mode.SUBTRACT)

with BuildPart() as lid:
    with Locations((0, 0, 20)):
        Box(WIDTH - 22, 38, 3)
    fillet(lid.edges().filter_by(Axis.Z), radius=3)

show(bracket, name="bracket", color="steelblue")
show(lid, name="lid", color="orange")
