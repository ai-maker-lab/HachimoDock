//! CoreBluetooth desktop transport for newline-delimited board control messages,
//! plus macOS App Nap guard so backgrounded companion links stay responsive.

#[cfg(any(target_os = "macos", test))]
pub mod pure {
    use serde_json::Value;

    /// Ensure a JSONL line ends with '\n' and chunk it to fit `max_payload`.
    #[cfg(test)]
    pub fn chunk_line(line: &str, max_payload: usize) -> Vec<Vec<u8>> {
        let mut bytes = line.as_bytes().to_vec();
        if bytes.last() != Some(&b'\n') {
            bytes.push(b'\n');
        }
        bytes.chunks(max_payload.max(1)).map(|c| c.to_vec()).collect()
    }

    /// Strict check for the secured GATT read probe reply:
    /// `{"ble":"ready","secure":true,"bonded":1}` (never newline-terminated).
    pub fn is_ble_ready_probe(bytes: &[u8]) -> bool {
        if bytes.is_empty() || bytes.last() == Some(&b'\n') || bytes.len() > 256 {
            return false;
        }
        serde_json::from_slice::<Value>(bytes).ok().is_some_and(|v| {
            v.get("ble").and_then(Value::as_str) == Some("ready")
                && v.get("secure").and_then(Value::as_bool) == Some(true)
        })
    }

    /// Reassemble newline-delimited JSONL frames arriving over BLE notifications.
    #[derive(Default)]
    pub struct LineReassembler {
        buf: Vec<u8>,
        discard_until_newline: bool,
        pub dropped_overlong: u32,
    }

    impl LineReassembler {
        pub const LIMIT: usize = 32 * 1024;

        pub fn push(&mut self, data: &[u8]) -> Vec<String> {
            let mut out = Vec::new();
            for &byte in data {
                if byte == b'\r' {
                    continue;
                }
                if byte == b'\n' {
                    if self.discard_until_newline {
                        self.discard_until_newline = false;
                        self.buf.clear();
                    } else if !self.buf.is_empty() {
                        out.push(String::from_utf8_lossy(&self.buf).into_owned());
                        self.buf.clear();
                    }
                    continue;
                }
                if self.discard_until_newline {
                    continue;
                }
                if self.buf.len() < Self::LIMIT {
                    self.buf.push(byte);
                } else {
                    self.buf.clear();
                    self.discard_until_newline = true;
                    self.dropped_overlong = self.dropped_overlong.saturating_add(1);
                }
            }
            out
        }
    }

    /// Bounded per-generation TX line queue used by the CoreBluetooth writer.
    pub struct BoundedLineQueue {
        items: std::collections::VecDeque<(u64, Vec<u8>, usize)>,
        total_bytes: usize,
        max_items: usize,
        max_bytes: usize,
    }

    impl BoundedLineQueue {
        pub fn new(max_items: usize, max_bytes: usize) -> Self {
            Self {
                items: std::collections::VecDeque::new(),
                total_bytes: 0,
                max_items,
                max_bytes,
            }
        }

        pub fn push_line(&mut self, generation: u64, line: &str) -> Result<(), &'static str> {
            let mut bytes = Vec::with_capacity(line.len() + 1);
            bytes.extend_from_slice(line.as_bytes());
            if bytes.last() != Some(&b'\n') {
                bytes.push(b'\n');
            }
            if bytes.len() > LineReassembler::LIMIT + 1 {
                return Err("蓝牙消息超过最大长度限制");
            }
            if self.items.len() >= self.max_items
                || self.total_bytes.saturating_add(bytes.len()) > self.max_bytes
            {
                return Err("蓝牙发送队列已满，请稍后重试");
            }
            self.total_bytes += bytes.len();
            self.items.push_back((generation, bytes, 0));
            Ok(())
        }

        pub fn discard_except(&mut self, generation: u64) {
            while let Some((gen, _, _)) = self.items.front() {
                if *gen == generation {
                    break;
                }
                if let Some((_, bytes, _)) = self.items.pop_front() {
                    self.total_bytes = self.total_bytes.saturating_sub(bytes.len());
                }
            }
        }

        pub fn peek_chunk(&self, generation: u64, max_payload: usize) -> Option<&[u8]> {
            let (gen, bytes, off) = self.items.front()?;
            if *gen != generation || *off >= bytes.len() {
                return None;
            }
            let end = (*off + max_payload.max(1)).min(bytes.len());
            Some(&bytes[*off..end])
        }

        pub fn advance(&mut self, n: usize) {
            let done = if let Some((_, bytes, off)) = self.items.front_mut() {
                *off = (*off + n).min(bytes.len());
                *off >= bytes.len()
            } else {
                false
            };
            if done {
                if let Some((_, bytes, _)) = self.items.pop_front() {
                    self.total_bytes = self.total_bytes.saturating_sub(bytes.len());
                }
            }
        }

        pub fn clear(&mut self) {
            self.items.clear();
            self.total_bytes = 0;
        }

        pub fn is_empty(&self) -> bool {
            self.items.is_empty()
        }
    }
}

/// Bit 63 tags BLE connection generations so they can never collide with
/// USB serial connection generations (`1..`).
pub const BLE_GENERATION_BIT: u64 = 1 << 63;

pub fn is_ble_generation(generation: u64) -> bool {
    generation != 0 && generation != u64::MAX && (generation & BLE_GENERATION_BIT) != 0
}

