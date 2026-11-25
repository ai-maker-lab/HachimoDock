#include "pet_p4_codex_usage.h"

#include <assert.h>

static bool receive(pet_codex_usage_t *current, const char *json, uint64_t now_ms) {
  cJSON *payload = cJSON_Parse(json);
  assert(payload);
  pet_codex_usage_sample_t next;
  bool parsed = pet_codex_usage_parse(payload, now_ms, &next);
  cJSON_Delete(payload);
  if (parsed) pet_codex_usage_apply(current, &next);
  return parsed;
}

#define USAGE_EVENT(source, period, timestamp, count) \
  "{\"source\":\"" source "\",\"tokenUsagePeriod\":\"" period "\",\"tsMs\":" timestamp \
  ",\"sessionTitle\":\"ignored\",\"tokenUsage\":{\"totalTokens\":" count "}}"

static bool next_day(const pet_codex_usage_t *usage, uint64_t now_ms,
                     uint64_t *prior, int *low, int *high) {
  uint64_t day = pet_codex_usage_fresh(&usage->latest, now_ms) ? usage->latest.total : UINT64_MAX;
  return pet_codex_usage_next(day, prior, low, high);
}

int main(void) {
  pet_codex_usage_t current = {0};
  uint64_t prior = UINT64_MAX - 1;
  int low, high;
  assert(next_day(&current, 0, &prior, &low, &high) && low == 0 && high == -1);
  assert(!next_day(&current, 1, &prior, &low, &high));
  assert(!receive(&current, USAGE_EVENT("codex", "session", "100", "42"), 2));
  assert(!receive(&current, USAGE_EVENT("codex", "today", "0", "42"), 2));
  assert(!receive(&current, USAGE_EVENT("codex", "today", "100", "-1"), 2));
  assert(!receive(&current, USAGE_EVENT("codex", "today", "100", "4.2"), 2));
  assert(!receive(&current, USAGE_EVENT("codex", "today", "100", "9007199254740992"), 2));
  assert(receive(&current, USAGE_EVENT("codex", "today", "100", "9007199254740991"), 3));
  assert(next_day(&current, 2, &prior, &low, &high) && low == INT32_MAX && high == 4194303);
  assert(!current.minute_total);
  assert(receive(&current, USAGE_EVENT("codex", "today", "100", "42"), 4));
  assert(receive(&current, USAGE_EVENT("codex", "today", "99", "42"), 5));
  assert(!next_day(&current, PET_CODEX_USAGE_MAX_AGE_MS + 2, &prior, &low, &high));
  assert(next_day(&current, PET_CODEX_USAGE_MAX_AGE_MS + 3, &prior, &low, &high) && high == -1);
  assert(receive(&current, USAGE_EVENT("codex", "today", "101", "0"), 300010));
  assert(next_day(&current, 300010, &prior, &low, &high) && low == 0 && high == 0);
  assert(receive(&current, USAGE_EVENT("codex", "today", "102", "0"), 300011));
  assert(!next_day(&current, 300011, &prior, &low, &high));
  assert(receive(&current, USAGE_EVENT("claude-code", "today", "103", "99"), 300012));
  assert(next_day(&current, 300012, &prior, &low, &high) && high == -1);

  assert(receive(&current, USAGE_EVENT("codex", "today", "1000000", "200000"), 301000));
  assert(current.minute_total == 0);
  assert(receive(&current, USAGE_EVENT("codex", "today", "1001000", "201000"), 302000));
  assert(receive(&current, USAGE_EVENT("codex", "today", "1001111", "202000"), 302111));
  assert(receive(&current, USAGE_EVENT("codex", "today", "1001111", "999999"), 302112));
  assert(receive(&current, USAGE_EVENT("codex", "today", "1000100", "999999"), 302113));
  assert(receive(&current, USAGE_EVENT("codex", "today", "1003000", "302000"), 304000));
  assert(current.minute_total == 102000);
  pet_codex_usage_advance(&current, 361999);
  assert(current.minute_total == 102000);
  pet_codex_usage_advance(&current, 362000);
  assert(current.minute_total == 100000);
  pet_codex_usage_advance(&current, 364000);
  assert(current.minute_total == 0);
  assert(receive(&current, USAGE_EVENT("codex", "today", "1063000", "900000"), 364000));
  assert(current.minute_total == 0);
  assert(receive(&current, USAGE_EVENT("codex", "today", "1063001", "901000"), 364001));
  assert(current.minute_total == 1000);
  assert(receive(&current, USAGE_EVENT("codex", "today", "1063002", "100"), 364002));
  assert(current.minute_total == 0);
  assert(receive(&current, USAGE_EVENT("codex", "today", "1063003", "110"), 364003));
  assert(current.minute_total == 10);
  assert(receive(&current, USAGE_EVENT("claude-code", "today", "1064000", "17"), 365000));
  assert(!current.latest.available && current.minute_total == 0);
}
