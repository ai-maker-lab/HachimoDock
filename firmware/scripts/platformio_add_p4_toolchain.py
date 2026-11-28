"""Expose the P4 toolchain, target firmware contract, and portable project root."""

Import("env")

import os
import re
import atexit
from pathlib import Path
import subprocess
import sys

project_dir = env.subst("$PROJECT_DIR")
# Keep exact per-environment SDK compilation contexts available to host checks.
env.Replace(COMPILATIONDB_INCLUDE_TOOLCHAIN=False,
            COMPILATIONDB_PATH=os.path.join(env.subst("$BUILD_DIR"), "platformio_compile_commands.json"))
env["ENV"]["PET_P4_PROJECT_DIR"] = project_dir
env["ENV"]["PET_P4_SYSTEM_WIFI"] = env.GetProjectOption("custom_p4_system_wifi", "0")
if env["ENV"]["PET_P4_SYSTEM_WIFI"] == "1":
    # SCons can reuse a CMake database without reconfiguration. Regenerate even
    # with an unset input so a public incremental build drops candidate trust.
    config_input = os.environ.get("PETUI_COMMUNITY_CONFIG_INPUT", "")
    env["ENV"]["PETUI_COMMUNITY_CONFIG_INPUT"] = config_input
    subprocess.run([sys.executable, os.path.join(project_dir, "tools/community_build_config.py"),
                    os.path.join(env.subst("$BUILD_DIR"), "config/petui_community_public.generated.h")], check=True)
env["ENV"]["PET_P4_CHIP_FAMILY"] = env.GetProjectOption("custom_p4_chip_family", "v1")
env["ENV"]["PET_P4_LCD_PANEL_AUTO"] = env.GetProjectOption("custom_p4_lcd_panel_auto", "0")
env["ENV"]["PET_P4_PROJECT_VER_OVERRIDE"] = env.GetProjectOption(
    "custom_p4_project_version", "0.7.57-p4"
)
env["ENV"]["PET_P4_UART_BAUD_OVERRIDE"] = env.GetProjectOption(
    "custom_p4_uart_baud", "4000000"
)

toolchain_dir = env.PioPlatform().get_package_dir("toolchain-riscv32-esp")
mirui_stack_archive = ""
if os.environ.get("PET_P4_MIRUI_STACK", env.GetProjectOption("custom_p4_mirui_stack", "1")) == "1":
    mirui_stack_archive = os.environ.get("PET_P4_MIRUI_STACK_ARCHIVE", "")
    if not mirui_stack_archive:
        suffix = ".exe" if os.name == "nt" else ""
        archive_tool = f"riscv32-esp-elf-ar{suffix}"
        if toolchain_dir:
            archive_tool = os.path.join(toolchain_dir, "bin", archive_tool)
        cache = os.environ.get("PETUI_MIRUI_CACHE") or os.path.join(env.subst("$PROJECT_BUILD_DIR"), "mirui-stack")
        mirui_stack_archive = subprocess.check_output(
            [sys.executable, os.path.join(project_dir, "native/sprite-stack/build.py"),
             "--ensure", cache, "--archive-tool", archive_tool], text=True, cwd=project_dir,
        ).strip()
if mirui_stack_archive:
    if not os.path.isabs(mirui_stack_archive) or not os.path.isfile(mirui_stack_archive):
        raise RuntimeError("PET_P4_MIRUI_STACK_ARCHIVE must point to the built RISC-V archive")
    # PlatformIO builds its own objects independently of CMake's Ninja graph.
    env.AppendUnique(CPPDEFINES=[("HACHI_STACK_ENABLED", 1)])

# The ESP-IDF builder starts CMake from os.environ and reuses its existing
# code model until a build input changes. Invalidate it when the archive changes.
os.environ["PET_P4_MIRUI_STACK_ARCHIVE"] = mirui_stack_archive
env["ENV"]["PET_P4_MIRUI_STACK_ARCHIVE"] = mirui_stack_archive
config_dir = Path(env.subst("$BUILD_DIR")) / "config"
config_dir.mkdir(parents=True, exist_ok=True)
stack_stamp = config_dir / "mirui-stack-archive"
if not stack_stamp.is_file() or stack_stamp.read_text(encoding="utf-8") != mirui_stack_archive:
    stack_stamp.write_text(mirui_stack_archive, encoding="utf-8")
    os.utime(config_dir, None)

# Use a linker that can resolve the vendor hardware-loop relocations in the
# pre-v3 H.264 archives. Keep the v1 SDK and compiler for all compilation.
if env["PIOENV"] == "esp32_p4_wifi6_system_settings_v1":
    linker_dir = os.environ.get("PET_P4_PRE_V3_LINKER_DIR", "")
    if not os.path.isabs(linker_dir) or not os.access(os.path.join(linker_dir, "ld"), os.X_OK):
        raise RuntimeError("Set PET_P4_PRE_V3_LINKER_DIR to the compatible linker directory")
    env.Append(LINKFLAGS=[f"-B{linker_dir}/"])


def normalize_component_lock(source, target, env):
    """Restore only this project's local component source paths, not versions."""
    family = env.GetProjectOption("custom_p4_chip_family", "v1")
    if env.GetProjectOption("custom_p4_system_wifi", "0") == "1":
        lock_name = f"dependencies.wifi-{family}.lock"
    else:
        lock_name = "dependencies.v3.lock" if family == "v3" else "dependencies.lock"
    lock_path = os.path.join(project_dir, lock_name)
    if not os.path.isfile(lock_path):
        return
    with open(lock_path, "r", encoding="utf-8") as lock_file:
        current = lock_file.read()
    portable_root = "$PET_P4_PROJECT_DIR"
    prefix=project_dir.replace("\\","/").rstrip("/")+"/components/"
    def portable_path(match):
        value=match.group(2).strip()
        if len(value)>1 and value[0]==value[-1] and value[0] in ("'",'"'):
            value=value[1:-1]
        value=value.replace("\\","/")
        if not value.startswith(prefix):return match.group(0)
        component=value[len(prefix):]
        if not component or component in (".","..") or "/" in component or not os.path.isdir(os.path.join(project_dir,"components",component)):
            raise RuntimeError("Unexpected project-local component dependency path")
        return match.group(1)+portable_root+"/components/"+component
    normalized=re.sub(r"(?m)^([ \t]+path:[ \t]+)([^\r\n]+)$",portable_path,current)
    if normalized != current:
        with open(lock_path, "w", encoding="utf-8", newline="\n") as lock_file:
            lock_file.write(normalized)


env.AddPostAction("$BUILD_DIR/${PROGNAME}.bin", normalize_component_lock)
# ESP-IDF also rewrites the lock when an incremental build decides the binary
# is already up to date; its .bin post-action is then skipped. Restore generated
# local paths at graceful SCons exit as well. Idempotent, and versions/hashes stay
# unchanged. Interrupted/abrupt exits still require the normal source hash gate.
atexit.register(normalize_component_lock,None,None,env)

if toolchain_dir:
    candidates = [
        os.path.join(toolchain_dir, "bin"),
        os.path.join(toolchain_dir, "riscv32-esp-elf", "bin"),
    ]
    for candidate in candidates:
        if os.path.isdir(candidate):
            env.PrependENVPath("PATH", candidate)
            break
