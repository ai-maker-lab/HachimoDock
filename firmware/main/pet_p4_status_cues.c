#include "pet_p4_status_cues.h"
#include "nvs.h"
#include <stdatomic.h>

/* Publish enabled+volume together to the playback task only after commit. */
static atomic_uint g_config = 30;
static atomic_bool g_initialized;
static atomic_bool g_persisted;
static void publish(pet_p4_status_cues_t c) { atomic_store(&g_config, (c.enabled << 8) | c.volume); }
void pet_p4_status_cues_init(void) {
  if (atomic_exchange(&g_initialized, true)) return;
  pet_p4_status_cues_t c = PET_P4_STATUS_CUES_DEFAULT, stored;
  nvs_handle_t h; size_t size = sizeof(stored);
  if (nvs_open("pet_cues", NVS_READONLY, &h) == ESP_OK) {
    if (nvs_get_blob(h, "config", &stored, &size) == ESP_OK
        && size == sizeof(stored) && pet_p4_status_cues_valid(stored)) {
      c = stored;
      atomic_store(&g_persisted, true);
    }
    nvs_close(h);
  }
  publish(c);
}
pet_p4_status_cues_t pet_p4_status_cues_get(void) {
  unsigned c = atomic_load(&g_config);
  return (pet_p4_status_cues_t){1, (c >> 8) & 1, c & 255, 0};
}
esp_err_t pet_p4_status_cues_set(bool enabled, unsigned volume) {
  if (volume > 100) return ESP_ERR_INVALID_ARG;
  pet_p4_status_cues_init();
  pet_p4_status_cues_t c = {1, enabled, volume, 0};
  pet_p4_status_cues_t previous = pet_p4_status_cues_get();
  if (atomic_load(&g_persisted) && previous.enabled == c.enabled && previous.volume == c.volume) return ESP_OK;
  nvs_handle_t h;
  esp_err_t err = nvs_open("pet_cues", NVS_READWRITE, &h);
  if (err != ESP_OK) return err;
  err = nvs_set_blob(h, "config", &c, sizeof(c));
  if (err == ESP_OK) err = nvs_commit(h);
  nvs_close(h);
  if (err == ESP_OK) {
    atomic_store(&g_persisted, true);
    publish(c);
  }
  return err;
}
