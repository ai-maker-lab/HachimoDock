//! Draw a bounded repeating height field with Mirui's TerrainView.
use alloc::boxed::Box;
use core::{ptr, slice};
use mirui::types::{Fixed, Fixed64};
use mirui_sprite_stack::raster::{
    Frame, Projection, RollMapping, Workspace, sheet_side,
    terrain::{TerrainColumn, TerrainRow, TerrainSurface, TerrainView},
};

use super::scene::{self, Assets, Decoration, Request};

const WIDTH: usize = 320;
const HEIGHT: usize = 240;
const PANEL_WIDTH: usize = WIDTH * 2;
const PANEL_HEIGHT: usize = HEIGHT * 2;
const PIVOT: Fixed = Fixed::from_int(82);
const PALETTE_LEN: usize = 17;
const PLANE_BYTES: usize = 4096;
const CLOUD_BYTES: usize = 1024;

#[repr(C)]
pub(super) struct Terrain {
    planes: u32,
    palette: u32,
    camera_x_q8: i32,
    camera_y_q8: i32,
    altitude_q8: i32,
    pub(super) sin_yaw_q12: i32,
    cos_yaw_q12: i32,
    sin_roll_q12: i32,
    cos_roll_q12: i32,
    scale_q8: i32,
    pub(super) perspective_q16: i32,
    slope_q8: i32,
    center_x_q8: i32,
    center_y_q8: i32,
}

struct Scratch {
    half_resolution: bool,
    frame: Frame,
    workspace: Workspace,
    geometry: super::GeometryScratch,
}

struct Landscape<'a> {
    planes: &'a [u8],
    palette: [[u32; 2]; PALETTE_LEN],
    fog: u8,
    clouds: bool,
    fog_theme: Option<scene::Fog>,
    distance_fog: u32,
    grain_shift: u32,
}

fn color(rgb: [u8; 3]) -> u32 {
    u32::from_le_bytes([rgb[0], rgb[1], rgb[2], 255])
}

impl TerrainSurface for Landscape<'_> {
    type Sample = usize;

    fn begin_row(&mut self, row: TerrainRow) {
        self.distance_fog = self.fog_theme.map_or(0, |fog| fog.at(row.depth));
        self.grain_shift = if row.pixel_width > Fixed::from_int(4) { 4 } else { 2 };
        self.fog = ((row.depth.to_int() - 255) / 4).clamp(0, 116) as u8;
        self.clouds = row.depth > Fixed::from_int(76) && row.depth < Fixed::from_int(520);
    }

    #[inline]
    fn height_at(&self, position: [Fixed; 2]) -> Option<(Fixed, usize)> {
        let [x, y] = position.map(Fixed::to_int);
        let index = (((y >> 4 & 63) << 6) + (x >> 4 & 63)) as usize;
        Some((Fixed::from_int(i32::from(self.planes[index].min(63))), index))
    }

    #[inline]
    fn colors(&self, position: [Fixed; 2], height: Fixed, index: usize) -> [u32; 2] {
        let material = usize::from(self.planes[PLANE_BYTES + index]).min(PALETTE_LEN - 1);
        let colors = self.palette[material];
        if self.fog_theme.is_none() { return colors; }
        let [x, y] = position.map(Fixed::to_int);
        let east = (index & !63) | ((index + 1) & 63);
        let north = (index + PLANE_BYTES - 64) & (PLANE_BYTES - 1);
        let next_x = i32::from(self.planes[east].min(63));
        let next_y = i32::from(self.planes[north].min(63));
        let incline = (height.to_int() * 2 - next_x - next_y).clamp(-14, 14);
        let aggregate = scene::grain(x >> self.grain_shift, y >> self.grain_shift) as i32;
        let light = (215 + incline * 2 + aggregate).clamp(170, 256);
        [scene::modulate(colors[0], light as u32),
         scene::modulate(colors[1], (light - (height.to_int() & 3) * 7) as u32)]
    }

    #[inline]
    fn shade(&self, packed: u32) -> u32 {
        if let Some(theme) = self.fog_theme { return theme.shade(packed, self.distance_fog); }
        let fog = u32::from(self.fog);
        if fog == 0 { return packed; }
        const HAZE: u32 = u32::from_le_bytes([147, 181, 224, 0]);
        const RB: u32 = 0x00ff_00ff;
        const G: u32 = 0x0000_ff00;
        let shade = 256 - fog;
        let rb = (((packed & RB) * shade + (HAZE & RB) * fog) >> 8) & RB;
        let g = (((packed & G) * shade + (HAZE & G) * fog) >> 8) & G;
        0xff00_0000 | rb | g
    }

    fn overlay(&self, position: [Fixed; 2], column: &mut TerrainColumn<'_, '_, '_>) {
        if !self.clouds { return; }
        let [x, y] = position.map(Fixed::to_int);
        let sample = (((y >> 4 & 31) << 5) + (x >> 4 & 31)) as usize;
        let density = self.planes[PLANE_BYTES * 2 + sample] & 15;
        if density > 2 {
            column.slab(
                Fixed::from_int(40 + i32::from(density)), Fixed::ONE,
                self.shade(0xfffae8d8), self.shade(0xffd7c4ad),
                core::iter::empty(),
            );
        }
    }
}

