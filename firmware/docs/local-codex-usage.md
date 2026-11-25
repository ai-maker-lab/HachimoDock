# Local Codex usage prototype (based on v0.1.260)

This personal firmware experiment is disabled by default. It leaves the Pet Manager client, the built-in Token dashboard and the ordinary package format unchanged. No existing component gains access to Codex usage by installing it or matching a component ID.

## Signal and permission

Pet Manager already sends `runtime/stats` over USB. The prototype consumes only its structured `source: "codex"`, `tokenUsagePeriod: "today"`, `tokenUsage.totalTokens` and `tsMs` fields. No conversation text, title, session ID, file path or credential is delivered to the component. LAN transport is not covered by this prototype.

- Opt in on the WiFi6 v3 target with `PET_P4_LOCAL_CODEX_USAGE_PUBKEY`, the lowercase hex encoding of a 65-byte uncompressed P-256 public point. Only `token-fishing-arcade`, `token-ocean-voyage`, and `token-world-atlas` signed by that key receive usage. Network-enabled and legacy radio modules remain excluded. Unknown or unsigned modules still run without usage. Configure a fresh build and verify the application image contains the intended public key before installation.
- `runtime/app.wasm` carries a final custom section named `hachi.codex-use.v1`, with exactly 64 bytes of fixed-width P-256 signature (`r || s`, 32 bytes each, big-endian). The signed message is `hachi/codex-usage/v1` plus a NUL byte, the case-sensitive component ID plus a NUL byte, then the exact original WASM bytes excluding that final custom section. Verification uses ECDSA with SHA-256. The same public key authorizes later signed revisions of the approved IDs without reflashing. Keep the private signing key out of the firmware, components and Git.
- Approved WASM instances receive `HACHI_CODEX_DAY_TOKENS` (32) and `HACHI_CODEX_MINUTE_TOKENS` (33) through `hachi_event` at activation and when values change. Decode both with `hachi_codex_day_tokens(a, b)`. `UINT64_MAX` means unavailable, not zero. Ordinary firmware does not send these events.
- Newer source timestamps replace older samples. A duplicate does not extend the five-minute receipt-age limit. If Pet Manager is idle and publishes nothing new, the probe may show no fresh sample even while USB is connected. A newer aggregate for a different followed Agent also makes the Codex sample unavailable.
- Today means the PC's local calendar day across the Codex sessions observed by Pet Manager. The firmware accumulates positive differences in a fixed 60-second ring even when no approved component is running. The first sample, a decreased cumulative counter and gaps of at least one minute do not count as bursts. The result is the increment observed over USB, with one-second bucket resolution, not a per-token stream or request RPM.

## Build and verify

Run `python -m pytest firmware/tests/p4_codex_usage_test.py`. The probe test requires Node and the SDK's clang and wasm-ld (`HACHI_CLANG`, `HACHI_WASM_LD`); it exercises the WASM exports with fixture values. Set `HACHI_MBEDTLS_INCLUDE` and `HACHI_MBEDCRYPTO_LIB` to host Mbed TLS headers and the built static library for the signature-policy test. These tests do not replace ESP32-P4 or USB hardware testing.

With the public key set, use `python -m platformio run -e esp32_p4_wifi6_local_usage_v3` only for the confirmed WiFi6 v3 board. It inherits the WiFi6 v3 board, chip and OTA partition settings, but reports `0.7.121-p4-r310-local6-wifi6`. The `-wifi6` suffix preserves the client's board-family preflight. Use the application image with the client's USB OTA file picker, not a factory image, and keep the matching prior or official WiFi6 v3 image for rollback. See [build and flashing](../BUILD.md).

While a signature-authorized Atlas instance is running, if SW3 short press is mapped to global Back and SW3 long press is Settings or disabled, short press goes to the postcard view and long press performs Back. The package does not claim the reserved short press; joystick Up also opens postcards. The persisted mappings and other components are unchanged; explicit alternative long-press assignments are not displaced.

Set Pet Manager to follow Codex over USB. Run a Codex turn and compare the next readings with the built-in Token dashboard. Switch between approved components and confirm that both observe the same rolling increment, which decays to zero. This needs a hardware check after the target image and modules are installed.

## Additional lifecycle work

- **Turn completed:** the PC monitors `event_msg:task_complete` and also has Desktop fallback signals. It can restore past state, and the visible `done` state is not emitted for every reply. A future PC channel should distinguish a live successful turn from abort, failure, duplicate and restored state before emitting a new event. A whole conversation/thread is not a turn.
- **Explicitly awaiting input:** only expose structured outstanding user-input, approval or elicitation requests from a supported Codex source, and clear the indicator on resolution, cancellation or session change. The bundled app-server adapter recognizes the request shapes for turns it controls, but recognition in that adapter does not show coverage for arbitrary Desktop threads. A reply that ends in a question is not a pending tool request.
