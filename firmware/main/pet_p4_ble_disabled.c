/* Wired builds keep the USB protocol and physical controls available without a radio. */
#include "pet_p4_ble.h"

void ble_send_line_shim(const char *line, void *ctx) { (void)line; (void)ctx; }
void pet_p4_ble_send_line_epoch(const char *line, uint32_t expected_epoch) { (void)line; (void)expected_epoch; }
void pet_p4_ble_set_reply_epoch(uint32_t expected_epoch) { (void)expected_epoch; }
bool pet_p4_ble_is_transport(pet_p4_send_line_fn send_line) { (void)send_line; return false; }
bool pet_p4_ble_link_ready(void) { return false; }
uint32_t pet_p4_ble_link_epoch(void) { return 0; }
uint32_t pet_p4_ble_reply_epoch(void) { return 0; }
