#ifndef HACHI_SPRITE_STACK_H
#define HACHI_SPRITE_STACK_H

#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

#ifndef HACHI_STACK_ENABLED
#define HACHI_STACK_ENABLED 0
#endif
#define HACHI_STACK_PROFILE "mirui-sprite-stack-v1"
#define HACHI_TERRAIN_PROFILE "mirui-height-field-v1"
#define HACHI_SCENE_PROFILE "mirui-scene-v1"
#define HACHI_WORLD_PROFILE "mirui-world-canvas-v1"
#define HACHI_WORLD_160_PROFILE "mirui-world-canvas-160-v1"
enum { HACHI_STACK_OBJECTS = 4, HACHI_STACK_MODEL_BYTES = 12850 };
enum { HACHI_TERRAIN_BYTES = 9216, HACHI_TERRAIN_COLORS = 17 };

typedef struct {
    int32_t x, y;
    uint32_t width, height, pixel_scale;
    int32_t scale_q8, perspective_q16, slope_q8, center_x_q8, center_y_q8;
    uint32_t instances, count;
} hachi_stack_scene_t;

typedef struct {
    uint32_t model, model_bytes;
    int32_t origin_q8[3], axes_q8[3][3], scale_q8;
} hachi_stack_instance_t;

typedef struct {
    const uint8_t *model;
    size_t model_bytes;
    int32_t origin_q8[3], axes_q8[3][3], scale_q8;
} hachi_stack_object_t;

typedef struct {
    uint32_t planes, palette;
    int32_t camera_x_q8, camera_y_q8, altitude_q8;
    int32_t sin_yaw_q12, cos_yaw_q12, sin_roll_q12, cos_roll_q12;
    int32_t scale_q8, perspective_q16, slope_q8, center_x_q8, center_y_q8;
} hachi_terrain_scene_t;

typedef struct {
    hachi_terrain_scene_t terrain;
    uint32_t instances, count;
} hachi_world_scene_t;

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
    uint32_t mode, map, map_width, map_height;
    uint32_t art, art_count, palette, billboards, billboard_count;
    uint32_t instances, count;
    uint32_t sky_rgb, ground_rgb, fog_rgb;
    int32_t fog_start_q8, fog_end_q8;
    uint32_t flags;
} hachi_scene_t;

typedef struct {
    const uint8_t *planes, *terrain_palette, *map, *art, *palette;
    const hachi_billboard_t *billboards;
} hachi_scene_assets_t;

int pet_scene_render(void *context, const hachi_scene_t *scene, const hachi_scene_assets_t *assets,
                     const hachi_stack_object_t *objects, uint16_t *screen, uint32_t *timing_us);

void *pet_stack_create(void);
void pet_stack_destroy(void *context);
int pet_stack_render(void *context, const hachi_stack_scene_t *scene,
                     const hachi_stack_object_t *objects, uint16_t *screen,
                     size_t screen_width, size_t screen_height);
void *pet_terrain_create(bool half_resolution);
void pet_terrain_destroy(void *context);
int pet_terrain_render(void *context, const hachi_terrain_scene_t *scene,
                       const uint8_t *planes, const uint8_t *palette, uint16_t *screen);
int pet_world_render(void *context, const hachi_terrain_scene_t *scene,
                     const uint8_t *planes, const uint8_t *palette,
                     const hachi_stack_object_t *objects, size_t count,
                     uint16_t *screen, uint32_t *timing_us);

#endif
