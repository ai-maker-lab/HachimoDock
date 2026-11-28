# Mirui renderer for PetUI

The native archive links Mirui's Sprite Stack rasterizer, height field,
textured walls, billboards and procedural space background into the WAMR host.
The guest ABI, camera, quotas, use in C and C++, asset format and package
capabilities are defined in the [PetUI 3D reference](../../../pc/skills/petui/references/mirui-3d.md).

## Build

PlatformIO firmware builds and desktop authoring runtime staging enable Mirui
by default. Both build and cache an archive from the pinned Mirui commit
`3329cbcad1592a3da4d29419414f2da1736dda58` and locked Rust dependencies.
Install Python 3.12 or later and Rust through rustup before building:

```sh
rustup toolchain install 1.97.0 --profile minimal
rustup target add --toolchain 1.97.0 riscv32imafc-unknown-none-elf
```

The RISC-V target is required for firmware. For a desktop cross-build, install
the Rust target matching the checker. The build fetches the pinned commit on
a cache miss. To use a local Git checkout containing that commit, set
`PETUI_MIRUI_SOURCE`. Set `PETUI_MIRUI_CACHE` to share a cache across builds,
or `PETUI_PYTHON` to select the Python executable for desktop staging.

For an explicit build of either archive and the host model exporter:

```sh
python3 firmware/native/sprite-stack/build.py /path/to/mirui /tmp/mirui-p4 \
  --archive-tool /path/to/riscv32-esp-elf-ar
python3 firmware/native/sprite-stack/build.py /path/to/mirui /tmp/mirui-host --host
```

The builder reads the pinned commit through `git archive`. It produces
`libpet_mirui_stack.a` and `MIRUI-LICENSE.txt`. The host build also produces
`mirui-pack-stack`. Build directories should start empty. Use `--offline`
when the Rust dependencies are cached.

Use `PET_P4_MIRUI_STACK_ARCHIVE` or `PETUI_MIRUI_STACK_HOST_ARCHIVE` to
override the corresponding archive. Set `PET_P4_MIRUI_STACK=0` for a firmware
build with only the ordinary PetUI renderer, or `PETUI_MIRUI_STACK=0` for
its desktop checker. The enabled firmware reports the renderer capabilities
in USB hello.

Build the WAMR checker with the desktop archive and the same WAMR source as
the target firmware.

```sh
WAMR_ROOT=/path/to/wasm-micro-runtime \
PET_P4_MIRUI_STACK_ARCHIVE=/tmp/mirui-host/libpet_mirui_stack.a \
  cmake -S firmware/tools/wasm-host-check -B /tmp/petui-mirui-checker
cmake --build /tmp/petui-mirui-checker --config Release
```

## Verify

The [Sprite Stack example](../../../pc/petui-projects/sprite-stack-demo/)
converts the pinned checkout's original jet artwork, checks two independent poses
and captures a cover using the native checker. Pass the Mirui checkout, host
exporter, host checker, PetUI compiler bin directory and a new output directory
to its `build.py`; append `--package` for the validated example package.

`hachi_runtime.c` checks wire offsets and constructs native render requests.
`port.rs` decodes SSK1 and projects stacks, `solid.rs` rasterizes opted-in solid
voxels, `terrain.rs` manages shared terrain and world buffers, and `scene.rs`
renders scene-specific geometry and decoration.
A WASM worker submits its finished image to the LCD compositor. On dual-core P4
targets with this archive, the worker runs on the core opposite the main
compositor. The render call itself is synchronous.
