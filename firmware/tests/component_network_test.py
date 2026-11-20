from pathlib import Path
import subprocess

def test_component_network_core(tmp_path):
    root = Path(__file__).resolve().parents[1]
    exe = tmp_path / "component-network"
    subprocess.run(["cc", "-std=c11", "-Wall", "-Wextra", "-Werror",
        "-Wno-misleading-indentation", "-Wno-deprecated-declarations", "-fsanitize=address,undefined", "-g",
        "-I" + str(root / "main"), "-I" + str(root / "tests/vendor/cjson"),
        str(root / "tests/component_network_test.c"),
        str(root / "main/pet_component_network.c"),
        str(root / "tests/vendor/cjson/cJSON.c"), "-pthread", "-o", str(exe)], check=True)
    subprocess.run([str(exe), str(root / "tests/component_network_policies.json")], check=True, timeout=15)

def test_component_network_device_backend(tmp_path):
    root = Path(__file__).resolve().parents[1]
    exe = tmp_path / "component-network-device"
    subprocess.run(["cc", "-std=c11", "-D_POSIX_C_SOURCE=200112L", "-Wall", "-Wextra", "-Werror",
        "-Wno-misleading-indentation", "-Wno-deprecated-declarations", "-Wno-sign-compare", "-fsanitize=address,undefined", "-g",
        "-I" + str(root / "main"), "-I" + str(root / "tests/vendor/cjson"),
        "-I" + str(root / "tests/component_network_stubs"),
        str(root / "tests/component_network_device_test.c"),
        str(root / "main/pet_component_network.c"),
        str(root / "tests/vendor/cjson/cJSON.c"), "-pthread", "-o", str(exe)], check=True)
    subprocess.run([str(exe)], check=True, timeout=15)
