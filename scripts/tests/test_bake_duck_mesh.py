"""The web asset must not inherit the terminal's lossy vertex clustering."""

import importlib.util
from pathlib import Path
import unittest

import numpy as np


SPEC = importlib.util.spec_from_file_location(
    "bake_duck_mesh", Path(__file__).resolve().parents[1] / "bake-duck-mesh.py"
)
bake = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(bake)


class FullDetailMeshTest(unittest.TestCase):
    def test_preserves_thin_surfaces_and_triangle_winding(self):
        triangles = np.array([
            [[0, 0, 0], [1, 0, 0], [0, 1, 0]],
            [[0, 1, .000004], [1, 0, .000004], [0, 0, .000004]],
            [[1, 0, 0], [1, 1, 0], [0, 1, 0]],
        ], dtype=np.float32)
        vertices, faces = bake.index_mesh(triangles)
        self.assertEqual(len(faces), len(triangles))
        np.testing.assert_array_equal(vertices[faces], triangles)
        self.assertEqual(len(vertices), 7)


if __name__ == "__main__":
    unittest.main()
