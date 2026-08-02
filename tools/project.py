"""QidianCrawler 项目校验、浏览器测试与可复现打包工具。"""

from __future__ import annotations

import hashlib
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
import zipfile
from dataclasses import dataclass
from html.parser import HTMLParser
from pathlib import Path
from typing import Iterable


PROJECT_NAME = "QidianCrawler"
EXTENSION_DIRECTORY = "extension"
REQUIRED_PERMISSIONS = {
    "activeTab",
    "downloads",
    "offscreen",
    "scripting",
    "storage",
}

REQUIRED_RUNTIME_FILES = frozenset(
    {
        "background.js",
        "diagnostics.css",
        "diagnostics.html",
        "diagnostics.js",
        "manifest.json",
        "offscreen.html",
        "offscreen.js",
        "popup.css",
        "popup.html",
        "popup.js",
        "src/automation-controller.js",
        "src/automation-state.js",
        "src/core.js",
        "src/events.js",
        "src/extract-page-next-ready.js",
        "src/extract-page-ready.js",
        "src/extract-page.js",
        "src/extractor.js",
        "src/log-client.js",
        "src/log-store.js",
        "src/page-readiness.js",
    }
)
# 这些运行模块会在扩展拆分中逐步启用。只有文件真实存在且被页面或脚本
# 引用时才会进入产物；除此之外的新增文件必须先经过人工更新白名单。
OPTIONAL_RUNTIME_FILES = frozenset(
    {
        "src/batch-store.js",
        "src/download-tracker.js",
        "src/extract-diagnostics.js",
    }
)
RUNTIME_FILE_ALLOWLIST = REQUIRED_RUNTIME_FILES | OPTIONAL_RUNTIME_FILES
FORBIDDEN_PERMISSIONS = {
    "alarms",
    "bookmarks",
    "browsingData",
    "cookies",
    "history",
    "management",
    "nativeMessaging",
    "proxy",
    "tabs",
    "unlimitedStorage",
    "webRequest",
    "webRequestBlocking",
}
ALLOWED_SUFFIXES = {".css", ".html", ".js", ".json", ".png"}
TEXT_SUFFIXES = {".css", ".html", ".js", ".json"}
FORBIDDEN_EXTENSION_PATH_PARTS = {
    ".git",
    ".idea",
    "__pycache__",
    "node_modules",
    "tests",
    "tools",
}
MAX_EXTENSION_FILE_BYTES = 1024 * 1024
FIXED_ZIP_DATETIME = (2026, 1, 1, 0, 0, 0)


class ProjectValidationError(RuntimeError):
    """项目结构或扩展安全约束不满足。"""

    def __init__(self, errors: Iterable[str]):
        self.errors = list(errors)
        super().__init__("\n".join(self.errors))


class LocalReferenceParser(HTMLParser):
    """提取 HTML 中的本地脚本和样式引用。"""

    def __init__(self) -> None:
        super().__init__()
        self.references: list[str] = []
        self.remote_references: list[str] = []
        self.inline_script_count = 0

    def handle_starttag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
        attributes = dict(attrs)
        reference: str | None = None
        if tag == "script":
            reference = attributes.get("src")
            if not reference:
                self.inline_script_count += 1
        elif tag == "link" and attributes.get("rel") == "stylesheet":
            reference = attributes.get("href")
        if not reference:
            return
        if reference.startswith(("http://", "https://", "//")):
            self.remote_references.append(reference)
        else:
            self.references.append(reference)


class BrowserResultParser(HTMLParser):
    """读取无头浏览器输出中的机器状态和测试摘要。"""

    def __init__(self) -> None:
        super().__init__()
        self.status: str | None = None
        self.expected_tests: int | None = None
        self._inside_summary = False
        self._summary_parts: list[str] = []

    @property
    def summary(self) -> str:
        return "".join(self._summary_parts).strip()

    def handle_starttag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
        attributes = dict(attrs)
        if tag == "body":
            self.status = attributes.get("data-status")
            expected = attributes.get("data-expected-tests")
            if expected and expected.isdecimal():
                self.expected_tests = int(expected)
        elif tag == "p" and attributes.get("id") == "summary":
            self._inside_summary = True

    def handle_endtag(self, tag: str) -> None:
        if tag == "p" and self._inside_summary:
            self._inside_summary = False

    def handle_data(self, data: str) -> None:
        if self._inside_summary:
            self._summary_parts.append(data)


