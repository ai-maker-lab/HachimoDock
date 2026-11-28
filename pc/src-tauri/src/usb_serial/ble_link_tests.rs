//! In-process unit tests for BLE link routing on `UsbSerialManager`.
//! Uses an injected mock `BleLinkBackend` — never mutates process-global state
//! and never spawns child processes.
use super::*;
use serde_json::{json, Value};

const BLE_GEN: u64 = crate::ble_transport::BLE_GENERATION_BIT | 1;
const BOARD: &str = "p4-aabbccddeeff";
const BOOT: &str = "0123456789abcdef";

fn full_ble_hello() -> Value {
    json!({
        "boardDeviceId": BOARD,
        "runtime": "esp-p4",
        "deviceModel": "ESP32-P4-WIFI6",
        "fw": "0.7.103-p4-r310-wifi6",
        "protocolSchema": 7,
        "capabilities": {
            "debugBootId": BOOT,
            "ble": {
                "controlTransport": "ble-jsonl-v1",
                "controlLineMaxBytes": 32768,
                "voice": false
            },
            "bleAppearanceChunks": true,
            "bleBubbleFont": true,
            "audioMasterVolume": "p4-master-volume-v1",
            "bluetoothKeyboardConfig": "p4-ble-keyboard-config-v1",
            "testMessageReceipt": true,
            "widgetData": crate::widget_data::PROTOCOL,
            "widgetWasmHost": crate::clawpkg::HACHI_HOST_PROFILE,
            "widgetLocalTools": "p4-local-tools-v1",
            "widgetInventory": true,
            "widgetDelete": true,
            "widgetDeletePreserveSave": true,
            "widgetActivation": "p4-widget-activation-v1",
            "appearanceSlotReuse": true,
            "rawAppearanceSlot1": true,
            "bubblePixels": bubble_pixels::SCHEMA,
            "bubblePixelsBoot": BOOT
        }
    })
}

struct MockBle {
    state: Mutex<Option<(u64, Value)>>,
    sent: Mutex<Vec<(u64, Value)>>,
    on_send: Mutex<Option<Box<dyn Fn(u64, &Value) + Send + Sync>>>,
    tx_queue_clears: AtomicUsize,
}

impl MockBle {
    fn connected() -> Arc<Self> {
        Arc::new(Self {
            state: Mutex::new(Some((BLE_GEN, full_ble_hello()))),
            sent: Mutex::new(Vec::new()),
            on_send: Mutex::new(None),
            tx_queue_clears: AtomicUsize::new(0),
        })
    }

    fn set_generation(&self, generation: u64) {
        *self.state.lock().unwrap() = Some((generation, full_ble_hello()));
    }

    fn tx_queue_clears(&self) -> usize {
        self.tx_queue_clears.load(Ordering::Acquire)
    }

    fn set_responder(&self, responder: impl Fn(u64, &Value) + Send + Sync + 'static) {
        *self.on_send.lock().unwrap() = Some(Box::new(responder));
    }

    fn disconnect(&self) {
        *self.state.lock().unwrap() = None;
    }

    fn sent_messages(&self) -> Vec<(u64, Value)> {
        self.sent.lock().unwrap().clone()
    }
}

impl BleLinkBackend for MockBle {
    fn status(&self) -> UsbConnectionStatus {
        match self.state.lock().unwrap().as_ref() {
            Some((gen, hello)) => UsbSerialManager::ble_status_from_hello(*gen, hello),
            None => disconnected_usb_status(),
        }
    }

    fn send_line_bound(&self, generation: u64, line: &str) -> Result<(), String> {
        let guard = self.state.lock().unwrap();
        let Some((cur_gen, _)) = guard.as_ref() else {
            return Err("蓝牙未连接".into());
        };
        if *cur_gen != generation {
            return Err("蓝牙连接已变化".into());
        }
        drop(guard);
        let parsed: Value = serde_json::from_str(line).map_err(|e| e.to_string())?;
        self.sent.lock().unwrap().push((generation, parsed.clone()));
        if let Some(cb) = self.on_send.lock().unwrap().as_ref() {
            cb(generation, &parsed);
        }
        Ok(())
    }

