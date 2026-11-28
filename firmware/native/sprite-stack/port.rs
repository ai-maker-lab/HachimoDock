//! Render prepared MIRX stack geometry with Mirui's native rasterizer.
#![cfg_attr(target_os = "none", no_std)]

extern crate alloc;

mod scene;
mod solid;
mod terrain;

use alloc::{boxed::Box, vec::Vec};
use core::{ptr, slice};
use mirui::types::{Fixed, Fixed64};
use mirui_sprite_stack::{
    PreparedSpriteStack, SparseLevel, StackSample,
    raster::{Frame, Projection, SceneCanvas, Workspace, sprites::{ProjectedStack, StackTransform}},
};

#[cfg(target_os = "none")]
mod device {
    use core::alloc::{GlobalAlloc, Layout};

    unsafe extern "C" {
        fn pet_stack_alloc(size: usize, alignment: usize) -> *mut u8;
        fn pet_stack_free(pointer: *mut u8);
        fn abort() -> !;
    }

    struct Allocator;
    unsafe impl GlobalAlloc for Allocator {
        unsafe fn alloc(&self, layout: Layout) -> *mut u8 {
            unsafe { pet_stack_alloc(layout.size(), layout.align()) }
        }
        unsafe fn dealloc(&self, pointer: *mut u8, _: Layout) {
            unsafe { pet_stack_free(pointer) }
        }
    }
    #[global_allocator]
    static ALLOCATOR: Allocator = Allocator;

    struct RenderWorker;
    critical_section::set_impl!(RenderWorker);
    // The host owns this context on its single synchronous WASM worker.
    unsafe impl critical_section::Impl for RenderWorker {
        unsafe fn acquire() -> critical_section::RawRestoreState {}
        unsafe fn release(_: critical_section::RawRestoreState) {}
    }

    #[panic_handler]
    fn panic(_: &core::panic::PanicInfo<'_>) -> ! {
        unsafe { abort() }
    }
}

const WIDTH: usize = 160;
const HEIGHT: usize = 120;
const MAX_LAYERS: usize = 16;
const MAX_SAMPLES: usize = 4096;
const MAX_SCENE_SAMPLES: usize = 8192;
const MAX_OBJECTS: usize = 4;
const MAX_MODEL_BYTES: usize = 12850;

#[repr(C)]
struct Scene {
    x: i32,
    y: i32,
    width: u32,
    height: u32,
    pixel_scale: u32,
    scale_q8: i32,
    perspective_q16: i32,
    slope_q8: i32,
    center_x_q8: i32,
    center_y_q8: i32,
    instances: u32,
    count: u32,
}

#[repr(C)]
struct Object {
    model: *const u8,
    model_bytes: usize,
    origin_q8: [i32; 3],
    axes_q8: [[i32; 3]; 3],
    scale_q8: i32,
}

struct Scratch {
    frame: Frame,
    workspace: Workspace,
    geometry: GeometryScratch,
}

struct GeometryScratch {
    samples: Vec<StackSample>,
    solid_rows: Vec<u64>,
}

impl GeometryScratch {
    fn new() -> Option<Self> {
        let mut samples = Vec::new();
        samples.try_reserve_exact(MAX_SAMPLES).ok()?;
        Some(Self { samples, solid_rows: Vec::new() })
    }
}

fn q8(n: i32) -> Fixed {
    Fixed::from_ratio(n, 256)
}

fn u16_at(data: &[u8], offset: usize) -> u16 {
    u16::from_le_bytes([data[offset], data[offset + 1]])
}

struct Model<'a> {
    extent: [u16; 3],
    pivot: [i32; 3],
    spacing: i32,
    offsets: [usize; MAX_LAYERS + 1],
    palette: &'a [[u8; 4]],
    samples: &'a [[u8; 3]],
}