@dataclass(frozen=True)
class ValidationReport:
    version: str
    permissions: tuple[str, ...]
    files: tuple[str, ...]
    referenced_files: tuple[str, ...]


@dataclass(frozen=True)
class BrowserTestResult:
    browser: Path
    browser_version: str
    summary: str
    test_count: int
    compatibility_mode: bool


@dataclass(frozen=True)
class PackageResult:
    version: str
    staging_directory: Path
    archive: Path
    sha256: str
    files: tuple[str, ...]


def project_root_from_tools() -> Path:
    return Path(__file__).resolve().parents[1]


def _read_utf8(path: Path, errors: list[str]) -> str:
    try:
        data = path.read_bytes()
        if data.startswith(b"\xef\xbb\xbf"):
            errors.append(f"[UTF8_BOM] 文件不应包含 UTF-8 BOM：{path}")
        text = data.decode("utf-8")
        if "\ufffd" in text:
            errors.append(f"[UTF8_REPLACEMENT] 文件包含替换字符：{path}")
        return text
    except UnicodeDecodeError as error:
        errors.append(f"[UTF8_INVALID] 文件不是有效 UTF-8：{path} ({error})")
        return ""


def extension_files(root: Path) -> list[Path]:
    extension_root = root / EXTENSION_DIRECTORY
    if not extension_root.is_dir():
        raise ProjectValidationError(
            [f"[EXTENSION_MISSING] 找不到扩展目录：{extension_root}"]
        )
    files: list[Path] = []
    errors: list[str] = []
    seen_casefolded: dict[str, str] = {}
    for path in sorted(extension_root.rglob("*")):
        if path.is_symlink():
            errors.append(f"[SYMLINK_FORBIDDEN] 扩展中禁止符号链接：{path}")
            continue
        if not path.is_file():
            continue
        relative = path.relative_to(extension_root)
        relative_text = relative.as_posix()
        folded = relative_text.casefold()
        previous = seen_casefolded.get(folded)
        if previous is not None and previous != relative_text:
            errors.append(
                f"[PATH_CASE_COLLISION] 扩展文件在大小写不敏感系统中重名："
                f"{previous} / {relative_text}"
            )
        else:
            seen_casefolded[folded] = relative_text
        if any(part in FORBIDDEN_EXTENSION_PATH_PARTS for part in relative.parts):
            errors.append(f"[DEV_FILE_FORBIDDEN] 扩展中包含开发文件：{relative}")
        if path.suffix.lower() not in ALLOWED_SUFFIXES:
            errors.append(f"[FILE_TYPE_FORBIDDEN] 扩展包含非白名单文件：{relative}")
        if relative_text not in RUNTIME_FILE_ALLOWLIST:
            errors.append(
                f"[PACKAGE_FILE_UNDECLARED] 扩展包含未声明的运行文件：{relative_text}"
            )
        if path.stat().st_size > MAX_EXTENSION_FILE_BYTES:
            errors.append(f"[FILE_TOO_LARGE] 扩展文件超过 1 MiB：{relative}")
        files.append(path)
    present = {
        path.relative_to(extension_root).as_posix()
        for path in files
    }
    missing = REQUIRED_RUNTIME_FILES - present
    if missing:
        errors.append(
            "[RUNTIME_FILE_MISSING] 缺少必要扩展运行文件："
            + ", ".join(sorted(missing))
        )
    if errors:
        raise ProjectValidationError(errors)
    return files


