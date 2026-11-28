#pragma once

#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>
#include "pet_p4_protocol.h"

#ifdef __cplusplus
extern "C" {
#endif

#if PET_P4_HAS_BLE
struct ble_gap_event;
int pet_p4_ble_register(void);
void pet_p4_ble_advertise_service(void);
void pet_p4_ble_gap_event(const struct ble_gap_event *event);
void pet_p4_ble_on_auth_changed(uint16_t conn_handle, bool authorized);
void pet_p4_ble_reset(void);
/* NimBLE host task only: returns whether conn is the authenticated bonded peer. */
bool pet_p4_ble_peer_authorized(uint16_t connection);
#endif

/* Protocol dispatcher reply shim for BLE-originated lines;
 * pet_p4_ble_is_transport() is the canonical BLE reply-channel check. */
void ble_send_line_shim(const char *line, void *ctx);
void pet_p4_ble_send_line_epoch(const char *line, uint32_t expected_epoch);
void pet_p4_ble_set_reply_epoch(uint32_t expected_epoch);
bool pet_p4_ble_is_transport(pet_p4_send_line_fn send_line);

bool pet_p4_ble_link_ready(void);
uint32_t pet_p4_ble_link_epoch(void);
uint32_t pet_p4_ble_reply_epoch(void);

#ifdef __cplusplus
}
#endif
