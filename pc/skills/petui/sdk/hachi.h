#ifndef HACHI_H
#define HACHI_H

#include <stdint.h>

#ifdef __cplusplus
extern "C" {
#endif

#if defined(HACHI_NATIVE_CANVAS)
#define HACHI_WIDTH 640
#define HACHI_HEIGHT 480
#else
#define HACHI_WIDTH 320
#define HACHI_HEIGHT 240
#endif

#define HACHI_IMPORT(name) __attribute__((import_module("hachi"), import_name(#name)))
#define HACHI_EXPORT(name) __attribute__((export_name(#name)))

/* A native-canvas module may add the empty hachi-frame-continuation-v1
 * custom section. On supporting hosts this bit accompanies the elapsed ms.
 * Return from a callback without drawing to continue the current image. */
#define HACHI_FRAME_CONTINUATION_FLAG (1 << 16)

enum {
    HACHI_TOUCH_DOWN = 1,
    HACHI_TOUCH_MOVE = 2,
    HACHI_TOUCH_UP = 3,
    HACHI_KEY_DOWN = 4,
    HACHI_KEY_UP = 5,
    HACHI_TOUCH_CANCEL = 6,
};

enum {
    HACHI_LEFT = 1,
    HACHI_RIGHT,
    HACHI_UP,
    HACHI_DOWN,
    HACHI_A,
    HACHI_B,
    HACHI_SELECT,
};

/* Call once from hachi_init to select native pixel and touch coordinates.
 * Submit single-line UTF-8 in hachi_frame. The host paints it above all graphics. */
HACHI_IMPORT(canvas640) void hachi_canvas640(void);

/* mirui-sprite-stack-v1. The offsets below refer to WASM linear memory. */
#define HACHI_STACK_OFFSET(pointer) ((uint32_t)(uintptr_t)(pointer))
#define HACHI_STACK_MAX_OBJECTS 4

typedef struct {
    uint32_t model, model_bytes;          /* Prepared SSK1 model */
    int32_t origin_q8[3], axes_q8[3][3];   /* Camera-space origin and model axes */
    int32_t scale_q8;
} hachi_stack_instance_t;

typedef struct {
    int32_t x, y;                         /* Destination on the 640×480 canvas */
    uint32_t width, height, pixel_scale;   /* Logical viewport, followed by integer upscale */
    int32_t scale_q8, perspective_q16, slope_q8, center_x_q8, center_y_q8;
    uint32_t instances, count;
} hachi_stack_scene_t;

/* One call in hachi_frame. Returns 0, -1 (input), -2 (callback/limit), or -3 (memory). */
HACHI_IMPORT(stack_draw) int hachi_stack_draw(const hachi_stack_scene_t *scene);

/* mirui-height-field-v1. Plane bytes are height[4096], material[4096], clouds[1024].
 * The palette is 17 RGB888 entries. Camera center and scale use the 320×240 viewport. */
typedef struct {
    uint32_t planes, palette;
    int32_t camera_x_q8, camera_y_q8, altitude_q8;
    int32_t sin_yaw_q12, cos_yaw_q12, sin_roll_q12, cos_roll_q12;
    int32_t scale_q8, perspective_q16, slope_q8, center_x_q8, center_y_q8;
} hachi_terrain_scene_t;

/* One call in hachi_frame. Draw the opaque terrain before other canvas graphics. */
HACHI_IMPORT(terrain_draw) int hachi_terrain_draw(const hachi_terrain_scene_t *scene);

typedef struct {
    hachi_terrain_scene_t terrain;
    uint32_t instances, count; /* Up to four hachi_stack_instance_t entries. */
} hachi_world_scene_t;

/* One 3D call per native frame. Positions and axes are (right, depth, up)
 * before pitch/slope and roll. Terrain and models share depth. Draw HUD after. */
HACHI_IMPORT(world_draw) int hachi_world_draw(const hachi_world_scene_t *scene);
#define HACHI_SCENE_MAX_STACKS 16
#define HACHI_SCENE_MAX_BILLBOARDS 48
#define HACHI_SCENE_MAX_ART 32
enum {
    HACHI_SCENE_HEIGHT_FIELD = 0, HACHI_SCENE_WALLS = 1, HACHI_SCENE_SPACE = 2,
    HACHI_SCENE_STARS = 1,
};

typedef struct {
    int32_t origin_q8[3], width_q8, height_q8;
    uint32_t art;
} hachi_billboard_t;

typedef struct {
    hachi_terrain_scene_t terrain;
    uint32_t mode, map, map_width, map_height; /* Space mode uses map as its star-field seed. */
    uint32_t art, art_count, palette, billboards, billboard_count;
    uint32_t instances, count;
    uint32_t sky_rgb, ground_rgb, fog_rgb;
    int32_t fog_start_q8, fog_end_q8;
    uint32_t flags;
} hachi_scene_t;

/* Textures are 16×16 indices into 16 RGBA8888 colors. Map cells are 0 (empty)
 * or a one-based opaque texture. Billboard index zero is transparent. All
 * positions and dimensions are Q8. This fills a 160×120 depth-tested scene
 * and expands it 4× on the native screen. Submit HUD and text afterward. */
HACHI_IMPORT(scene_draw) int hachi_scene_draw(const hachi_scene_t *scene);
HACHI_IMPORT(text) void hachi_text(int x, int y, int px, int rgb,
                                   const char *utf8, unsigned bytes);

HACHI_IMPORT(rect) void hachi_rect(int x, int y, int width, int height, int rgb);
HACHI_IMPORT(blit) void hachi_blit(int x, int y, int width, int height, const uint16_t *pixels);
HACHI_IMPORT(sprite) void hachi_sprite(int x, int y, int width, int height,
                                     const uint8_t *asset, unsigned bytes);
HACHI_IMPORT(tone) void hachi_tone(int hz, int milliseconds, int volume);
/* In hachi_event only. Select a cue in assets/speech.hab, or use -1 to stop. */
HACHI_IMPORT(sample) void hachi_sample(int cue);
static inline void hachi_music(int cue) {
    if (cue == -1) hachi_sample(128);
    else if ((unsigned)cue < 64) hachi_sample(64 + cue);
}
HACHI_IMPORT(load) int hachi_load(int slot, int fallback);
HACHI_IMPORT(save) void hachi_save(int slot, int value);
enum { HACHI_MEDIA_PREVIOUS = 1, HACHI_MEDIA_TOGGLE, HACHI_MEDIA_NEXT,
       HACHI_MEDIA_QUIETER, HACHI_MEDIA_LOUDER, HACHI_MEDIA_QUEUE, HACHI_MEDIA_SELECT };
/* Read a bounded host snapshot during hachi_frame. All times are milliseconds.
 * CLOCK_LOCAL uses UTC epoch plus signed UTC offset minutes in value.
 * CLOCK_MONOTONIC uses time since device boot, with value and age_ms zero.
 * UV uses sample UTC epoch, UV index × 100 in value, and sample age.
 * The output is zeroed when unavailable. Status: 0 unavailable, 1 ready, 2 stale. */
typedef struct {
    uint64_t time_ms;
    int32_t value;
    uint32_t age_ms;
} hachi_snapshot_t;

enum { HACHI_CLOCK_LOCAL = 0, HACHI_CLOCK_MONOTONIC = 1 };
enum { HACHI_UNAVAILABLE = 0, HACHI_READY = 1, HACHI_STALE = 2 };
HACHI_IMPORT(clock_read) int hachi_clock_read(int clock, hachi_snapshot_t *out);
HACHI_IMPORT(uv_read) int hachi_uv_read(hachi_snapshot_t *out);
/* A fresh unsigned value from the host, for games and visual effects. */
HACHI_IMPORT(random_u32) uint32_t hachi_random_u32(void);

/* component-network-v1: bounded asynchronous services. See component-network.md.
 * Submit up to 8192 JSON bytes. Poll <=512 bytes, read <=4096 bytes per call.
 * Release response handles after use. hachi_service_read reads response payloads;
 * credential.get returns presence status and zero bytes. At most 8 calls per entry.
 * Errors are negative; 0 from poll means no event. No network occurs in previews
 * and service calls return unavailable in the browser preview. */
HACHI_IMPORT(service_submit) int hachi_service_submit(const char *,unsigned);
HACHI_IMPORT(service_poll) int hachi_service_poll(char *,unsigned);
HACHI_IMPORT(service_read) int hachi_service_read(unsigned,unsigned,void *,unsigned);
HACHI_IMPORT(service_release) int hachi_service_release(unsigned);

HACHI_IMPORT(media_cmd) void hachi_media_cmd(int command);

HACHI_EXPORT(hachi_init) void hachi_init(void);
HACHI_EXPORT(hachi_event) void hachi_event(int type, int a, int b);
HACHI_EXPORT(hachi_frame) void hachi_frame(int elapsed_ms);

#ifdef __cplusplus
}
#endif

#endif
