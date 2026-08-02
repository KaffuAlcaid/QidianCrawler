from __future__ import annotations

import hashlib
import json
import shutil
import sys
import tempfile
import unittest
import zipfile
from pathlib import Path



PROJECT_ROOT = Path(__file__).resolve().parents[1]
TOOLS_ROOT = PROJECT_ROOT / "tools"
sys.path.insert(0, str(TOOLS_ROOT))

from project import (  # noqa: E402
    FIXED_ZIP_DATETIME,
    _safe_dist_root,
    build_package,
)


class PackageTests(unittest.TestCase):
    def test_package_is_reproducible_and_loadable(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            temporary_root = Path(directory)
            shutil.copytree(PROJECT_ROOT / "extension", temporary_root / "extension")
            first = build_package(temporary_root, temporary_root / "dist-one")
            second = build_package(temporary_root, temporary_root / "dist-two")

            first_bytes = first.archive.read_bytes()
            second_bytes = second.archive.read_bytes()
            self.assertEqual(first_bytes, second_bytes)
            self.assertEqual(first.sha256, hashlib.sha256(first_bytes).hexdigest())
            self.assertEqual(first.sha256, second.sha256)

            self.assertEqual(
                sorted(path.name for path in first.archive.parent.iterdir()),
                [first.staging_directory.name, first.archive.name],
            )

            with zipfile.ZipFile(first.archive, "r") as archive:
                names = archive.namelist()
                expected_names = sorted(
                    path.relative_to(temporary_root / "extension").as_posix()
                    for path in (temporary_root / "extension").rglob("*")
                    if path.is_file()
                )
                self.assertEqual(names, expected_names)
                self.assertIn("manifest.json", names)
                self.assertIn("offscreen.html", names)
                self.assertIn("offscreen.js", names)
                self.assertIn("src/automation-controller.js", names)
                self.assertIn("src/automation-state.js", names)
                self.assertIn("src/extract-page-ready.js", names)
                self.assertIn("src/extract-page-next-ready.js", names)
                self.assertIn("src/page-readiness.js", names)
                self.assertNotIn("extension/manifest.json", names)
                self.assertIsNone(archive.testzip())
                self.assertTrue(all(".." not in Path(name).parts for name in names))
                self.assertTrue(all("\\" not in name for name in names))
                self.assertTrue(all(not name.endswith(".py") for name in names))
                self.assertEqual(len(names), len({name.casefold() for name in names}))
                for info in archive.infolist():
                    self.assertEqual(info.date_time, FIXED_ZIP_DATETIME)
                    self.assertEqual(info.compress_type, zipfile.ZIP_STORED)
                    self.assertEqual(info.create_system, 3)
                    self.assertEqual(info.external_attr, 0o100644 << 16)
                    self.assertEqual(
                        archive.read(info.filename),
                        (temporary_root / "extension" / info.filename).read_bytes(),
                    )

            self.assertTrue((first.staging_directory / "manifest.json").is_file())
            self.assertFalse((first.staging_directory / "tests").exists())
            self.assertFalse((first.staging_directory / "tools").exists())

    def test_dist_root_must_not_overlap_source_directories(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            for name in ("extension", "tools", "tests"):
                (root / name).mkdir()
            for unsafe in (
                root,
                root / "extension",
                root / "extension" / "dist",
                root / "tools" / "dist",
                root / "tests" / "dist",
            ):
                with self.subTest(path=unsafe):
                    with self.assertRaises(RuntimeError):
                        _safe_dist_root(root, unsafe)

    def test_dist_root_rejects_symlink(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            for name in ("extension", "tools", "tests", "real-dist"):
                (root / name).mkdir()
            link = root / "linked-dist"
            try:
                link.symlink_to(root / "real-dist", target_is_directory=True)
            except OSError as error:
                self.skipTest(f"当前平台无法创建目录符号链接：{error}")
            with self.assertRaises(RuntimeError) as context:
                _safe_dist_root(root, link)
            self.assertIn("DIST_SYMLINK", str(context.exception))

    def test_packager_refuses_symlink_at_staging_target(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            shutil.copytree(PROJECT_ROOT / "extension", root / "extension")
            dist = root / "dist"
            protected = dist / "must-survive"
            protected.mkdir(parents=True)
            manifest = json.loads(
                (root / "extension" / "manifest.json").read_text(encoding="utf-8")
            )
            staging = dist / f"QidianCrawler-v{manifest['version']}"
            try:
                staging.symlink_to(protected, target_is_directory=True)
            except OSError as error:
                self.skipTest(f"当前平台无法创建目录符号链接：{error}")
            with self.assertRaises(RuntimeError) as context:
                build_package(root, dist)
            self.assertIn("STAGING_SYMLINK", str(context.exception))
            self.assertTrue(protected.is_dir(), "打包器不应删除符号链接目标")


if __name__ == "__main__":
    unittest.main()
