#pragma once

#include <stdbool.h>
#include <stdint.h>

static inline bool pet_p4_voice_ble_only(bool ble_ready, uint64_t usb_client_last_seen_ms,
                                        bool lan_connected, uint64_t now_ms,
                                        uint64_t host_timeout_ms) {
  return ble_ready && !lan_connected && (!usb_client_last_seen_ms ||
    (now_ms >= usb_client_last_seen_ms && now_ms - usb_client_last_seen_ms > host_timeout_ms));
}