def _manifest_references(manifest: dict[str, object]) -> set[str]:
    references: set[str] = set()
    background = manifest.get("background")
    if isinstance(background, dict) and isinstance(background.get("service_worker"), str):
        references.add(background["service_worker"])
    action = manifest.get("action")
    if isinstance(action, dict) and isinstance(action.get("default_popup"), str):
        references.add(action["default_popup"])
    options = manifest.get("options_ui")
    if isinstance(options, dict) and isinstance(options.get("page"), str):
        references.add(options["page"])
    content_scripts = manifest.get("content_scripts")
    if isinstance(content_scripts, list):
        for definition in content_scripts:
            if not isinstance(definition, dict):
                continue
            for key in ("js", "css"):
                values = definition.get(key)
                if isinstance(values, list):
                    references.update(value for value in values if isinstance(value, str))
    return references


def _javascript_file_references(text: str, relative: str, errors: list[str]) -> set[str]:
    """提取 importScripts、executeScript 和 offscreen 的本地文件引用。"""

    references: set[str] = set()
    for match in re.finditer(r"\bimportScripts\s*\(([^)]*)\)", text, re.DOTALL):
        arguments = match.group(1)
        literals = re.findall(r"[\"']([^\"']+)[\"']", arguments)
        references.update(literals)
        remainder = re.sub(r"[\"'][^\"']+[\"']", "", arguments)
        if re.sub(r"[\s,]", "", remainder):
            errors.append(
                f"[SCRIPT_REFERENCE_DYNAMIC] {relative} 的 importScripts 必须使用静态文件名。"
            )

    for match in re.finditer(r"\bfiles\s*:\s*\[([^]]*)\]", text, re.DOTALL):
        values = match.group(1)
        literals = re.findall(r"[\"']([^\"']+)[\"']", values)
        references.update(literals)
        remainder = re.sub(r"[\"'][^\"']+[\"']", "", values)
        if re.sub(r"[\s,]", "", remainder):
            errors.append(
                f"[SCRIPT_REFERENCE_DYNAMIC] {relative} 的 executeScript files "
                "必须使用静态文件名数组。"
            )

    for match in re.finditer(
        r"\bcreateDocument\s*\(\s*\{([^}]*)\}\s*\)", text, re.DOTALL
    ):
        definition = match.group(1)
        url_match = re.search(r"\burl\s*:\s*[\"']([^\"']+)[\"']", definition)
        if url_match:
            references.add(url_match.group(1))
        else:
            errors.append(
                f"[OFFSCREEN_REFERENCE_DYNAMIC] {relative} 的 offscreen 页面 "
                "必须使用静态本地文件名。"
            )
    return references