#[unsafe(no_mangle)]
extern "C" fn pet_terrain_create(half_resolution: bool) -> *mut Scratch {
    let divisor = if half_resolution { 2 } else { 1 };
    let side = sheet_side(WIDTH / divisor, HEIGHT / divisor, PIVOT / divisor as i32);
    let (Ok(frame), Ok(workspace)) = (Frame::new(side, side), Workspace::new(side, side))
    else { return ptr::null_mut() };
    let Some(geometry) = super::GeometryScratch::new() else { return ptr::null_mut() };
    Box::into_raw(Box::new(Scratch { half_resolution, frame, workspace, geometry }))
}

#[unsafe(no_mangle)]
unsafe extern "C" fn pet_terrain_destroy(context: *mut Scratch) {
    if !context.is_null() {
        drop(unsafe { Box::from_raw(context) });
    }
}

#[unsafe(no_mangle)]
unsafe extern "C" fn pet_terrain_render(
    context: *mut Scratch, terrain: *const Terrain, planes: *const u8,
    palette: *const u8, screen: *mut u16,
) -> i32 {
    unsafe { pet_world_render(context, terrain, planes, palette, ptr::null(), 0, screen, ptr::null_mut()) }
}

#[cfg(target_os = "none")]
fn tick_us() -> u32 {
    unsafe extern "C" { fn pet_world_tick_us() -> u32; }
    unsafe { pet_world_tick_us() }
}

#[cfg(not(target_os = "none"))]
fn tick_us() -> u32 { 0 }

struct Resolve {
    // The inverse roll transform in the same Q8 precision as RollMapping.
    x: i32, y: i32, cos: i32, sin: i32,
    bounds: [i32; 4],
}

impl Resolve {
    fn new(mapping: &RollMapping, roll: [i32; 2], [width, height]: [usize; 2], pivot: Fixed) -> Option<Self> {
        let mut resolve = Self { x: 128, y: 128, cos: 256, sin: 0, bounds: mapping.bounds };
        if mapping.rolled {
            let [sin, cos] = [-roll[0] / 16, roll[1] / 16];
            let half = mapping.size[0] as i32 / 2 * 256 + 128;
            let cx = width as i32 / 2;
            let cy = pivot.to_int();
            resolve.x = half - cos * cx + sin * cy;
            resolve.y = half - sin * cx - cos * cy;
            resolve.cos = cos;
            resolve.sin = sin;
            let mut bounds = [i32::MAX, i32::MAX, i32::MIN, i32::MIN];
            for y in [0, height as i32 - 1] {
                for x in [0, width as i32 - 1] {
                    let sx = (resolve.x + cos * x - sin * y) >> 8;
                    let sy = (resolve.y + sin * x + cos * y) >> 8;
                    bounds[0] = bounds[0].min(sx);
                    bounds[1] = bounds[1].min(sy);
                    bounds[2] = bounds[2].max(sx + 1);
                    bounds[3] = bounds[3].max(sy + 1);
                }
            }
            if bounds[0] < 0 || bounds[1] < 0 ||
                bounds[2] > mapping.size[0] as i32 || bounds[3] > mapping.size[1] as i32
            { return None; }
            resolve.bounds = bounds;
        }
        Some(resolve)
    }