#[cfg(any(target_os = "macos", test))]
pub fn next_ble_generation(prev: u64) -> u64 {
    let seq = (prev & !BLE_GENERATION_BIT)
        .wrapping_add(1)
        & 0x3fff_ffff_ffff_ffff;
    BLE_GENERATION_BIT | if seq == 0 { 1 } else { seq }
}

/// Strict outbound topic allowlist for the BLE desktop channel.
/// Mirrors `firmware/main/pet_p4_ble.c` / `pet_p4_protocol.c`: blocks firmware
/// OTA, raw binary UART streams, LAN trust/credentials, music streaming, and
/// voice/audio streams (while keeping one-shot `audio/volume` master volume).
pub fn ble_topic_allowed(topic: &str, payload: &serde_json::Value) -> bool {
    if topic == "control/command" {
        return payload.get("type").and_then(|v| v.as_str()) != Some("audio_bridge");
    }
    if topic.starts_with("state/") {
        return true;
    }
    matches!(
        topic,
        "bind"
            | "ack"
            | "system/heartbeat"
            | "system/reboot"
            | "system/reset-inputs"
            | "speech/text"
            | "runtime/stats"
            | "session/current"
            | "control/remote-cli-binding"
            | "control/screen-page"
            | "input/config"
            | "input/config-query"
            | "keyboard/config"
            | "audio/volume"
            | "diagnostics/query"
            | "ui/test-message"
            | "ui/text-pixels"
            | "resources/bubble-font"
            | "widget/list"
            | "widget/activate"
            | "widget/delete"
            | "widget/begin"
            | "widget/chunk"
            | "widget/commit"
            | "widget/status"
            | "widget/data"
            | "widget/notify"
            | "widget/catalog_inspect"
            | "widget/catalog_reconcile"
            | "widget/program-query"
            | "widget/program-inspect"
            | "widget/program-start"
            | "widget/program-stop"
            | "app/snapshot"
            | "app/image"
            | "asset/slot-query"
            | "asset/stat"
            | "asset/activate"
            | "asset/begin"
            | "asset/chunk"
            | "asset/file"
            | "asset/commit"
            | "asset/abort"
    )
}

/// Unified authenticated BLE link state. Kept in one snapshot so hello/identity
/// never races disconnect cleanup across threads.
#[cfg(target_os = "macos")]
#[derive(Debug, Clone, Default)]
pub struct BleStatus {
    pub secure_bonded: bool,
    pub generation: u64,
    pub board_device_id: Option<String>,
    pub hello: Option<serde_json::Value>,
}

