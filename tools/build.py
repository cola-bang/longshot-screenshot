"""打包 LongShot 扩展：生成 Chromium / Firefox 两个 zip。

用法： python tools/build.py
产出： dist/LongShot-v{ver}-chromium.zip
      dist/LongShot-v{ver}-firefox.zip

Chromium 包结构（解压即用）：
    LongShot-v{ver}-chromium/
        安装-Windows.cmd      <- 双击运行
        使用说明.md
        docs/install-guide.png
        longshot/             <- 扩展本体（加载这个文件夹）
"""
import json
import os
import shutil
import zipfile

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SRC = os.path.join(ROOT, "longshot")
DIST = os.path.join(ROOT, "dist")
BUILD = os.path.join(ROOT, "build")
INSTALLER = os.path.join(ROOT, "安装-Windows.cmd")
README = os.path.join(ROOT, "README.md")
DOCS = os.path.join(ROOT, "docs")

VERSION = json.load(open(os.path.join(SRC, "manifest.json"), encoding="utf-8"))["version"]
SKIP_FILES = {"README.md"}
SKIP_EXT = {".b64"}


def copy_tree(dst):
    if os.path.isdir(dst):
        shutil.rmtree(dst)
    os.makedirs(dst)
    ext = os.path.join(dst, "longshot")
    os.makedirs(ext)
    ignore = shutil.ignore_patterns(*[f"*{e}" for e in SKIP_EXT])
    for name in os.listdir(SRC):
        if name in SKIP_FILES or os.path.splitext(name)[1] in SKIP_EXT:
            continue
        src = os.path.join(SRC, name)
        target = os.path.join(ext, name)
        if os.path.isdir(src):
            shutil.copytree(src, target, ignore=ignore)
        else:
            shutil.copy2(src, target)
    shutil.copy2(README, os.path.join(dst, "使用说明.md"))
    return ext


def firefox_manifest(chromium):
    mf = dict(chromium)
    mf.pop("minimum_chrome_version", None)
    mf["background"] = {"scripts": ["background.js"]}
    mf["browser_specific_settings"] = {
        "gecko": {"id": "longshot@local", "strict_min_version": "115.0"}
    }
    return mf


def zip_dir(src, zip_path, prefix):
    if os.path.exists(zip_path):
        os.remove(zip_path)
    with zipfile.ZipFile(zip_path, "w", zipfile.ZIP_DEFLATED) as zf:
        for base, _dirs, files in os.walk(src):
            for name in files:
                full = os.path.join(base, name)
                rel = os.path.relpath(full, src)
                zf.write(full, os.path.join(prefix, rel))
    return os.path.getsize(zip_path)


def main():
    os.makedirs(DIST, exist_ok=True)
    chromium_manifest = json.load(open(os.path.join(SRC, "manifest.json"), encoding="utf-8"))

    # ---------- Chromium ----------
    name = f"LongShot-v{VERSION}-chromium"
    dst = os.path.join(BUILD, name)
    copy_tree(dst)
    if os.path.exists(INSTALLER):
        shutil.copy2(INSTALLER, os.path.join(dst, "安装-Windows.cmd"))
    if os.path.isdir(DOCS):
        shutil.copytree(
            DOCS,
            os.path.join(dst, "docs"),
            dirs_exist_ok=True,
            ignore=shutil.ignore_patterns("*.b64"),
        )
    zip1 = os.path.join(DIST, f"{name}.zip")
    size1 = zip_dir(dst, zip1, name)

    # ---------- Firefox ----------
    name = f"LongShot-v{VERSION}-firefox"
    dst = os.path.join(BUILD, name)
    ext = copy_tree(dst)
    with open(os.path.join(ext, "manifest.json"), "w", encoding="utf-8") as f:
        json.dump(firefox_manifest(chromium_manifest), f, ensure_ascii=False, indent=2)
    zip2 = os.path.join(DIST, f"{name}.zip")
    size2 = zip_dir(dst, zip2, name)

    print(f"chromium: {size1 / 1024:.1f} KB  ->  {zip1}")
    print(f"firefox : {size2 / 1024:.1f} KB  ->  {zip2}")


if __name__ == "__main__":
    main()
