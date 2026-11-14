"""Exercise the production ordered TX queue with a fake NimBLE notifier."""
from pathlib import Path
import subprocess
import tempfile

ROOT = Path(__file__).resolve().parents[1]


def test_ble_tx_reconnect_runtime():
    source = (ROOT / 'main/pet_p4_ble.c').read_text()
    queue = source[source.index('typedef struct ble_qitem'):source.index('static void ble_tx_event')]
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
#define BLE_HS_CONN_HANDLE_NONE 65535
#define BLE_HS_ENOMEM 6
#define portMUX_TYPE int
#define portMUX_INITIALIZER_UNLOCKED 0
#define portENTER_CRITICAL(p) ((void)(p))
#define portEXIT_CRITICAL(p) ((void)(p))
#define ESP_LOGW(...) ((void)0)
#define ESP_LOGD(...) ((void)0)
static uint16_t g_conn = BLE_HS_CONN_HANDLE_NONE;
static uint16_t g_ctl_handle = 16;
static bool g_ctl_subscribed, secure;
struct ble_gap_conn_desc { int unused; };
static bool ble_secure(uint16_t conn, struct ble_gap_conn_desc *desc) {
  (void)conn; (void)desc; return secure;
}
static bool ble_topic_allowed(const char *line) { (void)line; return true; }
static uint16_t ble_att_mtu(uint16_t conn) { (void)conn; return 23; }
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
  g_conn = 1; g_q_connected = true;
  secure = true; g_ctl_subscribed = true;
}
static void disconnect_link(void) {
  g_q_connected = false; g_q_conn_epoch++;
  g_conn = BLE_HS_CONN_HANDLE_NONE;
  g_ctl_subscribed = false;
}
int main(void) {
  ble_send_line_shim("offline", NULL); assert(!q_peek());
  connect_link();
  ble_send_line_shim("first", NULL);
  assert(q_peek()); ble_tx_step(); assert(!q_peek());
  assert(sent == 1 && sizes[0] == 6);
  ble_tx_step(); assert(calls == 1); /* No empty notifications after completion. */
  ble_send_line_shim("abcdefghijklmnopqrstuvwxyz", NULL);
  ble_send_line_shim("last", NULL);
  notify_rc = 6; ble_tx_step(); assert(q_peek()->off == 0);
  notify_rc = 0; fail_alloc = true; ble_tx_step(); assert(q_peek()->off == 0);
  fail_alloc = false; ble_tx_step(); assert(q_peek()->off == 20);
  unsigned before = sent;
  disconnect_link();
  ble_send_line_shim("offline", NULL);
  /* Rapid reconnect, same handle, before the consumer drains old items. */
  connect_link();
  ble_send_line_shim("new", NULL);
  ble_tx_step(); ble_tx_step();
  assert(sent == before);
  ble_tx_step(); assert(!q_peek());
  assert(sent == before + 1 && sizes[sent-1] == 4);
  /* An allocation begun on the old link must be rejected on publication. */
  ble_qitem_t *late = calloc(1, sizeof(*late));
  late->buf = malloc(1); late->conn_epoch = g_q_conn_epoch;
  disconnect_link(); connect_link(); assert(!q_push(late)); assert(!q_peek());
  ble_send_line_shim("hold", NULL); g_ctl_subscribed = false;
  ble_tx_step(); assert(q_peek()->off == 0);
  g_ctl_subscribed = true; ble_tx_step(); assert(!q_peek());
  /* Repeated disconnect cleanup while offline, including a partial control line. */
  for (int cycle = 0; cycle < 100; cycle++) {
    ble_send_line_shim("abcdefghijklmnopqrstuvwxyz", NULL);
    ble_tx_step(); assert(q_peek()->off == 20);
    disconnect_link(); ble_tx_step(); ble_tx_step();
    assert(!q_peek()); connect_link();
    sent = 0;
  }
  assert(live_allocations == 0);
  return 0;
}
'''
    with tempfile.TemporaryDirectory() as tmp:
        cfile = Path(tmp) / 'ble_tx_test.c'
        exe = Path(tmp) / 'ble_tx_test'
        cfile.write_text(harness + queue + cases)
        subprocess.run(['cc', '-std=c11', '-Wall', '-Wextra', '-Werror',
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