    fn verify_current_board(&self, board: &str, generation: u64) -> Result<(), String> {
        let guard = self.state.lock().unwrap();
        let Some((cur_gen, hello)) = guard.as_ref() else {
            return Err("蓝牙未连接".into());
        };
        if *cur_gen != generation || hello["boardDeviceId"].as_str() != Some(board) {
            return Err("蓝牙设备连接已变化".into());
        }
        Ok(())
    }

    fn clear_tx_queue(&self) {
        self.tx_queue_clears.fetch_add(1, Ordering::AcqRel);
    }
}

#[test]
fn ble_heartbeat_attaches_host_clock_and_wasm_uv_for_time_widgets() {
    let manager = UsbSerialManager::new();
    let mock = MockBle::connected();
    manager.set_ble_backend(mock.clone());

    let link = manager.link_status();
    assert!(link.connected);
    assert_eq!(link.transport, "ble");
    assert_eq!(link.board_device_id, BOARD);
    assert_eq!(link.boot_id, BOOT);
    assert!(!manager.status().connected, "USB-only status must stay false");

    // Request a UV refresh over BLE first, then emit heartbeat.
    manager.handle_ble_message(BLE_GEN, "wasm/uv_request", &json!({}));
    manager
        .send("system/heartbeat", &json!({ "tsMs": 123456 }))
        .unwrap();

    let sent = mock.sent_messages();
    assert_eq!(sent.len(), 1);
    assert_eq!(sent[0].0, BLE_GEN);
    assert_eq!(sent[0].1["topic"], "system/heartbeat");
    let clock = &sent[0].1["payload"]["clock"];
    assert!(clock["unixSeconds"].as_i64().is_some_and(|t| t > 1_700_000_000));
    assert!(clock["utcOffsetMinutes"].as_i64().is_some());
    assert!(clock["subsecondMs"].as_u64().is_some());
    assert!(sent[0].1["payload"].get("wasmUv").is_some());
}

#[test]
fn ble_blocks_usb_only_topics_and_allows_antigravity_follow_and_session() {
    let manager = UsbSerialManager::new();
    let mock = MockBle::connected();
    manager.set_ble_backend(mock.clone());

    for (topic, payload) in [
        ("firmware/begin", json!({})),
        ("lan/trust", json!({})),
        ("audio/control", json!({"action": "start"})),
        ("media/begin", json!({})),
        ("control/command", json!({"type": "audio_bridge", "action": "start"})),
        ("asset/raw-chunk", json!({"transferId": "t1"})),
    ] {
        assert!(
            manager.send(topic, &payload).is_err(),
            "BLE must reject USB-only topic {topic}"
        );
    }
    assert!(mock.sent_messages().is_empty());

    // Antigravity follow switch + session/current + state/antigravity over BLE.
    manager
        .send_follow_change_for_connection(
            BOARD,
            BLE_GEN,
            "control/remote-cli-binding",
            &json!({
                "enabled": true,
                "targetSource": "antigravity",
                "targetDeviceId": "mac-1",
            }),
        )
        .unwrap();
    let gen = manager
        .check_session_follow_target(BOARD, "antigravity", &BLE_GEN.to_string(), BOOT)
        .unwrap();
    assert_eq!(gen, BLE_GEN);
    manager
        .send_session_current_for_connection(
            BOARD,
            BLE_GEN,
            &json!({"agentId": "antigravity", "sessionId": "auto", "sessions": []}),
        )
        .unwrap();
    manager
        .send_state("antigravity", &json!({"source": "antigravity", "state": "working"}))
        .unwrap();
    // Stale codex update must be rejected while following antigravity!
    assert!(manager
        .send_state("codex", &json!({"source": "codex", "state": "idle"}))
        .is_err());
    assert_eq!(mock.sent_messages().len(), 3);
}