def validate_project(root: Path) -> ValidationReport:
    root = root.resolve()
    extension_root = root / EXTENSION_DIRECTORY
    errors: list[str] = []
    try:
        files = extension_files(root)
    except ProjectValidationError as error:
        raise error

    manifest_path = extension_root / "manifest.json"
    if not manifest_path.is_file():
        raise ProjectValidationError(
            [f"[MANIFEST_MISSING] 找不到 manifest.json：{manifest_path}"]
        )
    manifest_text = _read_utf8(manifest_path, errors)
    try:
        manifest = json.loads(manifest_text)
    except json.JSONDecodeError as error:
        raise ProjectValidationError(
            [f"[MANIFEST_JSON] manifest.json 无法解析：{error}"]
        ) from error

    if manifest.get("manifest_version") != 3:
        errors.append("[MANIFEST_VERSION] manifest_version 必须为 3。")
    if manifest.get("name") != PROJECT_NAME:
        errors.append(f"[PROJECT_NAME] 扩展名称必须为 {PROJECT_NAME}。")
    version = str(manifest.get("version") or "")
    if not re.fullmatch(r"\d+\.\d+\.\d+", version):
        errors.append("[VERSION_FORMAT] 扩展版本必须使用 x.y.z 数字格式。")

    permissions = set(manifest.get("permissions") or [])
    missing_permissions = REQUIRED_PERMISSIONS - permissions
    extra_permissions = permissions - REQUIRED_PERMISSIONS
    if missing_permissions:
        errors.append(
            "[PERMISSION_MISSING] 缺少必要权限："
            + ", ".join(sorted(missing_permissions))
        )
    if extra_permissions:
        errors.append(
            "[PERMISSION_EXTRA] 出现白名单外权限："
            + ", ".join(sorted(extra_permissions))
        )
    forbidden = permissions & FORBIDDEN_PERMISSIONS
    if forbidden:
        errors.append(
            "[PERMISSION_FORBIDDEN] 出现禁止权限：" + ", ".join(sorted(forbidden))
        )
    if manifest.get("host_permissions"):
        errors.append("[HOST_PERMISSION] 扩展不应声明常驻 host_permissions。")
    if manifest.get("content_scripts"):
        errors.append("[CONTENT_SCRIPT] 扩展不应声明常驻 content_scripts。")

    file_relatives = {
        path.relative_to(extension_root).as_posix(): path for path in files
    }
    referenced = _manifest_references(manifest)
    if "manifest.json" not in file_relatives:
        errors.append("[MANIFEST_PACKAGE] 扩展文件列表缺少 manifest.json。")

    for path in files:
        relative = path.relative_to(extension_root).as_posix()
        if path.suffix.lower() in TEXT_SUFFIXES:
            text = _read_utf8(path, errors)
        else:
            text = ""
        if path.suffix.lower() == ".html":
            parser = LocalReferenceParser()
            parser.feed(text)
            if parser.remote_references:
                errors.append(
                    f"[REMOTE_ASSET] {relative} 引用了远程资源："
                    + ", ".join(parser.remote_references)
                )
            if parser.inline_script_count:
                errors.append(f"[INLINE_SCRIPT] {relative} 包含内联脚本。")
            base = Path(relative).parent
            for reference in parser.references:
                normalized = (base / reference).as_posix()
                referenced.add(normalized)
        if path.suffix.lower() == ".js":
            if re.search(r"\beval\s*\(|\bnew\s+Function\s*\(", text):
                errors.append(f"[DYNAMIC_CODE] {relative} 使用动态执行代码。")
            if re.search(r"\b(fetch|XMLHttpRequest|WebSocket)\s*\(?", text):
                errors.append(f"[NETWORK_CODE] {relative} 包含主动网络请求代码。")
            referenced.update(_javascript_file_references(text, relative, errors))

    for reference in sorted(referenced):
        if reference.startswith(("http://", "https://", "//")):
            errors.append(f"[REMOTE_REFERENCE] 禁止远程可执行资源：{reference}")
            continue
        pure = Path(reference)
        if pure.is_absolute() or ".." in pure.parts:
            errors.append(f"[REFERENCE_ESCAPE] 资源引用越过扩展目录：{reference}")
            continue
        if pure.as_posix() not in file_relatives:
            errors.append(f"[REFERENCE_MISSING] 资源引用不存在：{reference}")

    for optional in sorted(OPTIONAL_RUNTIME_FILES.intersection(file_relatives)):
        if optional not in referenced:
            errors.append(
                f"[OPTIONAL_RUNTIME_UNREFERENCED] 可选运行文件存在但未被引用：{optional}"
            )

    if errors:
        raise ProjectValidationError(errors)
    return ValidationReport(
        version=version,
        permissions=tuple(sorted(permissions)),
        files=tuple(sorted(file_relatives)),
        referenced_files=tuple(sorted(referenced)),
    )


