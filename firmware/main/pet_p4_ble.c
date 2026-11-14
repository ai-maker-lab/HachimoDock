/*
 * [Input] Bonded BLE link (NimBLE over ESP-Hosted VHCI), protocol line dispatcher.
 * [Output] BLE control GATT service; inbound control lines enter the SAME
 *          serialized protocol queue as USB/UART with a BLE send_line; outbound
 *          replies over BLE are limited to a whitelisted topic set.
 * [Pos] Single-bond security and control channel.
 */

#include "pet_p4_ble.h"

#include <stdatomic.h>
#include <stdio.h>
#include <string.h>

#include "esp_err.h"
#include "esp_attr.h"
#include "esp_heap_caps.h"
#include "esp_hosted.h"
#include "esp_log.h"
#include "esp_timer.h"
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"
#include "freertos/queue.h"
#include "nimble/nimble_port.h"
#include "nimble/nimble_port_freertos.h"
#include "host/ble_hs.h"
#include "host/ble_hs_hci.h"
#include "host/ble_sm.h"
#include "host/ble_store.h"
#include "host/util/util.h"
#include "services/gap/ble_svc_gap.h"
#include "services/gatt/ble_svc_gatt.h"

void ble_store_config_init(void);

/* Enqueue a complete protocol line into the shared serialized dispatcher
 * (pet_p4_main.c); replies return over the BLE link. */
extern void pet_p4_ble_dispatch_line(const char *line);

static const char *TAG = "pet_p4_ble";

/* §5 JSONL: sender chunks by current notify length; receiver reassembles to
 * '\n' with a 32 KiB line limit. */
#define PET_P4_BLE_LINE_MAX 32768
#define PET_P4_BLE_WINDOW_MS 30000

/* Production BLE UUIDs (uuidgen). Little-endian args for BLE_UUID128_INIT.
 * Service: E3DB074D-BDB5-4577-88F2-E2D24057432A
 * Control: FDA67473-3FDC-4C62-8644-2570735C5D29 */
static const ble_uuid128_t g_svc_uuid =
    BLE_UUID128_INIT(0x2a, 0x43, 0x57, 0x40, 0xd2, 0xe2, 0xf2, 0x88,
                     0x77, 0x45, 0xb5, 0xbd, 0x4d, 0x07, 0xdb, 0xe3);
static const ble_uuid128_t g_ctl_uuid =
    BLE_UUID128_INIT(0x29, 0x5d, 0x5c, 0x73, 0x70, 0x25, 0x44, 0x86,
                     0x62, 0x4c, 0xdc, 0x3f, 0x73, 0x74, 0xa6, 0xfd);

static uint8_t g_addr_type;
static uint16_t g_conn = BLE_HS_CONN_HANDLE_NONE;
static uint16_t g_ctl_handle;
static bool g_ctl_subscribed;
static int64_t g_window_until;
static const char *g_state = "init";
static struct ble_npl_callout g_window_callout;
static uint16_t g_numcmp_conn = BLE_HS_CONN_HANDLE_NONE;
static uint32_t g_numcmp_value;
static bool g_pair_accepted;
static portMUX_TYPE g_pair_lock = portMUX_INITIALIZER_UNLOCKED;
static pet_p4_pair_snapshot_t g_pair_ui;
static atomic_bool g_pair_ready;
static struct ble_npl_event g_pair_event;
static unsigned g_pair_commands;
enum { PAIR_OPEN=1, PAIR_CLEAR=2, PAIR_ACCEPT=4, PAIR_REJECT=8 };

void pet_p4_ble_pair_snapshot(pet_p4_pair_snapshot_t *out) {
  portENTER_CRITICAL(&g_pair_lock);
  *out = g_pair_ui;
  portEXIT_CRITICAL(&g_pair_lock);
}
static void pair_ui(pet_p4_pair_mode_t mode, uint32_t ms) {
  portENTER_CRITICAL(&g_pair_lock);
  g_pair_ui = (pet_p4_pair_snapshot_t){mode, g_numcmp_value,
      esp_timer_get_time()/1000 + ms};
  portEXIT_CRITICAL(&g_pair_lock);
  ble_npl_callout_reset(&g_window_callout, ble_npl_time_ms_to_ticks32(ms));
}
static void pair_result(pet_p4_pair_mode_t mode) {
  g_window_until = 0;
  g_numcmp_conn = BLE_HS_CONN_HANDLE_NONE;
  pair_ui(mode, 2000);
}
static void pair_reply(bool accept) {
  if (g_numcmp_conn == BLE_HS_CONN_HANDLE_NONE) return;
  struct ble_sm_io io = {.action=BLE_SM_IOACT_NUMCMP, .numcmp_accept=accept};
  int rc = ble_sm_inject_io(g_numcmp_conn, &io);
  g_pair_accepted = accept && !rc;
  g_numcmp_conn = BLE_HS_CONN_HANDLE_NONE;
  if (!g_pair_accepted) pair_result(accept ? PET_P4_PAIR_FAILED : PET_P4_PAIR_REJECTED);
}


