"""Run from packages/sdk-python, with its dependencies installed: `PYTHONPATH=. python3 -m unittest discover -s tests`."""

import os
import tempfile
import unittest
from contextlib import redirect_stdout
from io import StringIO

from berth_sdk.generate_capability_policy import _sdk_read_paths


class SdkReadPathsTest(unittest.TestCase):
    def test_pythonpath_entries_are_filtered_to_narrow_existing_directories(self) -> None:
        with tempfile.TemporaryDirectory() as root:
            root = os.path.realpath(root)
            sdk = os.path.join(root, "packages", "sdk-python")
            app = os.path.join(root, "apps", "hello")
            os.makedirs(sdk)
            os.makedirs(app)
            link = os.path.join(root, "sdk-link")
            os.symlink(sdk, link)
            pythonpath = ":".join(
                ["/", "", "relative/dir", os.path.join(root, "missing"), root, os.path.join(root, "apps"), app, sdk, link, "/usr"]
            )
            with redirect_stdout(StringIO()):
                paths = _sdk_read_paths(pythonpath, app)
            # The link resolves to the SDK directory, so that is granted once. "/", a top-level directory such as
            # /usr, and anything containing the app (its workspace, apps/, the app itself) are too broad.
            self.assertEqual(paths, [sdk])

    def test_an_empty_pythonpath_grants_nothing(self) -> None:
        self.assertEqual(_sdk_read_paths("", "/workspace/apps/x"), [])


if __name__ == "__main__":
    unittest.main()
