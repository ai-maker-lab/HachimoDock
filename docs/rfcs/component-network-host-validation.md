# Local validation: generic component network candidate

Base: upstream main `139c99302aed65fc6804d31af9a56cfcbc58d184` (R292).
Feature target: `esp32_p4_component_network_candidate_v3`, default off elsewhere.

## Results

Latest-main revalidation: 23 portable/policy/font/WAMR ABI/trusted-service tests
passed, source-publication checks passed, and desktop source tests passed
(1943 passed, 1 skipped). Desktop tests require staging the official release
firmware resources first, as in upstream CI. A fresh enabled-candidate firmware
build passed the existing resource gates below. The application-only OTA of
that build booted `valid` on the same rev302 board, preserving all 30 components
and the previous fault-reset count of 11. These observations do not replace the
outstanding acceptance matrix below.

- Portable core and backend fakes pass ASan/UBSan; shared C/Python policy fixtures,
  real metered WAMR ABI and browser tests passed. An earlier selected regression
  suite passed 47 cases and six existing preview/input tests.
- Full Tauri development build passed with the actual Rust integration. Its
  `component_network` library test passed (1 test; 1697 unrelated tests filtered).
  This is not a complete desktop test-suite run or an installer release build.
- Latest-main R292 enabled candidate passes the original resource gates: application 3,005,168
  bytes; OTA slot 3,145,728; headroom 140,560 (minimum 131,072); internal static
  278,712 bytes; external static 10,103,900 bytes. Partition layout is unchanged.
- Candidate-only font row-plane compression reconstructs all 554,086 original
  bitmap bytes exactly (SHA256
  `1e357bf8ec947c56e3aca7221f315cb9b883aa26367abf8cb0c5fb7eeb601f5a`).
  Temporary PSRAM decode storage is released before normal tasks start.
- Preserving application OTA succeeded on one ESP32-P4 rev302 device. The new
  image reports `valid`, and all 30 component IDs survived installation/update.
  Fault-reset count remained 11 across OTA and component installation. A failed
  read-only ROM diagnostic attempt before OTA had raised the old count from 10
  to 11; this is not evidence of a candidate firmware fault.
- A separate WASM package installed and activated using negotiated exact network
  and credential capabilities. Its device HTTPS request received expected HTTP
  401 with transport status 0. Subsequent device acceptance restored component credentials, completed authenticated
  MQTT-over-TLS connection and received real broker messages. A separate component
  displayed real temperature telemetry. This verifies one provider/board combination,
  not general broker interoperability or long-duration stability.
- Provider endpoints, application UI/parsing and component identity are confined
  to the separately distributed component, outside this firmware change.

## Test setup

From repository root, install pytest and provide a C compiler. The new portable
and fake-backend tests use vendored cJSON and no live account/network:

```sh
python -m pytest -q firmware/tests/component_network_test.py firmware/tests/component_network_policy_test.py
```

For the optional real interpreter/browser ABI test, build the checker from this
checkout with `firmware/tools/wasm-host-check/CMakeLists.txt` and the device's pinned
WAMR. Set `HACHI_CLANG`, `HACHI_WASM_LD`, `HACHI_WASM_CHECK`, `HACHI_NODE` to the local
SDK/compiler/checker/Node executables, then run
`python -m pytest -q firmware/tests/component_network_wasm_test.py`.
The checker's old installed release cannot validate new service imports.

Existing trusted-service harnesses expect a managed cJSON include directory; in a
clean source-only checkout `C_INCLUDE_PATH="$PWD/firmware/tests/vendor/cjson"`
provides the same public header without changing the production sources.

ESP-IDF requires a build path without spaces. The local build used a byte-identical
source mirror in a temporary directory, the existing pinned ESP-IDF/PlatformIO
packages and pinned WAMR. The PC source was linked from the working checkout.

## Outstanding acceptance gates

Authenticated broker connection and live telemetry were observed on one device.
Certificate failure, DNS denial,
network loss/reconnect, switching during real fragments/requests, credential
persistence/removal and broader Wi-Fi/BLE/audio regressions still require device
acceptance. Fake-backend tests cannot prove radio interoperability or storage
durability. New profile credential storage uses ordinary NVS, not the existing
hardware-backed private-feed credential service. No eFuse changes were performed.
