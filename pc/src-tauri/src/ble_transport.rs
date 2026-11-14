//! CoreBluetooth transport for newline-delimited board control messages.

pub mod pure {
    /// Chunk a control line for characteristic writes (max write length minus
    /// ATT header is handled by the caller passing the payload budget).
    pub fn chunk_line(line: &str, max_payload: usize) -> Vec<Vec<u8>> {
        let mut bytes = line.as_bytes().to_vec();
        if bytes.last() != Some(&b'\n') { bytes.push(b'\n'); }
        bytes.chunks(max_payload.max(1)).map(|c| c.to_vec()).collect()
    }

    /// Reassemble control-line bytes arriving via notifications.
    #[derive(Default)]
    pub struct LineReassembler {
        buf: Vec<u8>,
        pub dropped_overlong: u32,
    }
    impl LineReassembler {
        pub const LIMIT: usize = 32 * 1024;
        pub fn push(&mut self, data: &[u8]) -> Vec<String> {
            self.buf.extend_from_slice(data);
            let mut out = Vec::new();
            while let Some(pos) = self.buf.iter().position(|&b| b == b'\n') {
                let line: Vec<u8> = self.buf.drain(..=pos).collect();
                out.push(String::from_utf8_lossy(&line[..pos]).into_owned());
            }
            if self.buf.len() > Self::LIMIT {
                self.buf.clear();
                self.dropped_overlong += 1;
            }
            out
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
        for c in &chunks { got.extend(ra.push(c)); }
        assert_eq!(got, vec![line.to_string()]);
    }

    #[test]
    fn reassembler_drops_overlong() {
        let mut ra = LineReassembler::default();
        ra.push(&vec![b'x'; LineReassembler::LIMIT + 10]);
        assert_eq!(ra.dropped_overlong, 1);
        assert!(ra.push(b"{\"topic\":\"a\"}\n") == vec!["{\"topic\":\"a\"}"]);
    }
}

/// Adapter and authenticated link status used by the desktop.
#[derive(Debug, Clone, Default)]
pub struct BleStatus {
    pub adapter_state: Option<&'static str>,
    pub secure_bonded: bool,
    pub generation: u64,
    pub board_device_id: Option<String>,
}

#[cfg(target_os = "macos")]
pub mod imp {
    use super::pure;
    use super::BleStatus;
    use objc2::define_class;
    use objc2::rc::Retained;
    use objc2_core_bluetooth::{
        CBCentralManager, CBCentralManagerDelegate, CBCharacteristic, CBManagerState,
        CBPeripheral, CBPeripheralDelegate, CBService,
    };
    use objc2_foundation::{
        NSData, NSError, NSObject, NSObjectProtocol,
    };
    use objc2::AnyThread;
    use std::sync::mpsc::{channel, Sender};
    use std::sync::{Arc, Mutex};
    use std::collections::VecDeque;

    pub const CTL: &str = "FDA67473-3FDC-4C62-8644-2570735C5D29";
    pub const BOARD_NAME: &str = "HachimoDock";

    /// Events the transport reports upward (lines go via `on_line`).
    #[derive(Debug)]
    pub enum BleEvent {
        Connected,
        Disconnected,
        Secure,
        /// macOS reported "Peer removed pairing information" (CBError 14).
        PairingRemoved,
    }

    struct Shared {
        tx_line: Sender<String>,
        periph: Option<Retained<CBPeripheral>>,
        max_write: usize,
        tx_event: Sender<BleEvent>,
        tx_pending: Mutex<VecDeque<Vec<u8>>>,
        status: Arc<Mutex<BleStatus>>,
        lines: pure::LineReassembler,
        ctl: Option<Retained<CBCharacteristic>>,
    }

    unsafe impl Send for Shared {}
    unsafe impl Sync for Shared {}
    static SHARED: std::sync::OnceLock<Arc<Mutex<Shared>>> = std::sync::OnceLock::new();
    struct SendMgr(pub Retained<CBCentralManager>);
    unsafe impl Send for SendMgr {}
    unsafe impl Sync for SendMgr {}
    static MGR: std::sync::OnceLock<SendMgr> = std::sync::OnceLock::new();

    fn shared() -> std::sync::MutexGuard<'static, Shared> {
        SHARED.get().unwrap().lock().unwrap()
    }

