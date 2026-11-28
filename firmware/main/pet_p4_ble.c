/*
 * [Input] Bonded BLE link (NimBLE over ESP-Hosted VHCI), protocol line dispatcher.
 * [Output] BLE desktop GATT service; inbound JSONL lines enter the shared
 *          serialized protocol queue with a BLE send_line shim; outbound
 *          replies are event-driven, bounded, and filtered by exact topic prefix.
 * [Pos] Single-bond desktop data channel coexisting with BLE HID and accessory client.
 */

#include "pet_p4_ble.h"

#include <stdatomic.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#include "esp_attr.h"
#include "esp_err.h"
#include "esp_heap_caps.h"
#include "esp_log.h"
#include "esp_timer.h"
#include "freertos/FreeRTOS.h"
#include "freertos/queue.h"
#include "freertos/task.h"
#include "host/ble_hs.h"
#include "host/ble_hs_hci.h"
#include "host/ble_sm.h"
#include "host/ble_store.h"
#include "host/util/util.h"
#include "nimble/nimble_port.h"
#include "nimble/nimble_port_freertos.h"
#include "services/gap/ble_svc_gap.h"
#include "services/gatt/ble_svc_gatt.h"

/* Enqueue a complete protocol line into the shared serialized dispatcher
 * (pet_p4_main.c) tagged with its connection epoch; replies return over BLE. */
extern void pet_p4_ble_dispatch_line(const char *line, uint32_t ble_epoch);

static const char *TAG = "pet_p4_ble";

/* JSONL framing: sender chunks by current ATT payload; receiver reassembles to
 * '\n' with a 32 KiB line limit. */
#define PET_P4_BLE_LINE_MAX 32768
#define PET_P4_BLE_TX_MAX_ITEMS 64
#define PET_P4_BLE_TX_MAX_BYTES (256 * 1024)
#define PET_P4_BLE_TX_BURST_MAX 8
#define PET_P4_BLE_TX_RETRY_MS 6
#define PET_P4_BLE_RX_QUEUE_DEPTH 64
#define PET_P4_BLE_RX_SLICE_BYTES 128

/* Production BLE UUIDs (little-endian for BLE_UUID128_INIT).
 * Service: E3DB074D-BDB5-4577-88F2-E2D24057432A
 * Control: FDA67473-3FDC-4C62-8644-2570735C5D29 */
static const ble_uuid128_t g_svc_uuid =
    BLE_UUID128_INIT(0x2a, 0x43, 0x57, 0x40, 0xd2, 0xe2, 0xf2, 0x88,
                     0x77, 0x45, 0xb5, 0xbd, 0x4d, 0x07, 0xdb, 0xe3);
static const ble_uuid128_t g_ctl_uuid =
    BLE_UUID128_INIT(0x29, 0x5d, 0x5c, 0x73, 0x70, 0x25, 0x44, 0x86,
                     0x62, 0x4c, 0xdc, 0x3f, 0x73, 0x74, 0xa6, 0xfd);

/* Host-task-owned connection state; cross-task readers use g_link_ready / g_q_lock. */
static uint16_t g_conn = BLE_HS_CONN_HANDLE_NONE;
static uint16_t g_ctl_handle;
static bool g_ctl_subscribed;
static bool g_peer_authorized;
static bool g_interval_requested;
static bool g_service_ready;
static atomic_bool g_link_ready;

/* Inbound JSONL reassembly buffer (NimBLE host task only; copied into RX queue). */
static EXT_RAM_BSS_ATTR char g_linebuf[PET_P4_BLE_LINE_MAX + 1];
static uint32_t g_linelen;
static uint32_t g_lines_dropped;

static void *pet_ble_buf_alloc(size_t size) {
#ifdef ESP_PLATFORM
  void *p = heap_caps_malloc(size, MALLOC_CAP_SPIRAM | MALLOC_CAP_8BIT);
  return p ? p : malloc(size);
#else
  return malloc(size);
#endif
}

