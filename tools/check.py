"""运行 QidianCrawler 的静态、Python 与真实浏览器测试。"""

from __future__ import annotations

import argparse
import sys
from pathlib import Path

from project import (
    ProjectValidationError,
    project_root_from_tools,
    run_browser_tests,
    run_python_tests,
    validate_project,
)


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--browser", help="Chrome 或 Edge 可执行文件路径。")
    parser.add_argument(
        "--skip-browser-tests",
        action="store_true",
        help="只在明确无法使用浏览器时跳过，并会打印未覆盖提示。",
    )
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    root = project_root_from_tools()
    try:
        report = validate_project(root)
        print(f"[通过] 扩展静态校验：QidianCrawler v{report.version}")
        print(f"[通过] 权限白名单：{', '.join(report.permissions)}")
        print(f"[通过] 扩展运行文件：{len(report.files)} 个")
        run_python_tests(root)
        print("[通过] Python 配套测试")
        if args.skip_browser_tests:
            print("[跳过] 浏览器 JavaScript/DOM 测试未运行，不能视为完整验证。")
        else:
            browser_result = run_browser_tests(root, args.browser, required=True)
            assert browser_result is not None
            print(f"[通过] 浏览器测试：{browser_result.summary}")
            print(f"[信息] 测试浏览器：{browser_result.browser}")
            print(f"[信息] 浏览器版本：{browser_result.browser_version}")
            if browser_result.compatibility_mode:
                print(
                    "[提示] 当前环境的 GPU 沙箱无法启动，测试器仅对本地测试页使用了受控兼容参数。"
                )
        return 0
    except (ProjectValidationError, RuntimeError) as error:
        print(str(error), file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
