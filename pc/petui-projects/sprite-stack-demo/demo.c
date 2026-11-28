#define HACHI_NATIVE_CANVAS
#include "hachi.h"
#include "jet_ssk.h"

/* A complete rotation in 16 steps. The same jet model is used for both instances. */
static const int sine[] = {0, 98, 181, 237, 256, 237, 181, 98, 0, -98, -181, -237, -256, -237, -181, -98};
static unsigned angle;
static int clock_ms, direction = 1;
static hachi_stack_instance_t jets[] = {
    {HACHI_STACK_OFFSET(jet_ssk), sizeof(jet_ssk),
     {-20 * 256, 0, 0}, {{256, 0, 0}, {0, 222, 128}, {0, -128, 222}}, 374},
    {HACHI_STACK_OFFSET(jet_ssk), sizeof(jet_ssk),
     {12 * 256, 35 * 256, -5 * 256},
     {{181, 181, 0}, {-157, 157, 128}, {90, -90, 222}}, 326},
};
static const hachi_stack_scene_t scene = {
    .width = 160, .height = 120, .pixel_scale = 4,
    .scale_q8 = 256, .perspective_q16 = 512, .slope_q8 = 24,
    .center_x_q8 = 80 * 256, .center_y_q8 = 60 * 256,
    .instances = HACHI_STACK_OFFSET(jets), .count = 2,
};

HACHI_EXPORT(hachi_init) void hachi_init(void) {
    hachi_canvas640();
}

HACHI_EXPORT(hachi_event) void hachi_event(int kind, int key, int ignored) {
    (void)ignored;
    if (kind == HACHI_KEY_DOWN && key == HACHI_A) direction = -direction;
}

HACHI_EXPORT(hachi_frame) void hachi_frame(int elapsed_ms) {
    clock_ms += elapsed_ms;
    if (clock_ms >= 112) {
        clock_ms -= 112;
        angle = (angle + (unsigned)direction) & 15;
    }
    const int s = sine[angle], c = sine[(angle + 4) & 15];
    jets[0].axes_q8[0][0] = c;
    jets[0].axes_q8[0][1] = -s / 2;
    jets[0].axes_q8[0][2] = s * 222 / 256;
    jets[0].axes_q8[2][0] = -s;
    jets[0].axes_q8[2][1] = -c / 2;
    jets[0].axes_q8[2][2] = c * 222 / 256;
    jets[1].origin_q8[0] = (12 + s / 16) * 256;
    hachi_rect(0, 0, 640, 480, 0x203e60);
    hachi_rect(0, 284, 640, 196, 0x132944);
    if (hachi_stack_draw(&scene)) __builtin_trap();
}