/// Keep macOS from putting the backgrounded companion app into App Nap while
/// still allowing normal idle system sleep.
#[cfg(target_os = "macos")]
pub fn prevent_macos_app_nap() {
    use objc2::rc::Retained;
    use objc2::runtime::NSObjectProtocol;
    use objc2_foundation::{NSActivityOptions, NSProcessInfo, NSString};
    use std::sync::OnceLock;

    struct ActivityToken(#[allow(dead_code)] Retained<objc2::runtime::ProtocolObject<dyn NSObjectProtocol>>);
    unsafe impl Send for ActivityToken {}
    unsafe impl Sync for ActivityToken {}

    static ACTIVITY: OnceLock<ActivityToken> = OnceLock::new();
    let _ = ACTIVITY.get_or_init(|| {
        let info = NSProcessInfo::processInfo();
        let reason = NSString::from_str(
            "Maintain HachimiDock companion BLE/USB link and agent status synchronization",
        );
        let token = info.beginActivityWithOptions_reason(
            NSActivityOptions::UserInitiatedAllowingIdleSystemSleep,
            &reason,
        );
        ActivityToken(token)
    });
}

#[cfg(not(target_os = "macos"))]
pub fn prevent_macos_app_nap() {}

#[cfg(target_os = "macos")]
pub mod imp {
    use super::pure::{self, BoundedLineQueue, LineReassembler};
    use super::BleStatus;
    use dispatch2::{DispatchQueue, DispatchRetained, DispatchTime};
    use objc2::rc::Retained;
    use objc2::runtime::ProtocolObject;
    use objc2::{define_class, AnyThread, Message};
    use objc2_core_bluetooth::{
        CBAdvertisementDataLocalNameKey, CBAdvertisementDataServiceUUIDsKey, CBCentralManager,
        CBCentralManagerDelegate, CBCharacteristic, CBCharacteristicWriteType, CBManagerState,
        CBPeripheral, CBPeripheralDelegate, CBService, CBUUID,
    };
    use objc2_foundation::{NSArray, NSData, NSError, NSObject, NSObjectProtocol, NSString};
    use std::collections::HashMap;
    use std::sync::atomic::{AtomicBool, Ordering};
    use std::sync::mpsc::{channel, Sender};
    use std::sync::{Arc, Mutex, OnceLock};
    use std::time::{Duration, Instant};

    pub const CTL: &str = "FDA67473-3FDC-4C62-8644-2570735C5D29";
    const DATA_SERVICE: &str = "E3DB074D-BDB5-4577-88F2-E2D24057432A";
    const HID_SERVICE: &str = "1812";
    pub const BOARD_NAME: &str = "HachimiDock";
    const MAX_PENDING_LINES: usize = 512;
    const MAX_PENDING_BYTES: usize = 512 * 1024;
    const BACKPRESSURE_RETRY_NS: i64 = 20_000_000; // 20 ms
    const RECONNECT_SCAN_DELAY_NS: i64 = 1_000_000_000; // 1 s
    const CONNECTED_POLL_INTERVAL_NS: i64 = 2_000_000_000; // 2 s
    const INCOMPATIBLE_COOLDOWN: Duration = Duration::from_secs(60);
    const AUTH_FAILURE_COOLDOWN: Duration = Duration::from_secs(15);

    /// Lifecycle events emitted upward with their exact generation tag.
    #[derive(Debug, Clone)]
    pub enum BleEvent {
        Connected,
        Disconnected(u64),
        Secure(u64),
        /// macOS reported "Peer removed pairing information" (CBError 14).
        PairingRemoved,
    }

    struct QueueOwned {
        periph: Option<Retained<CBPeripheral>>,
        ctl: Option<Retained<CBCharacteristic>>,
        lines: LineReassembler,
        scan_epoch: u64,
        incompatible: HashMap<String, Instant>,
    }

    struct Runtime {
        queue: DispatchRetained<DispatchQueue>,
        status: Mutex<BleStatus>,
        tx_queue: Mutex<BoundedLineQueue>,
        cb_state: Mutex<QueueOwned>,
        tx_line: Mutex<Sender<(u64, String)>>,
        tx_event: Mutex<Sender<BleEvent>>,
        retry_scheduled: AtomicBool,
    }

    impl Runtime {
        fn emit_event(&self, event: BleEvent) {
            if let Ok(tx) = self.tx_event.lock() {
                let _ = tx.send(event);
            }
        }

        fn emit_line(&self, generation: u64, line: String) {
            if let Ok(tx) = self.tx_line.lock() {
                let _ = tx.send((generation, line));
            }
        }
    }

    // SAFETY: Every field is `Send + Sync` except the CoreBluetooth `Retained`
    // handles inside `cb_state` (only accessed on our serial GCD `queue`) and
    // `DispatchRetained<DispatchQueue>` (thread-safe GCD queue handle).
    unsafe impl Send for Runtime {}
    unsafe impl Sync for Runtime {}

    struct OwnedCentral {
        central: Retained<CBCentralManager>,
        #[allow(dead_code)]
        delegate: Retained<BleDelegate>,
    }

    unsafe impl Send for OwnedCentral {}
    unsafe impl Sync for OwnedCentral {}

    static RUNTIME: OnceLock<Arc<Runtime>> = OnceLock::new();
    static CENTRAL: OnceLock<OwnedCentral> = OnceLock::new();

    fn runtime() -> Option<&'static Arc<Runtime>> {
        RUNTIME.get()
    }

    fn data_uuid() -> Retained<CBUUID> {
        unsafe { CBUUID::UUIDWithString(&NSString::from_str(DATA_SERVICE)) }
    }

    fn hid_uuid() -> Retained<CBUUID> {
        unsafe { CBUUID::UUIDWithString(&NSString::from_str(HID_SERVICE)) }
    }

    fn peripheral_matches(cb: &QueueOwned, p: &CBPeripheral) -> bool {
        cb.periph
            .as_ref()
            .is_some_and(|cur| Retained::as_ptr(cur) as *const CBPeripheral == p as *const CBPeripheral)
    }

    unsafe fn peripheral_id_string(p: &CBPeripheral) -> String {
        p.identifier().UUIDString().to_string()
    }

    /// Must only be called on `runtime().queue`. Returns whether this peripheral
    /// recently lacked the BLE desktop service/characteristic and is cooling down.
    unsafe fn is_incompatible_on_queue(rt: &Arc<Runtime>, p: &CBPeripheral) -> bool {
        let id = peripheral_id_string(p);
        let now = Instant::now();
        rt.cb_state
            .lock()
            .ok()
            .is_some_and(|mut cb| {
                cb.incompatible.retain(|_, until| *until > now);
                cb.incompatible.contains_key(&id)
            })
    }

    unsafe fn mark_cooldown_on_queue(rt: &Arc<Runtime>, p: &CBPeripheral, duration: Duration) {
        let id = peripheral_id_string(p);
        let until = Instant::now() + duration;
        if let Ok(mut cb) = rt.cb_state.lock() {
            cb.incompatible
                .entry(id)
                .and_modify(|existing| *existing = (*existing).max(until))
                .or_insert(until);
        }
    }

    unsafe fn mark_incompatible_on_queue(rt: &Arc<Runtime>, p: &CBPeripheral) {
        mark_cooldown_on_queue(rt, p, INCOMPATIBLE_COOLDOWN);
    }

    /// Must only be called on `runtime().queue`. Returns the board if macOS
    /// already maintains an OS-level connection to it (e.g. bonded HID auto-reconnect).
    unsafe fn find_connected_board_on_queue(
        rt: &Arc<Runtime>,
        central: &CBCentralManager,
    ) -> Option<Retained<CBPeripheral>> {
        let data_services = NSArray::from_retained_slice(&[data_uuid()]);
        for candidate in central
            .retrieveConnectedPeripheralsWithServices(&data_services)
            .iter()
        {
            if !is_incompatible_on_queue(rt, &candidate) {
                return Some(candidate);
            }
        }
        let hid_services = NSArray::from_retained_slice(&[hid_uuid()]);
        for candidate in central
            .retrieveConnectedPeripheralsWithServices(&hid_services)
            .iter()
        {
            if candidate
                .name()
                .is_some_and(|name| name.to_string() == BOARD_NAME)
                && !is_incompatible_on_queue(rt, &candidate)
            {
                return Some(candidate);
            }
        }
        None
    }

    /// Must only be called on `runtime().queue`. Periodically checks whether macOS
    /// `bluetoothd` auto-reconnected the bonded HID board while we are scanning,
    /// since an OS-connected peripheral stops advertising and will not trigger
    /// `didDiscoverPeripheral`.
    fn schedule_connected_poll_on_queue(rt: &Arc<Runtime>, expected_epoch: u64) {
        let rt_clone = rt.clone();
        let when = DispatchTime::NOW.time(CONNECTED_POLL_INTERVAL_NS);
        let _ = rt.queue.after(when, move || {
            let should_poll = rt_clone
                .cb_state
                .lock()
                .ok()
                .is_some_and(|cb| cb.periph.is_none() && cb.scan_epoch == expected_epoch);
            if !should_poll {
                return;
            }
            let Some(owned) = CENTRAL.get() else { return };
            unsafe {
                if owned.central.state() != CBManagerState::PoweredOn {
                    return;
                }
                if let Some(board) = find_connected_board_on_queue(&rt_clone, &owned.central) {
                    connect_board_on_queue(&owned.delegate, &owned.central, &board);
                    return;
                }
            }
            schedule_connected_poll_on_queue(&rt_clone, expected_epoch);
        });
    }

    /// Must only be called on `runtime().queue`.
    unsafe fn start_scan_on_queue(delegate: &BleDelegate, central: &CBCentralManager) {
        if central.state() != CBManagerState::PoweredOn {
            return;
        }
        let Some(rt) = runtime() else { return };
        if let Some(board) = find_connected_board_on_queue(rt, central) {
            connect_board_on_queue(delegate, central, &board);
            return;
        }
        let poll_epoch = match rt.cb_state.lock() {
            Ok(mut cb) => {
                if cb.periph.is_some() {
                    return;
                }
                cb.scan_epoch = cb.scan_epoch.wrapping_add(1);
                cb.scan_epoch
            }
            Err(_) => return,
        };
        let scan_services = NSArray::from_retained_slice(&[data_uuid(), hid_uuid()]);
        central.scanForPeripheralsWithServices_options(Some(&scan_services), None);
        schedule_connected_poll_on_queue(rt, poll_epoch);
    }

    /// Must only be called on `runtime().queue`. Cancels a failed or incompatible
    /// peripheral so `did_disconnect` clears `cb_state.periph` and schedules rescan.
    unsafe fn cancel_peripheral_on_queue(p: &CBPeripheral) {
        if let Some(owned) = CENTRAL.get() {
            owned.central.cancelPeripheralConnection(p);
        }
    }

    /// Must only be called on `runtime().queue`.
    unsafe fn connect_board_on_queue(
        delegate: &BleDelegate,
        central: &CBCentralManager,
        board: &CBPeripheral,
    ) {
        let Some(rt) = runtime() else { return };
        central.stopScan();
        board.setDelegate(Some(ProtocolObject::from_ref::<BleDelegate>(delegate)));
        if let Ok(mut cb) = rt.cb_state.lock() {
            cb.scan_epoch = cb.scan_epoch.wrapping_add(1);
            cb.periph = Some(board.retain());
        }
        central.connectPeripheral_options(board, None);
    }

    /// Must only be called on `runtime().queue`.
    fn schedule_rescan_on_queue(rt: &Arc<Runtime>, expected_epoch: u64) {
        let rt_clone = rt.clone();
        let when = DispatchTime::NOW.time(RECONNECT_SCAN_DELAY_NS);
        let _ = rt.queue.after(when, move || {
            let should_scan = rt_clone
                .cb_state
                .lock()
                .ok()
                .is_some_and(|cb| cb.periph.is_none() && cb.scan_epoch == expected_epoch);
            if !should_scan {
                return;
            }
            if let Some(owned) = CENTRAL.get() {
                unsafe {
                    start_scan_on_queue(&owned.delegate, &owned.central);
                }
            }
        });
    }

    /// Drain queued JSONL lines on `runtime().queue` using the live negotiated ATT MTU.
    fn pump_on_queue() {
        let Some(rt) = runtime() else { return };
        let (periph, ctl) = match rt.cb_state.lock() {
            Ok(cb) => (cb.periph.clone(), cb.ctl.clone()),
            Err(_) => return,
        };
        let (Some(p), Some(ctl)) = (periph, ctl) else {
            return;
        };
        let (secure, generation) = match rt.status.lock() {
            Ok(s) => (s.secure_bonded, s.generation),
            Err(_) => return,
        };
        if !secure || generation == 0 {
            return;
        }
        let max_write = unsafe {
            p.maximumWriteValueLengthForType(CBCharacteristicWriteType::WithoutResponse)
        }
        .max(20) as usize;

        let Ok(mut pending) = rt.tx_queue.lock() else {
            return;
        };
        pending.discard_except(generation);
        while let Some(chunk) = pending.peek_chunk(generation, max_write) {
            if unsafe { !p.canSendWriteWithoutResponse() } {
                if !rt.retry_scheduled.swap(true, Ordering::AcqRel) {
                    let rt_clone = rt.clone();
                    let when = DispatchTime::NOW.time(BACKPRESSURE_RETRY_NS);
                    let _ = rt.queue.after(when, move || {
                        rt_clone.retry_scheduled.store(false, Ordering::Release);
                        pump_on_queue();
                    });
                }
                return;
            }
            let data = NSData::with_bytes(chunk);
            let written = chunk.len();
            unsafe {
                p.writeValue_forCharacteristic_type(
                    &data,
                    &ctl,
                    CBCharacteristicWriteType::WithoutResponse,
                );
            }
            pending.advance(written);
        }
    }

    define_class!(
        #[unsafe(super(NSObject))]
        #[name = "HachimoBleDelegate"]
        struct BleDelegate;

        unsafe impl NSObjectProtocol for BleDelegate {}

        unsafe impl CBCentralManagerDelegate for BleDelegate {
            #[unsafe(method(centralManagerDidUpdateState:))]
            unsafe fn central_manager_did_update_state(&self, c: &CBCentralManager) {
                let Some(rt) = runtime() else { return };
                let state = c.state();
                let state_str = match state {
                    CBManagerState::PoweredOn => "powered_on",
                    CBManagerState::PoweredOff => "powered_off",
                    CBManagerState::Unauthorized => "unauthorized",
                    CBManagerState::Unsupported => "unsupported",
                    _ => "initializing",
                };
                eprintln!("[ble] central state={state_str}");
                if state == CBManagerState::PoweredOn {
                    let idle = rt.cb_state.lock().ok().is_some_and(|cb| cb.periph.is_none());
                    if idle {
                        start_scan_on_queue(self, c);
                    }
                } else {
                    let old_gen = rt.status.lock().ok().map(|mut s| {
                        let prev = if s.secure_bonded { s.generation } else { 0 };
                        s.secure_bonded = false;
                        s.board_device_id = None;
                        s.hello = None;
                        prev
                    }).unwrap_or(0);
                    if let Ok(mut cb) = rt.cb_state.lock() {
                        cb.periph = None;
                        cb.ctl = None;
                        cb.lines = LineReassembler::default();
                        cb.scan_epoch = cb.scan_epoch.wrapping_add(1);
                    }
                    if let Ok(mut q) = rt.tx_queue.lock() {
                        q.clear();
                    }
                    if old_gen != 0 {
                        eprintln!("[ble] disconnected gen={old_gen}");
                        rt.emit_event(BleEvent::Disconnected(old_gen));
                    }
                }
            }

            #[unsafe(method(centralManager:didDiscoverPeripheral:advertisementData:RSSI:))]
            unsafe fn did_discover(
                &self,
                c: &CBCentralManager,
                p: &CBPeripheral,
                ad: &objc2_foundation::NSDictionary,
                _rssi: &objc2_foundation::NSNumber,
            ) {
                let Some(rt) = runtime() else { return };
                if rt.cb_state.lock().ok().is_some_and(|cb| cb.periph.is_some()) {
                    return;
                }
                let advertised = ad
                    .objectForKey(CBAdvertisementDataServiceUUIDsKey)
                    .and_then(|value| value.downcast::<NSArray>().ok())
                    .is_some_and(|services| services.containsObject(&data_uuid()));
                let local_name = ad
                    .objectForKey(CBAdvertisementDataLocalNameKey)
                    .and_then(|value| value.downcast::<NSString>().ok())
                    .is_some_and(|name| name.to_string() == BOARD_NAME);
                if (advertised || local_name || p.name().is_some_and(|name| name.to_string() == BOARD_NAME))
                    && !is_incompatible_on_queue(rt, p)
                {
                    connect_board_on_queue(self, c, p);
                }
            }

            #[unsafe(method(centralManager:didConnectPeripheral:))]
            unsafe fn did_connect(&self, _c: &CBCentralManager, p: &CBPeripheral) {
                let Some(rt) = runtime() else { return };
                if !rt.cb_state.lock().ok().is_some_and(|cb| peripheral_matches(&cb, p)) {
                    return;
                }
                rt.emit_event(BleEvent::Connected);
                let services = NSArray::from_retained_slice(&[data_uuid()]);
                p.discoverServices(Some(&services));
            }

            #[unsafe(method(centralManager:didDisconnectPeripheral:error:))]
            unsafe fn did_disconnect(
                &self,
                _c: &CBCentralManager,
                p: &CBPeripheral,
                e: Option<&NSError>,
            ) {
                let Some(rt) = runtime() else { return };
                if !rt.cb_state.lock().ok().is_some_and(|cb| peripheral_matches(&cb, p)) {
                    return;
                }
                if e.is_some_and(|err| err.code() == 14) {
                    rt.emit_event(BleEvent::PairingRemoved);
                }
                let old_gen = rt.status.lock().ok().map(|mut status| {
                    let prev = if status.secure_bonded { status.generation } else { 0 };
                    status.secure_bonded = false;
                    status.board_device_id = None;
                    status.hello = None;
                    prev
                }).unwrap_or(0);
                let epoch = rt.cb_state.lock().ok().map(|mut cb| {
                    cb.periph = None;
                    cb.ctl = None;
                    cb.lines = LineReassembler::default();
                    cb.scan_epoch = cb.scan_epoch.wrapping_add(1);
                    cb.scan_epoch
                }).unwrap_or(0);
                if let Ok(mut pending) = rt.tx_queue.lock() {
                    pending.clear();
                }
                if old_gen != 0 {
                    eprintln!("[ble] disconnected gen={old_gen}");
                    rt.emit_event(BleEvent::Disconnected(old_gen));
                } else {
                    // Peripheral disconnected before reaching secure_bonded (e.g. unpaired
                    // nearby board or rejected auth). Cool down briefly to avoid 1s spin loops.
                    mark_cooldown_on_queue(rt, p, AUTH_FAILURE_COOLDOWN);
                }
                schedule_rescan_on_queue(rt, epoch);
            }

            #[unsafe(method(centralManager:didFailToConnectPeripheral:error:))]
            unsafe fn did_fail_to_connect(
                &self,
                _c: &CBCentralManager,
                p: &CBPeripheral,
                e: Option<&NSError>,
            ) {
                let Some(rt) = runtime() else { return };
                if !rt.cb_state.lock().ok().is_some_and(|cb| peripheral_matches(&cb, p)) {
                    return;
                }
                if e.is_some_and(|err| err.code() == 14) {
                    rt.emit_event(BleEvent::PairingRemoved);
                }
                mark_cooldown_on_queue(rt, p, AUTH_FAILURE_COOLDOWN);
                let epoch = rt.cb_state.lock().ok().map(|mut cb| {
                    cb.periph = None;
                    cb.ctl = None;
                    cb.scan_epoch = cb.scan_epoch.wrapping_add(1);
                    cb.scan_epoch
                }).unwrap_or(0);
                schedule_rescan_on_queue(rt, epoch);
            }
        }

        unsafe impl CBPeripheralDelegate for BleDelegate {
            #[unsafe(method(peripheral:didDiscoverServices:))]
            unsafe fn did_discover_services(
                &self,
                p: &CBPeripheral,
                error: Option<&NSError>,
            ) {
                let Some(rt) = runtime() else { return };
                if !rt.cb_state.lock().ok().is_some_and(|cb| peripheral_matches(&cb, p)) {
                    return;
                }
                if let Some(error) = error {
                    eprintln!("[ble] service discovery failed: {error:?}");
                    cancel_peripheral_on_queue(p);
                    return;
                }
                let target = data_uuid();
                let mut found = false;
                if let Some(svcs) = p.services() {
                    for s in svcs.iter() {
                        if s.UUID() == target {
                            found = true;
                            let ctl_uuid = CBUUID::UUIDWithString(&NSString::from_str(CTL));
                            let chars = NSArray::from_retained_slice(&[ctl_uuid]);
                            p.discoverCharacteristics_forService(Some(&chars), &s);
                        }
                    }
                }
                if !found {
                    eprintln!("[ble] data service missing on connected peripheral; cooling down");
                    mark_incompatible_on_queue(rt, p);
                    cancel_peripheral_on_queue(p);
                }
            }

            #[unsafe(method(peripheral:didDiscoverCharacteristicsForService:error:))]
            unsafe fn did_discover_chars(
                &self,
                p: &CBPeripheral,
                svc: &CBService,
                error: Option<&NSError>,
            ) {
                let Some(rt) = runtime() else { return };
                if !rt.cb_state.lock().ok().is_some_and(|cb| peripheral_matches(&cb, p)) {
                    return;
                }
                if let Some(error) = error {
                    eprintln!("[ble] characteristic discovery failed: {error:?}");
                    cancel_peripheral_on_queue(p);
                    return;
                }
                let mut found_ctl = false;
                if let Some(chars) = svc.characteristics() {
                    for ch in chars.iter() {
                        if ch.UUID().UUIDString().to_string().eq_ignore_ascii_case(CTL) {
                            found_ctl = true;
                            if let Ok(mut cb) = rt.cb_state.lock() {
                                cb.ctl = Some(ch.clone());
                            }
                            p.setNotifyValue_forCharacteristic(true, &ch);
                        }
                    }
                }
                if !found_ctl {
                    eprintln!("[ble] control characteristic missing; cooling down");
                    mark_incompatible_on_queue(rt, p);
                    cancel_peripheral_on_queue(p);
                }
            }

            #[unsafe(method(peripheral:didUpdateNotificationStateForCharacteristic:error:))]
            unsafe fn did_update_subscription(
                &self,
                p: &CBPeripheral,
                ch: &CBCharacteristic,
                error: Option<&NSError>,
            ) {
                let Some(rt) = runtime() else { return };
                if !rt.cb_state.lock().ok().is_some_and(|cb| peripheral_matches(&cb, p)) {
                    return;
                }
                if !ch.UUID().UUIDString().to_string().eq_ignore_ascii_case(CTL) {
                    return;
                }
                if let Some(error) = error {
                    eprintln!("[ble] notification subscribe failed: {error:?}");
                    cancel_peripheral_on_queue(p);
                    return;
                }
                if ch.isNotifying() {
                    // Authenticated read initiates SMP pairing/encryption before bind.
                    p.readValueForCharacteristic(ch);
                } else {
                    cancel_peripheral_on_queue(p);
                }
            }

            #[unsafe(method(peripheral:didUpdateValueForCharacteristic:error:))]
            unsafe fn did_update_value(
                &self,
                p: &CBPeripheral,
                ch: &CBCharacteristic,
                error: Option<&NSError>,
            ) {
                if !ch.UUID().UUIDString().to_string().eq_ignore_ascii_case(CTL) {
                    return;
                }
                let Some(rt) = runtime() else { return };
                if !rt.cb_state.lock().ok().is_some_and(|cb| peripheral_matches(&cb, p)) {
                    return;
                }
                if let Some(error) = error {
                    eprintln!(
                        "[ble] value update failed for {}: {error:?}",
                        ch.UUID().UUIDString()
                    );
                    let not_secure = rt.status.lock().ok().is_none_or(|s| !s.secure_bonded);
                    if not_secure {
                        cancel_peripheral_on_queue(p);
                    }
                    return;
                }
                let Some(data) = ch.value() else { return };
                let bytes = data.to_vec();

                let is_probe = pure::is_ble_ready_probe(&bytes);
                let mut became_secure_gen = None;
                let mut reject_unauth_probe = false;
                let generation = {
                    let Ok(mut status) = rt.status.lock() else { return };
                    if !status.secure_bonded {
                        if !is_probe {
                            reject_unauth_probe = bytes.starts_with(b"{\"ble\":");
                            0
                        } else {
                            let next_gen = super::next_ble_generation(status.generation);
                            status.generation = next_gen;
                            status.secure_bonded = true;
                            became_secure_gen = Some(next_gen);
                            next_gen
                        }
                    } else {
                        status.generation
                    }
                };
                if generation == 0 {
                    if reject_unauth_probe {
                        eprintln!("[ble] unauthenticated ready probe rejected; cancelling");
                        cancel_peripheral_on_queue(p);
                    }
                    return;
                }
                if let Some(gen) = became_secure_gen {
                    eprintln!("[ble] secure link ready gen={gen}");
                    rt.emit_event(BleEvent::Secure(gen));
                }
                if is_probe {
                    return;
                }

                let complete_lines = match rt.cb_state.lock() {
                    Ok(mut cb) => cb.lines.push(&bytes),
                    Err(_) => return,
                };
                for line in complete_lines {
                    if let Ok(message) = serde_json::from_str::<serde_json::Value>(&line) {
                        if message.get("topic").and_then(serde_json::Value::as_str) == Some("hello") {
                            let payload = message.get("payload").cloned().unwrap_or(serde_json::Value::Null);
                            if let Ok(mut status) = rt.status.lock() {
                                if status.secure_bonded && status.generation == generation {
                                    status.board_device_id = payload
                                        .get("boardDeviceId")
                                        .and_then(serde_json::Value::as_str)
                                        .map(str::to_owned);
                                    status.hello = Some(payload);
                                }
                            }
                        }
                    }
                    rt.emit_line(generation, line);
                }
            }

            #[unsafe(method(peripheralIsReadyToSendWriteWithoutResponse:))]
            unsafe fn ready_to_send(&self, p: &CBPeripheral) {
                let Some(rt) = runtime() else { return };
                if !rt.cb_state.lock().ok().is_some_and(|cb| peripheral_matches(&cb, p)) {
                    return;
                }
                pump_on_queue();
            }
        }
    );

    /// Public CoreBluetooth desktop transport handle.
    pub struct BleTransport {
        runtime: Arc<Runtime>,
    }

    impl BleTransport {
        pub fn new<F, G>(on_line: F, on_event: G) -> Self
        where
            F: Fn(u64, String) + Send + 'static,
            G: Fn(BleEvent) + Send + 'static,
        {
            let (line_tx, line_rx) = channel::<(u64, String)>();
            let (ev_tx, ev_rx) = channel::<BleEvent>();
            let queue = DispatchQueue::new("com.hachimodock.ble", None);
            let rt = Arc::new(Runtime {
                queue,
                status: Mutex::new(BleStatus::default()),
                tx_queue: Mutex::new(BoundedLineQueue::new(MAX_PENDING_LINES, MAX_PENDING_BYTES)),
                cb_state: Mutex::new(QueueOwned {
                    periph: None,
                    ctl: None,
                    lines: LineReassembler::default(),
                    scan_epoch: 0,
                    incompatible: HashMap::new(),
                }),
                tx_line: Mutex::new(line_tx),
                tx_event: Mutex::new(ev_tx),
                retry_scheduled: AtomicBool::new(false),
            });
            let _ = RUNTIME.set(rt.clone());

            let _ = std::thread::Builder::new()
                .name("ble-dispatch".into())
                .spawn(move || {
                    for (gen, line) in line_rx {
                        on_line(gen, line);
                    }
                });
            let _ = std::thread::Builder::new()
                .name("ble-events".into())
                .spawn(move || {
                    for ev in ev_rx {
                        on_event(ev);
                    }
                });

            Self { runtime: rt }
        }

        /// Start `CBCentralManager` on the dedicated serial GCD queue after the
        /// caller has registered all transport handles/backends.
        pub fn start_central(&self) {
            let init_rt = self.runtime.clone();
            self.runtime.queue.exec_async(move || {
                let delegate: Retained<BleDelegate> =
                    unsafe { objc2::msg_send![BleDelegate::alloc(), init] };
                let central = unsafe {
                    CBCentralManager::initWithDelegate_queue(
                        CBCentralManager::alloc(),
                        Some(ProtocolObject::from_ref::<BleDelegate>(&*delegate)),
                        Some(&init_rt.queue),
                    )
                };
                let _ = CENTRAL.set(OwnedCentral { central, delegate });
            });
        }

        /// Enqueue a JSONL line strictly bound to `generation`; chunking and
        /// CoreBluetooth writes execute on the dedicated serial CB queue.
        pub fn send_line_bound(&self, generation: u64, line: &str) -> Result<(), String> {
            {
                let status = self.runtime.status.lock().map_err(|_| "蓝牙状态不可用")?;
                if !status.secure_bonded || status.generation != generation {
                    return Err("蓝牙连接已变化".into());
                }
            }
            {
                let mut pending = self.runtime.tx_queue.lock().map_err(|_| "蓝牙发送队列不可用")?;
                pending.push_line(generation, line).map_err(|e| e.to_string())?;
            }
            self.runtime.queue.exec_async(pump_on_queue);
            Ok(())
        }

        pub fn verify_current_board(&self, board: &str, generation: u64) -> Result<(), String> {
            let status = self.runtime.status.lock().map_err(|_| "蓝牙状态不可用")?;
            if !status.secure_bonded
                || status.generation != generation
                || status.board_device_id.as_deref() != Some(board)
            {
                return Err("蓝牙设备连接已变化".into());
            }
            Ok(())
        }

        pub fn clear_tx_queue(&self) {
            if let Ok(mut pending) = self.runtime.tx_queue.lock() {
                pending.clear();
            }
        }

        pub fn status(&self) -> BleStatus {
            self.runtime
                .status
                .lock()
                .map(|s| s.clone())
                .unwrap_or_default()
        }
    }
}