impl<'a> Model<'a> {
    fn read(data: &'a [u8]) -> Option<Self> {
        if data.len() < 18 || &data[..4] != b"SSK1" {
            return None;
        }
        let [width, height, layers, colors] = [data[4], data[5], data[6], data[7]];
        if width == 0 || width > 64 || height == 0 || height > 64
            || layers == 0 || layers as usize > MAX_LAYERS || colors == 0 || colors > 128
        {
            return None;
        }
        let spacing = i32::from(u16_at(data, 14));
        if !(1..=1024).contains(&spacing) {
            return None;
        }
        let pivot = [8, 10, 12].map(|at| i32::from(u16_at(data, at) as i16));
        if pivot.iter().any(|p| !(-16384..=16384).contains(p)) {
            return None;
        }
        let palette_at = 16 + 2 * (usize::from(layers) + 1);
        let end_palette = palette_at + 4 * usize::from(colors);
        let (palette, _) = data.get(palette_at..end_palette)?.as_chunks::<4>();
        let (samples, remainder) = data.get(end_palette..)?.as_chunks::<3>();
        if !remainder.is_empty() || samples.is_empty() || samples.len() > MAX_SAMPLES {
            return None;
        }
        let mut offsets = [0; MAX_LAYERS + 1];
        for (i, bound) in offsets[..=usize::from(layers)].iter_mut().enumerate() {
            *bound = usize::from(u16_at(data, 16 + i * 2));
        }
        Some(Self {
            extent: [u16::from(width), u16::from(height), u16::from(layers)],
            pivot, spacing, offsets, palette, samples,
        })
    }
}

fn draw_stack(
    tile: &mut SceneCanvas<'_, '_>,
    samples: &mut Vec<StackSample>,
    model: &Model<'_>,
    object: &Object,
    camera: &Projection, fog: Option<scene::Fog>,
) -> Option<()> {
    samples.clear();
    samples.extend(model.samples.iter().map(|&[x, y, color]| StackSample { x, y, color }));
    let layers = usize::from(model.extent[2]);
    let level = [SparseLevel::new(1, &model.offsets[..=layers], samples)?];
    let stack = PreparedSpriteStack::new(model.extent, model.pivot, model.spacing, model.palette, &level)?;
    let transform = StackTransform {
        origin: object.origin_q8.map(q8),
        axes: object.axes_q8.map(|axis| axis.map(q8)),
        scale: q8(object.scale_q8),
        layer_spacing: q8(model.spacing),
        depth_radius: Fixed::from_int(i32::from(model.extent[1])) * q8(object.scale_q8),
    };
    let amount = fog.map_or(0, |fog| fog.at(transform.origin[1]));
    if let Some(projected) = ProjectedStack::<MAX_LAYERS>::new(
        &stack, transform, camera, Fixed::from_int(3), |_, _| Some(Fixed::ZERO),
    ) {
        projected.view().draw(tile, camera, |sample| {
            let color = u32::from_le_bytes(model.palette[usize::from(sample.color)]);
            fog.map_or(color, |fog| fog.shade(color, amount))
        });
    }
    Some(())
}

fn draw_objects(
    tile: &mut SceneCanvas<'_, '_>, scratch: &mut GeometryScratch,
    objects: &[Object], camera: &Projection,
) -> Option<()> {
    draw_objects_shaded(tile, scratch, objects, camera, None)
}

fn draw_objects_shaded(
    tile: &mut SceneCanvas<'_, '_>, scratch: &mut GeometryScratch,
    objects: &[Object], camera: &Projection, fog: Option<scene::Fog>,
) -> Option<()> {
    let mut budget = MAX_SCENE_SAMPLES;
    let mut face_budget = solid::MAX_FACE_PIXELS;
    for object in objects {
        if object.model.is_null() || object.model_bytes > MAX_MODEL_BYTES
            || !(1..=1024).contains(&object.scale_q8)
            || object.origin_q8.iter().any(|n| !(-262144..=262144).contains(n))
            || object.axes_q8.iter().flatten().any(|n| !(-256..=256).contains(n))
        { return None; }
        let model = Model::read(unsafe { slice::from_raw_parts(object.model, object.model_bytes) })?;
        budget = budget.checked_sub(model.samples.len())?;
        if camera.perspective.is_zero() && model.palette.last() == Some(&solid::PALETTE_TAG) {
            solid::draw(tile, &mut scratch.solid_rows, &model, object, camera, fog, &mut face_budget)?;
        } else {
            draw_stack(tile, &mut scratch.samples, &model, object, camera, fog)?;
        }
    }
    Some(())
}

