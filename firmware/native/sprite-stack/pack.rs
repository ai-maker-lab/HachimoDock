use mirui_sprite_stack::SpriteStackAsset;
use std::{env, fs, path::PathBuf};

fn run() -> Result<(), Box<dyn std::error::Error>> {
    let args: Vec<_> = env::args_os().skip(1).collect();
    if !(2..=3).contains(&args.len()) {
        return Err("usage: mirui-pack-stack input.mirx output.ssk [pivot_z_q8]".into());
    }
    let pivot_z = args.get(2).map_or(Ok(0), |arg| arg.to_string_lossy().parse::<i32>())?;
    let file = fs::read(&args[0])?;
    let asset = SpriteStackAsset::from_mirx(Box::leak(file.into_boxed_slice()))?;
    let desc = asset.descriptor();
    let (width, height) = desc.canvas();
    let [pivot_x, pivot_y] = desc.pivot_q8();
    let pivot = [pivot_x, pivot_y, pivot_z];
    let spacing = desc.spacing_q8();
    let layers = desc.layers();
    if width > 64 || height > 64 || layers.len() > 16 ||
        pivot.iter().any(|n| !(-16384..=16384).contains(n)) || !(1..=1024).contains(&spacing) {
        return Err("MIRX dimensions, pivot or spacing exceed Sprite Stack v1 limits".into());
    }

    let pixels = asset.atlas().read_pixels().map_err(|e| format!("Could not read MIRX pixels: {e:?}"))?;
    let mut palette = Vec::<[u8; 4]>::new();
    let mut samples = Vec::<[u8; 3]>::new();
    let mut offsets = vec![0u16];
    for region in layers.iter() {
        for y in 0..region.height() {
            for x in 0..region.width() {
                let pixel = pixels.get_pixel((region.x() + x) as i32, (region.y() + y) as i32);
                if pixel.a == 0 {
                    continue;
                }
                if pixel.a != 255 {
                    return Err("SSK1 requires fully opaque or transparent source pixels".into());
                }
                let rgba = [pixel.r, pixel.g, pixel.b, pixel.a];
                let index = match palette.iter().position(|color| *color == rgba) {
                    Some(index) => index,
                    None if palette.len() < 128 => {
                        palette.push(rgba);
                        palette.len() - 1
                    }
                    None => return Err("Sprite Stack v1 supports up to 128 opaque colors".into()),
                };
                if samples.len() == 4096 {
                    return Err("Sprite Stack v1 supports up to 4096 samples per model".into());
                }
                samples.push([x as u8, y as u8, index as u8]);
            }
        }
        offsets.push(samples.len() as u16);
    }
    if samples.is_empty() {
        return Err("MIRX contains no opaque samples".into());
    }

    let mut out = b"SSK1".to_vec();
    out.extend([width as u8, height as u8, layers.len() as u8, palette.len() as u8]);
    for n in pivot {
        out.extend_from_slice(&(n as i16).to_le_bytes());
    }
    out.extend_from_slice(&(spacing as u16).to_le_bytes());
    for offset in offsets {
        out.extend_from_slice(&offset.to_le_bytes());
    }
    out.extend(palette.into_iter().flatten());
    out.extend(samples.into_iter().flatten());
    fs::write(PathBuf::from(&args[1]), out)?;
    Ok(())
}

fn main() {
    if let Err(error) = run() {
        eprintln!("{error}");
        std::process::exit(1);
    }
}