#[cfg(test)]
mod tests {
    use super::pure::*;

    #[test]
    fn control_chunk_and_reassemble_roundtrip() {
        let line = "{\"topic\":\"hello\",\"payload\":{\"a\":1}}";
        let chunks = chunk_line(line, 17);
        assert!(chunks.len() > 1);
        assert!(chunks.last().unwrap().ends_with(b"\n"));
        let mut ra = LineReassembler::default();
        let mut got = Vec::new();
        for c in &chunks {
            got.extend(ra.push(c));
        }
        assert_eq!(got, vec![line.to_string()]);
    }

    #[test]
    fn reassembler_drops_overlong_and_recovers_after_newline() {
        let mut ra = LineReassembler::default();
        assert!(ra.push(&vec![b'x'; LineReassembler::LIMIT + 10]).is_empty());
        assert_eq!(ra.dropped_overlong, 1);
        assert!(ra.push(b"still-overlong\n{\"topic\":\"a\"}\r\n") == vec!["{\"topic\":\"a\"}"]);
        assert_eq!(ra.dropped_overlong, 1);
    }

    #[test]
    fn ready_probe_matches_only_secured_non_newline_probe() {
        assert!(is_ble_ready_probe(b"{\"ble\":\"ready\",\"secure\":true,\"bonded\":1}"));
        assert!(!is_ble_ready_probe(b"{\"ble\":\"ready\",\"secure\":true}\n"));
        assert!(!is_ble_ready_probe(b"{\"ble\":\"ready\",\"secure\":false}"));
        assert!(!is_ble_ready_probe(b"{\"topic\":\"hello\",\"payload\":{}}\n"));
    }