    fn write<const UPSCALE: usize>(&self, source: &[[u8; 4]], output: &mut [u16], pitch: usize) {
        let [left, top, _, _] = self.bounds;
        let mut base_x = self.x - left * 256;
        let mut base_y = self.y - top * 256;
        for rows in output.chunks_exact_mut(PANEL_WIDTH * UPSCALE) {
            let (first, rest) = rows.split_at_mut(PANEL_WIDTH);
            let mut x = base_x;
            let mut y = base_y;
            for block in first.chunks_exact_mut(UPSCALE) {
                // The affine map's four rounded corners determine its extrema.
                // The entire output therefore lands in the validated source bounds.
                let index = (y >> 8) as usize * pitch + (x >> 8) as usize;
                let pixel = unsafe { *source.get_unchecked(index) };
                let rgb = (u16::from(pixel[0] & 248) << 8) | (u16::from(pixel[1] & 252) << 3) | u16::from(pixel[2] >> 3);
                block.fill(rgb);
                x += self.cos;
                y += self.sin;
            }
            for row in rest.chunks_exact_mut(PANEL_WIDTH) {
                row.copy_from_slice(first);
            }
            base_x -= self.sin;
            base_y += self.cos;
        }
    }
}

#[unsafe(no_mangle)]
unsafe extern "C" fn pet_world_render(
    context: *mut Scratch, terrain: *const Terrain, planes: *const u8,
    palette: *const u8, objects: *const super::Object, count: usize,
    screen: *mut u16, timing_us: *mut [u32; 3],
) -> i32 {
    unsafe { render(context, terrain, planes, palette, objects, count, screen, timing_us, None) }
}

#[unsafe(no_mangle)]
unsafe extern "C" fn pet_scene_render(
    context: *mut Scratch, request: *const Request, assets: *const Assets,
    objects: *const super::Object, screen: *mut u16, timing_us: *mut [u32; 3],
) -> i32 {
    let (Some(request), Some(assets)) = (unsafe { request.as_ref() }, unsafe { assets.as_ref() })
    else { return -1 };
    let Some(decoration) = (unsafe { Decoration::new(request, assets) }) else { return -1 };
    unsafe { render(context, &request.terrain, assets.planes, assets.terrain_palette,
                    objects, request.count as usize, screen, timing_us, Some(&decoration)) }
}

