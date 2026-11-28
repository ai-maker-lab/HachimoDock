//! Walls and batched cutout sprites on Mirui's shared color/depth canvas.
use core::slice;
use mirui::types::Fixed;
use mirui_sprite_stack::raster::{Projection, SceneCanvas};

use super::q8;
use super::terrain::Terrain;

pub(super) const STACKS: usize = 16;
pub(super) const BILLBOARDS: usize = 48;
const ART_SIDE: usize = 16;
const BILLBOARD_PIXELS: usize = 320 * 120;
const CELL: i32 = 16;
const NEAR: Fixed = Fixed::from_int(2);
const FAR: Fixed = Fixed::from_int(480);

pub(super) const HEIGHT_FIELD: u32 = 0;
pub(super) const WALLS: u32 = 1;
pub(super) const OPEN_SPACE: u32 = 2;
const STARS: u32 = 1;
pub(super) const SPACE_LIMIT_Q8: i32 = 1 << 29;

#[repr(C)]
pub(super) struct Request {
    pub terrain: Terrain,
    pub mode: u32,
    pub map: u32,
    pub map_width: u32,
    pub map_height: u32,
    pub art: u32,
    pub art_count: u32,
    pub palette: u32,
    pub billboards: u32,
    pub billboard_count: u32,
    pub instances: u32,
    pub count: u32,
    pub sky_rgb: u32,
    pub ground_rgb: u32,
    pub fog_rgb: u32,
    pub fog_start_q8: i32,
    pub fog_end_q8: i32,
    pub flags: u32,
}

#[repr(C)]
pub(super) struct Billboard {
    origin_q8: [i32; 3],
    width_q8: i32,
    height_q8: i32,
    art: u32,
}

#[repr(C)]
pub(super) struct Assets {
    pub planes: *const u8,
    pub terrain_palette: *const u8,
    pub map: *const u8,
    pub art: *const u8,
    pub palette: *const [u8; 4],
    pub billboards: *const Billboard,
}

#[derive(Clone, Copy)]
pub(super) struct Fog {
    rgb: u32,
    start: i32,
    end: i32,
}

impl Fog {
    pub(super) fn new(rgb: u32, start: i32, end: i32) -> Self {
        Self { rgb: packed(rgb), start, end }
    }

    pub(super) fn at(self, depth: Fixed) -> u32 {
        if depth.to_int() <= self.start { return 0; }
        let range = (self.end - self.start).max(1);
        ((depth.to_int() - self.start) * 256 / range).clamp(0, 256) as u32
    }

    pub(super) fn shade(self, pixel: u32, amount: u32) -> u32 {
        blend(pixel, self.rgb, amount)
    }
}

pub(super) fn packed(rgb: u32) -> u32 {
    u32::from_le_bytes([(rgb >> 16) as u8, (rgb >> 8) as u8, rgb as u8, 255])
}

fn blend(from: u32, to: u32, amount: u32) -> u32 {
    let remain = 256 - amount;
    const RB: u32 = 0x00ff_00ff;
    const G: u32 = 0x0000_ff00;
    let rb = (((from & RB) * remain + (to & RB) * amount) >> 8) & RB;
    let g = (((from & G) * remain + (to & G) * amount) >> 8) & G;
    0xff00_0000 | rb | g
}

// Apply the same brightness multiplier to each channel. The palette
// supplies the surface color and distance fog supplies the ambient tint.
#[inline]
pub(super) fn modulate(rgb: u32, light: u32) -> u32 {
    const RB: u32 = 0x00ff_00ff;
    const G: u32 = 0x0000_ff00;
    let rb = (((rgb & RB) * light) >> 8) & RB;
    let g = (((rgb & G) * light) >> 8) & G;
    0xff00_0000 | rb | g
}

#[inline]
pub(super) fn grain(x: i32, y: i32) -> u32 {
    let h = x.wrapping_mul(7829) ^ y.wrapping_mul(15173);
    (h ^ (h >> 6) ^ (h >> 12)) as u32 & 31
}

#[inline]
fn star_hash(mut value: u32) -> u32 {
    value ^= value >> 16;
    value = value.wrapping_mul(0x7feb_352d);
    value ^= value >> 15;
    value = value.wrapping_mul(0x846c_a68b);
    value ^ (value >> 16)
}

struct PlaneRow {
    origin: [Fixed; 2],
    step: [Fixed; 2],
    color: u32,
    fog: u32,
    coarse: bool,
    ceiling: bool,
}