/* Inbound JSONL reassembly (shared rx queue semantics: one task drains). */
/* GATT host-task staging only: no ISR/DMA access, copy into RX queue before reuse. */
static EXT_RAM_BSS_ATTR char g_linebuf[PET_P4_BLE_LINE_MAX + 1];
static uint32_t g_linelen;
static uint32_t g_lines_dropped;

static bool ble_secure(uint16_t conn, struct ble_gap_conn_desc *desc) {
  if (g_window_until && !g_pair_accepted) return false;
  return !ble_gap_conn_find(conn, desc)
      && desc->sec_state.encrypted
      && desc->sec_state.authenticated
      && desc->sec_state.bonded;
}

static bool pairing_window(void) {
  return g_window_until != 0;
}

static void ble_advertise(void);

/* Outbound whitelist (§5, B1-1 control only). Replies/hello/state/acks over
 * BLE; anything else stays on the wired transports. */
static bool ble_topic_allowed(const char *line) {
  static const char *prefixes[] = {
      "\"topic\":\"hello\"", "\"topic\":\"ack\"", "\"topic\":\"state\"",
      "\"topic\":\"session/", "\"topic\":\"heartbeat\"", "\"topic\":\"ui/",
      "\"topic\":\"conversation/", "\"topic\":\"input/",
      "\"topic\":\"diagnostics/", "\"topic\":\"protocol/ack",
      "\"topic\":\"asset/ack\"", "\"topic\":\"widget-install-ack\"", "\"topic\":\"protocol/error", "\"topic\":\"widget/",
      "\"topic\":\"media/status\"", "\"topic\":\"data/", "\"topic\":\"firmware/status", "\"topic\":\"app/",
  };
  for (size_t i = 0; i < sizeof(prefixes) / sizeof(prefixes[0]); i++) {
    if (strstr(line, prefixes[i])) return true;
  }
  return false;
}

/* ---------- ordered TX queue: control lines ---------- */

typedef struct ble_qitem {
  struct ble_qitem *next;
  uint32_t conn_epoch;
  uint8_t *buf;
  uint32_t len, off;
} ble_qitem_t;

static ble_qitem_t *g_q_head, *g_q_tail;
static uint32_t g_q_conn_epoch;
static bool g_q_connected;
static portMUX_TYPE g_q_lock = portMUX_INITIALIZER_UNLOCKED;

static bool q_snapshot(uint32_t *epoch) {
  portENTER_CRITICAL(&g_q_lock);
  *epoch = g_q_conn_epoch;
  bool connected = g_q_connected;
  portEXIT_CRITICAL(&g_q_lock);
  return connected;
}

static bool q_push(ble_qitem_t *it) {
  portENTER_CRITICAL(&g_q_lock);
  bool accepted = g_q_connected && it->conn_epoch == g_q_conn_epoch;
  if (accepted) {
    it->next = NULL;
    if (g_q_tail) g_q_tail->next = it; else g_q_head = it;
    g_q_tail = it;
  }
  portEXIT_CRITICAL(&g_q_lock);
  if (!accepted) { free(it->buf); free(it); }
  return accepted;
}

static ble_qitem_t *q_peek(void) {
  portENTER_CRITICAL(&g_q_lock);
  ble_qitem_t *it = g_q_head;
  portEXIT_CRITICAL(&g_q_lock);
  return it;
}

static ble_qitem_t *q_pop(void) {
  portENTER_CRITICAL(&g_q_lock);
  ble_qitem_t *it = g_q_head;
  if (it) { g_q_head = it->next; if (!g_q_head) g_q_tail = NULL; }
  portEXIT_CRITICAL(&g_q_lock);
  return it;
}