#[unsafe(no_mangle)]
extern "C" fn pet_stack_create() -> *mut Scratch {
    let (Ok(frame), Ok(workspace)) = (Frame::new(WIDTH, HEIGHT), Workspace::new(WIDTH, HEIGHT)) else {
        return ptr::null_mut();
    };
    let Some(geometry) = GeometryScratch::new() else { return ptr::null_mut() };
    Box::into_raw(Box::new(Scratch { frame, workspace, geometry }))
}

#[unsafe(no_mangle)]
unsafe extern "C" fn pet_stack_destroy(context: *mut Scratch) {
    if !context.is_null() {
        drop(unsafe { Box::from_raw(context) });
    }
}

#[unsafe(no_mangle)]
unsafe extern "C" fn pet_stack_render(
    context: *mut Scratch, scene: *const Scene, objects: *const Object, screen: *mut u16,
    screen_width: usize, screen_height: usize,
) -> i32 {
    let (Some(context), Some(scene)) = (unsafe { context.as_mut() }, unsafe { scene.as_ref() })
    else { return -1 };
    let (width, height, scale) = (scene.width as usize, scene.height as usize, scene.pixel_scale as usize);
    let count = scene.count as usize;
    if !(1..=WIDTH).contains(&width) || !(1..=HEIGHT).contains(&height) || !(1..=4).contains(&scale)
        || !(1..=MAX_OBJECTS).contains(&count) || objects.is_null() || screen.is_null()
        || screen_width > 640 || screen_height > 480
        || !(64..=2048).contains(&scene.scale_q8) || !(0..=8192).contains(&scene.perspective_q16)
        || !(-512..=512).contains(&scene.slope_q8)
        || !(-40960..=81920).contains(&scene.center_x_q8) || !(-30720..=61440).contains(&scene.center_y_q8)
        || !(-640..640).contains(&scene.x) || !(-480..480).contains(&scene.y)
    { return -1; }
    let objects = unsafe { slice::from_raw_parts(objects, count) };
    let camera = Projection {
        perspective: Fixed64::from_ratio(i64::from(scene.perspective_q16), 65536),
        slope: q8(scene.slope_q8),
        scale: q8(scene.scale_q8),
        center: [q8(scene.center_x_q8), q8(scene.center_y_q8)],
    };
    let ok = context.workspace.with_extent(
        &mut context.frame, [width, height], [width, height], [0, 0],
        [0, 0, width as i32, height as i32], |tile| {
            tile.color.bytes.fill(0);
            tile.clear_depth();
            draw_objects(tile, &mut context.geometry, objects, &camera)
        },
    );
    if ok.is_none() { return -1; }

    let Ok(pixels) = context.frame.texture.read_pixels() else { return -1 };
    let output = unsafe { slice::from_raw_parts_mut(screen, screen_width * screen_height) };
    for (i, pixel) in pixels.bytes()[..width * height * 4].chunks_exact(4).enumerate() {
        if pixel[3] == 0 { continue; }
        let x = scene.x + ((i % width) * scale) as i32;
        let y = scene.y + ((i / width) * scale) as i32;
        let left = x.clamp(0, screen_width as i32) as usize;
        let right = (x + scale as i32).clamp(0, screen_width as i32) as usize;
        let rgb = (u16::from(pixel[0] & 248) << 8) | (u16::from(pixel[1] & 252) << 3)
            | (u16::from(pixel[2]) >> 3);
        for row in y.max(0)..(y + scale as i32).min(screen_height as i32) {
            let start = row as usize * screen_width;
            output[start + left..start + right].fill(rgb);
        }
    }
    0
}