pub(super) struct Decoration<'a> {
    request: &'a Request,
    map: &'a [u8],
    art: &'a [[u8; ART_SIDE * ART_SIDE]],
    palette: &'a [[u8; 4]; 16],
    billboards: &'a [Billboard],
    pub fog: Fog,
}

impl<'a> Decoration<'a> {
    /// Guest address lifetimes are checked by WAMR before the synchronous host call.
    pub(super) unsafe fn new(request: &'a Request, assets: &'a Assets) -> Option<Self> {
        if request.mode > OPEN_SPACE || request.flags & !STARS != 0 ||
            request.art_count > 32 || request.billboard_count as usize > BILLBOARDS ||
            request.count as usize > STACKS ||
            !(0..=262144).contains(&request.fog_start_q8) ||
            !(request.fog_start_q8..=262144).contains(&request.fog_end_q8) ||
            assets.palette.is_null()
        { return None; }
        let map = if request.mode == WALLS {
            if !(1..=32).contains(&request.map_width) || !(1..=32).contains(&request.map_height) ||
                !(512..=8192).contains(&request.terrain.perspective_q16) || assets.map.is_null()
            { return None; }
            unsafe { slice::from_raw_parts(assets.map, (request.map_width * request.map_height) as usize) }
        } else { &[] };
        let art = if request.art_count == 0 { &[] } else {
            if assets.art.is_null() { return None; }
            unsafe { slice::from_raw_parts(assets.art.cast(), request.art_count as usize) }
        };
        let billboards = if request.billboard_count == 0 { &[] } else {
            if assets.billboards.is_null() { return None; }
            unsafe { slice::from_raw_parts(assets.billboards, request.billboard_count as usize) }
        };
        let object_limit = if request.mode == OPEN_SPACE && request.terrain.perspective_q16 >= 512 {
            SPACE_LIMIT_Q8
        } else { 262144 };
        if map.iter().any(|&cell| u32::from(cell) > request.art_count) ||
            billboards.iter().any(|sprite| {
                sprite.art >= request.art_count ||
                    sprite.origin_q8.iter().any(|n| !(-object_limit..=object_limit).contains(n)) ||
                    !(1..=16384).contains(&sprite.width_q8) || !(1..=16384).contains(&sprite.height_q8)
            })
        { return None; }
        let fog_start = request.fog_start_q8 / 256;
        let fog_end = request.fog_end_q8 / 256;
        let fog = if request.mode == OPEN_SPACE && fog_start == 1024 {
            Fog::new(request.fog_rgb, i32::MAX, i32::MAX)
        } else {
            Fog::new(request.fog_rgb, fog_start, fog_end)
        };
        Some(Self {
            request, map, art, palette: unsafe { &*assets.palette.cast() }, billboards,
            fog,
        })
    }

    pub(super) fn mode(&self) -> u32 { self.request.mode }

    pub(super) fn background(&self, x: i32, y: i32, horizon: i32) -> u32 {
        let sky = packed(self.request.sky_rgb);
        if self.request.mode != OPEN_SPACE && self.request.flags & STARS != 0 {
            let yaw = self.request.terrain.sin_yaw_q12 >> 5;
            let v = (x + yaw).wrapping_mul(18447) ^ (y - horizon).wrapping_mul(29123);
            let star = v.wrapping_mul(v | 1) as u32;
            if star & 255 <= 2 {
                return blend(sky, 0xffedeeff, 112 + (star >> 24) / 2);
            }
        }
        blend(sky, self.fog.rgb, (72 - (y - horizon).abs()).max(0) as u32 * 2)
    }

