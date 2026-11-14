//! Exercise production BLE routing without CoreBluetooth or a device.
use super::*;
use serde_json::json;

static MANAGER: std::sync::OnceLock<UsbSerialManager> = std::sync::OnceLock::new();
static GENERATION: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(1 << 63);
static PLAYING: AtomicBool = AtomicBool::new(false);
static SENT: Mutex<Vec<String>> = Mutex::new(Vec::new());

fn status() -> Option<UsbConnectionStatus> {
    Some(UsbConnectionStatus {
        connected: true, board_device_id: "ble-fixture".into(), transport: "ble".into(),
        connection_id: GENERATION.load(Ordering::SeqCst).to_string(), boot_id: "0123456789abcdef".into(),
        runtime: "esp-p4".into(),
        capabilities: json!({"widgetMedia":"p4-media-v1","widgetActivation":"p4-widget-activation-v1","widgetInventory":true,
            "widgetDelete":true,"widgetDeletePreserveSave":true}),
        port_name:"bluetooth".into(), baud_rate:0, device_model:String::new(), firmware:String::new(), build_id:String::new(), git_sha:String::new(), build_dirty:false, protocol_schema:1, wire_protocol:"ble-jsonl-v1".into()
    })
}

fn send(generation: u64, topic: &str, payload: &serde_json::Value) -> Result<(), String> {
    assert_eq!(generation, GENERATION.load(Ordering::SeqCst));
    SENT.lock().unwrap().push(topic.into());
    let reply = match topic {
        "diagnostics/query" => Some(("diagnostics/status", json!({"runtime":{"audioPlaybackActive":false}}))),
        "media/query" => Some(("media/status", json!({"state":if PLAYING.load(Ordering::SeqCst) {"playing"} else {"idle"}}))),
        "widget/list" => Some(("widget/inventory", json!({"items":[],"complete":true}))),
        "ui/mac-notice" => Some(("protocol/ack", json!({"ok":true, "requestTopic":topic}))),
        "widget/activate" => Some(("protocol/ack", json!({"ok":true}))),
        "widget/delete" => {
            assert_eq!(payload["widgetId"], "test-component");
            assert_eq!(payload["preserveSave"], true);
            Some(("widget-install-ack", json!({"transferId":payload["transferId"],"phase":"delete","ok":true})))
        }
        _ => None,
    };
    if let Some((topic, mut response)) = reply {
        response["requestId"] = payload["requestId"].clone();
        response["boardDeviceId"] = "ble-fixture".into();
        MANAGER.get().unwrap().handle_ble_widget_ack(topic, &response);
    }
    Ok(())
}

#[test]
fn ble_preflight_inventory_activation_and_follow_scope() {
    // Production callback slots are process-global; isolate them from USB tests.
    const CHILD: &str = "HACHIMO_BLE_LINK_TEST_CHILD";
    if std::env::var_os(CHILD).is_none() {
        let output = std::process::Command::new(std::env::current_exe().unwrap())
            .args(["--exact", "usb_serial::ble_link_tests::ble_preflight_inventory_activation_and_follow_scope", "--nocapture"])
            .env(CHILD, "1").output().unwrap();
        assert!(output.status.success(), "{}\n{}", String::from_utf8_lossy(&output.stdout), String::from_utf8_lossy(&output.stderr));
        return;
    }
    BLE_STATUS.set(status).unwrap();
    BLE_FALLBACK.set(send).unwrap();
    assert!(MANAGER.set(UsbSerialManager::new()).is_ok());
    let manager = MANAGER.get().unwrap();
    assert!(!manager.status().connected);
    manager.send_mac_notice("ble-fixture", json!({"title":"Codex","text":"等你处理"})).unwrap();
    assert_eq!(manager.component_sync_audio_status("ble-fixture").unwrap()["blocked"], false);
    PLAYING.store(true, Ordering::SeqCst);
    assert_eq!(manager.component_sync_audio_status("ble-fixture").unwrap()["blocked"], true);
    assert_eq!(manager.query_widget_inventory("ble-fixture").unwrap()["complete"], true);
    manager.remove_widget("ble-fixture", "test-component").unwrap();
    assert_eq!(manager.activate_installed_widget("ble-fixture", "hachimi-weather", true).unwrap()["ok"], true);
    let generation = GENERATION.load(Ordering::SeqCst);
    manager.send_follow_change_for_connection("ble-fixture", generation, "control/remote-cli-binding",
        &json!({"enabled":true,"targetSource":"devin"})).unwrap();
    manager.send_session_current_for_connection("ble-fixture", generation, &json!({"agentId":"devin","sessionId":"one"})).unwrap();
    let before = SENT.lock().unwrap().len();
    assert!(manager.send_session_current_for_connection("ble-fixture", generation, &json!({"agentId":"codex"})).is_err());
    assert!(manager.query_widget_inventory("wrong-board").is_err());
    GENERATION.fetch_add(1, Ordering::SeqCst);
    assert!(manager.send_session_current_for_connection("ble-fixture", generation, &json!({"agentId":"devin"})).is_err());
    assert_eq!(SENT.lock().unwrap().len(), before);
}