/* Strict O(1) prefix whitelist matching {"topic":"<allowed> at frame start.
 * Prevents payload text substrings from bypassing topic filtering. */
static bool ble_topic_allowed(const char *line) {
  static const char header[] = "{\"topic\":\"";
  static const char *const allowed[] = {
      "hello\"",
      "ack\"",
      "state\"",
      "session/",
      "heartbeat\"",
      "ui/",
      "input/",
      "diagnostics/",
      "protocol/ack",
      "protocol/error",
      "asset/ack\"",
      "widget-install-ack\"",
      "widget/",
      "keyboard/config-state\"",
      "wasm/uv_request\"",
      "media/status\"", /* passive playback status broadcast only */
      "audio/volume-state\"",
      "data/",
      "firmware/status", /* passive version/OTA status broadcast only */
      "app/",
      "resources/bubble-font/status\"",
  };
  if (!line) return false;
  while (*line == '\n' || *line == '\r' || *line == ' ') line++;
  if (strncmp(line, header, sizeof(header) - 1) != 0) return false;
  const char *topic = line + (sizeof(header) - 1);
  for (size_t i = 0; i < sizeof(allowed) / sizeof(allowed[0]); i++) {
    if (strncmp(topic, allowed[i], strlen(allowed[i])) == 0) return true;
  }
  return false;
}

/* ---------- bounded ordered TX queue (event-driven on NimBLE host) ---------- */

typedef struct ble_qitem {
  struct ble_qitem *next;
  uint32_t conn_epoch;
  uint8_t *buf;
  uint32_t len, off;
} ble_qitem_t;

static ble_qitem_t *g_q_head, *g_q_tail;
static uint32_t g_q_items;
static size_t g_q_bytes;
static uint32_t g_q_conn_epoch;
static bool g_q_connected;
static uint32_t g_tx_dropped;
static portMUX_TYPE g_q_lock = portMUX_INITIALIZER_UNLOCKED;

static struct ble_npl_event g_tx_event;
static struct ble_npl_callout g_tx_retry;
static atomic_bool g_tx_scheduled;
static atomic_uint_least32_t g_reply_epoch;

static void q_clear_all(bool connected);

static void ble_tx_schedule(void) {
  if (!g_service_ready) return;
  if (!atomic_exchange_explicit(&g_tx_scheduled, true, memory_order_acq_rel)) {
    ble_npl_eventq_put(nimble_port_get_dflt_eventq(), &g_tx_event);
  }
}

static void ble_update_link_ready(void) {
  bool ready = g_service_ready && g_conn != BLE_HS_CONN_HANDLE_NONE
      && g_ctl_subscribed && g_peer_authorized;
  bool prev = atomic_load_explicit(&g_link_ready, memory_order_acquire);
  if (ready && !prev) {
    /* Open TX queue and RX line buffer on a fresh epoch only after both auth and notify subscribe. */
    g_linelen = 0;
    q_clear_all(true);
    atomic_store_explicit(&g_link_ready, true, memory_order_release);
    ble_tx_schedule();
  } else if (!ready && prev) {
    atomic_store_explicit(&g_link_ready, false, memory_order_release);
    g_linelen = 0;
    q_clear_all(false);
  }
}

static bool q_snapshot(uint32_t *epoch) {
  portENTER_CRITICAL(&g_q_lock);
  *epoch = g_q_conn_epoch;
  bool connected = g_q_connected;
  portEXIT_CRITICAL(&g_q_lock);
  return connected;
}

