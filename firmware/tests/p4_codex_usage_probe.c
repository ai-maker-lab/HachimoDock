#include "hachi.h"

static uint64_t total;

void hachi_init(void) {
    hachi_canvas640();
    total = UINT64_MAX;
}

void hachi_event(int type, int low, int high) {
    if (type == HACHI_CODEX_DAY_TOKENS) total = hachi_codex_day_tokens(low, high);
}

void hachi_frame(int elapsed_ms) {
    (void)elapsed_ms;
    hachi_rect(0, 0, 640, 480, 0x102637);
    hachi_text(36, 116, 24, 0xbae8ee, "CODEX / TODAY", 13);
    if (total == UINT64_MAX) {
        hachi_text(36, 188, 24, 0xeed093, "NO FRESH SAMPLE", 15);
        return;
    }
    char digits[16];
    unsigned start = sizeof(digits);
    uint64_t remaining = total;
    do {
        digits[--start] = (char)('0' + remaining % 10);
        remaining /= 10;
    } while (remaining && start);
    hachi_text(36, 180, 32, 0xeed093, digits + start, sizeof(digits) - start);
}
