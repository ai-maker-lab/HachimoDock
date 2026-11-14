import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
const read = (file) => readFileSync(new URL(file, import.meta.url), "utf8");

test("connection labels distinguish BLE from USB", () => {
  for (const file of ["dashboard/DeviceStatusBar.jsx", "shell/ContextRail.jsx"]) {
    const source = read(file);
    assert.match(source, /usb.transport === "ble" \? "蓝牙" : "USB"/);
    assert.match(source, /已连接（/);
  }
  assert.match(read("dashboard/DeviceStatusBar.jsx"), /设备未连接/);
});

test("bulk entry points gate BLE with a USB requirement in their existing error UI", () => {
  for (const file of ["AppearanceDetail.jsx", "AppearanceGallery.jsx", "component-center/MusicPlayer.jsx", "DeviceDashboard.jsx", "shell/FirmwareUpdateNavItem.jsx"]) {
    const source = read(file);
    assert.match(source, /transport === "ble"/);
    assert.match(source, /需要 USB 连接/);
  }
});
