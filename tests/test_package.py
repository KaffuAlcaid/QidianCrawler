from __future__ import annotations

import hashlib
import json
import os
import shutil
import subprocess
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


def isolated_git_environment(
    global_config: Path,
    global_attributes: Path,
    hooks_directory: Path,
    template_directory: Path,
) -> dict[str, str]:
    environment = os.environ.copy()
    direct_overrides = {
        "GIT_CONFIG",
        "GIT_CONFIG_COUNT",
        "GIT_CONFIG_LOCAL",
        "GIT_CONFIG_PARAMETERS",
        "GIT_CONFIG_SYSTEM",
        "GIT_CEILING_DIRECTORIES",
        "GIT_DISCOVERY_ACROSS_FILESYSTEM",
        "GIT_DIR",
        "GIT_IMPLICIT_WORK_TREE",
        "GIT_WORK_TREE",
        "GIT_INDEX_FILE",
        "GIT_OBJECT_DIRECTORY",
        "GIT_ALTERNATE_OBJECT_DIRECTORIES",
        "GIT_COMMON_DIR",
        "GIT_TEMPLATE_DIR",
    }
    for name in tuple(environment):
        if (
            name in direct_overrides
            or name.startswith("GIT_CONFIG_KEY_")
            or name.startswith("GIT_CONFIG_VALUE_")
        ):
            environment.pop(name)

    environment.update(
        {
            "GIT_CONFIG_NOSYSTEM": "1",
            "GIT_CONFIG_GLOBAL": str(global_config),
            "GIT_ATTR_NOSYSTEM": "1",
            "GIT_TEMPLATE_DIR": str(template_directory),
        }
    )
    command_config = (
        ("core.hooksPath", hooks_directory),
        ("core.attributesFile", global_attributes),
        ("init.templateDir", template_directory),
    )
    environment["GIT_CONFIG_COUNT"] = str(len(command_config))
    for index, (key, value) in enumerate(command_config):
        environment[f"GIT_CONFIG_KEY_{index}"] = key
        environment[f"GIT_CONFIG_VALUE_{index}"] = str(value)
    return environment


class PackageTests(unittest.TestCase):
    def require_git(self) -> str:
        git = shutil.which("git")
        if git is None:
            self.skipTest("Git 不可用，无法验证不同 core.autocrlf checkout 的产物。")
        try:
            completed = subprocess.run(
                [git, "--version"],
                check=False,
                capture_output=True,
                text=True,
                encoding="utf-8",
                errors="replace",
            )
        except OSError as error:
            self.skipTest(
                "Git 不可用，无法验证不同 core.autocrlf checkout 的产物："
                f"{error}"
            )
        if completed.returncode != 0:
            self.skipTest(
                "Git 不可用，无法验证不同 core.autocrlf checkout 的产物："
                f"{completed.stderr.strip()}"
            )
        return git

    def run_git(
        self,
        git: str,
        *arguments: str,
        cwd: Path | None = None,
        environment: dict[str, str] | None = None,
    ) -> None:
        subprocess.run(
            [git, *arguments],
            cwd=cwd,
            env=environment,
            check=True,
            capture_output=True,
            text=True,
            encoding="utf-8",
            errors="replace",
        )

    def test_package_is_reproducible_and_loadable(self) -> None:
        git = self.require_git()
        with tempfile.TemporaryDirectory() as directory:
            temporary_root = Path(directory)
            repository = temporary_root / "repository"
            global_config = temporary_root / "empty-gitconfig"
            global_attributes = temporary_root / "empty-attributes"
            empty_hooks = temporary_root / "empty-hooks"
            empty_template = temporary_root / "empty-template"
            repository.mkdir()
            empty_hooks.mkdir()
            empty_template.mkdir()
            global_config.write_text("", encoding="utf-8", newline="\n")
            global_attributes.write_text("", encoding="utf-8", newline="\n")
            git_environment = isolated_git_environment(
                global_config,
                global_attributes,
                empty_hooks,
                empty_template,
            )
            shutil.copytree(PROJECT_ROOT / "extension", repository / "extension")
            shutil.copy2(
                PROJECT_ROOT / ".gitattributes",
                repository / ".gitattributes",
            )
            self.run_git(
                git,
                "init",
                ".",
                cwd=repository,
                environment=git_environment,
            )
            self.run_git(
                git,
                "config",
                "--local",
                "core.autocrlf",
                "false",
                cwd=repository,
                environment=git_environment,
            )
            self.run_git(
                git,
                "add",
                "--",
                ".gitattributes",
                "extension",
                cwd=repository,
                environment=git_environment,
            )
            self.run_git(
                git,
                "-c",
                "user.name=QidianCrawler Tests",
                "-c",
                "user.email=tests@qidiancrawler.invalid",
                "commit",
                "--no-gpg-sign",
                "-m",
                "Create packaging fixture",
                cwd=repository,
                environment=git_environment,
            )

            checkouts: dict[str, Path] = {}
            for autocrlf in ("true", "false"):
                checkout = temporary_root / f"checkout-{autocrlf}"
                self.run_git(
                    git,
                    "clone",
                    "--no-checkout",
                    str(repository),
                    str(checkout),
                    environment=git_environment,
                )
                self.run_git(
                    git,
                    "config",
                    "--local",
                    "core.autocrlf",
                    autocrlf,
                    cwd=checkout,
                    environment=git_environment,
                )
                self.run_git(
                    git,
                    "checkout",
                    "--force",
                    "HEAD",
                    cwd=checkout,
                    environment=git_environment,
                )
                checkouts[autocrlf] = checkout

            first_root = checkouts["true"]
            second_root = checkouts["false"]
            first = build_package(first_root, first_root / "dist")
            second = build_package(second_root, second_root / "dist")

            first_bytes = first.archive.read_bytes()
            second_bytes = second.archive.read_bytes()
            self.assertEqual(first_bytes, second_bytes)
            self.assertEqual(first.sha256, hashlib.sha256(first_bytes).hexdigest())
            self.assertEqual(second.sha256, hashlib.sha256(second_bytes).hexdigest())
            self.assertEqual(first.sha256, second.sha256)

            self.assertEqual(
                sorted(path.name for path in first.archive.parent.iterdir()),
                [first.staging_directory.name, first.archive.name],
            )

            with zipfile.ZipFile(first.archive, "r") as archive:
                names = archive.namelist()
                expected_names = sorted(
                    path.relative_to(first_root / "extension").as_posix()
                    for path in (first_root / "extension").rglob("*")
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
                        (first_root / "extension" / info.filename).read_bytes(),
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
            shutil.copy2(PROJECT_ROOT / ".gitattributes", root / ".gitattributes")
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
