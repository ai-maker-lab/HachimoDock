# RFC: provider-independent network services for components

Status: local implementation candidate, default off; **not release ready**.

The candidate is implemented on the R292 source below, with portable policy/queue,
ESP HTTPS/MQTTS/NVS backend, WASM ABI, package/client capability checks and matching
SDK/preview validation. Existing release targets do not advertise this capability.
The dedicated `esp32_p4_component_network_candidate_v3` target advertises it for
local development only. No application-specific endpoints, account state, parser,
renderer, component identity branch or built-in application is included.

Local host tests cover policy contracts in C/Python/Rust, ASan/UBSan ownership and
quota checks, mocked TLS/DNS/storage/MQTT fragmentation, and a real WASM module in
WAMR and the browser preview. The default Wi-Fi v3 target builds within budget.
The enabled candidate now passes the unchanged 128 KiB OTA-headroom gate:
3,005,168 application bytes and 140,560 bytes headroom. A full desktop development
build passed. Preserving OTA on one ESP32-P4 rev302 device booted a valid image;
all 30 installed components remained. A separately distributed WASM component
confirmed real HTTPS connectivity (an expected HTTP 401 without credentials).
Authenticated MQTT and live telemetry were observed on one board; broader
hardware acceptance remains pending. This is not a
validated general firmware release. See the validation record for exact limits.

The executable contract is documented in
`pc/skills/petui/references/component-network.md`.

Reviewed against main `139c99302aed65fc6804d31af9a56cfcbc58d184` (R292 public source).

## Problem and ownership

R292 already supports public HTTPS feeds, bounded private bearer GET feeds,
a single MQTT feed and hardware-backed credentials for that existing feed path.
This proposal adds a separate asynchronous WASM request API: GET/POST and raw
response reads, component-owned dynamic MQTT subscriptions/publications, and
explicit credential lifecycle operations. It does not replace or weaken the
existing private-feed credential service. Copying an application into firmware
is not an acceptable way to provide these additional capabilities.

The host should own transport, certificate validation, bounded asynchronous jobs,
component identity and credential persistence. A separately distributed component
should own its service endpoints, login workflow, protocol payloads, JSON parsing,
domain state, labels, visuals and input mapping. This proposal introduces no
provider, application identifier, account, embedded token or built-in component.

A component package update must be sufficient to change application behavior once
its required host capabilities are installed. New applications should not require
another firmware branch or a component-ID dispatch in the renderer or input path.

## Existing extension points and gaps

| Layer | Existing behavior | Required extension |
|---|---|---|
| HTTPS feeds | Public and private bearer GET feeds with bounded mappings | Separate authenticated request service with GET/POST, bounded body and explicitly scoped headers |
| WASM host | Clock, random, UV, graphics, sound and eight integer save slots | Versioned asynchronous service ABI and bounded byte reads |
| MQTT | Existing single MQTT feed | Generic MQTT-over-TLS session with bounded subscriptions, messages and publish requests |
| Persistence | Integer WASM save slots and existing hardware-backed feed credentials | Component-scoped credential records, explicit erase and lifecycle rules |
| Installation | Import and manifest allowlists, capability checks | Matching firmware, SDK, packager, preview and client checks for the new profiles |

This is an additive API. Existing public and private feed profiles keep their existing restrictions.
An implementation must not silently turn a feed URL into an authenticated request.

## Proposed contract

Names below are illustrative and require normal API review before implementation.
They must not be advertised by firmware until their implementation and validation
are complete.

### Declaration and negotiation

A versioned runtime declaration describes the component's allowed HTTPS origins,
methods, MQTT TLS brokers, publish/subscribe topic patterns and credential quota.
The declaration belongs in the component package, not a firmware provider table.

The device advertises separate profiles for network access and scoped credentials.
The client checks the exact profiles before installation; neither a version number
nor general Wi-Fi support implies support. A component not using these profiles
continues to follow the existing validation path. Unsupported boards do not
advertise them. A default-off development target may be used for HIL admission.

Minimal synthetic policy example, not an installable package:

```json
{
  "profile": "component-network-v1",
  "https": [{"origin": "https://api.example.org", "methods": ["GET", "POST"]}],
  "mqtts": [{
    "host": "events.example.org",
    "port": 8883,
    "subscribe": ["sensors/+/report"],
    "publish": ["sensors/+/request"]
  }],
  "credentials": {"records": 8, "totalBytes": 8192}
}
```

Patterns are validated as MQTT topic filters, not shell globs. The policy validator
must define containment for concrete subscriptions and reject broader requests.
Actual resource limits remain subject to device memory, firmware size and HIL tests.

### Asynchronous HTTPS

- The guest submits an allowed origin, path, method, bounded body and validated
  headers, and receives an operation handle immediately. Network operations do not
  execute on the rendering/input thread or inside the WASM instruction budget.
- A worker validates the full request, performs TLS and returns status, bounded
  response metadata and a response handle. The guest reads a response in chunks
  and explicitly releases it. Large responses must not require an unbounded WASM
  allocation; limits and truncation are explicit errors, not silent success.
- HTTPS validates the certificate chain, hostname and time. It rejects user-info
  URLs and cross-origin redirects. The host supplies transport headers itself and
  rejects conflicting framing/header-injection attempts.
- Credential references can generate an Authorization value for an allowed origin.
  References resolve using host-owned component identity. They are never copied
  into manifests, diagnostics, errors or cache keys.
- Failures distinguish unsupported capability, denied policy, offline, TLS failure,
  timeout, response limit, cancellation and HTTP status. Retry of a POST is an
  application decision; the host must not silently repeat an ambiguous request.
