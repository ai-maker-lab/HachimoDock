//! Capture the current framebuffer over the active board link using pull-v1.
use crate::usb_serial::UsbSerialManager;
use base64::{engine::general_purpose::STANDARD, Engine};
use image::{codecs::png::PngEncoder, ImageEncoder};
use serde_json::{json, Value};
use std::sync::{mpsc, Mutex};
use std::time::{Duration, Instant};

#[path = "graphics_capture_integrity.rs"]
mod integrity;
#[path = "graphics_capture_pull.rs"]
mod pull;
#[cfg(test)]
#[path = "graphics_acceptance.rs"]
mod graphics_acceptance;

type Message = (String, Value);
static REPLIES: Mutex<Option<mpsc::SyncSender<Message>>> = Mutex::new(None);

pub(crate) fn receive(topic: &str, payload: &Value) -> bool {
    if let Ok(slot) = REPLIES.lock() {
        if let Some(tx) = slot.as_ref() {
            let _ = tx.try_send((topic.to_owned(), payload.clone()));
            return true;
        }
    }
    false
}

struct LiveCapture<'a> {
    manager: &'a UsbSerialManager,
    board: &'a str,
    generation: u64,
    started: Instant,
    rx: mpsc::Receiver<Message>,
    close_ack: bool,
}

impl Drop for LiveCapture<'_> {
    fn drop(&mut self) {
        if let Ok(mut slot) = REPLIES.lock() {
            *slot = None;
        }
    }
}

impl pull::Transport for LiveCapture<'_> {
    fn elapsed(&self) -> Duration { self.started.elapsed() }
    fn delay(&mut self, duration: Duration) { std::thread::sleep(duration); }
    fn close_ack_supported(&self) -> bool { self.close_ack }
    fn send(&mut self, topic: &str, payload: &Value) -> Result<(), ()> {
        self.manager.send_link_bound(self.board, self.generation, topic, payload).map_err(|_| ())
    }
    fn receive(&mut self, timeout: Duration) -> Result<Option<Message>, ()> {
        match self.rx.recv_timeout(timeout) {
            Ok(message) => Ok(Some(message)),
            Err(mpsc::RecvTimeoutError::Timeout) => Ok(None),
            Err(mpsc::RecvTimeoutError::Disconnected) => Err(()),
        }
    }
}

pub(crate) fn capture(manager: &UsbSerialManager, board: &str) -> Result<Value, String> {
    let (link, generation) = manager.connected_link_snapshot(board)?;
    if link.capabilities["screenshotTransfer"] != "pull-fnv1a32-v1"
        || (link.transport == "ble" && link.capabilities["bleScreenshotPull"] != true) {
        return Err("当前固件不支持分块截图".into());
    }
    let (tx, rx) = mpsc::sync_channel(8);
    let mut slot = REPLIES.lock().map_err(|_| "截图服务不可用")?;
    if slot.is_some() {
        return Err("正在截图".into());
    }
    *slot = Some(tx);
    drop(slot);
    let mut io = LiveCapture {
        manager,
        board,
        generation,
        rx,
        started: Instant::now(),
        close_ack: link.capabilities["screenshotCloseAck"] == "p4-snapshot-close-v1",
    };
    let (width, height) = (320, 240);
    let id = uuid::Uuid::new_v4().simple().to_string();
    let result = pull::capture(&mut io, width, height, &id);
    let report = result.capture.report();
    if report["passed"] != true {
        return Err(format!("设备截图失败：{}", report["errors"]));
    }
    let mut rgb = Vec::with_capacity(width * height * 3);
    for pair in result.capture.raw.chunks_exact(2) {
        let px = u16::from_le_bytes([pair[0], pair[1]]);
        let (r, g, b) = ((px >> 11) as u8, ((px >> 5) & 63) as u8, (px & 31) as u8);
        rgb.extend_from_slice(&[(r << 3) | (r >> 2), (g << 2) | (g >> 4), (b << 3) | (b >> 2)]);
    }
    let mut png = Vec::new();
    PngEncoder::new(&mut png).write_image(&rgb, width as u32, height as u32, image::ExtendedColorType::Rgb8)
        .map_err(|e| e.to_string())?;
    Ok(json!({ "png": STANDARD.encode(png) }))
}