    #[test]
    fn bounded_line_queue_enforces_limits_and_generation_isolation() {
        let mut q = BoundedLineQueue::new(2, 32);
        q.push_line(1, "hello").unwrap();
        q.push_line(1, "world").unwrap();
        assert!(q.push_line(1, "overflow").is_err());
        assert_eq!(q.peek_chunk(1, 3), Some(&b"hel"[..]));
        q.advance(3);
        assert_eq!(q.peek_chunk(1, 10), Some(&b"lo\n"[..]));
        q.advance(3);
        assert_eq!(q.peek_chunk(1, 10), Some(&b"world\n"[..]));
        q.discard_except(2);
        assert!(q.is_empty());
    }

    #[test]
    fn ble_topic_allowlist_and_generation_tagging() {
        use super::{ble_topic_allowed, is_ble_generation, next_ble_generation, BLE_GENERATION_BIT};
        use serde_json::json;

        assert!(!is_ble_generation(0));
        assert!(!is_ble_generation(1));
        assert!(!is_ble_generation(u64::MAX));
        assert!(is_ble_generation(BLE_GENERATION_BIT | 1));

        let mut gen = 0u64;
        for expected_seq in 1u64..=10 {
            let next = next_ble_generation(gen);
            assert!(is_ble_generation(next), "generation {next} must be valid BLE generation");
            assert_eq!(next, BLE_GENERATION_BIT | expected_seq);
            assert_ne!(next, gen);
            gen = next;
        }
        assert_eq!(
            next_ble_generation(BLE_GENERATION_BIT | 0x3fff_ffff_ffff_ffff),
            BLE_GENERATION_BIT | 1
        );

        for topic in [
            "system/heartbeat",
            "state/antigravity",
            "state/active",
            "session/current",
            "control/remote-cli-binding",
            "audio/volume",
            "resources/bubble-font",
            "ui/test-message",
            "ui/text-pixels",
            "widget/data",
            "widget/notify",
            "widget/begin",
            "asset/chunk",
            "keyboard/config",
        ] {
            assert!(ble_topic_allowed(topic, &json!({})), "expected {topic} allowed");
        }
        assert!(ble_topic_allowed("control/command", &json!({"command": "ping"})));
        assert!(!ble_topic_allowed("control/command", &json!({"type": "audio_bridge", "action": "start"})));
        for blocked in [
            "firmware/begin",
            "firmware/chunk",
            "control/apply-wifi",
            "lan/trust",
            "component/credential-set",
            "component/network-status-query",
            "audio/control",
            "audio/play_chunk",
            "audio/conversation",
            "media/begin",
            "asset/raw-chunk",
            "voice/feedback",
            "debug/screenshot",
        ] {
            assert!(!ble_topic_allowed(blocked, &json!({})), "expected {blocked} blocked");
        }
    }
}