unsafe fn render(
    context: *mut Scratch, terrain: *const Terrain, planes: *const u8,
    palette: *const u8, objects: *const super::Object, count: usize,
    screen: *mut u16, timing_us: *mut [u32; 3], decoration: Option<&Decoration<'_>>,
) -> i32 {
    let (Some(context), Some(terrain)) = (unsafe { context.as_mut() }, unsafe { terrain.as_ref() })
    else { return -1 };
    let mode = decoration.map_or(scene::HEIGHT_FIELD, Decoration::mode);
    let max_stacks = if decoration.is_some() { scene::STACKS } else { super::MAX_OBJECTS };
    let camera_range = if mode == scene::OPEN_SPACE {
        -scene::SPACE_LIMIT_Q8..=scene::SPACE_LIMIT_Q8
    } else { 0..=262143 };
    if (mode == scene::HEIGHT_FIELD && (planes.is_null() || palette.is_null())) || screen.is_null()
        || count > max_stacks || (count != 0 && objects.is_null())
        || !camera_range.contains(&terrain.camera_x_q8) || !camera_range.contains(&terrain.camera_y_q8)
        || !(0..=131072).contains(&terrain.altitude_q8)
        || !(128..=4096).contains(&terrain.scale_q8) || !(0..=8192).contains(&terrain.perspective_q16)
        || !(-512..=512).contains(&terrain.slope_q8)
        || !(-81920..=163840).contains(&terrain.center_x_q8)
        || !(-61440..=122880).contains(&terrain.center_y_q8)
    { return -1; }
    let yaw = [terrain.sin_yaw_q12, terrain.cos_yaw_q12];
    let roll = [terrain.sin_roll_q12, terrain.cos_roll_q12];
    if yaw.into_iter().chain(roll).any(|n| !(-4096..=4096).contains(&n)) { return -1; }
    let from_q12 = |n| Fixed::from_ratio(n, 4096);
    let [sine, cosine] = roll.map(from_q12);
    let rotation = (roll != [0, 4096]).then_some((-sine, cosine));
    let divisor = if context.half_resolution { 2 } else { 1 };
    let size = [WIDTH / divisor, HEIGHT / divisor];
    let pivot = PIVOT / divisor as i32;
    let mapping = RollMapping::new(size, pivot, rotation);
    let Some(resolve) = Resolve::new(&mapping, roll, size, pivot) else { return -1 };
    let [left, top, right, bottom] = resolve.bounds;
    let extent = [(right - left) as usize, (bottom - top) as usize];
    if extent[0] == 0 || extent[1] == 0 || extent[0] * extent[1] > context.frame.width * context.frame.height {
        return -1;
    }
    let q = super::q8;
    let perspective = Fixed64::from_ratio(i64::from(terrain.perspective_q16), 65536);
    let projection = Projection {
        scale: q(terrain.scale_q8) / divisor as i32, perspective, slope: q(terrain.slope_q8),
        center: mapping.projection_center([terrain.center_x_q8, terrain.center_y_q8].map(|n| q(n) / divisor as i32)),
    };
    let [sin, cos] = yaw.map(from_q12);
    let view = TerrainView {
        projection, origin: [q(terrain.camera_x_q8), q(terrain.camera_y_q8)],
        altitude: q(terrain.altitude_q8), yaw: (sin, cos),
        heights: [Fixed::ZERO, Fixed::from_int(63)],
        depth: [Fixed::from_int(-380), Fixed::from_int(760)],
    };
    let mut landscape = (mode == scene::HEIGHT_FIELD).then(|| {
        let palette = unsafe { &*palette.cast::<[[u8; 3]; PALETTE_LEN]>() };
        Landscape {
            planes: unsafe { slice::from_raw_parts(planes, PLANE_BYTES * 2 + CLOUD_BYTES) },
            palette: core::array::from_fn(|i| {
                let top = palette[i];
                let wall = if i < 4 { top } else { top.map(|n| n - n / 5) };
                [color(top), color(wall)]
            }),
            fog: 0, clouds: false, fog_theme: decoration.map(|scene| scene.fog), distance_fog: 0, grain_shift: 2,
        }
    });
    let horizon = if perspective.is_zero() { 0 } else {
        (projection.center[1] - projection.divide_perspective(projection.scale * projection.slope)).to_int()
    };
    let sky = |row: i32| {
        let shade = ((row - horizon) * divisor as i32 + 84).clamp(0, 100) as u8;
        color([106 + shade, 151 + shade / 2 + shade / 6, 228 + shade / 4])
    };
    let objects = if count == 0 { &[] } else { unsafe { slice::from_raw_parts(objects, count) } };
    let start = tick_us();
    let mut ground_done = 0;
    let rendered = context.workspace.with_extent(
        &mut context.frame, extent, mapping.size, [left, top], resolve.bounds,
        |tile| {
            tile.clear_depth();
            if let Some(landscape) = landscape.as_mut() {
                view.draw(tile, landscape);
            }
            if let Some(decoration) = decoration {
                if mode == scene::WALLS {
                    decoration.walls(tile, &projection, resolve.bounds, view.origin, [sin, cos], view.altitude);
                    decoration.wall_planes(tile, &projection, view.origin, [sin, cos], view.altitude);
                } else {
                    if mode == scene::OPEN_SPACE {
                        let camera = [terrain.camera_x_q8, terrain.camera_y_q8, terrain.altitude_q8];
                        decoration.space_stars(tile, &projection, horizon, camera, yaw);
                    }
                    tile.paint_background(|_, _| (), |_, row| row,
                        |_, row, x, _| decoration.background(x, *row, horizon));
                }
                ground_done = tick_us();
                decoration.billboards(tile, &projection, resolve.bounds);
                super::draw_objects_shaded(tile, &mut context.geometry, objects, &projection, Some(decoration.fog))
            } else {
                tile.paint_background(|_, _| (), |_, row| sky(row), |_, color, _, _| *color);
                ground_done = tick_us();
                super::draw_objects(tile, &mut context.geometry, objects, &projection)
            }
        },
    );
    if rendered.is_none() { return -1; }
    let models_done = tick_us();
    let Ok(pixels) = context.frame.texture.read_pixels() else { return -1 };
    let source = &pixels.bytes().as_chunks::<4>().0[..extent[0] * extent[1]];
    let output = unsafe { slice::from_raw_parts_mut(screen, PANEL_WIDTH * PANEL_HEIGHT) };
    if context.half_resolution {
        resolve.write::<4>(source, output, extent[0]);
    } else {
        resolve.write::<2>(source, output, extent[0]);
    }
    if let Some(timing) = unsafe { timing_us.as_mut() } {
        *timing = [ground_done.wrapping_sub(start), models_done.wrapping_sub(ground_done), tick_us().wrapping_sub(models_done)];
    }
    0
}
