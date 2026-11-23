#!/usr/bin/env python3
"""Build geography.gol from original synthetic OSM geometry.

Use the fixture encoder from the Regol source checkout.
PYTHONPATH=/path/to/regol/tools python3 tests/fixtures/geography.py /path/to/regol-binary
"""

from pathlib import Path
import subprocess
import sys
from tempfile import TemporaryDirectory

from make_fixture import encode


def dataset():
    coordinates = [
        (178, -2), (-178, -2), (-178, 2), (178, 2),  # Shell
        (179.4, -0.5), (179.4, 0.5), (-179.4, 0.5), (-179.4, -0.5),  # Hole
        (178.6, 0), (-178.6, 0),  # East and west shell interiors
        (179.9, 0), (-179.9, 0),  # East and west hole interiors
        (179.7, 0.5),  # Hole boundary
        (0, 0),  # Greenwich control
        (179.7, 0), (-179.7, 0),  # Dateline path
        (-0.1, 0), (0.1, 0),  # Greenwich path
        (-15, 80), (15, 80),  # Sparse great-circle path
        (-15, 79), (15, 79),  # Nearby arc that misses the query
        (0, 80.3342036),  # Great-circle midpoint of the first path
        (179.9, 1.5), (-179.9, 1.5),  # Dateline path in the shell
        (179.85, -0.2), (179.95, -0.2), (179.95, 0.2), (179.85, 0.2),  # Narrow area
        (179.7, -0.1), (-179.7, -0.1), (-179.7, 0.1), (179.7, 0.1),  # Candidate outline
        (-1, -1), (1, -1), (1, 1), (-1, 1),  # Greenwich shell
        (-80, 84), (80, 84),  # Arc that reaches 88.95°N
        (-0.1, 85.0511287), (0.1, 85.0511287),  # Clamped-center decoy
        (-90, 84), (90, 84),  # Arc that reaches the North Pole
        (180, 1), (-180, 1),  # The same meridian in both GOL encodings
    ]
    nodes = [
        {"id": ident, "lon": lon, "lat": lat, "tags": {}}
        for ident, (lon, lat) in enumerate(coordinates, 1)
    ]
    for ident in [9, 10, 11, 12, 13, 14]:
        nodes[ident - 1]["tags"] = {"test:group": "dateline"}
    nodes[22]["tags"] = {"test:group": "arc_midpoint"}
    for node in nodes[-2:]:
        node["tags"] = {"test:group": "seam_point"}

    ways = [
        {"id": 101, "nodes": [1, 2, 3, 4, 1], "tags": {"name": "Shell", "area": "yes"}},
        {"id": 102, "nodes": [5, 6, 7, 8, 5], "tags": {}},
        {"id": 103, "nodes": [15, 16], "tags": {"test:group": "dateline"}},
        {"id": 104, "nodes": [17, 18], "tags": {"test:group": "dateline"}},
        {"id": 105, "nodes": [19, 20], "tags": {"test:group": "arc"}},
        {"id": 106, "nodes": [21, 22], "tags": {"test:group": "arc"}},
        {"id": 107, "nodes": [24, 25], "tags": {"test:group": "dateline"}},
        {"id": 108, "nodes": [26, 27, 28, 29, 26], "tags": {"name": "Narrow", "area": "yes"}},
        {"id": 109, "nodes": [30, 31, 32, 33, 30], "tags": {"test:group": "seam_path", "area": "yes"}},
        {"id": 110, "nodes": [34, 35, 36, 37, 34], "tags": {}},
        {"id": 111, "nodes": [38, 39], "tags": {"test:group": "polar_arc"}},
        {"id": 112, "nodes": [40, 41], "tags": {"test:group": "polar_arc"}},
        {"id": 113, "nodes": [42, 43], "tags": {"test:group": "polar_arc"}},
    ]
    relations = [
        {"id": 201, "members": [["way", 101, "outer"], ["way", 102, "inner"]],
         "tags": {"type": "multipolygon", "name": "Courtyard"}},
        {"id": 202, "members": [["way", 105, ""]],
         "tags": {"type": "route", "test:group": "arc"}},
        {"id": 203, "members": [["way", 106, ""]],
         "tags": {"type": "route", "test:group": "arc"}},
        {"id": 204, "members": [["relation", 202, ""]],
         "tags": {"type": "collection", "test:group": "arc"}},
        {"id": 205, "members": [["way", 109, ""]],
         "tags": {"type": "route", "test:group": "seam_path"}},
        {"id": 206, "members": [["way", 104, ""]],
         "tags": {"type": "route", "test:group": "seam_path"}},
        {"id": 207, "members": [["way", 110, "outer"], ["way", 101, "outer"], ["way", 102, "inner"]],
         "tags": {"type": "multipolygon", "name": "Two Shells"}},
        {"id": 208, "members": [["way", 111, ""]],
         "tags": {"type": "route", "test:group": "polar_arc"}},
        {"id": 209, "members": [["way", 113, ""]],
         "tags": {"type": "route", "test:group": "polar_arc"}},
    ]
    return {"nodes": nodes, "ways": ways, "relations": relations}


def main():
    regol = Path(sys.argv[1]).resolve()
    fixture = Path(__file__).with_suffix(".gol")
    with TemporaryDirectory() as tmp:
        source = Path(tmp) / "geography.osm.pbf"
        output = source.with_name("geography.gol")
        source.write_bytes(encode(dataset()))
        subprocess.run([regol, "build", source, output], check=True)
        subprocess.run([regol, "check", output], check=True)
        fixture.write_bytes(output.read_bytes())


if __name__ == "__main__":
    main()
