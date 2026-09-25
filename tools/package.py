"""静态校验并打包 QidianCrawler Chrome/Edge 扩展。"""

from __future__ import annotations

import sys

from project import (
    ProjectValidationError,
    build_package,
    project_root_from_tools,
    validate_project,
)


def main() -> int:
    root = project_root_from_tools()
    try:
        report = validate_project(root)
        print(f"[通过] 静态校验：QidianCrawler v{report.version}")
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
