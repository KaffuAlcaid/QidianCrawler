from __future__ import annotations

import json
import re
import unittest
from pathlib import Path


PROJECT_ROOT = Path(__file__).resolve().parents[1]


class RepositoryScopeTests(unittest.TestCase):
    def test_legacy_runtime_paths_are_removed(self) -> None:
        forbidden = [
            "automation",
            "edge-extension",
            "example",
            "src/qidian_exporter",
            "watch.bat",
            "pyproject.toml",
        ]
        existing = [item for item in forbidden if (PROJECT_ROOT / item).exists()]
        existing.extend(
            path.name for path in PROJECT_ROOT.glob("edge-extension-release-*")
        )
        self.assertEqual(existing, [], f"仍存在旧运行路径：{existing}")

    def test_extension_automation_is_event_driven_and_permissions_minimal(self) -> None:
        extension = PROJECT_ROOT / "extension"
        manifest = json.loads(
            (extension / "manifest.json").read_text(encoding="utf-8")
        )
        permissions = manifest.get("permissions", [])
        self.assertNotIn("host_permissions", manifest)
        self.assertNotIn("content_scripts", manifest)
        self.assertNotIn("tabs", permissions)
        self.assertNotIn("alarms", permissions)
        self.assertNotIn("webNavigation", permissions)
        self.assertIn("offscreen", permissions)
        self.assertTrue((extension / "offscreen.html").is_file())
        self.assertTrue((extension / "offscreen.js").is_file())

        popup_html = (extension / "popup.html").read_text(encoding="utf-8")
        self.assertIn('id="capture-current"', popup_html)
        self.assertIn('id="open-next"', popup_html)
        self.assertIn('id="automation-start"', popup_html)
        self.assertIn('id="automation-stop"', popup_html)
        self.assertIn('id="automation-target"', popup_html)
        self.assertIn('id="export-format"', popup_html)

        javascript = {
            path.relative_to(extension).as_posix(): path.read_text(encoding="utf-8")
            for path in extension.rglob("*.js")
        }
        self.assertTrue(all("chrome.alarms" not in text for text in javascript.values()))
        self.assertTrue(all("webNavigation" not in text for text in javascript.values()))
        self.assertTrue(all("setInterval(" not in text for text in javascript.values()))
        self.assertEqual(
            {
                name
                for name, text in javascript.items()
                if "chrome.tabs.onUpdated" in text
            },
            {"background.js"},
        )
        self.assertEqual(
            {
                name
                for name, text in javascript.items()
                if "chrome.tabs.onRemoved" in text
            },
            {"background.js"},
        )
        navigation_owners = {
            name for name, text in javascript.items() if "chrome.tabs.update(" in text
        }
        self.assertEqual(navigation_owners, {"background.js", "popup.js"})
        self.assertEqual(javascript["background.js"].count("chrome.tabs.update("), 1)
        self.assertEqual(javascript["popup.js"].count("chrome.tabs.update("), 1)
        self.assertIn("chrome.offscreen", javascript["background.js"])
        self.assertIn(".createDocument(", javascript["background.js"])
        self.assertIn('message.type === "automation-start"', javascript["background.js"])

    def test_browser_fixtures_are_small_and_synthetic(self) -> None:
        runner = PROJECT_ROOT / "tests" / "runner.js"
        self.assertLess(runner.stat().st_size, 64 * 1024)
        content = runner.read_text(encoding="utf-8")
        self.assertIn("合成正文", content)
        self.assertNotIn("example/0.html", content)

    def test_browser_test_count_matches_machine_metadata(self) -> None:
        html = (PROJECT_ROOT / "tests" / "runner.html").read_text(encoding="utf-8")
        script = (PROJECT_ROOT / "tests" / "runner.js").read_text(encoding="utf-8")
        match = re.search(r'data-expected-tests="(\d+)"', html)
        self.assertIsNotNone(match, "runner.html 缺少 data-expected-tests")
        expected = int(match.group(1))
        registered = len(re.findall(r"^\s*test\(", script, flags=re.MULTILINE))
        self.assertGreater(expected, 0)
        self.assertEqual(registered, expected)


if __name__ == "__main__":
    unittest.main()