#[test]
fn ble_master_volume_and_keyboard_config_and_test_message_roundtrip() {
    let manager = UsbSerialManager::new();
    let mock = MockBle::connected();
    let mgr_for_cb = manager.clone();
    mock.set_responder(move |gen, msg| {
        let topic = msg["topic"].as_str().unwrap();
        let req = &msg["payload"];
        match topic {
            "audio/volume" => {
                mgr_for_cb.handle_ble_message(
                    gen,
                    "audio/volume-state",
                    &json!({
                        "ok": true,
                        "engine": "p4-master-volume-v1",
                        "boardDeviceId": BOARD,
                        "requestId": req["requestId"],
                        "volume": req.get("volume").cloned().unwrap_or(json!(65)),
                        "persisted": true
                    }),
                );
            }
            "keyboard/config" => {
                mgr_for_cb.handle_ble_message(
                    gen,
                    "keyboard/config-state",
                    &json!({
                        "ok": true,
                        "boardDeviceId": BOARD,
                        "requestId": req["requestId"],
                        "enabled": true
                    }),
                );
            }
            "ui/test-message" => {
                mgr_for_cb.handle_ble_message(
                    gen,
                    "ui/test-message/status",
                    &json!({
                        "ok": true,
                        "boardDeviceId": BOARD,
                        "requestId": req["requestId"],
                        "status": "ready",
                        "token": 7
                    }),
                );
            }
            "widget/list" => {
                mgr_for_cb.handle_ble_message(
                    gen,
                    "widget/inventory",
                    &json!({
                        "ok": true,
                        "boardDeviceId": BOARD,
                        "requestId": req["requestId"],
                        "complete": true,
                        "items": []
                    }),
                );
            }
            _ => {}
        }
    });
    manager.set_ble_backend(mock.clone());

    let vol = manager.device_volume(BOARD, Some(80)).unwrap();
    assert_eq!(vol["volume"], 80);

    let kb = manager
        .bluetooth_keyboard_config(BOARD, BLE_GEN, json!({}))
        .unwrap();
    assert_eq!(kb["enabled"], true);

    let tm = manager
        .test_message_exchange(BOARD, BLE_GEN, json!({"phase": "prepare"}))
        .unwrap();
    assert_eq!(tm["status"], "ready");

    let inv = manager.query_widget_inventory(BOARD).unwrap();
    assert_eq!(inv["complete"], true);
}

#[test]
fn ble_bubble_font_and_widget_data_bulk_guard_and_disconnect_wakes_waiters() {
    let manager = UsbSerialManager::new();
    let mock = MockBle::connected();
    let mgr_for_cb = manager.clone();
    mock.set_responder(move |gen, msg| {
        if msg["topic"] == "resources/bubble-font" {
            let req = &msg["payload"];
            mgr_for_cb.handle_ble_message(
                gen,
                "resources/bubble-font/status",
                &json!({
                    "ok": true,
                    "boardDeviceId": BOARD,
                    "requestId": req["requestId"],
                    "loaded": true
                }),
            );
        }
    });
    manager.set_ble_backend(mock.clone());

    // Already-loaded bubble32-v1 font returns immediately over BLE.
    manager
        .ensure_bubble_font(BOARD, &BLE_GEN.to_string())
        .unwrap();
    assert!(!manager.ble_bulk_active());

    // Nested BleBulkGuard uses a refcount so an inner early drop never unblocks
    // widget/data while an outer bulk transfer is still in flight.
    {
        let _outer = BleBulkGuard::acquire(&manager.ble_bulk_active, true);
        {
            let _inner = BleBulkGuard::acquire(&manager.ble_bulk_active, true);
            assert!(manager.ble_bulk_active());
        }
        assert!(manager.ble_bulk_active());
        assert!(manager
            .send_widget_data_scoped(BOARD, Some(BLE_GEN), &json!({"source": "computer.status"}))
            .is_err());
    }
    assert!(!manager.ble_bulk_active());
    manager
        .send_widget_data_scoped(BOARD, Some(BLE_GEN), &json!({"source": "computer.status"}))
        .unwrap();

    // Stale BLE generation cannot update RX liveness or resolve shared waiters.
    let stale_rx = manager
        .register_widget_ack_waiter("t-stale", "begin", None, None)
        .unwrap();
    let stale_gen = crate::ble_transport::next_ble_generation(BLE_GEN);
    let rx_before = manager.last_rx_activity_ms();
    assert!(!manager.handle_ble_message(
        stale_gen,
        "widget-install-ack",
        &json!({"transferId": "t-stale", "phase": "begin", "ok": true}),
    ));
    assert_eq!(manager.last_rx_activity_ms(), rx_before);
    assert!(matches!(
        stale_rx.recv_timeout(Duration::from_millis(20)),
        Err(mpsc::RecvTimeoutError::Timeout)
    ));
    manager.remove_widget_ack_waiter("t-stale", "begin", None, None);

    // Pending waiter wakes immediately on ble_disconnected().
    let rx = manager
        .register_widget_ack_waiter("t-ble", "begin", None, None)
        .unwrap();
    mock.disconnect();
    manager.ble_disconnected(BLE_GEN);
    assert!(matches!(
        rx.recv_timeout(Duration::from_millis(50)),
        Err(mpsc::RecvTimeoutError::Disconnected)
    ));
}

