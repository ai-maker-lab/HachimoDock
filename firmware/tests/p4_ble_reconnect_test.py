"""Exercise the refactored firmware BLE TX queue, topic filter, RX framing, and bond restore."""
from pathlib import Path
import subprocess
import tempfile

ROOT = Path(__file__).resolve().parents[1]


def test_ble_topic_prefix_whitelist_and_bounded_tx_queue(tmp_path):
    source = (ROOT / 'main/pet_p4_ble.c').read_text()
    topic_fn = source[source.index('static bool ble_topic_allowed'):source.index('/* ---------- bounded ordered TX queue')]
    queue_code = source[source.index('typedef struct ble_qitem'):source.index('static void ble_tx_event_cb')]
    harness = r'''
#include <assert.h>
#include <stdatomic.h>
#include <stdbool.h>
#include <stdint.h>
#include <stdlib.h>
#include <string.h>
static unsigned live_allocations;
static void *tracked_malloc(size_t n) {
  void *p = malloc(n); if (p) live_allocations++; return p;
}
static void *tracked_calloc(size_t n, size_t size) {
  void *p = calloc(n, size); if (p) live_allocations++; return p;
}
static void tracked_free(void *p) {
  if (p) { assert(live_allocations); live_allocations--; } free(p);
}
#define malloc tracked_malloc
#define calloc tracked_calloc
#define free tracked_free
#define PET_P4_BLE_LINE_MAX 32768
#define PET_P4_BLE_TX_MAX_ITEMS 4
#define PET_P4_BLE_TX_MAX_BYTES 128
#define PET_P4_BLE_TX_BURST_MAX 2
#define PET_P4_BLE_TX_RETRY_MS 6
#define BLE_HS_CONN_HANDLE_NONE 65535
#define BLE_HS_ENOMEM 6
#define portMUX_TYPE int
#define portMUX_INITIALIZER_UNLOCKED 0
#define portENTER_CRITICAL(p) ((void)(p))
#define portEXIT_CRITICAL(p) ((void)(p))
#define ESP_LOGW(...) ((void)0)
#define ESP_LOGD(...) ((void)0)
struct ble_npl_event { int dummy; };
struct ble_npl_callout { int armed; };
static unsigned eventq_puts, retry_resets;
static void *nimble_port_get_dflt_eventq(void) { return (void *)1; }
static void ble_npl_eventq_put(void *q, struct ble_npl_event *ev) { (void)q; (void)ev; eventq_puts++; }
static int ble_npl_time_ms_to_ticks32(int ms) { return ms; }
static void ble_npl_callout_reset(struct ble_npl_callout *c, int ticks) { (void)ticks; c->armed++; retry_resets++; }
static uint16_t g_conn = BLE_HS_CONN_HANDLE_NONE;
static uint16_t g_ctl_handle = 16;
static bool g_ctl_subscribed, g_peer_authorized, g_service_ready = true;
static size_t g_linelen;
static atomic_bool g_link_ready;
static bool pet_p4_ble_peer_authorized(uint16_t conn) { return conn == g_conn && g_peer_authorized; }
static void *pet_ble_buf_alloc(size_t size) { return malloc(size); }
static uint16_t fake_mtu = 23;
static uint16_t ble_att_mtu(uint16_t conn) { (void)conn; return fake_mtu; }
struct os_mbuf { unsigned len; uint8_t data[600]; };
static bool fail_alloc;
static unsigned calls, sent, handles[64], sizes[64];
static int notify_rc;
static struct os_mbuf *ble_hs_mbuf_from_flat(const void *buf, unsigned len) {
  if (fail_alloc) return NULL;
  assert(len > 0 && len <= 600);
  struct os_mbuf *om = malloc(sizeof(*om));
  assert(om); om->len = len; memcpy(om->data, buf, len); return om;
}
static int ble_gatts_notify_custom(uint16_t conn, uint16_t handle, struct os_mbuf *om) {
  (void)conn; calls++;
  if (!notify_rc) { handles[sent] = handle; sizes[sent++] = om->len; }
  free(om); return notify_rc;
}
'''
    cases = r'''
static void connect_link(void) {
  g_conn = 1;
  g_peer_authorized = true;
  g_ctl_subscribed = true;
  ble_update_link_ready();
}
static void disconnect_link(void) {
  g_conn = BLE_HS_CONN_HANDLE_NONE;
  g_peer_authorized = false;
  g_ctl_subscribed = false;
  ble_update_link_ready();
}
int main(void) {
  /* Strict topic-prefix whitelist prevents substring bypasses. */
  assert(ble_topic_allowed("{\"topic\":\"hello\",\"payload\":{}}"));
  assert(ble_topic_allowed("{\"topic\":\"audio/volume-state\",\"payload\":{}}"));
  assert(ble_topic_allowed("{\"topic\":\"resources/bubble-font/status\",\"payload\":{}}"));
  assert(!ble_topic_allowed("\n{\"topic\":\"debug/screenshot_error\",\"payload\":{}}"));
  assert(!ble_topic_allowed("{\"topic\":\"audio/chunk\",\"payload\":{\"text\":\"\\\"topic\\\":\\\"hello\\\"\"}}"));
  assert(!ble_topic_allowed("{\"topic\":\"lan/trust-status\",\"payload\":{\"x\":\"\\\"topic\\\":\\\"ui/\\\"\"}}"));

  /* Offline and unauthenticated connections reject TX enqueue and never leak. */
  assert(!ble_queue_line_for_epoch("offline", 0));
  assert(!q_peek());
  assert(!atomic_load(&g_link_ready));
  g_conn = 1;
  g_ctl_subscribed = true;
  g_peer_authorized = false;
  ble_update_link_ready();
  assert(!atomic_load(&g_link_ready));
  assert(!ble_queue_line_for_epoch("unauth", 0));

  connect_link();
  assert(atomic_load(&g_link_ready));
  assert(ble_queue_line_for_epoch("first", 0));
  ble_tx_step();
  assert(!q_peek() && sent == 1 && sizes[0] == 6);
  ble_tx_step();
  assert(calls == 1); /* No spurious sends when empty. */

  /* MTU below 23 clamps safely without unsigned underflow. */
  fake_mtu = 0;
  assert(ble_queue_line_for_epoch("abcdefghijklmnopqrstuvwxyz", 0));
  ble_tx_step();
  assert(!q_peek() && sent == 3 && sizes[1] == 20 && sizes[2] == 7);
  fake_mtu = 23;

  /* Bounded queue drops gracefully when full and never leaks. */
  for (int i = 0; i < 4; i++) assert(ble_queue_line_for_epoch("msg", 0));
  assert(!ble_queue_line_for_epoch("overflow", 0));
  assert(g_tx_dropped == 1);

  /* Disconnect immediately frees all queued items and resets partial RX line length. */
  g_linelen = 17;
  disconnect_link();
  assert(g_linelen == 0);
  assert(!q_peek() && g_q_items == 0 && g_q_bytes == 0 && live_allocations == 0);

  /* Congestion arms retry callout and preserves item offset. */
  connect_link();
  assert(ble_queue_line_for_epoch("abcdefghijklmnopqrstuvwxyz", 0));
  notify_rc = BLE_HS_ENOMEM;
  unsigned retries_before = retry_resets;
  ble_tx_step();
  assert(q_peek() && q_peek()->off == 0 && retry_resets == retries_before + 1);
  notify_rc = 0;
  fail_alloc = true;
  ble_tx_step();
  assert(q_peek() && q_peek()->off == 0);
  fail_alloc = false;
  ble_tx_step();
  assert(!q_peek());

  /* Stale epoch rejected both at q_push and at ble_send_line_shim reply scope. */
  uint32_t old_epoch = g_q_conn_epoch;
  ble_qitem_t *late = calloc(1, sizeof(*late));
  late->buf = malloc(4); late->len = 4; late->conn_epoch = old_epoch;
  disconnect_link(); connect_link();
  assert(g_q_conn_epoch != old_epoch);
  assert(!q_push(late) && !q_peek());
  pet_p4_ble_set_reply_epoch(old_epoch);
  ble_send_line_shim("{\"topic\":\"hello\",\"payload\":{}}", (void *)1);
  assert(!q_peek());
  pet_p4_ble_set_reply_epoch(g_q_conn_epoch);
  ble_send_line_shim("{\"topic\":\"hello\",\"payload\":{}}", (void *)1);
  assert(q_peek());
  ble_tx_step();
  assert(!q_peek());
  pet_p4_ble_set_reply_epoch(0);

  /* Unsubscribing closes link readiness and clears queued items. */
  assert(ble_queue_line_for_epoch("queued", 0));
  assert(q_peek());
  g_ctl_subscribed = false;
  ble_update_link_ready();
  assert(!atomic_load(&g_link_ready) && !q_peek());
  assert(!ble_queue_line_for_epoch("blocked", 0));

  disconnect_link();
  assert(live_allocations == 0);
  return 0;
}
'''
    cfile = tmp_path / 'ble_tx_test.c'
    exe = tmp_path / 'ble_tx_test'
    cfile.write_text(harness + topic_fn + queue_code + cases)
    subprocess.run(['cc', '-std=c11', '-Wall', '-Wextra', '-Werror', '-fsanitize=address,undefined',
                    str(cfile), '-o', str(exe)], check=True)
    subprocess.run([str(exe)], check=True)


