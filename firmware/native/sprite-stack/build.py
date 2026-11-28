#!/usr/bin/env python3
"""Build the pinned Mirui sprite-stack archive for ESP32-P4 or the desktop checker."""

import argparse
import hashlib
import os
from pathlib import Path
from platform import machine
import shutil
import subprocess
import tarfile
import tempfile


UPSTREAM = "https://github.com/W-Mai/mirui.git"
REVISION = "3329cbcad1592a3da4d29419414f2da1736dda58"
TARGET = "riscv32imafc-unknown-none-elf"
NATIVE = Path(__file__).resolve().parent
SOURCES = ("port.rs", "terrain.rs", "scene.rs", "solid.rs")


def use_esp_gcc_builtins(archive, archive_tool):
    # Use ESP-IDF's hard-float libgcc implementations of these integer routines.
    members = subprocess.check_output([archive_tool, "t", archive], text=True).splitlines()
    helpers = [name for name in members if name.endswith(("-bswapsi2.o", "-popcountsi2.o"))]
    if helpers:
        subprocess.run([archive_tool, "d", archive, *helpers], check=True)


def build(work, checkout, args, archive_name):
    source = work / "source"
    source.mkdir(parents=True)
    if checkout is None:
        if args.offline:
            raise SystemExit("Set PETUI_MIRUI_SOURCE to a checkout containing the pinned Mirui revision")
        checkout = work / "upstream.git"
        subprocess.run(["git", "init", "--quiet", "--bare", checkout], check=True)
        subprocess.run(["git", "-C", checkout, "fetch", "--quiet", "--depth=1", "--no-tags",
                        UPSTREAM, REVISION], check=True)
    with subprocess.Popen(
        ["git", "-C", checkout, "archive", REVISION], stdout=subprocess.PIPE
    ) as archive:
        with tarfile.open(fileobj=archive.stdout, mode="r|*") as files:
            files.extractall(source, filter="data")
        if archive.wait():
            raise SystemExit(f"Could not archive Mirui commit {REVISION}")

    bridge = work / "bridge"
    (bridge / "src").mkdir(parents=True)
    shutil.copyfile(NATIVE / "port.rs", bridge / "src/lib.rs")
    shutil.copyfile(NATIVE / ("Cargo.lock" if args.host else "Cargo.p4.lock"), bridge / "Cargo.lock")
    for module in ("terrain.rs", "scene.rs", "solid.rs"):
        shutil.copyfile(NATIVE / module, bridge / "src" / module)
    if args.host:
        (bridge / "src/bin").mkdir()
        shutil.copyfile(NATIVE / "pack.rs", bridge / "src/bin/mirui-pack-stack.rs")
    features = '["std"]' if args.host else "[]"
    (bridge / "Cargo.toml").write_text(f"""[package]
name = "pet-mirui-stack"
version = "0.1.0"
edition = "2024"

[lib]
crate-type = ["staticlib"]

[dependencies]
critical-section = "1.2"
mirui = {{ path = "../source", default-features = false, features = {features} }}
mirui-sprite-stack = {{ path = "../source/extensions/sprite-stack" }}

[profile.release]
opt-level = 2
lto = true
codegen-units = 1
panic = "abort"
""")
    command = ["cargo", "+1.97.0", "build", "--release", "--locked"]
    output = bridge / "target"
    target = args.host_target if args.host else TARGET
    if target:
        command += ["--target", target]
        output /= target
    if args.host and args.host_target and args.host_target.endswith("-msvc"):
        # The bundled WAMR checker links the static MSVC runtime.
        command = ["cargo", "+1.97.0", "--config", f'target.{target}.rustflags=["-Ctarget-feature=+crt-static"]',
                   *command[2:]]
    if args.host_target == "x86_64-pc-windows-gnu" and os.name != "nt":
        command = ["cargo", "+1.97.0", "--config", 'target.x86_64-pc-windows-gnu.linker="x86_64-w64-mingw32-gcc"',
                   *command[2:]]
    if args.offline:
        command += ["--offline"]
    subprocess.run(command, cwd=bridge, check=True, env={**os.environ, "CARGO_TARGET_DIR": str(bridge / "target")})
    archive = work / archive_name
    shutil.copyfile(output / "release" / archive_name, archive)
    if args.host:
        suffix = ".exe" if "-windows-" in (args.host_target or "") or os.name == "nt" else ""
        pack = output / "release" / f"mirui-pack-stack{suffix}"
        shutil.copy2(pack, work)
    else:
        use_esp_gcc_builtins(archive, args.archive_tool)
    shutil.copyfile(source / "LICENSE", work / "MIRUI-LICENSE.txt")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("source", nargs="?", type=Path, help="Mirui Git checkout")
    parser.add_argument("build_dir", nargs="?", type=Path, help="New staging directory")
    parser.add_argument("--ensure", type=Path, metavar="CACHE", help="Reuse or build the pinned archive in CACHE")
    parser.add_argument("--host", action="store_true")
    parser.add_argument("--host-target")
    parser.add_argument("--offline", action="store_true")
    parser.add_argument("--archive-tool", default="riscv32-esp-elf-ar")
    args = parser.parse_args()
    if args.host_target and not args.host:
        parser.error("--host-target requires --host")
    msvc = args.host and (args.host_target or ("msvc" if os.name == "nt" else "")).endswith("msvc")
    name = "pet_mirui_stack.lib" if msvc else "libpet_mirui_stack.a"
    if args.ensure is None:
        if args.source is None or args.build_dir is None:
            parser.error("provide a source and build directory, or use --ensure")
        work = args.build_dir.resolve()
        build(work, args.source.resolve(), args, name)
        print(work / name)
        return
    if args.source or args.build_dir:
        parser.error("use PETUI_MIRUI_SOURCE with --ensure")
    checkout = os.environ.get("PETUI_MIRUI_SOURCE")
    cache = args.ensure.resolve()
    digest = hashlib.sha256()
    inputs = (*SOURCES, "pack.rs", "Cargo.lock") if args.host else (*SOURCES, "Cargo.p4.lock")
    for path in (Path(__file__), *(NATIVE / source for source in inputs)):
        digest.update(path.read_bytes())
    platform = (args.host_target or f"host-{os.name}-{machine()}") if args.host else TARGET
    digest.update(platform.encode())
    work = cache / f"{platform}-{digest.hexdigest()[:20]}"
    if not (work / name).is_file():
        cache.mkdir(parents=True, exist_ok=True)
        with tempfile.TemporaryDirectory(prefix=".mirui-", dir=cache) as scratch:
            stage = Path(scratch) / "build"
            build(stage, Path(checkout).resolve() if checkout else None, args, name)
            result = Path(scratch) / "result"
            result.mkdir()
            for path in stage.iterdir():
                if path.is_file():
                    path.rename(result / path.name)
            try:
                result.rename(work)
            except OSError:
                if not (work / name).is_file():
                    raise
    print(work / name)


if __name__ == "__main__":
    main()