bool pet_p4_ble_queue_parts(const char *header, const char *body, size_t body_len, const char *suffix) {
  uint32_t conn_epoch;
  if (!q_snapshot(&conn_epoch)) return false;
  size_t head_len = strlen(header), suffix_len = strlen(suffix);
  size_t n = head_len + body_len + suffix_len;
  if (n >= PET_P4_BLE_LINE_MAX) return false;
  ble_qitem_t *it = calloc(1, sizeof(*it));
  if (!it) return false;
  it->conn_epoch = conn_epoch;
  it->buf = malloc(n + 1);
  if (!it->buf) { free(it); return false; }
  memcpy(it->buf, header, head_len);
  memcpy(it->buf + head_len, body, body_len);
  memcpy(it->buf + head_len + body_len, suffix, suffix_len);
  if (!n || it->buf[n - 1] != '\n') it->buf[n++] = '\n';
  it->len = n;
  return q_push(it);
}

/* BLE send_line: queue the control line for the ordered TX task.
 * Send-side gating (secure + subscribed) happens at TX time. */
void ble_send_line_shim(const char *line, void *ctx) {
  (void) ctx;
  if (line && ble_topic_allowed(line))
    pet_p4_ble_queue_parts(line, "", 0, "");
}

/* One packet per host event: GAP disconnect cannot race a send to a reused handle. */
static void ble_tx_step(void) {
  ble_qitem_t *it = q_peek();
  struct ble_gap_conn_desc desc;
  if (it && it->conn_epoch != g_q_conn_epoch) goto pop;
  if (!it || g_conn == BLE_HS_CONN_HANDLE_NONE || !ble_secure(g_conn, &desc)) {
    return;
  }
  uint16_t mtu = ble_att_mtu(g_conn);
  int rc = BLE_HS_ENOMEM;
  if (!g_ctl_subscribed) return;
  uint32_t n = it->len - it->off;
  if (n > mtu - 3) n = mtu - 3;
  struct os_mbuf *om = ble_hs_mbuf_from_flat(it->buf + it->off, n);
  if (om) rc = ble_gatts_notify_custom(g_conn, g_ctl_handle, om);
  if (!rc) it->off += n;
  if (rc) {
    static uint32_t fails;
    if ((++fails & 0x3ff) == 1) ESP_LOGW(TAG, "TX_NOTIFY_FAIL rc=%d n=%u", rc, (unsigned) fails);
    return;
  }
  if (it->off >= it->len) {
    pop:
    it = q_pop();
    if (it) {
      free(it->buf); free(it);
    }
  }
}

static void ble_tx_event(struct ble_npl_event *event) {
  ble_tx_step();
  xTaskNotifyGive((TaskHandle_t) ble_npl_event_get_arg(event));
}

static void ble_tx_task(void *arg) {
  (void) arg;
  struct ble_npl_event event;
  ble_npl_event_init(&event, ble_tx_event, xTaskGetCurrentTaskHandle());
  for (;;) {
    ble_npl_eventq_put(nimble_port_get_dflt_eventq(), &event);
    ulTaskNotifyTake(pdTRUE, portMAX_DELAY);
    vTaskDelay(pdMS_TO_TICKS(2));
  }
}

/* ---------- §3 single-bond security ---------- */

static int clear_bond(const ble_addr_t *peer) {
  int rc = 0;
  bool was_adv = ble_gap_adv_active();
  if (was_adv) {
    rc = ble_gap_adv_stop();
    ESP_LOGI(TAG, "ADV_STOP rc=%d", rc);
    if (rc) return rc;
  }
  rc = ble_gap_unpair(peer);
  ESP_LOGI(TAG, "UNPAIR rc=%d", rc);
  if (rc == BLE_HS_ENOENT) rc = 0;
  if (was_adv && g_conn == BLE_HS_CONN_HANDLE_NONE) {
    ble_advertise();
    if (!ble_gap_adv_active()) {
      ESP_LOGE(TAG, "ADV_RESTART_FAILED");
      if (!rc) rc = BLE_HS_EAPP;
    }
  }
  return rc;
}

static bool clear_all_bonds(void) {
  ble_addr_t peers[3];
  int n = 0;
  int rc = ble_store_util_bonded_peers(peers, &n, 3);
  ESP_LOGI(TAG, "BONDS count=%d rc=%d", n, rc);
  if (rc) return false;
  bool ok = true;
  for (int i = 0; i < n; i++) {
    int result = clear_bond(&peers[i]);
    ESP_LOGI(TAG, "CLEAR_BOND rc=%d", result);
    if (result) ok = false;
  }
  return ok;
}

static bool same_addr(const ble_addr_t *a, const ble_addr_t *b) {
  return a->type == b->type && !memcmp(a->val, b->val, 6);
}

/* ---------- control RX → serialized protocol queue ---------- */