static bool q_push(ble_qitem_t *it) {
  portENTER_CRITICAL(&g_q_lock);
  bool accepted = g_q_connected
      && it->conn_epoch == g_q_conn_epoch
      && g_q_items < PET_P4_BLE_TX_MAX_ITEMS
      && g_q_bytes + it->len <= PET_P4_BLE_TX_MAX_BYTES;
  if (accepted) {
    it->next = NULL;
    if (g_q_tail) g_q_tail->next = it; else g_q_head = it;
    g_q_tail = it;
    g_q_items++;
    g_q_bytes += it->len;
  } else if (g_q_connected && it->conn_epoch == g_q_conn_epoch) {
    g_tx_dropped++;
  }
  uint32_t dropped = g_tx_dropped;
  portEXIT_CRITICAL(&g_q_lock);
  if (!accepted) {
    free(it->buf);
    free(it);
    if (dropped && (dropped & 0x3f) == 1) {
      ESP_LOGW(TAG, "TX_QUEUE_FULL dropped=%u", (unsigned)dropped);
    }
    return false;
  }
  ble_tx_schedule();
  return true;
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
  if (it) {
    g_q_head = it->next;
    if (!g_q_head) g_q_tail = NULL;
    if (g_q_items) g_q_items--;
    g_q_bytes = g_q_bytes >= it->len ? g_q_bytes - it->len : 0;
  }
  portEXIT_CRITICAL(&g_q_lock);
  return it;
}

static void q_clear_all(bool connected) {
  ble_qitem_t *stale = NULL;
  portENTER_CRITICAL(&g_q_lock);
  g_q_connected = connected;
  if (!++g_q_conn_epoch) g_q_conn_epoch = 1;
  stale = g_q_head;
  g_q_head = NULL;
  g_q_tail = NULL;
  g_q_items = 0;
  g_q_bytes = 0;
  portEXIT_CRITICAL(&g_q_lock);
  while (stale) {
    ble_qitem_t *next = stale->next;
    free(stale->buf);
    free(stale);
    stale = next;
  }
}

static bool ble_queue_line_for_epoch(const char *line, uint32_t expected_epoch) {
  if (!line || !atomic_load_explicit(&g_link_ready, memory_order_acquire)) return false;
  uint32_t conn_epoch;
  if (!q_snapshot(&conn_epoch)) return false;
  if (expected_epoch != 0 && conn_epoch != expected_epoch) return false;
  size_t n = strlen(line);
  if (n >= PET_P4_BLE_LINE_MAX) return false;
  ble_qitem_t *it = calloc(1, sizeof(*it));
  if (!it) return false;
  it->conn_epoch = conn_epoch;
  it->buf = pet_ble_buf_alloc(n + 1);
  if (!it->buf) { free(it); return false; }
  memcpy(it->buf, line, n);
  if (!n || it->buf[n - 1] != '\n') it->buf[n++] = '\n';
  it->len = (uint32_t)n;
  return q_push(it);
}

uint32_t pet_p4_ble_reply_epoch(void) {
  return atomic_load_explicit(&g_reply_epoch, memory_order_acquire);
}

void pet_p4_ble_set_reply_epoch(uint32_t expected_epoch) {
  atomic_store_explicit(&g_reply_epoch, expected_epoch, memory_order_release);
}

void pet_p4_ble_send_line_epoch(const char *line, uint32_t expected_epoch) {
  if (line && ble_topic_allowed(line))
    ble_queue_line_for_epoch(line, expected_epoch);
}

/* BLE send_line: enqueue whitelisted control lines for event-driven TX.
 * Replies (ctx != NULL) bind to the active request's epoch so a disconnect +
 * reconnect never leaks stale replies into a newer session. */
void ble_send_line_shim(const char *line, void *ctx) {
  uint32_t expected_epoch = ctx ? atomic_load_explicit(&g_reply_epoch, memory_order_acquire) : 0;
  pet_p4_ble_send_line_epoch(line, expected_epoch);
}

/* Runs strictly on the NimBLE host task. Drains up to PET_P4_BLE_TX_BURST_MAX
 * notify packets per invocation and arms a short callout only on congestion. */
