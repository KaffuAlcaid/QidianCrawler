"""运行 QidianCrawler 的静态校验。"""

from __future__ import annotations

import sys

from project import (
    ProjectValidationError,
    project_root_from_tools,
    validate_project,
)


def main() -> int:
    root = project_root_from_tools()
    try:
        report = validate_project(root)
        print(f"[通过] 扩展静态校验：QidianCrawler v{report.version}")
        print(f"[通过] 权限白名单：{', '.join(report.permissions)}")
        print(f"[通过] 扩展运行文件：{len(report.files)} 个")
        return 0
    except (ProjectValidationError, RuntimeError) as error:
        print(str(error), file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
