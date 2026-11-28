//! Orthographic voxel faces for opted-in SSK1 models.

use alloc::vec::Vec;
use core::array;
use mirui::types::Fixed;
use mirui_sprite_stack::raster::{Projection, SceneCanvas};

use super::{Model, Object, q8, scene};

// The unused final palette entry keeps the existing SSK1 layout readable by
// thin-slice hosts. No cell refers to this entry.
pub(super) const PALETTE_TAG: [u8; 4] = *b"VOX\0";
pub(super) const MAX_FACE_PIXELS: usize = 196_608;
type Point = [i32; 3];

fn add(a: Point, b: Point) -> Point {
    array::from_fn(|i| a[i] + b[i])
}

fn pixel_axis(camera: &Projection, [right, depth, up]: [Fixed; 3]) -> Point {
    [
        ((camera.scale * right).to_f32() * 256.0) as i32,
        (-(camera.scale * (up + camera.slope * depth)).to_f32() * 256.0) as i32,
        (depth.to_f32() * 256.0) as i32,
    ]
}

fn cross(a: Point, b: Point) -> i64 {
    i64::from(a[0]) * i64::from(b[1]) - i64::from(a[1]) * i64::from(b[0])
}

struct Face {
    axis: usize,
    far_index: bool,
    a: Point,
    b: Point,
    area: i64,
    lower: [i32; 2],
    upper: [i32; 2],
}

impl Face {
    fn new(axis: usize, steps: [Point; 3]) -> Option<Self> {
        let normal = steps[axis];
        let mut a = steps[(axis + 1) % 3];
        let mut b = steps[(axis + 2) % 3];
        if cross(a, b) < 0 {
            core::mem::swap(&mut a, &mut b);
        }
        let area = cross(a, b);
        if area == 0 {
            return None;
        }
        let depth_delta = i64::from(normal[2]) * area
            - i64::from(a[2]) * cross(normal, b)
            - i64::from(b[2]) * cross(a, normal);
        if depth_delta == 0 {
            return None;
        }
        Some(Self {
            axis, far_index: depth_delta < 0, a, b, area,
            lower: array::from_fn(|i| a[i].min(0) + b[i].min(0)),
            upper: array::from_fn(|i| a[i].max(0) + b[i].max(0)),
        })
    }

    fn draw(&self, tile: &mut SceneCanvas<'_, '_>, base: Point, color: u32, budget: &mut usize) -> Option<()> {
        let [left, top, right, bottom] = tile.color.clip;
        let x0 = ((base[0] + self.lower[0] + 255) >> 8).max(left);
        let x1 = ((base[0] + self.upper[0]) >> 8).min(right - 1);
        let y0 = ((base[1] + self.lower[1] + 255) >> 8).max(top);
        let y1 = ((base[1] + self.upper[1]) >> 8).min(bottom - 1);
        if x0 > x1 || y0 > y1 {
            return Some(());
        }
        *budget = budget.checked_sub(((x1 - x0 + 1) * (y1 - y0 + 1)) as usize)?;
        for y in y0..=y1 {
            for x in x0..=x1 {
                let p = [(x << 8) - base[0], (y << 8) - base[1], 0];
                let u = cross(p, self.b);
                let v = cross(self.a, p);
                // Closed edges avoid gaps where perpendicular surfaces meet.
                if u >= 0 && v >= 0 && u <= self.area && v <= self.area {
                    let z = base[2] + ((i64::from(self.a[2]) * u
                        + i64::from(self.b[2]) * v) / self.area) as i32;
                    tile.write_visible(x, y, q8(z), color);
                }
            }
        }
        Some(())
    }
}

