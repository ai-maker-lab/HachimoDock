#pragma once
#include <stdbool.h>
#include <stdint.h>
#include <stddef.h>
#include <string.h>
#include "esp_err.h"

typedef struct { uint8_t version, enabled, volume, reserved; } pet_p4_status_cues_t;
#define PET_P4_STATUS_CUES_DEFAULT ((pet_p4_status_cues_t){1, 0, 30, 0})
static inline bool pet_p4_status_cues_valid(pet_p4_status_cues_t c) {
  return c.version == 1 && c.enabled <= 1 && c.volume <= 100 && c.reserved == 0;
}
/* Byte access avoids unaligned int16 accesses in the DMA staging buffer. */
static inline void pet_p4_status_cues_scale(uint8_t *pcm, size_t bytes, unsigned volume) {
  for (size_t i = 0; i + 1 < bytes; i += 2) {
    int32_t sample = (int16_t)((uint16_t)pcm[i] | (uint16_t)pcm[i+1] << 8);
    int64_t scaled = (int64_t)sample * volume / 100;
    if (scaled > INT16_MAX) scaled = INT16_MAX;
    if (scaled < INT16_MIN) scaled = INT16_MIN;
    uint16_t out = (uint16_t)(int16_t)scaled;
    pcm[i] = out & 255; pcm[i+1] = out >> 8;
  }
}
void pet_p4_status_cues_init(void);
pet_p4_status_cues_t pet_p4_status_cues_get(void);
esp_err_t pet_p4_status_cues_set(bool enabled, unsigned volume);