    pub(super) fn space_stars(&self, canvas: &mut SceneCanvas<'_, '_>, p: &Projection, horizon: i32,
                              camera_q8: [i32; 3], [sin, cos]: [i32; 2]) {
        if self.request.flags & STARS == 0 || !(512..=8192).contains(&self.request.terrain.perspective_q16) {
            return;
        }
        let camera = camera_q8.map(|v| v >> 8);
        let lens = p.divide_perspective(Fixed::ONE);
        let focal = (p.scale * lens * 16).to_int();
        let center = p.center[0].to_int();
        let sky = packed(self.request.sky_rgb);

        // Regenerate only the cells inside each visible distance band. The
        // seed and signed cell coordinates completely determine each star.
        for cell in [65_536, 4096, 192] {
            let [cx, cy, cz] = camera.map(|v| v.div_euclid(cell));
            let seed = self.request.map ^ (cell as u32).wrapping_mul(0x27d4_eb2d);
            for y in (cy - 3)..=(cy + 3) {
                for x in (cx - 3)..=(cx + 3) {
                    let column = seed ^ (x as u32).wrapping_mul(0x9e37_79b1)
                        ^ (y as u32).wrapping_mul(0x85eb_ca77);
                    for z in (cz - 3)..=(cz + 3) {
                        let bits = star_hash(column ^ (z as u32).wrapping_mul(0xc2b2_ae3d));
                        let offset = |shift: u32| (cell * ((bits >> shift) as i32 & 255)) >> 8;
                        let dx = x * cell + offset(0) - camera[0];
                        let dy = y * cell + offset(8) - camera[1];
                        let dz = z * cell + offset(16) - camera[2];
                        let extent = dx.abs().max(dy.abs()).max(dz.abs());
                        let fade = (extent - cell / 2).min(3 * cell - extent);
                        if fade <= 0 { continue; }
                        let forward = -(dx * sin + dy * cos) / 4096;
                        if forward < cell / 4 { continue; }
                        let right = (dx * cos - dy * sin) / 4096;
                        let project = |axis: i32| (i64::from(axis) * i64::from(focal) / i64::from(forward * 16)) as i32;
                        let px = center + project(right);
                        let py = horizon - project(dz);
                        let strength = (56 + ((bits >> 24) & 127)) * ((fade * 256 / cell).min(256) as u32) / 256;
                        let tint = if bits >> 31 == 0 { 0xffeaf3ff } else { 0xfffff2dc };
                        let depth = Fixed::from_int(forward) - lens;
                        if strength < 12 { continue; }
                        let visible = canvas.write_visible(px, py, depth, blend(sky, packed(tint), strength));
                        if visible && strength > 148 {
                            let halo = blend(sky, packed(tint), strength / 4);
                            canvas.write_visible(px + 1, py, depth, halo);
                            canvas.write_visible(px, py + 1, depth, halo);
                        }
                    }
                }
            }
        }
    }

    pub(super) fn wall_planes(&self, canvas: &mut SceneCanvas<'_, '_>, p: &Projection,
                             origin: [Fixed; 2], [sin, cos]: [Fixed; 2], altitude: Fixed) {
        let lens_distance = p.divide_perspective(Fixed::ONE);
        let focal = p.scale * lens_distance;
        let horizon = p.center[1] - focal * p.slope;
        let floor = packed(self.request.ground_rgb);
        let ceiling = packed(self.request.sky_rgb);

        // Intersect each screen row with the ground or ceiling. Within a row
        // the world coordinates are affine, so we only divide once per row.
        canvas.paint_background(
            |_, _| (),
            |_, y| {
                let vertical = horizon - (Fixed::from_int(y) + Fixed::HALF);
                let upper = vertical > Fixed::ZERO;
                let height = if upper { Fixed::from_int(CELL) - altitude } else { -altitude };
                if vertical.abs() < Fixed::from_ratio(1, 8) {
                    return None;
                }
                let distance = focal * (height - p.slope * lens_distance) / vertical;
                if distance < NEAR || distance > FAR {
                    return None;
                }
                let footprint = distance / focal;
                let step = [cos * footprint, -sin * footprint];
                let lateral = Fixed::HALF - p.center[0];
                Some(PlaneRow {
                    origin: [origin[0] - sin * distance + step[0] * lateral,
                             origin[1] - cos * distance + step[1] * lateral],
                    step, color: if upper { ceiling } else { floor }, fog: self.fog.at(distance),
                    coarse: footprint > Fixed::from_int(4), ceiling: upper,
                })
            },
            |_, row, x, _| {
                let Some(row) = row else { return self.fog.rgb };
                let u = (row.origin[0] + row.step[0] * x).to_int();
                let v = (row.origin[1] + row.step[1] * x).to_int();
                let joint = (u & 15) <= 1 || (v & 15) == 0;
                let edge = (u & 15) == 2 || (v & 15) == 1;
                let light = if row.coarse { 218 + grain(u >> 4, v >> 4) }
                    else if joint { if row.ceiling { 133 } else { 155 } }
                    else if edge { 255 }
                    else { 205 + grain(u >> 1, v >> 1) };
                self.fog.shade(modulate(row.color, light), row.fog)
            },
        );
    }

    fn color(&self, tile: usize, x: usize, y: usize) -> u8 {
        self.art[tile][y * ART_SIDE + x] & 15
    }

