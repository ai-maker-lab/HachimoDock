# Component network host (experimental)

`component-network-v1` is an additive candidate capability, disabled on existing
release targets. A successful host test is not firmware release or device acceptance.
The candidate passes the existing OTA headroom gate and has limited device testing;
this does not establish general release acceptance. See `docs/rfcs/component-network-host.md` for acceptance gates.

The component owns login/logout screens, remote payloads, parsing and UI. Firmware
owns bounded transport and component-scoped storage. Never put account values in
package JSON, diagnostics, exports or firmware sources.

Declare `hachiNetwork` in `runtime/widget.json` and import at least one service:

```json
{
  "profile": "component-network-v1",
  "https": [{"origin": "https://api.example.org", "methods": ["GET", "POST"]}],
  "mqtts": [{"host": "events.example.org", "port": 8883,
    "subscribe": ["sensors/+/report"], "publish": ["sensors/one/request"]}],
  "credentials": {"records": 2, "totalBytes": 4096}
}
```

Origins are exact lowercase public DNS names, without paths, ports or wildcards.
At most four HTTPS origins and two MQTT brokers; eight subscribe and eight publish
filters per broker. MQTT topic filters may use valid `+` and terminal `#` wildcards;
a subscription must be contained by its declared filter. Publishing uses a concrete
topic. Policy JSON is less than 2048 UTF-8 bytes. No redirects, private IPv4 routes,
plain HTTP, certificate bypass, arbitrary sockets or foreign credential namespaces.
The candidate resolves IPv4, rejects non-public answers and connects to the validated
numeric address while verifying the original TLS hostname with the certificate bundle.

## Asynchronous ABI

The SDK exposes `hachi_service_submit`, `hachi_service_poll`, `hachi_service_read`
and `hachi_service_release`. At most eight service calls per WASM entry; existing
instruction, drawing, storage and input budgets remain in force. Browser previews
and install probes return unavailable and do not perform live networking by default.
Tests may explicitly provide a `host.services` mock adapter; this does not enable
fetch, broker access or credentials in the browser.

Submit UTF-8 JSON (up to 8192 bytes); a positive result is the request ID:

```json
{"op":"http","origin":"https://api.example.org","path":"/items","method":"GET"}
{"op":"http","origin":"https://api.example.org","path":"/session","method":"POST","body":"{}","headers":{"Content-Type":"application/json"}}
{"op":"credential.set","key":"session","value":"value supplied at runtime"}
{"op":"credential.get","key":"session"}
{"op":"credential.erase","key":"session"}
{"op":"mqtt.connect","host":"events.example.org","clientId":"sensor-dashboard","username":"runtime username","passwordCredential":"session"}
{"op":"mqtt.subscribe","host":"events.example.org","topic":"sensors/one/report","qos":0}
{"op":"mqtt.unsubscribe","host":"events.example.org","topic":"sensors/one/report"}
{"op":"mqtt.publish","host":"events.example.org","topic":"sensors/one/request","payload":"{}","qos":0}
{"op":"mqtt.disconnect"}
```

HTTP bodies and MQTT publish payloads are at most 4096 bytes. GET has no body.
HTTP accepts up to eight headers (name <=48 bytes, value <=512); routing/framing,
proxy and direct Authorization headers are rejected. To authenticate, use
`"authorization":{"credential":"session","prefix":"Bearer "}`. The host reads
only this component's credential; invalid header values fail before sending.
No automatic retry of HTTP or failed POST. HTTP has per-operation timeouts and a
12-second response-read deadline, rather than a guaranteed 12-second total deadline.

Poll into a buffer up to 512 bytes. Zero means no event, positive means JSON length:

```json
{"type":"http","handle":12,"request":8,"status":200,"bytes":321,"topic":""}
```

`request` correlates a completion to submit; unsolicited MQTT events use zero.
Read body bytes by handle and offset into a buffer up to 4096 bytes. Release each
handle after consumption, including empty/error responses. MQTT acknowledgement
status carries the broker packet ID, matching the immediate MQTT command result.
`mqtt.connected`, `mqtt.disconnected`, `mqtt.subscribed`, `mqtt.unsubscribed`,
`mqtt.published`, `mqtt.error` and `mqtt.message` are asynchronous event types.

There is one active component owner and one MQTT connection. Switching components
revokes old requests/handles, drops stale completions and closes the old session.
Only eight concrete subscriptions may be active. MQTT reconnect delay is 10 seconds;
keepalive is 45 seconds; the outbox is capped at 16 KiB. Applications must resubscribe
after `mqtt.connected`. Incoming messages are reassembled up to 64 KiB.

Queue: four pending jobs, eight retained responses, 256 KiB retained payload total;
HTTP response maximum 192 KiB. Overflow is explicit (`overflow` event); the component
must release handles and recover its state. Native transport also uses bounded
scratch buffers outside the retained payload quota.

Negative errors: -1 unavailable, -2 denied, -3 invalid, -4 busy, -5 limit, -6 stale,
-7 transport, -8 storage. The ABI also returns -3 for invalid guest ranges or excess
service calls. Transport failures do not imply that a remote POST had no effect.

Credential keys contain 1–32 ASCII letters/digits/`_-.`; values <=4096 bytes, declared
records <=8 and total bytes <=8192. Credential values persist across package updates
and component switches. Explicit erase or component removal removes them. Storage
uses normal NVS with full-owner collision checks, not an encrypted secret vault.

## Wired diagnostics and provisioning

The candidate exposes `component/network-status-query` over the trusted wired
control route. Its `component/network-status` reply reports the active owner,
queue/retained counts, HTTP/transport status, MQTT connection and received-message
count; no credential values are returned.

`component/credential-set {widgetId,key,value,requestId}` queues a write only for
the active declared owner. `component/credential-result` confirms queue admission,
not durable completion. The guest receives the normal credential completion event.
There is no wired credential read/export API. This storage is ordinary NVS; the
existing hardware-backed private-feed service remains separate and unchanged.
