from __future__ import annotations

import json
import shutil
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock



PROJECT_ROOT = Path(__file__).resolve().parents[1]
TOOLS_ROOT = PROJECT_ROOT / "tools"
sys.path.insert(0, str(TOOLS_ROOT))

from project import (  # noqa: E402
    PROJECT_NAME,
    REQUIRED_PERMISSIONS,
    RUNTIME_FILE_ALLOWLIST,
    ProjectValidationError,
    find_browser,
    run_browser_tests,
    validate_project,
)


class ManifestTests(unittest.TestCase):
    def test_current_extension_passes_static_validation(self) -> None:
        report = validate_project(PROJECT_ROOT)
        manifest = json.loads(
            (PROJECT_ROOT / "extension" / "manifest.json").read_text(encoding="utf-8")
        )
        self.assertEqual(report.version, manifest["version"])
        self.assertRegex(report.version, r"^\d+\.\d+\.\d+$")
        self.assertEqual(set(report.permissions), REQUIRED_PERMISSIONS)
        self.assertIn("manifest.json", report.files)
        self.assertIn("background.js", report.referenced_files)
        self.assertIn("popup.html", report.referenced_files)
        self.assertIn("diagnostics.html", report.referenced_files)
        self.assertIn("offscreen.html", report.referenced_files)
        self.assertIn("offscreen.js", report.referenced_files)
        self.assertIn("src/automation-controller.js", report.referenced_files)
        self.assertIn("src/automation-state.js", report.referenced_files)
        self.assertIn("src/extract-page.js", report.referenced_files)
        self.assertIn("src/extract-page-ready.js", report.referenced_files)
        self.assertIn("src/extract-page-next-ready.js", report.referenced_files)
        self.assertIn("src/page-readiness.js", report.referenced_files)
        self.assertTrue(set(report.files).issubset(RUNTIME_FILE_ALLOWLIST))

    def test_manifest_has_no_persistent_site_access(self) -> None:
        manifest = json.loads(
            (PROJECT_ROOT / "extension" / "manifest.json").read_text(encoding="utf-8")
        )
        self.assertEqual(manifest["name"], PROJECT_NAME)
        self.assertNotIn("host_permissions", manifest)
        self.assertNotIn("content_scripts", manifest)
        self.assertNotIn("alarms", manifest["permissions"])

    def test_validator_rejects_extra_permission(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            temporary_root = Path(directory)
            shutil.copytree(PROJECT_ROOT / "extension", temporary_root / "extension")
            manifest_path = temporary_root / "extension" / "manifest.json"
            manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
            manifest["permissions"].append("tabs")
            manifest_path.write_text(
                json.dumps(manifest, ensure_ascii=False, indent=2) + "\n",
                encoding="utf-8",
            )
            with self.assertRaises(ProjectValidationError) as context:
                validate_project(temporary_root)
            self.assertIn("PERMISSION_EXTRA", str(context.exception))

    def test_validator_tracks_execute_script_file_references(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            temporary_root = Path(directory)
            shutil.copytree(PROJECT_ROOT / "extension", temporary_root / "extension")
            popup_path = temporary_root / "extension" / "popup.js"
            popup_source = popup_path.read_text(encoding="utf-8")
            popup_path.write_text(
                popup_source.replace(
                    '"src/extract-page.js"',
                    '"src/not-present.js"',
                    1,
                ),
                encoding="utf-8",
                newline="\n",
            )
            with self.assertRaises(ProjectValidationError) as context:
                validate_project(temporary_root)
            self.assertIn("REFERENCE_MISSING", str(context.exception))

    def test_validator_tracks_offscreen_document_reference(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            temporary_root = Path(directory)
            shutil.copytree(PROJECT_ROOT / "extension", temporary_root / "extension")
            background_path = temporary_root / "extension" / "background.js"
            background_source = background_path.read_text(encoding="utf-8")
            background_path.write_text(
                background_source.replace(
                    'url: "offscreen.html"',
                    'url: "missing-offscreen.html"',
                    1,
                ),
                encoding="utf-8",
                newline="\n",
            )
            with self.assertRaises(ProjectValidationError) as context:
                validate_project(temporary_root)
            self.assertIn("REFERENCE_MISSING", str(context.exception))

    def test_validator_rejects_undeclared_publishable_file(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            temporary_root = Path(directory)
            shutil.copytree(PROJECT_ROOT / "extension", temporary_root / "extension")
            (temporary_root / "extension" / "debug.json").write_text(
                '{"private": true}\n', encoding="utf-8", newline="\n"
            )
            with self.assertRaises(ProjectValidationError) as context:
                validate_project(temporary_root)
            self.assertIn("PACKAGE_FILE_UNDECLARED", str(context.exception))

    def test_explicit_browser_path_does_not_fall_back(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            missing = Path(directory) / "missing-browser.exe"
            with self.assertRaises(RuntimeError) as context:
                find_browser(missing)
            self.assertIn("BROWSER_EXPLICIT_INVALID", str(context.exception))

    def test_browser_runner_rejects_zero_test_false_positive(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / "tests").mkdir()
            (root / "tests" / "runner.html").write_text(
                '<!doctype html><body data-status="running" '
                'data-expected-tests="2"><p id="summary">正在运行</p></body>',
                encoding="utf-8",
                newline="\n",
            )
            browser = root / "browser.exe"
            browser.touch()
            completed = subprocess.CompletedProcess(
                args=[str(browser)],
                returncode=0,
                stdout=(
                    '<!doctype html><body data-status="passed" '
                    'data-expected-tests="2"><p id="summary">0 通过，0 失败</p>'
                    "</body>"
                ),
                stderr="",
            )
            with mock.patch("project.subprocess.run", return_value=completed):
                with self.assertRaises(RuntimeError) as context:
                    run_browser_tests(root, browser)
            self.assertIn("BROWSER_TEST_FAILED", str(context.exception))


if __name__ == "__main__":
    unittest.main()
