"""Merged PR version rules; no network calls, tags or releases are created by these tests."""
import importlib.util
from pathlib import Path
import subprocess
import unittest

SPEC = importlib.util.spec_from_file_location(
    "release_version", Path(__file__).resolve().parents[1] / "ci-release-version.py"
)
release = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(release)


class ReleaseVersionTest(unittest.TestCase):
    def test_explicit_branch_is_used_exactly(self):
        self.assertEqual(release.choose_version("daemon-v1.2.3", {}, "0.23.0", "new"),
                         ("1.2.3", "daemon-v1.2.3"))

    def test_other_branch_increments_highest_numeric_stable_patch(self):
        tags = {"daemon-v1.2.9": "a", "daemon-v1.2.10": "b",
                "daemon-staging-v9.0.0": "c", "daemon-dev-main": "d"}
        self.assertEqual(release.choose_version("feat/studio-control", tags, "0.1.0", "new"),
                         ("1.2.11", "daemon-v1.2.11"))

    def test_no_stable_tags_uses_workspace_version(self):
        self.assertEqual(release.choose_version("fix/uart", {}, "0.23.0", "new"),
                         ("0.23.1", "daemon-v0.23.1"))

    def test_retry_reuses_the_same_commit_even_after_newer_releases(self):
        tags = {"daemon-v0.23.1": "mine", "daemon-v0.24.0": "later"}
        self.assertEqual(release.choose_version("feat/ui", tags, "0.23.0", "mine"),
                         ("0.23.1", "daemon-v0.23.1"))

    def test_explicit_collision_never_moves_existing_tag(self):
        with self.assertRaisesRegex(ValueError, "refusing to move"):
            release.choose_version("daemon-v1.2.3", {"daemon-v1.2.3": "other"}, "0.1.0", "mine")

    def test_noncanonical_branch_names_use_automatic_patch(self):
        for branch in ["feature/daemon-v1.2.3", "daemon-v01.2.3", "daemon-v1.2.3-rc.1"]:
            self.assertEqual(release.choose_version(branch, {}, "2.3.4", "mine")[0], "2.3.5")

    def test_concurrent_reservations_retry_the_next_patch(self):
        tags = {"daemon-v1.2.3": "old"}
        calls = []
        def create(tag, sha):
            calls.append(tag)
            if len(calls) == 1:
                tags[tag] = "another-pr"
                raise subprocess.CalledProcessError(1, ["gh"])
            tags[tag] = sha
        result = release.reserve("feat/ui", "mine", "1.2.3", lambda: dict(tags), create)
        self.assertEqual(result, ("1.2.5", "daemon-v1.2.5"))
        self.assertEqual(calls, ["daemon-v1.2.4", "daemon-v1.2.5"])

    def test_out_of_order_older_merge_is_not_published_as_a_higher_version(self):
        tags = {"daemon-v1.2.4": "newer"}
        created = []
        result = release.reserve("feat/old", "older", "1.2.3", lambda: tags,
                                 lambda *args: created.append(args),
                                 lambda older, newer: (older, newer) == ("older", "newer"))
        self.assertIsNone(result)
        self.assertEqual(created, [])

    def test_auth_or_network_failure_is_not_treated_as_a_collision(self):
        def fail(*_):
            raise subprocess.CalledProcessError(1, ["gh"])
        with self.assertRaises(subprocess.CalledProcessError):
            release.reserve("feat/ui", "mine", "1.2.3", lambda: {}, fail)

    def test_stamp_changes_only_workspace_version(self):
        source = '[workspace.metadata.tool]\nversion = "9.8.7"\n\n[workspace.package]\nversion = "0.23.0" # keep\nedition = "2024"\n\n[workspace.dependencies]\nserde = "1"\n'
        changed = release.stamp(source, "1.2.3")
        self.assertEqual(changed, source.replace('version = "0.23.0"', 'version = "1.2.3"'))
        self.assertEqual(release.package_version(changed), "1.2.3")

    def test_manual_prerelease_stamping_still_works(self):
        source = '[workspace.package]\nversion = "0.23.0"\n'
        self.assertEqual(release.package_version(release.stamp(source, "1.2.3-rc.1+build.2")),
                         "1.2.3-rc.1+build.2")
        for invalid in ['1.2', '1.2.3-01', '1.2.3"\nbad=true']:
            with self.assertRaises(ValueError):
                release.stamp(source, invalid)


if __name__ == "__main__":
    unittest.main()