/* RX hand-off: the NimBLE host task must not block on the pet state mutex
 * (it would stop processing completed-packet events, starving TX mbufs), so
 * complete control lines go, in arrival order, to a
 * dedicated task that dispatches them. */
static QueueHandle_t g_rx_queue;
static uint32_t g_rx_dropped;

static void rx_enqueue(const char *data, size_t len) {
  char *line = heap_caps_malloc(len + 1, MALLOC_CAP_SPIRAM | MALLOC_CAP_8BIT);
  if (!line) line = malloc(len + 1);
  if (line) {
    memcpy(line, data, len);
    line[len] = 0;
    if (g_rx_queue && xQueueSend(g_rx_queue, &line, 0) == pdTRUE) return;
    free(line);
  }
  if ((++g_rx_dropped & 0x3f) == 1) ESP_LOGW(TAG, "RX_DROPPED n=%u", (unsigned) g_rx_dropped);
}

static void ble_rx_task(void *arg) {
  (void) arg;
  char *line;
  for (;;) {
    if (xQueueReceive(g_rx_queue, &line, portMAX_DELAY) != pdTRUE) continue;
    int64_t t0 = esp_timer_get_time();
    pet_p4_ble_dispatch_line(line);
    int64_t us = esp_timer_get_time() - t0;
    if (us > 50000) ESP_LOGW(TAG, "RX_SLOW %lldms", us / 1000);
    free(line);
  }
}

static void handle_ctl_byte(char c) {
  if (c == '\r') return;
  if (c == '\n') {
    if (g_linelen && g_linelen <= PET_P4_BLE_LINE_MAX) {
      g_linebuf[g_linelen] = '\0';
      ESP_LOGD(TAG, "CTRL_RX len=%u %.48s", (unsigned) g_linelen, g_linebuf);
      rx_enqueue(g_linebuf, g_linelen);
    }
    g_linelen = 0;
    return;
  }
  if (g_linelen < PET_P4_BLE_LINE_MAX) {
    g_linebuf[g_linelen++] = c;
  } else if (g_linelen == PET_P4_BLE_LINE_MAX) {
    g_lines_dropped++;
    ESP_LOGW(TAG, "LINE_TOO_LONG dropped=%u", (unsigned) g_lines_dropped);
    g_linelen++;  /* stay dropped until newline resets */
  }
}

static int access_cb(uint16_t conn, uint16_t attr,
                     struct ble_gatt_access_ctxt *ctx, void *arg) {
  (void) attr;
  (void) arg;
  struct ble_gap_conn_desc desc;
  bool sec = ble_secure(conn, &desc);
  ESP_LOGD(TAG, "ACCESS op=%u secure=%d", ctx->op, sec);
  if (!sec) {
    return BLE_ATT_ERR_INSUFFICIENT_AUTHEN;
  }
  if (ctx->op == BLE_GATT_ACCESS_OP_WRITE_CHR) {
    uint16_t n = OS_MBUF_PKTLEN(ctx->om);
    uint8_t tmp[600];
    if (!n || n > sizeof(tmp) || os_mbuf_copydata(ctx->om, 0, n, tmp)) {
      return BLE_ATT_ERR_INVALID_ATTR_VALUE_LEN;
    }
    for (uint16_t i = 0; i < n; i++) handle_ctl_byte((char) tmp[i]);
    return 0;
  }
  if (ctx->op == BLE_GATT_ACCESS_OP_READ_CHR) {
    char buf[128];
    int len = snprintf(buf, sizeof(buf),
        "{\"ble\":\"%s\",\"secure\":true,\"bonded\":%u}",
        g_state, desc.sec_state.bonded ? 1 : 0);
    return os_mbuf_append(ctx->om, buf, len) ? BLE_ATT_ERR_INSUFFICIENT_RES : 0;
  }
  return BLE_ATT_ERR_INSUFFICIENT_AUTHOR;
}

static const struct ble_gatt_chr_def g_chrs[] = {
  {
    .uuid = &g_ctl_uuid.u,
    .access_cb = access_cb,
    .flags = BLE_GATT_CHR_F_READ | BLE_GATT_CHR_F_READ_AUTHEN
           | BLE_GATT_CHR_F_WRITE | BLE_GATT_CHR_F_WRITE_NO_RSP
           | BLE_GATT_CHR_F_WRITE_AUTHEN | BLE_GATT_CHR_F_NOTIFY,
    .val_handle = &g_ctl_handle,
  },
  {0},
};