def find_browser(explicit: str | Path | None = None) -> Path | None:
    if explicit:
        requested = Path(explicit).expanduser()
        if not requested.is_file():
            raise RuntimeError(
                f"[BROWSER_EXPLICIT_INVALID] --browser 指定的文件不存在：{requested}"
            )
        return requested.resolve()

    candidates: list[Path] = []
    environment_browser = os.environ.get("QIDIANCRAWLER_BROWSER")
    if environment_browser:
        configured = Path(environment_browser).expanduser()
        if not configured.is_file():
            raise RuntimeError(
                "[BROWSER_ENV_INVALID] QIDIANCRAWLER_BROWSER 指向的文件不存在："
                f"{configured}"
            )
        return configured.resolve()
    for name in ("google-chrome", "google-chrome-stable", "chrome", "chromium", "msedge"):
        located = shutil.which(name)
        if located:
            candidates.append(Path(located))
    if sys.platform == "win32":
        local_app_data = os.environ.get("LOCALAPPDATA")
        if local_app_data:
            candidates.extend(
                [
                    Path(local_app_data) / "Google/Chrome/Application/chrome.exe",
                    Path(local_app_data) / "Microsoft/Edge/Application/msedge.exe",
                ]
            )
        candidates.extend(
            [
                Path(r"C:\Program Files\Google\Chrome\Application\chrome.exe"),
                Path(r"C:\Program Files (x86)\Google\Chrome\Application\chrome.exe"),
                Path(r"C:\Program Files\Microsoft\Edge\Application\msedge.exe"),
                Path(r"C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe"),
            ]
        )
    seen: set[Path] = set()
    for candidate in candidates:
        normalized = candidate.expanduser()
        if normalized in seen:
            continue
        seen.add(normalized)
        if normalized.is_file():
            return normalized.resolve()
    return None


def browser_version(browser: Path) -> str:
    """尽力读取实际执行的浏览器版本；失败时返回明确的未知说明。"""

    try:
        completed = subprocess.run(
            [str(browser), "--version"],
            capture_output=True,
            text=True,
            encoding="utf-8",
            errors="replace",
            timeout=10,
            check=False,
        )
    except (OSError, subprocess.TimeoutExpired):
        return "未知（浏览器未能返回 --version）"
    output = (completed.stdout or completed.stderr).strip().splitlines()
    if completed.returncode == 0 and output:
        return output[0][:200]
    return "未知（浏览器未返回版本文本）"


def _parse_browser_document(document: str) -> BrowserResultParser:
    parser = BrowserResultParser()
    parser.feed(document)
    parser.close()
    return parser


def _expected_browser_tests(runner: Path) -> int:
    try:
        source = runner.read_text(encoding="utf-8")
    except (OSError, UnicodeDecodeError) as error:
        raise RuntimeError(
            f"[BROWSER_TEST_METADATA] 无法读取浏览器测试页：{error}"
        ) from error
    metadata = _parse_browser_document(source)
    if metadata.expected_tests is None or metadata.expected_tests <= 0:
        raise RuntimeError(
            "[BROWSER_TEST_METADATA] tests/runner.html 必须声明正整数 "
            "data-expected-tests。"
        )
    return metadata.expected_tests