def test_oversized_control_line_is_discarded_until_newline(tmp_path):
    source = (ROOT / 'main/pet_p4_ble.c').read_text()
    handler = source[source.index('static void handle_ctl_byte'):source.index('static int access_cb')]
    code = r'''#include <assert.h>
#include <stdint.h>
#include <string.h>
#define PET_P4_BLE_LINE_MAX 4
#define ESP_LOGW(...) ((void)0)
#define ESP_LOGD(...) ((void)0)
static char g_linebuf[PET_P4_BLE_LINE_MAX + 1];
static uint32_t g_linelen, g_lines_dropped, delivered;
static void rx_enqueue(const char *line, size_t len) {
  assert(len == 4 && !strcmp(line, "okay")); delivered++;
}
''' + handler + r'''
int main(void) {
  const char *wire = "123456789\nokay\r\n";
  while (*wire) handle_ctl_byte(*wire++);
  assert(delivered == 1 && g_lines_dropped == 1 && g_linelen == 0);
}
'''
    path = tmp_path / 'line.c'
    path.write_text(code)
    exe = tmp_path / 'line'
    subprocess.run(['cc', '-std=c11', '-Wall', '-Werror', '-fsanitize=address,undefined',
                    str(path), '-o', str(exe)], check=True)
    subprocess.run([str(exe)], check=True)


