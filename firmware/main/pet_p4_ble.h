/*
 * [Input] ESP-Hosted 1.4.7 (IDF Component Manager), NimBLE host, serialized protocol queue entry.
 * [Output] BLE transport lifecycle, single-bond pairing state, availability reporting.
 * [Pos] BLE wireless transport started after the pet UI is up; failure degrades to
 *       "bluetooth unavailable" without rebooting.
 */

#pragma once

#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>
#include "esp_err.h"
#include "pet_p4_protocol.h"

#ifdef __cplusplus
extern "C" {
#endif

/* Start the BLE transport on its own task. Returns the task creation result. */
esp_err_t pet_p4_ble_start(void);

typedef enum {
  PET_P4_PAIR_OFF, PET_P4_PAIR_WINDOW, PET_P4_PAIR_COMPARE,
  PET_P4_PAIR_SUCCESS, PET_P4_PAIR_FAILED, PET_P4_PAIR_REJECTED,
  PET_P4_PAIR_CLEARED
} pet_p4_pair_mode_t;
typedef struct {
  pet_p4_pair_mode_t mode;
  uint32_t number;
  int64_t deadline_ms;
} pet_p4_pair_snapshot_t;
void pet_p4_ble_pair_snapshot(pet_p4_pair_snapshot_t *out);
/* Board pairing controls run on the host queue. */
void pet_p4_ble_open_pairing_window(void);
/* Board gesture: recheck that no comparison arrived before host dispatch. */
void pet_p4_ble_pair_clear_bonds(void);
/* Submit the numeric comparison decision from the board buttons. */
void pet_p4_ble_numcmp_reply(bool accept);

/* The shim send_line the protocol dispatcher hands to BLE-originated lines;
 * pet_p4_ble_is_transport() is the single "is this reply channel BLE"
 * test for other modules. */
void ble_send_line_shim(const char *line, void *ctx);
bool pet_p4_ble_is_transport(pet_p4_send_line_fn send_line);

bool pet_p4_ble_queue_parts(const char *header, const char *body, size_t body_len, const char *suffix);
bool pet_p4_ble_link_ready(void);

#ifdef __cplusplus
}
#endif