static const struct ble_gatt_svc_def g_svcs[] = {
  {
    .type = BLE_GATT_SVC_TYPE_PRIMARY,
    .uuid = &g_svc_uuid.u,
    .characteristics = g_chrs,
  },
  {0},
};

/* ---------- GAP ---------- */

static int gap_cb(struct ble_gap_event *event, void *arg) {
  (void) arg;
  switch (event->type) {
    case BLE_GAP_EVENT_CONNECT:
      ESP_LOGI(TAG, "CONNECT status=%d", event->connect.status);
      if (!event->connect.status) {
        g_conn = event->connect.conn_handle;
        g_pair_accepted = false;
        portENTER_CRITICAL(&g_q_lock);
        g_q_connected = true;
        portEXIT_CRITICAL(&g_q_lock);
        /* Request larger packets and 2M PHY for component transfers. */
        int dl = ble_gap_set_data_len(g_conn, 251, 2120);
        int phy = ble_gap_set_prefered_le_phy(g_conn, BLE_GAP_LE_PHY_2M_MASK,
                                              BLE_GAP_LE_PHY_2M_MASK, 0);
        ESP_LOGI(TAG, "LINK_TUNE data_len=%d phy=%d", dl, phy);
        struct ble_gap_conn_desc desc;
        if (!ble_gap_conn_find(g_conn, &desc)) {
          ESP_LOGI(TAG, "CONN_PARAMS itvl=%u(x1.25ms) latency=%u timeout=%u",
                   desc.conn_itvl, desc.conn_latency, desc.supervision_timeout);
          ESP_LOGI(TAG, "peer %02x:%02x:%02x:%02x:%02x:%02x",
                   desc.peer_id_addr.val[5], desc.peer_id_addr.val[4],
                   desc.peer_id_addr.val[3], desc.peer_id_addr.val[2],
                   desc.peer_id_addr.val[1], desc.peer_id_addr.val[0]);
        }
      } else {
        ble_advertise();
      }
      break;
    case BLE_GAP_EVENT_DISCONNECT: {
      ESP_LOGI(TAG, "DISCONNECT reason=%d", event->disconnect.reason);
      if (g_numcmp_conn != BLE_HS_CONN_HANDLE_NONE || g_pair_accepted) {
        pair_result(PET_P4_PAIR_FAILED);
      }
      g_numcmp_conn = BLE_HS_CONN_HANDLE_NONE;
      g_pair_accepted = false;
      portENTER_CRITICAL(&g_q_lock);
      g_q_connected = false;
      g_q_conn_epoch++;
      portEXIT_CRITICAL(&g_q_lock);
      g_conn = BLE_HS_CONN_HANDLE_NONE;
      g_ctl_subscribed = false;
      g_linelen = 0;
      ble_advertise();
      break;
    }
    case BLE_GAP_EVENT_CONN_UPDATE: {
      struct ble_gap_conn_desc desc;
      if (!ble_gap_conn_find(event->conn_update.conn_handle, &desc)) {
        ESP_LOGI(TAG, "CONN_UPDATE status=%d itvl=%u(x1.25ms) latency=%u",
                 event->conn_update.status, desc.conn_itvl, desc.conn_latency);
      }
      break;
    }
    case BLE_GAP_EVENT_PHY_UPDATE_COMPLETE:
      ESP_LOGI(TAG, "PHY status=%d tx=%u rx=%u", event->phy_updated.status,
               event->phy_updated.tx_phy, event->phy_updated.rx_phy);
      if (!event->phy_updated.status) {
        /* Uplink is bounded by controller buffers released once per
         * connection event, so 15 ms doubles headroom over the 30 ms macOS
         * default. Requested after the PHY procedure to avoid a collision. */
        struct ble_gap_upd_params up = {
          .itvl_min = 12, .itvl_max = 12, .latency = 0,
          .supervision_timeout = 400, .min_ce_len = 0, .max_ce_len = 0,
        };
        ESP_LOGI(TAG, "PARAMS_REQ rc=%d",
                 ble_gap_update_params(event->phy_updated.conn_handle, &up));
      }
      break;
    case BLE_GAP_EVENT_DATA_LEN_CHG:
      ESP_LOGI(TAG, "DATA_LEN tx=%u rx=%u", event->data_len_chg.max_tx_octets,
               event->data_len_chg.max_rx_octets);
      break;
    case BLE_GAP_EVENT_MTU:
      ESP_LOGI(TAG, "MTU=%u", event->mtu.value);
      break;
    case BLE_GAP_EVENT_ENC_CHANGE: {
      struct ble_gap_conn_desc desc;
      int rc = ble_gap_conn_find(event->enc_change.conn_handle, &desc);
      if (!rc) {
        ESP_LOGI(TAG, "SECURITY status=%d enc=%u auth=%u bond=%u keysize=%u",
                 event->enc_change.status, desc.sec_state.encrypted,
                 desc.sec_state.authenticated, desc.sec_state.bonded,
                 desc.sec_state.key_size);
        if (pairing_window() && !g_pair_accepted && desc.sec_state.encrypted) {
          ble_gap_terminate(event->enc_change.conn_handle, BLE_ERR_REM_USER_CONN_TERM);
          break;
        }
        if (event->enc_change.status && (g_pair_accepted || g_numcmp_conn != BLE_HS_CONN_HANDLE_NONE)) {
          pair_result(PET_P4_PAIR_FAILED);
        }
        /* Only a newly accepted, fully secure pairing may evict old bonds. */
        if (event->enc_change.status == 0 && desc.sec_state.bonded
            && desc.sec_state.encrypted && desc.sec_state.authenticated
            && g_pair_accepted && pairing_window()) {
          ble_addr_t peers[3];
          int n = 0;
          if (!ble_store_util_bonded_peers(peers, &n, 3)) {
            for (int i = 0; i < n; i++) {
              if (!same_addr(&desc.peer_id_addr, &peers[i])) {
                ESP_LOGI(TAG, "CLEAR_STALE rc=%d", clear_bond(&peers[i]));
              }
            }
          }
          g_pair_accepted = false;
          pair_result(PET_P4_PAIR_SUCCESS);
        }
      }
      break;
    }
    case BLE_GAP_EVENT_PASSKEY_ACTION:
      if (!pairing_window()) {
        ESP_LOGW(TAG, "PAIRING_DENIED window closed");
        ble_gap_terminate(event->passkey.conn_handle, BLE_ERR_REM_USER_CONN_TERM);
        break;
      }
      /* The comparison value stays local to the board. */
      if (event->passkey.params.action == BLE_SM_IOACT_NUMCMP) {
        g_numcmp_conn = event->passkey.conn_handle;
        g_numcmp_value = event->passkey.params.numcmp;
        pair_ui(PET_P4_PAIR_COMPARE, 30000);
        ESP_LOGI(TAG, "NUMCMP=%06u", (unsigned) g_numcmp_value);
        break;
      }
      if (event->passkey.params.action == BLE_SM_IOACT_DISP) {
        uint32_t r;
        int rc;
        do {
          rc = ble_hs_hci_util_rand(&r, sizeof(r));
          if (rc) break;
        } while (r >= 4294000000UL);
        if (rc) { ESP_LOGE(TAG, "RANDOM_FAILED=%d", rc); break; }
        struct ble_sm_io io = {.action = BLE_SM_IOACT_DISP, .passkey = r % 1000000};
        ESP_LOGW(TAG, "PASSKEY_ACTION=DISP (unexpected; peer lacks numcmp) PAIRING_CODE=%06u",
                 (unsigned) io.passkey);
        ESP_LOGI(TAG, "PAIRING_INJECT=%d",
                 ble_sm_inject_io(event->passkey.conn_handle, &io));
      } else {
        ESP_LOGW(TAG, "PASSKEY_ACTION=%d unhandled", event->passkey.params.action);
      }
      break;
    case BLE_GAP_EVENT_REPEAT_PAIRING: {
      ESP_LOGI(TAG, "REPEAT_PAIRING window=%d", pairing_window());
      if (!pairing_window()) return BLE_GAP_REPEAT_PAIRING_IGNORE;
      struct ble_gap_conn_desc desc;
      if (ble_gap_conn_find(event->repeat_pairing.conn_handle, &desc)) {
        return BLE_GAP_REPEAT_PAIRING_IGNORE;
      }
      int rc = ble_store_util_delete_peer(&desc.peer_id_addr);
      ESP_LOGI(TAG, "DELETE_PEER rc=%d", rc);
      return rc ? BLE_GAP_REPEAT_PAIRING_IGNORE : BLE_GAP_REPEAT_PAIRING_RETRY;
    }
    case BLE_GAP_EVENT_SUBSCRIBE: {
      struct ble_gap_conn_desc desc;
      bool sec = ble_secure(event->subscribe.conn_handle, &desc);
      if (event->subscribe.attr_handle == g_ctl_handle) {
        g_ctl_subscribed = event->subscribe.cur_notify;
      }
      ESP_LOGI(TAG, "SUBSCRIBE h=%u on=%d secure=%d",
               event->subscribe.attr_handle, event->subscribe.cur_notify, sec);
      break;
    }
    default:
      break;
  }
  return 0;
}

