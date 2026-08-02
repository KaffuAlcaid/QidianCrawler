"""校验并打包 QidianCrawler Chrome/Edge 扩展。"""

from __future__ import annotations

import argparse
import sys

from project import (
    ProjectValidationError,
    build_package,
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
        help="跳过真实浏览器测试；正式发布不建议使用。",
    )
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    root = project_root_from_tools()
    try:
        report = validate_project(root)
        print(f"[通过] 静态校验：QidianCrawler v{report.version}")
        run_python_tests(root)
        print("[通过] Python 配套测试")
        if args.skip_browser_tests:
            print("[警告] 已明确跳过浏览器测试；该产物不是完整验收结果。")
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
        result = build_package(root)
        print(f"[完成] 解压目录：{result.staging_directory}")
        print(f"[完成] ZIP：{result.archive}")
        print(f"[完成] SHA-256：{result.sha256}")
        print(f"[完成] 归档文件：{len(result.files)} 个")
        return 0
    except (ProjectValidationError, RuntimeError, OSError) as error:
        print(str(error), file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())