def run_browser_tests(
    root: Path,
    browser: str | Path | None = None,
    *,
    required: bool = True,
) -> BrowserTestResult | None:
    root = root.resolve()
    browser_path = find_browser(browser)
    if browser_path is None:
        if required:
            raise RuntimeError(
                "[BROWSER_MISSING] 找不到 Chrome/Edge。可通过 "
                "QIDIANCRAWLER_BROWSER 指定浏览器路径。"
            )
        return None
    runner = root / "tests" / "runner.html"
    if not runner.is_file():
        raise RuntimeError(f"[BROWSER_TEST_MISSING] 找不到浏览器测试页：{runner}")

    expected_tests = _expected_browser_tests(runner)

    def execute(extra_flags: list[str]) -> subprocess.CompletedProcess[str]:
        with tempfile.TemporaryDirectory(prefix="qidiancrawler-browser-") as profile:
            command = [
                str(browser_path),
                "--headless=new",
                "--disable-background-networking",
                "--disable-component-update",
                "--disable-default-apps",
                "--disable-gpu",
                "--no-default-browser-check",
                "--no-first-run",
                "--virtual-time-budget=5000",
                *extra_flags,
                f"--user-data-dir={profile}",
                "--dump-dom",
                runner.resolve().as_uri(),
            ]
            try:
                return subprocess.run(
                    command,
                    cwd=root,
                    capture_output=True,
                    text=True,
                    encoding="utf-8",
                    errors="replace",
                    timeout=45,
                    check=False,
                )
            except subprocess.TimeoutExpired as error:
                raise RuntimeError(
                    "[BROWSER_TEST_TIMEOUT] 浏览器测试 45 秒内没有结束。"
                ) from error

    completed = execute([])
    compatibility_mode = False
    standard_error = completed.stderr
    gpu_startup_failed = (
        completed.returncode != 0
        and (
            "GPU process isn't usable" in completed.stderr
            or completed.returncode == -1073741790
        )
    )
    if gpu_startup_failed:
        compatibility_mode = True
        completed = execute(
            [
                "--no-sandbox",
                "--disable-gpu-sandbox",
                "--disable-software-rasterizer",
                "--disable-features=Vulkan,Dawn,SkiaGraphite",
            ]
        )
    output = completed.stdout
    browser_document = _parse_browser_document(output)
    summary_match = re.fullmatch(
        r"\s*(\d+)\s+通过，\s*(\d+)\s+失败\s*", browser_document.summary
    )
    passed = int(summary_match.group(1)) if summary_match else -1
    failed = int(summary_match.group(2)) if summary_match else -1
    complete = (
        completed.returncode == 0
        and browser_document.status == "passed"
        and browser_document.expected_tests == expected_tests
        and summary_match is not None
        and expected_tests > 0
        and passed == expected_tests
        and failed == 0
    )
    if not complete:
        summary = browser_document.summary or "浏览器测试未返回结构化摘要。"
        stderr_tail = completed.stderr[-1500:].strip()
        if compatibility_mode and standard_error:
            stderr_tail = (
                "标准无头模式发生 GPU 沙箱启动失败；兼容重试仍未通过。\n"
                + stderr_tail
            ).strip()
        raise RuntimeError(
            f"[BROWSER_TEST_FAILED] {summary}；"
            f"预期 {expected_tests} 项，实际通过 {passed}、失败 {failed}。"
            + (f"\n浏览器输出：{stderr_tail}" if stderr_tail else "")
        )
    return BrowserTestResult(
        browser=browser_path,
        browser_version=browser_version(browser_path),
        summary=browser_document.summary,
        test_count=expected_tests,
        compatibility_mode=compatibility_mode,
    )


def run_python_tests(root: Path) -> None:
    completed = subprocess.run(
        [
            sys.executable,
            "-m",
            "unittest",
            "discover",
            "-s",
            "tests",
            "-p",
            "test_*.py",
            "-v",
        ],
        cwd=root.resolve(),
        check=False,
    )
    if completed.returncode != 0:
        raise RuntimeError("[PYTHON_TEST_FAILED] Python 配套测试未通过。")


def _safe_dist_root(root: Path, dist_root: Path | None) -> Path:
    root = root.resolve()
    requested = dist_root or (root / "dist")
    requested_absolute = requested.absolute()
    if requested_absolute.is_symlink():
        raise RuntimeError("[DIST_SYMLINK] 打包目录不能是符号链接或目录联接。")
    resolved = requested_absolute.resolve()
    try:
        resolved.relative_to(root)
    except ValueError as error:
        raise RuntimeError("[DIST_ESCAPE] 打包目录必须位于项目目录内。") from error
    if resolved == root:
        raise RuntimeError("[DIST_ROOT] 打包目录不能是项目根目录。")
    protected = [
        (root / EXTENSION_DIRECTORY).resolve(),
        (root / "tools").resolve(),
        (root / "tests").resolve(),
    ]
    for directory in protected:
        overlaps = (
            resolved == directory
            or resolved in directory.parents
            or directory in resolved.parents
        )
        if overlaps:
            raise RuntimeError(
                "[DIST_OVERLAP] 打包目录不能与扩展源码、工具或测试目录相交："
                f"{resolved}"
            )
    return resolved