pub(super) fn draw(
    tile: &mut SceneCanvas<'_, '_>, rows: &mut Vec<u64>, model: &Model<'_>,
    object: &Object, camera: &Projection, fog: Option<scene::Fog>, budget: &mut usize,
) -> Option<()> {
    let [width, depth, height] = model.extent.map(usize::from);
    let len = depth * height;
    rows.clear();
    rows.try_reserve_exact(len).ok()?;
    rows.resize(len, 0);

    let mut palette = [0; 128];
    let origin = object.origin_q8.map(q8);
    let fog_amount = fog.map_or(0, |fog| fog.at(origin[1]));
    for (dst, source) in palette.iter_mut().zip(&model.palette[..model.palette.len() - 1]) {
        let rgba = u32::from_le_bytes(*source);
        *dst = if rgba >> 24 == 0 { 0 } else { fog.map_or(rgba, |fog| fog.shade(rgba, fog_amount)) };
    }
    let layers = &model.offsets[..=height];
    if layers[0] != 0 || layers[height] != model.samples.len() {
        return None;
    }
    for (z, bounds) in layers.windows(2).enumerate() {
        for &[x, y, index] in model.samples.get(bounds[0]..bounds[1])? {
            let (x, y, index) = (usize::from(x), usize::from(y), usize::from(index));
            if x >= width || y >= depth || index >= model.palette.len() - 1 {
                return None;
            }
            if palette[index] != 0 {
                rows[z * depth + y] |= 1 << x;
            }
        }
    }

    let basis = object.axes_q8.map(|axis| axis.map(|v| q8(v) * q8(object.scale_q8)));
    let vectors = [basis[0], basis[1].map(|v| -v), basis[2].map(|v| v * q8(model.spacing))];
    let steps = vectors.map(|v| pixel_axis(camera, v));
    let corners = [-q8(model.pivot[0]) - Fixed::HALF,
                   -q8(model.pivot[1]) - Fixed::HALF,
                   -q8(model.pivot[2]) - Fixed::HALF];
    let anchor = array::from_fn(|i| origin[i] + (0..3).fold(Fixed::ZERO, |sum, j| {
        sum + vectors[j][i] * corners[j]
    }));
    let mut anchor = pixel_axis(camera, anchor);
    anchor[0] += (camera.center[0].to_f32() * 256.0) as i32;
    anchor[1] += (camera.center[1].to_f32() * 256.0) as i32;
    let faces = [0, 1, 2].map(|i| Face::new(i, steps));
    for (z, bounds) in layers.windows(2).enumerate() {
        for &[x, y, index] in &model.samples[bounds[0]..bounds[1]] {
            let color = palette[usize::from(index)];
            if color == 0 {
                continue;
            }
            let cell = [usize::from(x), usize::from(y), z];
            let base = array::from_fn(|i| anchor[i] + (0..3).map(|j| steps[j][i] * cell[j] as i32).sum::<i32>());
            for face in faces.iter().flatten() {
                let axis = face.axis;
                let mut neighbor = cell;
                let next = if face.far_index { cell[axis].checked_add(1) } else { cell[axis].checked_sub(1) };
                let occluded = next.is_some_and(|at| {
                    if at >= usize::from(model.extent[axis]) {
                        return false;
                    }
                    neighbor[axis] = at;
                    rows[neighbor[2] * depth + neighbor[1]] & (1 << neighbor[0]) != 0
                });
                if !occluded {
                    let origin = if face.far_index { add(base, steps[axis]) } else { base };
                    face.draw(tile, origin, color, budget)?;
                }
            }
        }
    }
    Some(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use mirui::types::Fixed64;
    use mirui_sprite_stack::raster::{Frame, Workspace};

    #[test]
    fn thin_stack_covers_its_full_side_and_passes_shared_depth() {
        let mut frame = Frame::new(24, 24).unwrap();
        let mut workspace = Workspace::new(24, 24).unwrap();
        let mut offsets = [0; super::super::MAX_LAYERS + 1];
        offsets[..4].copy_from_slice(&[0, 3, 6, 9]);
        let model = Model {
            extent: [3, 1, 3], pivot: [256, 0, 256], spacing: 256, offsets,
            palette: &[[255, 0, 0, 255], PALETTE_TAG],
            samples: &[[0, 0, 0], [1, 0, 0], [2, 0, 0],
                       [0, 0, 0], [1, 0, 0], [2, 0, 0],
                       [0, 0, 0], [1, 0, 0], [2, 0, 0]],
        };
        let object = Object {
            model: core::ptr::null(), model_bytes: 0, origin_q8: [0; 3],
            axes_q8: [[256, 0, 0], [0, 256, 0], [0, 0, 256]], scale_q8: 256,
        };
        let camera = Projection {
            perspective: Fixed64::ZERO, slope: Fixed::ZERO, scale: Fixed::from_int(4),
            center: [Fixed::from_int(12); 2],
        };
        let red = 0xff0000ff;
        let green = 0xff00ff00;
        workspace.with_canvas(&mut frame, |tile| {
            tile.clear_depth();
            for y in 0..24 {
                for x in 0..24 {
                    tile.write_visible(x, y, Fixed::ONE, green);
                }
            }
            let mut budget = MAX_FACE_PIXELS;
            draw(tile, &mut Vec::new(), &model, &object, &camera, None, &mut budget).unwrap();
            for y in 6..=18 {
                for x in 6..=18 {
                    assert_eq!(tile.get(tile.color.index(x, y)), red, "{x}, {y}");
                    assert_eq!(tile.sample_depth(x, y), Some(-Fixed::HALF));
                }
            }
            assert_eq!(tile.get(tile.color.index(5, 12)), green);
            assert!(tile.write_visible(12, 12, -Fixed::ONE, green));
        });
    }
}