#[test]
fn usb_takeover_fails_closed_for_ble_writes_and_retires_ble_waiters() {
    let manager = UsbSerialManager::new();
    let mock = MockBle::connected();
    manager.set_ble_backend(mock.clone());

    let rx = manager
        .register_widget_ack_waiter("t-takeover", "begin", None, None)
        .unwrap();

    // Simulate a real USB connection taking over while BLE is still attached.
    {
        let (_dispatch, mut conn) = manager.inbound_owner.connection(&manager.connection).unwrap();
        *conn = Some(UsbConnection {
            connection_id: 1,
            port_name: "memory-usb-takeover".into(),
            baud_rate: 4_000_000,
            writer: Box::new(std::io::sink()),
            board_device_id: BOARD.into(),
            runtime: "esp-p4".into(),
            device_model: "ESP32-P4".into(),
            firmware: "0.7.121-p4-r310-wifi6".into(),
            build_id: String::new(),
            git_sha: String::new(),
            build_dirty: false,
            protocol_schema: 7,
            wire_protocol: "pet-usb-jsonl-v3".into(),
            capabilities: json!({"debugBootId": "0123456789abcdef"}),
            connected: true,
            cancel_reader: Arc::new(AtomicBool::new(false)),
            capture_active: Arc::new(AtomicBool::new(false)),
        });
        manager.inbound_owner.publish(1);
        cache_usb_status(&manager.status_snapshot, conn.as_ref());
    }
    manager.retire_ble_on_usb_connect();

    // BLE status, verification, and generation-scoped BLE writes all fail closed while USB is active,
    // and queued BLE writes are drained on USB takeover.
    assert!(manager.status().connected);
    assert!(!manager.ble_status().connected);
    assert_eq!(mock.tx_queue_clears(), 1);
    assert!(manager.verify_ble_board(BOARD, BLE_GEN).is_err());
    assert!(manager
        .send_session_current_for_connection(BOARD, BLE_GEN, &json!({"agentId": "antigravity"}))
        .is_err());
    assert!(mock.sent_messages().is_empty());
    assert!(matches!(
        rx.recv_timeout(Duration::from_millis(50)),
        Err(mpsc::RecvTimeoutError::Disconnected)
    ));
}

#[test]
fn stale_ble_disconnect_does_not_clear_newer_generation_waiters() {
    let manager = UsbSerialManager::new();
    let mock = MockBle::connected();
    manager.set_ble_backend(mock.clone());

    // Simulate a fast reconnect where gen2 is already active before gen1's disconnect arrives.
    let gen2 = crate::ble_transport::BLE_GENERATION_BIT | 2;
    mock.set_generation(gen2);

    let rx = manager
        .register_widget_ack_waiter("t-gen2", "begin", None, None)
        .unwrap();

    manager.ble_disconnected(BLE_GEN);

    assert!(matches!(
        rx.recv_timeout(Duration::from_millis(20)),
        Err(mpsc::RecvTimeoutError::Timeout)
    ));
    assert_eq!(manager.link_status().connection_id, gen2.to_string());
}