static void ble_tx_step(void) {
  atomic_store_explicit(&g_tx_scheduled, false, memory_order_release);
  bool congested = false;
  for (unsigned sent = 0; sent < PET_P4_BLE_TX_BURST_MAX; ) {
    ble_qitem_t *it = q_peek();
    if (!it) return;
    uint32_t epoch;
    bool connected = q_snapshot(&epoch);
    if (!connected || it->conn_epoch != epoch) {
      it = q_pop();
      if (it) { free(it->buf); free(it); }
      continue;
    }
    if (g_conn == BLE_HS_CONN_HANDLE_NONE || !g_ctl_subscribed
        || !g_peer_authorized || !pet_p4_ble_peer_authorized(g_conn)) {
      return;
    }
    uint16_t mtu = ble_att_mtu(g_conn);
    if (mtu < 23) mtu = 23;
    uint32_t max_chunk = (uint32_t)(mtu - 3);
    uint32_t n = it->len - it->off;
    if (n > max_chunk) n = max_chunk;
    struct os_mbuf *om = ble_hs_mbuf_from_flat(it->buf + it->off, n);
    int rc = BLE_HS_ENOMEM;
    if (om) rc = ble_gatts_notify_custom(g_conn, g_ctl_handle, om);
    if (rc) {
      static uint32_t fails;
      if ((++fails & 0x3ff) == 1) {
        ESP_LOGW(TAG, "TX_NOTIFY_FAIL rc=%d n=%u", rc, (unsigned)fails);
      }
      congested = true;
      break;
    }
    it->off += n;
    sent++;
    if (it->off >= it->len) {
      it = q_pop();
      if (it) { free(it->buf); free(it); }
    }
  }
  if (q_peek() && g_conn != BLE_HS_CONN_HANDLE_NONE && g_ctl_subscribed && g_peer_authorized) {
    if (congested) {
      ble_npl_callout_reset(&g_tx_retry, ble_npl_time_ms_to_ticks32(PET_P4_BLE_TX_RETRY_MS));
    } else {
      ble_tx_schedule();
    }
  }
}

static void ble_tx_event_cb(struct ble_npl_event *event) {
  (void)event;
  ble_tx_step();
}

/* ---------- RX hand-off off the NimBLE host task ---------- */

typedef struct {
  char *line;
  uint32_t epoch;
} ble_rx_item_t;

static QueueHandle_t g_rx_queue;
static uint32_t g_rx_dropped;

static void rx_enqueue(const char *data, size_t len) {
  uint32_t epoch;
  if (!atomic_load_explicit(&g_link_ready, memory_order_acquire) || !q_snapshot(&epoch)) {
    return;
  }
  char *line = pet_ble_buf_alloc(len + 1);
  if (line) {
    memcpy(line, data, len);
    line[len] = '\0';
    ble_rx_item_t item = { .line = line, .epoch = epoch };
    if (g_rx_queue && xQueueSend(g_rx_queue, &item, 0) == pdTRUE) return;
    free(line);
  }
  if ((++g_rx_dropped & 0x3f) == 1) {
    ESP_LOGW(TAG, "RX_DROPPED n=%u", (unsigned)g_rx_dropped);
  }
}

static void ble_rx_task(void *arg) {
  (void)arg;
  ble_rx_item_t item;
  for (;;) {
    if (xQueueReceive(g_rx_queue, &item, portMAX_DELAY) != pdTRUE) continue;
    uint32_t current_epoch;
    bool current = atomic_load_explicit(&g_link_ready, memory_order_acquire)
        && q_snapshot(&current_epoch) && item.epoch == current_epoch;
    if (current) {
      int64_t t0 = esp_timer_get_time();
      pet_p4_ble_dispatch_line(item.line, item.epoch);
      int64_t us = esp_timer_get_time() - t0;
      if (us > 50000) ESP_LOGW(TAG, "RX_SLOW %lldms", us / 1000);
    }
    free(item.line);
  }
}