static void ble_advertise(void) {
  struct ble_hs_adv_fields fields = {0};
  fields.flags = BLE_HS_ADV_F_DISC_GEN | BLE_HS_ADV_F_BREDR_UNSUP;
  const char *name = "HachimoDock";
  fields.name = (const uint8_t *) name;
  fields.name_len = strlen(name);
  fields.name_is_complete = 1;
  int rc = ble_gap_adv_set_fields(&fields);
  if (rc) {
    ESP_LOGE(TAG, "ADV_FIELDS=%d", rc);
    return;
  }
  struct ble_gap_adv_params params = {0};
  params.conn_mode = BLE_GAP_CONN_MODE_UND;
  params.disc_mode = BLE_GAP_DISC_MODE_GEN;
  ESP_LOGI(TAG, "ADVERTISING rc=%d",
           ble_gap_adv_start(g_addr_type, NULL, BLE_HS_FOREVER, &params, gap_cb, NULL));
}

static void sync_cb(void) {
  int rc = ble_hs_util_ensure_addr(0);
  if (!rc) rc = ble_hs_id_infer_auto(0, &g_addr_type);
  ESP_LOGI(TAG, "HOST_SYNC rc=%d", rc);
  if (!rc) {
    ble_addr_t peers[3];
    int n = 0;
    int brc = ble_store_util_bonded_peers(peers, &n, 3);
    ESP_LOGI(TAG, "BONDS count=%d rc=%d", n, brc);
    /* §3: device pairs with exactly one computer; >1 bond means stale state. */
    if (!brc && n > 1) {
      ESP_LOGW(TAG, "MULTI_BOND_CLEARED please re-pair");
      clear_all_bonds();
    }
    ble_advertise();
    g_state = "ready";
    atomic_store(&g_pair_ready, true);
  }
}

