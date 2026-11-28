#!/usr/bin/env python3
"""Build the Sprite Stack example against the native Mirui checker."""

import argparse
import json
from pathlib import Path
import shutil
import subprocess
import sys

from PIL import Image

source = Path(__file__).resolve().parent
petui = source.parents[1] / "skills/petui"
sys.path.insert(0, str(petui / "scripts"))
from compile_wasm import compile_wasm
from pack_hachiapp import package_directory, write_package


def cover(checker, module, destination):
    output = subprocess.check_output(
        [checker, module, "--serve"], input="clock 0 0\nframe 33\n",
        text=True, timeout=10,
    )
    frame = next(item for line in output.splitlines() if (item := json.loads(line))["frame"])
    rgb = bytearray()
    runs = iter(frame["runs"])
    for count, pixel in zip(runs, runs):
        r, g, b = pixel >> 11, (pixel >> 5) & 63, pixel & 31
        rgb.extend(bytes(((r << 3) | (r >> 2), (g << 2) | (g >> 4), (b << 3) | (b >> 2))) * count)
    Image.frombytes("RGB", (frame["width"], frame["height"]), bytes(rgb)).save(destination)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("mirui", type=Path, help="Pinned Mirui checkout")
    parser.add_argument("exporter", type=Path, help="mirui-pack-stack from the host build")
    parser.add_argument("checker", type=Path, help="petui-wasm-check built with Mirui Sprite Stack")
    parser.add_argument("cc_tools", type=Path, help="PetUI bin directory with clang and wasm-ld")
    parser.add_argument("out", type=Path, help="New output directory")
    parser.add_argument("--package", action="store_true", help="Validate and package with a Sprite Stack-enabled Pet Manager")
    args = parser.parse_args()
    args.out.mkdir(parents=True)
    model = args.out / "jet.ssk"
    subprocess.run([args.exporter, args.mirui / "gallery/pixel-flight/assets/jet.mirx", model, "1280"], check=True)
    (args.out / "jet_ssk.h").write_text(
        "static const unsigned char jet_ssk[] = {\n" + ",".join(map(str, model.read_bytes())) + "\n};\n"
    )
    code, module = args.out / "demo.c", args.out / "app.wasm"
    shutil.copyfile(source / "demo.c", code)
    compile_wasm(code, petui / "sdk", args.cc_tools / "clang", args.cc_tools / "wasm-ld", module)
    subprocess.run([args.checker, module, source / "game.trace"], check=True)
    preview = args.out / "cover.png"
    cover(args.checker, module, preview)
    if args.package:
        package = args.out / "package"
        shutil.copytree(source / "package", package)
        (package / "pc").mkdir()
        shutil.copyfile(preview, package / "pc/cover.png")
        shutil.copyfile(args.exporter.resolve().with_name("MIRUI-LICENSE.txt"), package / "LICENSE.txt")
        files, wasm = package_directory(package, module.read_bytes())
        write_package(args.out / "Mirui-Sprite-Stack.hachiapp", files, wasm)


if __name__ == "__main__":
    main()