def _write_reproducible_zip(source_root: Path, files: list[Path], destination: Path) -> None:
    temporary = destination.with_suffix(destination.suffix + ".tmp")
    if temporary.exists():
        temporary.unlink()
    with zipfile.ZipFile(
        temporary,
        "w",
        compression=zipfile.ZIP_STORED,
    ) as archive:
        for path in files:
            relative = path.relative_to(source_root).as_posix()
            info = zipfile.ZipInfo(relative, FIXED_ZIP_DATETIME)
            info.create_system = 3
            info.create_version = 20
            info.extract_version = 10
            info.compress_type = zipfile.ZIP_STORED
            info.flag_bits = 0
            info.internal_attr = 0
            info.external_attr = 0o100644 << 16
            archive.writestr(info, path.read_bytes())
    temporary.replace(destination)


def _verify_archive(archive_path: Path, source_root: Path, files: list[Path]) -> tuple[str, ...]:
    expected = tuple(sorted(path.relative_to(source_root).as_posix() for path in files))
    with zipfile.ZipFile(archive_path, "r") as archive:
        names = tuple(sorted(archive.namelist()))
        if len({name.casefold() for name in names}) != len(names):
            raise RuntimeError("[ZIP_CASE_COLLISION] ZIP 中存在大小写不敏感重名文件。")
        if names != expected:
            raise RuntimeError("[ZIP_CONTENTS] ZIP 文件清单与扩展源码不一致。")
        if "manifest.json" not in names:
            raise RuntimeError("[ZIP_MANIFEST] ZIP 根目录缺少 manifest.json。")
        if archive.testzip() is not None:
            raise RuntimeError("[ZIP_CRC] ZIP CRC 校验失败。")
        for name in names:
            path = Path(name)
            if path.is_absolute() or ".." in path.parts or "\\" in name:
                raise RuntimeError(f"[ZIP_PATH] ZIP 包含不安全路径：{name}")
            if archive.read(name) != (source_root / path).read_bytes():
                raise RuntimeError(f"[ZIP_BYTES] ZIP 文件内容与源码不一致：{name}")
            info = archive.getinfo(name)
            if info.date_time != FIXED_ZIP_DATETIME:
                raise RuntimeError(f"[ZIP_TIMESTAMP] ZIP 时间戳不固定：{name}")
            if info.compress_type != zipfile.ZIP_STORED:
                raise RuntimeError(f"[ZIP_COMPRESSION] ZIP 文件不是 STORE 模式：{name}")
            if info.create_system != 3 or info.external_attr != 0o100644 << 16:
                raise RuntimeError(f"[ZIP_MODE] ZIP 文件权限元数据不固定：{name}")
    return expected


def build_package(root: Path, dist_root: Path | None = None) -> PackageResult:
    root = root.resolve()
    report = validate_project(root)
    source_root = root / EXTENSION_DIRECTORY
    files = extension_files(root)
    destination_root = _safe_dist_root(root, dist_root)
    destination_root.mkdir(parents=True, exist_ok=True)
    base_name = f"{PROJECT_NAME}-v{report.version}"
    staging = destination_root / base_name
    archive_path = destination_root / f"{base_name}.zip"

    if staging.exists() or staging.is_symlink():
        staging_absolute = staging.absolute()
        staging_resolved = staging.resolve()
        if staging.is_symlink() or staging_resolved != staging_absolute:
            raise RuntimeError(
                f"[STAGING_SYMLINK] 拒绝删除符号链接或目录联接：{staging}"
            )
        if staging_resolved.parent != destination_root:
            raise RuntimeError(f"[STAGING_ESCAPE] 解压目录不在打包目录直属位置：{staging}")
        if not staging.is_dir():
            raise RuntimeError(f"[STAGING_NOT_DIRECTORY] 解压路径不是目录：{staging}")
        shutil.rmtree(staging)
    staging.mkdir(parents=True)
    for path in files:
        relative = path.relative_to(source_root)
        target = staging / relative
        target.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(path, target)

    _write_reproducible_zip(source_root, files, archive_path)
    packaged_files = _verify_archive(archive_path, source_root, files)
    digest = hashlib.sha256(archive_path.read_bytes()).hexdigest()
    return PackageResult(
        version=report.version,
        staging_directory=staging,
        archive=archive_path,
        sha256=digest,
        files=packaged_files,
    )