static void reset_cb(int reason) {
  ESP_LOGE(TAG, "HOST_RESET=%d", reason);
  g_state = "unavailable";
}

static void host_task(void *arg) {
  (void) arg;
  nimble_port_run();
  nimble_port_freertos_deinit();
}

static void window_expiry_cb(struct ble_npl_event *event) {
  (void) event;
  pet_p4_pair_snapshot_t ui;
  pet_p4_ble_pair_snapshot(&ui);
  if (ui.mode == PET_P4_PAIR_COMPARE) {
    bool pending = g_numcmp_conn != BLE_HS_CONN_HANDLE_NONE;
    pair_reply(false);
    g_pair_accepted = false;
    pair_result(pending ? PET_P4_PAIR_REJECTED : PET_P4_PAIR_FAILED);
    if (g_conn != BLE_HS_CONN_HANDLE_NONE)
      ble_gap_terminate(g_conn, BLE_ERR_REM_USER_CONN_TERM);
  } else {
    g_window_until = 0;
    pair_ui(PET_P4_PAIR_OFF, 30000);
    ble_npl_callout_stop(&g_window_callout);
  }
}

static void pair_command_cb(struct ble_npl_event *event) {
  (void) event;
  portENTER_CRITICAL(&g_pair_lock);
  unsigned commands = g_pair_commands;
  g_pair_commands = 0;
  portEXIT_CRITICAL(&g_pair_lock);
  if (commands & PAIR_OPEN) {
    if (!pairing_window()) {
      g_pair_accepted = false;
      g_window_until = esp_timer_get_time() + (int64_t)PET_P4_BLE_WINDOW_MS*1000;
      pair_ui(PET_P4_PAIR_WINDOW, PET_P4_BLE_WINDOW_MS);
      if (g_conn != BLE_HS_CONN_HANDLE_NONE)
        ble_gap_terminate(g_conn, BLE_ERR_REM_USER_CONN_TERM);
      else if (!ble_gap_adv_active()) ble_advertise();
    }
  }
  if (commands & PAIR_REJECT) pair_reply(false);
  else if (commands & PAIR_ACCEPT) pair_reply(true);
  pet_p4_pair_snapshot_t ui;
  pet_p4_ble_pair_snapshot(&ui);
  if ((commands & PAIR_CLEAR) && ui.mode == PET_P4_PAIR_WINDOW) {
    pair_reply(false);
    bool ok = clear_all_bonds();
    pair_result(ok ? PET_P4_PAIR_CLEARED : PET_P4_PAIR_FAILED);
  }
}
static void pair_post(unsigned command) {
  if (!atomic_load(&g_pair_ready)) return;
  portENTER_CRITICAL(&g_pair_lock);
  g_pair_commands |= command;
  portEXIT_CRITICAL(&g_pair_lock);
  ble_npl_eventq_put(nimble_port_get_dflt_eventq(), &g_pair_event);
}

