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

    def test_pythonpath_entries_that_are_another_apps_directory_are_refused(self) -> None:
        with tempfile.TemporaryDirectory() as root:
            root = os.path.realpath(root)
            sdk = os.path.join(root, "packages", "sdk-python")
            app = os.path.join(root, "apps", "hello")
            # Another app under apps/, even with no berth.yml of its own yet.
            other = os.path.join(root, "apps", "other")
            # An example app outside apps/, and a directory within it.
            example = os.path.join(root, "examples", "resident-apps", "demo")
            example_lib = os.path.join(example, "lib")
            for d in (sdk, app, other, example_lib):
                os.makedirs(d)
            with open(os.path.join(example, "berth.yml"), "w") as f:
                f.write("name: demo\n")
            examples = os.path.join(root, "examples")
            resident = os.path.join(examples, "resident-apps")
            pythonpath = ":".join([other, example, example_lib, examples, resident, sdk])
            out = StringIO()
            with redirect_stdout(out):
                paths = _sdk_read_paths(pythonpath, app)
            # Only the SDK survives: the others are an app, part of one, or hold one.
            self.assertEqual(paths, [sdk])
            self.assertEqual(out.getvalue().count("another app's directory"), 5)

    def test_an_empty_pythonpath_grants_nothing(self) -> None:
        self.assertEqual(_sdk_read_paths("", "/workspace/apps/x"), [])


if __name__ == "__main__":
    unittest.main()
