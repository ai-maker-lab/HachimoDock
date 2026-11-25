#pragma once

#include "cJSON.h"

#include <stdbool.h>
#include <stdint.h>
#include <string.h>

enum {
  PET_CODEX_DAY_TOKENS_EVENT = 32, PET_CODEX_MINUTE_TOKENS_EVENT = 33,
  PET_CODEX_USAGE_MAX_AGE_MS = 300000, PET_CODEX_USAGE_WINDOW_MS = 60000,
  PET_CODEX_USAGE_BUCKETS = 60
};

typedef struct {
  uint64_t source_ms;
  uint64_t received_ms;
  uint64_t total;
  bool available;
} pet_codex_usage_sample_t;

typedef struct {
  pet_codex_usage_sample_t latest;
  uint64_t second;
  uint64_t minute_total;
  uint64_t buckets[PET_CODEX_USAGE_BUCKETS];
} pet_codex_usage_t;

static inline bool pet_codex_usage_u53(const cJSON *item, uint64_t *value) {
  if (!cJSON_IsNumber(item) ||
      !(item->valuedouble >= 0 && item->valuedouble <= 9007199254740991.0)) return false;
  uint64_t integer = (uint64_t)item->valuedouble;
  if ((double)integer != item->valuedouble) return false;
  *value = integer;
  return true;
}

static inline bool pet_codex_usage_parse(const cJSON *payload, uint64_t now_ms,
                                         pet_codex_usage_sample_t *sample) {
  const cJSON *source = cJSON_GetObjectItemCaseSensitive(payload, "source");
  const cJSON *period = cJSON_GetObjectItemCaseSensitive(payload, "tokenUsagePeriod");
  const cJSON *usage = cJSON_GetObjectItemCaseSensitive(payload, "tokenUsage");
  uint64_t source_ms, total;
  if (!cJSON_IsString(source) || !source->valuestring[0] || !cJSON_IsString(period) ||
      strcmp(period->valuestring, "today") || !cJSON_IsObject(usage) ||
      !pet_codex_usage_u53(cJSON_GetObjectItemCaseSensitive(payload, "tsMs"), &source_ms) ||
      !source_ms || !pet_codex_usage_u53(cJSON_GetObjectItemCaseSensitive(usage, "totalTokens"), &total))
    return false;
  bool codex = strcmp(source->valuestring, "codex") == 0;
  *sample = (pet_codex_usage_sample_t){source_ms, now_ms, codex ? total : 0, codex};
  return true;
}

static inline void pet_codex_usage_clear(pet_codex_usage_t *usage) {
  if (usage->minute_total) memset(usage->buckets, 0, sizeof(usage->buckets));
  usage->minute_total = 0;
}

static inline void pet_codex_usage_advance(pet_codex_usage_t *usage, uint64_t now_ms) {
  uint64_t second = now_ms / 1000;
  if (second <= usage->second) return;
  if (second - usage->second >= PET_CODEX_USAGE_BUCKETS || !usage->minute_total) {
    pet_codex_usage_clear(usage);
    usage->second = second;
    return;
  }
  while (usage->second < second) {
    uint64_t *bucket = &usage->buckets[++usage->second % PET_CODEX_USAGE_BUCKETS];
    usage->minute_total -= *bucket;
    *bucket = 0;
  }
}

static inline bool pet_codex_usage_fresh(const pet_codex_usage_sample_t *sample, uint64_t now_ms) {
  return sample->available && (now_ms < sample->received_ms ||
         now_ms - sample->received_ms < PET_CODEX_USAGE_MAX_AGE_MS);
}

static inline void pet_codex_usage_apply(pet_codex_usage_t *usage,
                                         const pet_codex_usage_sample_t *sample) {
  const pet_codex_usage_sample_t *latest = &usage->latest;
  if (sample->source_ms <= latest->source_ms) return;
  pet_codex_usage_advance(usage, sample->received_ms);
  if (!sample->available || !pet_codex_usage_fresh(latest, sample->received_ms) ||
      sample->total < latest->total) {
    pet_codex_usage_clear(usage);
  } else if (sample->source_ms - latest->source_ms < PET_CODEX_USAGE_WINDOW_MS &&
             sample->received_ms - latest->received_ms < PET_CODEX_USAGE_WINDOW_MS) {
    uint64_t added = sample->total - latest->total;
    usage->buckets[usage->second % PET_CODEX_USAGE_BUCKETS] += added;
    usage->minute_total += added;
  }
  usage->latest = *sample;
}

static inline bool pet_codex_usage_next(uint64_t value, uint64_t *prior_value, int *low, int *high) {
  if (value == *prior_value) return false;
  *prior_value = value;
  *low = value == UINT64_MAX ? 0 : (int)(value & INT32_MAX);
  *high = value == UINT64_MAX ? -1 : (int)(value >> 31);
  return true;
}