    define_class!(
        #[unsafe(super(NSObject))]
        #[name = "BleDelegate"]
        struct BleDelegate;

        unsafe impl NSObjectProtocol for BleDelegate {}

        unsafe impl CBCentralManagerDelegate for BleDelegate {
            #[unsafe(method(centralManagerDidUpdateState:))]
            unsafe fn central_manager_did_update_state(&self, c: &CBCentralManager) {
                let state = c.state();
                shared().status.lock().unwrap().adapter_state = Some(match state {
                    CBManagerState::PoweredOn => "powered_on",
                    CBManagerState::PoweredOff => "powered_off",
                    CBManagerState::Unauthorized => "unauthorized",
                    CBManagerState::Unsupported => "unsupported",
                    _ => "initializing",
                });
                if state == CBManagerState::PoweredOn {
                    // The board advertises only its name (the 128-bit service
                    // UUID does not fit the 31-byte advertisement).
                    c.scanForPeripheralsWithServices_options(None, None);
                }
            }

            #[unsafe(method(centralManager:didDiscoverPeripheral:advertisementData:RSSI:))]
            unsafe fn did_discover(
                &self,
                c: &CBCentralManager,
                p: &CBPeripheral,
                _ad: &objc2_foundation::NSDictionary,
                _rssi: &objc2_foundation::NSNumber,
            ) {
                let name = unsafe { p.name() };
                if !name.is_some_and(|name| name.to_string() == BOARD_NAME) { return; }
                let id = p.identifier().UUIDString();
                eprintln!("[ble] found {id}, connecting");
                c.stopScan();
                p.setDelegate(Some(ProtocolObject::from_ref::<BleDelegate>(self)));
                // CoreBluetooth cancels the connection unless the app keeps a
                // strong reference to the peripheral.
                shared().periph = Some(p.retain());
                c.connectPeripheral_options(p, None);
            }

            #[unsafe(method(centralManager:didConnectPeripheral:))]
            unsafe fn did_connect(&self, _c: &CBCentralManager, p: &CBPeripheral) {
                let mut s = shared();
                s.max_write = unsafe {
                    p.maximumWriteValueLengthForType(
                        objc2_core_bluetooth::CBCharacteristicWriteType::WithoutResponse,
                    )
                }.max(20) as usize;

                let _ = s.tx_event.send(BleEvent::Connected);
                drop(s);
                p.discoverServices(None);
            }

            #[unsafe(method(centralManager:didDisconnectPeripheral:error:))]
            unsafe fn did_disconnect(
                &self,
                c: &CBCentralManager,
                _p: &CBPeripheral,
                e: Option<&NSError>,
            ) {
                {
                    let mut s = shared();
                    if e.is_some_and(|e| e.code() == 14) {
                        let _ = s.tx_event.send(BleEvent::PairingRemoved);
                    }
                    s.periph = None;
                    s.ctl = None;
                    s.lines = pure::LineReassembler::default();
                    {
                        let mut status = s.status.lock().unwrap();
                        status.secure_bonded = false;
                        status.board_device_id = None;
                    }
                    let _ = s.tx_event.send(BleEvent::Disconnected);
                    s.tx_pending.lock().unwrap().clear();
                }
                // Backoff via a detached timer thread, then re-scan.
                std::thread::spawn(|| {
                    std::thread::sleep(std::time::Duration::from_secs(1));
                    if let Some(m) = MGR.get().map(|w| &w.0) {
                        unsafe { m.scanForPeripheralsWithServices_options(None, None) };
                    }
                });
            }

            #[unsafe(method(centralManager:didFailToConnectPeripheral:error:))]
            unsafe fn did_fail_to_connect(
                &self,
                c: &CBCentralManager,
                _p: &CBPeripheral,
                e: Option<&NSError>,
            ) {
                {
                    let mut s = shared();
                    if e.is_some_and(|e| e.code() == 14) {
                        let _ = s.tx_event.send(BleEvent::PairingRemoved);
                    }
                    s.periph = None;
                }
                c.scanForPeripheralsWithServices_options(None, None);
            }
        }

        unsafe impl CBPeripheralDelegate for BleDelegate {
            #[unsafe(method(peripheral:didDiscoverServices:))]
            unsafe fn did_discover_services(
                &self,
                p: &CBPeripheral,
                _e: Option<&NSError>,
            ) {
                if let Some(svcs) = p.services() {
                    for s in svcs.iter() {
                        p.discoverCharacteristics_forService(None, &s);
                    }
                }
            }

            #[unsafe(method(peripheral:didDiscoverCharacteristicsForService:error:))]
            unsafe fn did_discover_chars(
                &self,
                p: &CBPeripheral,
                svc: &CBService,
                _e: Option<&NSError>,
            ) {
                if let Some(chars) = svc.characteristics() {
                    let mut s = shared();
                    for ch in chars.iter() {
                        let u = ch.UUID().UUIDString().to_string();
                        if u == CTL {
                            s.ctl = Some(ch.clone());
                            p.setNotifyValue_forCharacteristic(true, &ch);
                            // Secured read triggers pairing when unbonded.
                            p.readValueForCharacteristic(&ch);
                        }
                    }
                }
            }

            #[unsafe(method(peripheral:didUpdateValueForCharacteristic:error:))]
            unsafe fn did_update_value(
                &self,
                _p: &CBPeripheral,
                ch: &CBCharacteristic,
                error: Option<&NSError>,
            ) {
                if let Some(error) = error {
                    eprintln!("[ble] value update failed for {}: {error:?}", ch.UUID().UUIDString());
                    return;
                }
                if ch.UUID().UUIDString().to_string() != CTL { return; }
                let Some(data) = ch.value() else { return };
                let bytes = data.to_vec();
                let mut s = shared();
                // The secured read or a secured notification can arrive first.
                if !s.status.lock().unwrap().secure_bonded {
                    {
                        let mut status = s.status.lock().unwrap();
                        status.generation = status.generation.wrapping_add(1) | (1 << 63);
                        status.secure_bonded = true;
                    }
                    let _ = s.tx_event.send(BleEvent::Secure);
                }
                if bytes.starts_with(b"{\"ble\":") && bytes.last() != Some(&b'\n') {
                    return; // The secured read reply is separate from the JSONL stream.
                }
                for line in s.lines.push(&bytes) {
                    if s.status.lock().unwrap().board_device_id.is_none() {
                        if let Ok(message) = serde_json::from_str::<serde_json::Value>(&line) {
                            if message["topic"] == "hello" {
                                s.status.lock().unwrap().board_device_id = message["payload"]["boardDeviceId"].as_str().map(str::to_owned);
                            }
                        }
                    }
                    let _ = s.tx_line.send(line);
                }
            }

            #[unsafe(method(peripheralIsReadyToSendWriteWithoutResponse:))]
            unsafe fn ready_to_send(&self, _p: &CBPeripheral) {
                pump();
            }
        }
    );