static void handle_ctl_byte(char c) {
  if (c == '\r') return;
  if (c == '\n') {
    if (g_linelen && g_linelen <= PET_P4_BLE_LINE_MAX) {
      g_linebuf[g_linelen] = '\0';
      ESP_LOGD(TAG, "CTRL_RX len=%u %.48s", (unsigned)g_linelen, g_linebuf);
      rx_enqueue(g_linebuf, g_linelen);
    }
    g_linelen = 0;
    return;
  }
  if (g_linelen < PET_P4_BLE_LINE_MAX) {
    g_linebuf[g_linelen++] = c;
  } else if (g_linelen == PET_P4_BLE_LINE_MAX) {
    g_lines_dropped++;
    ESP_LOGW(TAG, "LINE_TOO_LONG dropped=%u", (unsigned)g_lines_dropped);
    g_linelen++; /* stay dropped until newline resets */
  }
}

static int access_cb(uint16_t conn, uint16_t attr,
                     struct ble_gatt_access_ctxt *ctx, void *arg) {
  (void)attr;
  (void)arg;
  bool sec = g_service_ready && conn == g_conn && pet_p4_ble_peer_authorized(conn);
  ESP_LOGD(TAG, "ACCESS op=%u secure=%d", ctx->op, sec);
  if (!sec) {
    return BLE_ATT_ERR_INSUFFICIENT_AUTHEN;
  }
  if (ctx->op == BLE_GATT_ACCESS_OP_WRITE_CHR) {
    if (!atomic_load_explicit(&g_link_ready, memory_order_acquire)) {
      return BLE_ATT_ERR_INSUFFICIENT_AUTHEN;
    }
    uint16_t total = OS_MBUF_PKTLEN(ctx->om);
    if (!total || total > 600) {
      return BLE_ATT_ERR_INVALID_ATTR_VALUE_LEN;
    }
    /* Copy in small slices to keep NimBLE host stack usage bounded (4 KiB stack). */
    uint8_t tmp[PET_P4_BLE_RX_SLICE_BYTES];
    uint16_t off = 0;
    while (off < total) {
      uint16_t chunk = total - off;
      if (chunk > sizeof(tmp)) chunk = sizeof(tmp);
      if (os_mbuf_copydata(ctx->om, off, chunk, tmp) != 0) {
        return BLE_ATT_ERR_INVALID_ATTR_VALUE_LEN;
      }
      for (uint16_t i = 0; i < chunk; i++) handle_ctl_byte((char)tmp[i]);
      off += chunk;
    }
    return 0;
  }
  if (ctx->op == BLE_GATT_ACCESS_OP_READ_CHR) {
    static const char ready[] = "{\"ble\":\"ready\",\"secure\":true,\"bonded\":1}";
    return os_mbuf_append(ctx->om, ready, sizeof(ready) - 1) == 0
        ? 0 : BLE_ATT_ERR_INSUFFICIENT_RES;
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

static void request_desktop_interval(uint16_t conn) {
  if (g_interval_requested || conn == BLE_HS_CONN_HANDLE_NONE) return;
  g_interval_requested = true;
  struct ble_gap_upd_params params = {
    .itvl_min = 12, .itvl_max = 12, .latency = 0, .supervision_timeout = 400,
  };
  int rc = ble_gap_update_params(conn, &params);
  ESP_LOGI(TAG, "Desktop 15 ms interval request: %d", rc);
  (void)rc;
}

void pet_p4_ble_reset(void) {
  if (g_service_ready) ble_npl_callout_stop(&g_tx_retry);
  q_clear_all(false);
  g_conn = BLE_HS_CONN_HANDLE_NONE;
  g_ctl_subscribed = false;
  g_peer_authorized = false;
  g_interval_requested = false;
  g_linelen = 0;
  atomic_store_explicit(&g_link_ready, false, memory_order_release);
}

void pet_p4_ble_on_auth_changed(uint16_t conn_handle, bool authorized) {
  if (conn_handle != g_conn || g_conn == BLE_HS_CONN_HANDLE_NONE) {
    g_peer_authorized = false;
  } else {
    g_peer_authorized = authorized;
  }
  ble_update_link_ready();
}

void pet_p4_ble_gap_event(const struct ble_gap_event *event) {
  switch (event->type) {
    case BLE_GAP_EVENT_CONNECT:
      if (!event->connect.status) {
        atomic_store_explicit(&g_link_ready, false, memory_order_release);
        q_clear_all(false);
        g_conn = event->connect.conn_handle;
        g_ctl_subscribed = false;
        g_peer_authorized = false;
        g_interval_requested = false;
        g_linelen = 0;
      }
      break;
    case BLE_GAP_EVENT_DISCONNECT:
      if (event->disconnect.conn.conn_handle == g_conn) {
        pet_p4_ble_reset();
      }
      break;
    case BLE_GAP_EVENT_SUBSCRIBE:
      if (event->subscribe.conn_handle == g_conn && event->subscribe.attr_handle == g_ctl_handle) {
        g_ctl_subscribed = event->subscribe.cur_notify;
        ble_update_link_ready();
        if (g_ctl_subscribed && !event->subscribe.prev_notify) {
          uint16_t conn = event->subscribe.conn_handle;
          int length_rc = ble_gap_set_data_len(conn, 251, 2120);
          int phy_rc = ble_gap_set_prefered_le_phy(conn, BLE_GAP_LE_PHY_2M_MASK,
                                                   BLE_GAP_LE_PHY_2M_MASK, 0);
          ESP_LOGI(TAG, "Desktop link negotiation: length=%d phy=%d", length_rc, phy_rc);
          (void)length_rc;
          /* If the controller/peer declines starting 2M PHY negotiation, request the
           * 15 ms connection interval immediately instead of waiting forever. */
          if (phy_rc != 0) request_desktop_interval(conn);
        }
      }
      break;
    case BLE_GAP_EVENT_PHY_UPDATE_COMPLETE:
      if (g_ctl_subscribed && event->phy_updated.conn_handle == g_conn) {
        /* Sequence the interval request after the PHY procedure completes
         * (even if the peer stayed on 1M PHY). */
        request_desktop_interval(g_conn);
      }
      break;
    default: break;
  }
}

int pet_p4_ble_register(void) {
  if (g_service_ready) return 0;
  int rc = ble_gatts_count_cfg(g_svcs);
  if (rc) return rc;
  rc = ble_gatts_add_svcs(g_svcs);
  if (rc) return rc;
  g_rx_queue = xQueueCreate(PET_P4_BLE_RX_QUEUE_DEPTH, sizeof(ble_rx_item_t));
  if (!g_rx_queue) return BLE_HS_ENOMEM;
  if (xTaskCreate(ble_rx_task, "pet_ble_rx", 8192, NULL, 5, NULL) != pdPASS) {
    vQueueDelete(g_rx_queue);
    g_rx_queue = NULL;
    return BLE_HS_ENOMEM;
  }
  ble_npl_event_init(&g_tx_event, ble_tx_event_cb, NULL);
  ble_npl_callout_init(&g_tx_retry, nimble_port_get_dflt_eventq(), ble_tx_event_cb, NULL);
  atomic_store_explicit(&g_tx_scheduled, false, memory_order_release);
  g_service_ready = true;
  return 0;
}

void pet_p4_ble_advertise_service(void) {
  if (!g_service_ready) return;
  struct ble_hs_adv_fields response = {
    .uuids128 = &g_svc_uuid, .num_uuids128 = 1, .uuids128_is_complete = 1
  };
  int rc = ble_gap_adv_rsp_set_fields(&response);
  if (rc) ESP_LOGW(TAG, "Unable to advertise desktop service: %d", rc);
}

bool pet_p4_ble_is_transport(pet_p4_send_line_fn send_line) {
  return send_line == ble_send_line_shim;
}

bool pet_p4_ble_link_ready(void) {
  return atomic_load_explicit(&g_link_ready, memory_order_acquire);
}

uint32_t pet_p4_ble_link_epoch(void) {
  uint32_t epoch;
  (void)q_snapshot(&epoch);
  return epoch;
}