def test_saved_bond_restores_desktop_with_keyboard_off(tmp_path):
    """Use the real mode and persisted layout with a memory-backed NVS blob."""
    source = (ROOT / "main/ble_budget_probe.c").read_text()
    begin = source.index("typedef struct {\n  uint8_t enabled;")
    end = source.index("static bool keyboard_slot_valid", begin)
    harness = r"""
#include <assert.h>
#include <stdbool.h>
#include <stdint.h>
#include <stdatomic.h>
#include <string.h>
#define PET_P4_HAS_BLE 1
#define PET_BLE_GESTURE_COUNT 20
#define NVS_READONLY 0
#define NVS_READWRITE 1
#define ESP_OK 0
typedef int nvs_handle_t;
static uint8_t blob[42]; /* Existing layout_v1 size. */
static bool stored, bonded;
static atomic_bool ready;
static int nvs_open(const char *ns,int mode,nvs_handle_t *handle) {
  (void)mode; assert(!strcmp(ns,"pet_ble")); *handle = 1; return ESP_OK;
}
static int nvs_get_blob(int handle,const char *key,void *out,size_t *size) {
  assert(handle && !strcmp(key,"layout_v1") && *size == sizeof(blob));
  if (!stored) return -1;
  memcpy(out,blob,*size); return ESP_OK;
}
static int nvs_set_blob(int handle,const char *key,const void *data,size_t size) {
  assert(handle && !strcmp(key,"layout_v1") && size == sizeof(blob));
  memcpy(blob,data,size); stored = true; return ESP_OK;
}
static int nvs_commit(int handle) { assert(handle); return ESP_OK; }
static void nvs_close(int handle) { assert(handle); }

static bool pet_ble_shortcut_paired(void) { return bonded; }
static unsigned windows_opened;
static void pet_ble_shortcut_open_pair(void) { ++windows_opened; }
static void pet_ble_shortcut_close_pair(void) {}
bool pet_ble_keyboard_enabled(void);
"""
    cases = r"""
int main(void) {
  pet_ble_keyboard_load(); assert(!pet_ble_shortcut_restore_requested());
  assert(pet_ble_keyboard_set_mode(true));
  assert(pet_ble_keyboard_set_mode(false));
  assert(!pet_ble_shortcut_restore_requested()); /* No saved bond. */
  assert(pet_ble_keyboard_set_mode(true));
  bonded = true; /* Desktop client disconnected before turning HID off. */
  assert(pet_ble_keyboard_set_mode(false));
  assert(!pet_ble_keyboard_connected() && pet_ble_shortcut_restore_requested());
  unsigned previous_windows = windows_opened;
  assert(blob[0] == 0 && blob[1] == 0);
  bonded = false; /* Cold boot: NimBLE has not loaded its bonds yet. */
  pet_ble_keyboard_load();
  assert(!pet_ble_keyboard_enabled() && pet_ble_shortcut_restore_requested());
  bonded = true; atomic_store(&check_saved_bond,false); /* NimBLE synchronized. */
  assert(pet_ble_shortcut_restore_requested());
  assert(windows_opened == previous_windows);
  bonded = false; /* Host completed bond deletion. */
  assert(!pet_ble_shortcut_restore_requested());
}
"""
    src = tmp_path / "keyboard_mode.c"
    src.write_text(harness + source[begin:end] + cases)
    exe = src.with_suffix("")
    subprocess.run(["cc", "-std=c11", "-Wall", "-Werror", str(src), "-o", str(exe)], check=True)
    subprocess.run([str(exe)], check=True)


def test_ble_accessory_coexistence_and_no_polling_tx_task():
    probe = (ROOT / "main/ble_budget_probe.c").read_text()
    ble = (ROOT / "main/pet_p4_ble.c").read_text()
    assert "pet_ble_shortcut_restore_requested()" in probe.split("pet_accessory_poll(")[1].split("))")[0]
    assert "ble_tx_task" not in ble
    assert "vTaskDelay" not in ble
    assert "pet_p4_ble_on_auth_changed" in probe