    use objc2::runtime::ProtocolObject;
    use objc2::Message;

    /// Schedule a drain on the CoreBluetooth (main) queue after new work is
    /// queued; isReadyToSendWriteWithoutResponse only fires after a stall.
    fn kick() {
        dispatch2::DispatchQueue::main().exec_async(pump);
    }

    /// Drain control chunks while CoreBluetooth accepts writes without response.
    fn pump() {
        let s = shared();
        let (Some(p), Some(ctl)) = (s.periph.as_ref(), s.ctl.as_ref()) else { return };
        let mut pending = s.tx_pending.lock().unwrap();
        while let Some(bytes) = pending.front() {
            if unsafe { !p.canSendWriteWithoutResponse() } {
                // isReadyToSendWriteWithoutResponse only follows a write that
                // hit the limit; poll briefly so a not-yet-ready link (e.g.
                // right after connect) cannot stall the queue forever.
                static RETRY: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);
                if !RETRY.swap(true, std::sync::atomic::Ordering::SeqCst) {
                    std::thread::spawn(|| {
                        std::thread::sleep(std::time::Duration::from_millis(20));
                        RETRY.store(false, std::sync::atomic::Ordering::SeqCst);
                        kick();
                    });
                }
                return;
            }
            let d = unsafe { NSData::dataWithBytes_length(bytes.as_ptr() as _, bytes.len()) };
            unsafe {
                p.writeValue_forCharacteristic_type(
                    &d, ctl,
                    objc2_core_bluetooth::CBCharacteristicWriteType::WithoutResponse,
                );
            }
            pending.pop_front();
        }
    }

    /// Public transport handle.
    pub struct BleTransport {
        status: Arc<Mutex<BleStatus>>,
        shared: Arc<Mutex<Shared>>,
    }

    impl BleTransport {
        pub fn start<F, G>(on_line: F, on_event: G) -> Self
        where
            F: Fn(String) + Send + 'static,
            G: Fn(BleEvent) + Send + 'static,
        {
            let (line_tx, line_rx) = channel::<String>();
            let (ev_tx, ev_rx) = channel::<BleEvent>();
            let status = Arc::new(Mutex::new(BleStatus::default()));
            let status2 = status.clone();
            let shared = Arc::new(Mutex::new(Shared {
                tx_line: line_tx,
                periph: None,
                max_write: 20,
                tx_event: ev_tx,
                tx_pending: Mutex::new(VecDeque::new()),
                status: status2,
                lines: pure::LineReassembler::default(),
                ctl: None,
            }));
            let shared2 = shared.clone();
            std::thread::Builder::new()
                .name("ble-dispatch".into())
                .spawn(move || {
                    for line in line_rx { on_line(line); }
                })
                .expect("ble-dispatch");
            std::thread::Builder::new()
                .name("ble-events".into())
                .spawn(move || {
                    for ev in ev_rx.iter() { on_event(ev); }
                })
                .expect("ble-events");
            std::thread::Builder::new()
                .name("ble-central".into())
                .spawn(move || {
                    let shared3 = shared2.clone();
                    let _ = SHARED.set(shared3);
                    let delegate: Retained<BleDelegate> = unsafe {
                        objc2::msg_send![BleDelegate::alloc(), init]
                    };
                    let mgr = unsafe {
                        CBCentralManager::initWithDelegate_queue(
                            CBCentralManager::alloc(),
                            Some(ProtocolObject::from_ref::<BleDelegate>(&*delegate)),
                            None,
                        )
                    };
                    let _ = MGR.set(SendMgr(mgr));
                    let _keep = delegate;
                    loop { std::thread::sleep(std::time::Duration::from_secs(3600)); }
                })
                .expect("ble-central");
            Self { status, shared }
        }

        /// Queue a control line; chunked + paced on the delegate queue.
        pub fn send_line(&self, line: &str) {
            let _ = self.send_line_bound(self.status().generation, line);
        }

        pub fn send_line_bound(&self, generation: u64, line: &str) -> Result<(), String> {
            let max = self.max_write();
            {
                let shared = self.shared.lock().map_err(|_| "蓝牙发送队列不可用")?;
                let status = shared.status.lock().map_err(|_| "蓝牙状态不可用")?;
                if !status.secure_bonded || status.generation != generation || shared.ctl.is_none() {
                    return Err("蓝牙连接已变化".into());
                }
                let mut pending = shared.tx_pending.lock().map_err(|_| "蓝牙发送队列不可用")?;
                pending.extend(pure::chunk_line(line, max));
            }
            kick();
            Ok(())
        }

        pub(crate) fn with_current_board<T>(&self, board: &str, generation: u64, work: impl FnOnce() -> Result<T, String>) -> Result<T, String> {
            let status = self.status.lock().map_err(|_| "蓝牙状态不可用")?;
            if !status.secure_bonded || status.generation != generation || status.board_device_id.as_deref() != Some(board) {
                return Err("蓝牙设备连接已变化".into());
            }
            work()
        }

        /// Current max payload for one write-without-response.
        /// Queried live: CoreBluetooth only raises it after the MTU exchange,
        /// which completes after didConnect.
        fn max_write(&self) -> usize {
            let mut s = self.shared.lock().unwrap();
            if let Some(p) = s.periph.clone() {
                s.max_write = unsafe {
                    p.maximumWriteValueLengthForType(
                        objc2_core_bluetooth::CBCharacteristicWriteType::WithoutResponse,
                    )
                }.max(20) as usize;
            }
            s.max_write
        }

        pub fn status(&self) -> BleStatus {
            self.status.lock().map(|s| s.clone()).unwrap_or_default()
        }

    }
}