- Private/local destinations require a separately specified policy. Public-cloud
  access must not accidentally grant arbitrary access to local services.

### MQTT over TLS

- Initial scope: one session owned by the active component, with fixed negotiated
  ceilings for subscriptions, topic bytes, payload bytes, queued events and memory.
- Broker names and allowed topics come from the installed policy. Credentials are
  component-owned references, not a service-specific firmware login implementation.
- The host exposes connect/disconnect, subscribe/unsubscribe and bounded publish.
  Events include connection state, subscription acknowledgement, complete messages,
  publish acknowledgement and queue overflow/discontinuity.
- Publish defaults to non-retained; supported QoS/retain behavior must be explicit.
  Application-level control, topic construction and payload validation remain in
  the component. The host never invents discovery/control messages.
- Fragmented messages are reassembled within the negotiated size limit or rejected.
  Topic/payload lengths and offsets are checked before copying. Reconnection uses
  bounded backoff; subscription readiness is not inferred from a socket connection.
- Queue overflow must tell the guest that its state may be incomplete, so that the
  guest can request a new snapshot when its protocol supports one.

### Credentials and lifecycle

- Credential names resolve within an identity supplied by the host from the active
  installed package. The guest cannot select another component's namespace.
- Persist bounded records outside the package, with explicit per-record and total
  quotas, deletion and error reporting. A component update preserves its own
  records; deleting it clears its records. Credentials never appear in exports.
- Runtime/component switches advance a generation. Old callbacks and response
  handles cannot be consumed by another component or another generation.
- On suspension, failure, removal or replacement, stop subscriptions and release
  transport/response buffers. An in-flight request that cannot be interrupted
  safely must become inaccessible immediately and finish within its deadline.
- Storage isolation is not a claim of encrypted-at-rest storage. Any hardware/NVS
  encryption guarantee must be specified and tested separately.

### Generic WASM bridge

The ABI needs bounded submit/poll/read/release operations and a scoped credential
interface. Validate guest pointer ranges, lengths, handles, ownership and generation
on every call, including after module failure. Installation probes and desktop
previews must not perform real network requests or mutate credential storage.
A local fake service can exercise the exact ABI deterministically in previews.

Do not expose raw sockets, arbitrary firmware function pointers, unrestricted NVS,
filesystem paths or a component-selected native application entry point.

## Implementation map

| Area | Source integration points |
|---|---|
| Generic network worker/policy/store | New independent modules under `firmware/main/`, with transport-independent validation helpers |
| Runtime ABI and import profile | `firmware/components/hachi_wamr/hachi_runtime.h` and `.c` |
| Active owner, generation and cleanup | `firmware/main/pet_p4_wasm_trial.c` |
| Manifest parsing and rejection | `firmware/main/pet_p4_miniapp.c` |
| Capability advertisement | `firmware/main/pet_p4_protocol.c` |
| Build/resource gates | `firmware/main/CMakeLists.txt`, firmware build profiles and budget checks |
| SDK | `pc/skills/petui/sdk/hachi.h` |
| Pack/build validation | `pc/skills/petui/scripts/pack_hachiapp.py`, `validate_generated_widget.py`, authoring flow |
| Client capability and module validation | `pc/src-tauri/src/clawpkg.rs`, `petui_authoring.rs`, `usb_serial.rs` |
| Desktop ABI preview | `pc/src-tauri/src/wasm_preview_session.rs` and the WASM preview engine |
| Public contracts | PetUI network reference, capability fixtures and protocol documentation |

The desktop changes above recognize and validate a generic interface. They must
not introduce a particular provider's account screen or data-source implementation.
A declarative component settings/credential-input surface can be specified
separately if existing component extension panels cannot express the desired flow.

## Graphics compatibility is a separate check

The existing ABI limits text to 12–48 px, 40 lines and 240,000 text-work units, and
limits each WASM call to 160,000 instructions. Existing graphics, caching and
sprites should be measured before increasing limits.

If a dynamic dashboard cannot meet these limits without changing its approved
appearance, propose general bounded circle/arc primitives or an explicit resource
profile with identical desktop/device checks. Do not move its drawing function
into firmware or globally relax the existing limits to make it work.

## Acceptance and regression gates

1. Synthetic endpoints only in checked-in fixtures; no production account or token.
2. Reject undeclared origins, widened topic filters, invalid methods/headers,
   malformed manifests, invalid guest ranges and handles from another owner.
3. Test a component switch during TLS, HTTP response delivery, MQTT fragments,
   reconnect, subscription acknowledgement and credential reads/writes.
4. Test failed/cancelled POST without automatic duplicate submission; complete
   response delivery, explicit size failures and event-queue overflow reporting.
5. Verify credential update preservation, removal, failed writes and namespace
   isolation. Diagnostic and package-export tests must exclude credential values.
6. Test identical import/profile handling in firmware, SDK packaging and client;
   old packages still install and run without declaring network access.
7. Build supported/unsupported targets. Preserve OTA and internal/static memory
   gates, execution/input budgets and existing Wi-Fi/BLE/audio arbitration.
8. Use the actual target device to test public TLS, DNS, disconnect/reconnect,
   component switching and physical input while networking is active. Desktop
   HTTPS success is not device TLS or RF validation.

## Suggested delivery order

First agree the contract and quotas in this RFC. Then implement the complete
transport/credential/ABI path with installation checks and deterministic tests in
one reviewable feature series. Enable advertised profiles only after device HIL
passes. Independently distributed components can then migrate to the public ABI.
This branch now contains an experimental implementation in addition to this RFC.
The existing public targets remain default off. The candidate must pass every
resource and device gate before promotion to a release profile.
