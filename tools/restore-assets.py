"""从 *.b64 还原二进制资源（图标、截图、安装脚本）。

仓库里只放文本文件，二进制以同名 .b64 保存。克隆后执行：

    python tools/restore-assets.py
"""
import base64
import os
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SKIP_DIRS = {"node_modules", "build", "dist", "out", "__pycache__"}


def main():
    count = 0
    for dirpath, dirs, files in os.walk(ROOT):
        dirs[:] = [d for d in dirs if d not in SKIP_DIRS and not d.startswith(".")]
        for name in sorted(files):
            if not name.endswith(".b64"):
                continue
            src = os.path.join(dirpath, name)
            dst = src[: -len(".b64")]
            with open(src, "rb") as f:
                raw = base64.b64decode(f.read())
            with open(dst, "wb") as f:
                f.write(raw)
            print("restore", os.path.relpath(dst, ROOT), len(raw), "bytes")
            count += 1
    if not count:
        print("没有找到 .b64 资源；如果你是从 zip 安装的，资源已经齐全。")
    else:
        print(f"完成，共还原 {count} 个文件。")
    return 0


if __name__ == "__main__":
    sys.exit(main())
