"""Losslessly split each original 16px row into low/high byte planes.
No glyph subset, font regeneration or runtime rendering changes.
"""
from pathlib import Path
import argparse, hashlib, re, zlib
from compress_font_asset import bitmap_bytes
ROOT=Path(__file__).resolve().parents[1]
def data():
    raw=bitmap_bytes()
    source=(ROOT/'main/pet_p4_font_cn.c').read_text()
    metrics=re.findall(r'\.bitmap_index\s*=\s*(\d+),\s*\.adv_w\s*=\s*\d+,\s*\.box_w\s*=\s*(\d+),\s*\.box_h\s*=\s*(\d+)',source)
    assert len(metrics)==21208
    low,high=bytearray(),bytearray()
    restored=bytearray(len(raw))
    for offset,width,height in metrics:
        offset,width,height=map(int,(offset,width,height))
        assert width<=16 and height<=17
        size=(width*height+7)//8;pad=(-width*height)%8
        value=int.from_bytes(raw[offset:offset+size],'big')>>pad
        rebuilt=0
        for y in range(height):
            row=(value>>((height-y-1)*width))&((1<<width)-1)
            low.append(row&255);high.append(row>>8);rebuilt=(rebuilt<<width)|row
        restored[offset:offset+size]=(rebuilt<<pad).to_bytes(size,'big')
    assert restored==raw
    return raw,bytes(low+high),len(low)
def main():
    args=argparse.ArgumentParser();args.add_argument('--check',action='store_true');args.add_argument('--libdeflate',type=Path);args=args.parse_args()
    raw,planes,rows=data();asset=ROOT/'assets/fonts/pet_cn_16_row_planes.deflate';header=ROOT/'main/pet_p4_font_row_planes_size.h'
    packed=asset.read_bytes() if args.check else zlib.compress(planes,9)
    if args.libdeflate and not args.check:
        import ctypes
        lib=ctypes.CDLL(str(args.libdeflate.resolve()))
        lib.libdeflate_alloc_compressor.argtypes=[ctypes.c_int];lib.libdeflate_alloc_compressor.restype=ctypes.c_void_p
        lib.libdeflate_zlib_compress.argtypes=[ctypes.c_void_p,ctypes.c_void_p,ctypes.c_size_t,ctypes.c_void_p,ctypes.c_size_t];lib.libdeflate_zlib_compress.restype=ctypes.c_size_t
        lib.libdeflate_free_compressor.argtypes=[ctypes.c_void_p]
        compressor=lib.libdeflate_alloc_compressor(12)
        if not compressor:raise ValueError('Compressor allocation failed')
        buffer=ctypes.create_string_buffer(len(planes)*2)
        try:size=lib.libdeflate_zlib_compress(compressor,planes,len(planes),buffer,len(buffer))
        finally:lib.libdeflate_free_compressor(compressor)
        if not size:raise ValueError('Compression failed')
        packed=buffer.raw[:size]
    assert zlib.decompress(packed)==planes
    fnv=2166136261
    for b in raw:fnv=((fnv^b)*16777619)&0xffffffff
    text=('/* Generated from the canonical licensed font without changing glyphs. */\n#pragma once\n'
        f'#define PET_FONT_PLANE_ROWS {rows}U\n#define PET_FONT_PLANE_BYTES {len(planes)}U\n'
        f'#define PET_FONT_PLANE_PACKED_BYTES {len(packed)}U\n'
        f'#define PET_FONT_PLANE_ADLER UINT32_C(0x{zlib.adler32(planes):08x})\n'
        f'#define PET_FONT_PLANE_FNV UINT32_C(0x{fnv:08x})\n')
    if args.check:assert header.read_text()==text
    else:asset.write_bytes(packed);header.write_text(text)
    print(f'Exact font row planes: {len(raw)} -> {len(packed)} bytes; sha256={hashlib.sha256(raw).hexdigest()}')
if __name__=='__main__':main()