    pub(super) fn walls(&self, target: &mut SceneCanvas<'_, '_>, projection: &Projection,
                         bounds: [i32; 4], origin: [Fixed; 2], yaw: [Fixed; 2], altitude: Fixed) {
        let distance = projection.divide_perspective(Fixed::ONE);
        let width = self.request.map_width as i32;
        let height = self.request.map_height as i32;
        let [sin, cos] = yaw;
        let [left, top, right, bottom] = bounds;
        for x in left..right {
            let u = (Fixed::from_int(x) + Fixed::HALF - projection.center[0]) / projection.scale;
            let r = projection.apply_perspective(u);
            let direction = [r * cos - sin, -r * sin - cos];
            let mut cells = origin.map(|n| n.to_int().div_euclid(CELL));
            let steps = direction.map(|axis| if axis < Fixed::ZERO { -1 } else { 1 });
            let mut interval = [FAR; 2];
            let mut next = [FAR; 2];
            for axis in 0..2 {
                if direction[axis].abs() < Fixed::from_ratio(1, 64) { continue; }
                interval[axis] = Fixed::from_int(CELL) / direction[axis].abs();
                let edge = Fixed::from_int((cells[axis] + i32::from(steps[axis] > 0)) * CELL);
                next[axis] = (edge - origin[axis]) / direction[axis];
            }
            for _ in 0..64 {
                let axis = usize::from(next[1] < next[0]);
                let t = next[axis];
                if t >= FAR { break; }
                cells[axis] += steps[axis];
                let [cx, cy] = cells;
                if cx < 0 || cy < 0 || cx >= width || cy >= height { break; }
                let wall = self.map[(cy * width + cx) as usize];
                if wall == 0 {
                    next[axis] = t + interval[axis];
                    continue;
                }
                let depth = t.max(NEAR) - distance;
                let Some([_, y, scale, _]) =
                    projection.project_camera(Fixed::ZERO, Fixed::from_int(CELL) - altitude, depth)
                else { break };
                let min_y = y.to_int();
                let max_y = (y + scale * CELL).to_int();
                let other = origin[1 - axis] + direction[1 - axis] * t;
                let tex_x = other.to_int().rem_euclid(CELL) as usize;
                let fog = self.fog.at(t);
                for sy in min_y.max(top)..max_y.min(bottom) {
                    let tex_y = ((sy - min_y) * ART_SIDE as i32 / (max_y - min_y)) as usize;
                    let value = usize::from(self.color(wall as usize - 1, tex_x, tex_y));
                    let mut pixel = u32::from_le_bytes(self.palette[value]) | 0xff00_0000;
                    if axis == 0 { pixel = blend(pixel, 0xff000000, 56); }
                    target.write_visible(x, sy, depth, self.fog.shade(pixel, fog));
                }
                break;
            }
        }
    }

    pub(super) fn billboards(&self, target: &mut SceneCanvas<'_, '_>, projection: &Projection,
                             [left, top, right, bottom]: [i32; 4]) {
        let mut work = BILLBOARD_PIXELS;
        for item in self.billboards {
            let [x, depth, up] = item.origin_q8.map(q8);
            let [x, y, w, h] = if self.request.mode == OPEN_SPACE && depth > Fixed::from_int(480) {
                // Divide first to keep precision on distant bodies whose
                // pixels-per-unit would round down in 24.8 fixed point.
                let denominator = Fixed::ONE + projection.apply_perspective(depth);
                let project = |amount| projection.scale * (amount / denominator);
                let x = projection.center[0] + project(x);
                let y = projection.center[1] - project(up + projection.slope * depth);
                [x, y, project(q8(item.width_q8)), project(q8(item.height_q8))]
            } else {
                let Some([x, y, scale, _]) = projection.project_camera(x, up, depth) else { continue };
                [x, y, scale * q8(item.width_q8), scale * q8(item.height_q8)]
            };
            let w = w.to_int().max(1);
            let h = h.to_int().max(1);
            let x0 = x.to_int() - w / 2;
            let y0 = y.to_int() - h / 2;
            let [x1, y1, x2, y2] = [x0.max(left), y0.max(top), (x0 + w).min(right), (y0 + h).min(bottom)];
            if x1 >= x2 || y1 >= y2 { continue; }
            let area = (x2 - x1) as usize * (y2 - y1) as usize;
            let Some(remaining) = work.checked_sub(area) else { continue };
            work = remaining;
            let fog = self.fog.at(depth);
            for sy in y1..y2 {
                let ty = ((sy - y0) as usize * ART_SIDE + ART_SIDE / 2) / h as usize;
                for sx in x1..x2 {
                    let tx = ((sx - x0) as usize * ART_SIDE + ART_SIDE / 2) / w as usize;
                    let index = usize::from(self.color(item.art as usize, tx, ty));
                    if index != 0 {
                        let pixel = u32::from_le_bytes(self.palette[index]);
                        target.write_visible(sx, sy, depth, self.fog.shade(pixel, fog));
                    }
                }
            }
        }
    }
}
