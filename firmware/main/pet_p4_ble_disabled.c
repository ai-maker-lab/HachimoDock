/* Wired builds keep the USB protocol and physical controls available without a radio. */
#include "pet_p4_ble.h"

esp_err_t pet_p4_ble_start(void) { return ESP_OK; }
void pet_p4_ble_pair_snapshot(pet_p4_pair_snapshot_t *out) {
  *out = (pet_p4_pair_snapshot_t){.mode = PET_P4_PAIR_OFF};
}
void pet_p4_ble_open_pairing_window(void) {}
void pet_p4_ble_pair_clear_bonds(void) {}
void pet_p4_ble_numcmp_reply(bool accept) { (void)accept; }
void ble_send_line_shim(const char *line, void *ctx) { (void)line; (void)ctx; }
bool pet_p4_ble_is_transport(pet_p4_send_line_fn send_line) { (void)send_line; return false; }
bool pet_p4_ble_link_ready(void) { return false; }

bool pet_p4_ble_queue_parts(const char *header, const char *body, size_t body_len, const char *suffix) {
  (void)header; (void)body; (void)body_len; (void)suffix; return false;
}