static void ble_task(void *arg) {
  (void) arg;
  g_state = "init";
  esp_log_level_set("NimBLE", ESP_LOG_WARN);

  /* The Hosted constructor normally initializes the host. Bring up the SDIO
     transport before starting NimBLE, and leave the UI and USB independent. */
  esp_err_t rc = esp_hosted_init();
  ESP_LOGI(TAG, "HOSTED_INIT=%s", esp_err_to_name(rc));
  rc = esp_hosted_slave_reset();
  ESP_LOGI(TAG, "HOSTED_RESET=%s", esp_err_to_name(rc));
  if (rc != ESP_OK) {
    ESP_LOGE(TAG, "C6 slave reset failed; bluetooth unavailable");
    g_state = "unavailable";
    vTaskDelete(NULL);
    return;
  }
  rc = nimble_port_init();
  ESP_LOGI(TAG, "NIMBLE_INIT=%s", esp_err_to_name(rc));
  if (rc != ESP_OK) {
    ESP_LOGE(TAG, "nimble init failed; bluetooth unavailable");
    g_state = "unavailable";
    vTaskDelete(NULL);
    return;
  }

  ble_hs_cfg.sync_cb = sync_cb;
  ble_hs_cfg.reset_cb = reset_cb;
  ble_hs_cfg.sm_bonding = 1;
  ble_hs_cfg.sm_sc = 1;
  ble_hs_cfg.sm_sc_only = 1;
  ble_hs_cfg.sm_mitm = 1;
  ble_hs_cfg.sm_io_cap = BLE_HS_IO_DISPLAY_YESNO;
  ble_hs_cfg.sm_our_key_dist = BLE_SM_PAIR_KEY_DIST_ENC | BLE_SM_PAIR_KEY_DIST_ID;
  ble_hs_cfg.sm_their_key_dist = BLE_SM_PAIR_KEY_DIST_ENC | BLE_SM_PAIR_KEY_DIST_ID;
  ble_store_config_init();
  ble_svc_gap_init();
  ble_svc_gatt_init();
  ble_svc_gap_device_name_set("HachimoDock");

  rc = ble_gatts_count_cfg(g_svcs);
  if (!rc) rc = ble_gatts_add_svcs(g_svcs);
  if (rc) {
    ESP_LOGE(TAG, "GATT_FAILED=%d", rc);
    g_state = "unavailable";
    vTaskDelete(NULL);
    return;
  }
  ble_npl_callout_init(&g_window_callout, nimble_port_get_dflt_eventq(),
                       window_expiry_cb, NULL);
  ble_npl_event_init(&g_pair_event, pair_command_cb, NULL);
  nimble_port_freertos_init(host_task);
  xTaskCreate(ble_tx_task, "pet_p4_ble_tx", 4096, NULL, 6, NULL);
  g_rx_queue = xQueueCreate(128, sizeof(char *));
  if (g_rx_queue) xTaskCreate(ble_rx_task, "pet_p4_ble_rx", 8192, NULL, 5, NULL);
  vTaskDelete(NULL);
}

/* ---------- public API ---------- */

esp_err_t pet_p4_ble_start(void) {
  BaseType_t ok = xTaskCreate(ble_task, "pet_p4_ble", 6144, NULL, 5, NULL);
  return ok == pdPASS ? ESP_OK : ESP_ERR_NO_MEM;
}


void pet_p4_ble_open_pairing_window(void) { pair_post(PAIR_OPEN); }
void pet_p4_ble_pair_clear_bonds(void) { pair_post(PAIR_CLEAR); }

bool pet_p4_ble_is_transport(pet_p4_send_line_fn send_line) {
  return send_line == ble_send_line_shim;
}


bool pet_p4_ble_link_ready(void) {
  struct ble_gap_conn_desc desc;
  return g_conn != BLE_HS_CONN_HANDLE_NONE && ble_secure(g_conn, &desc);
}

void pet_p4_ble_numcmp_reply(bool accept) {
  pair_post(accept ? PAIR_ACCEPT : PAIR_REJECT);
}
