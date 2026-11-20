"""Exact full-font startup with real code, including failure latching and scratch release."""
from pathlib import Path
import subprocess,sys,zlib
import p4_font_native32_test as original
ROOT=Path(__file__).resolve().parents[1]
def test_packed_rows_restore_original_bytes_and_release_scratch(tmp_path):
    subprocess.run([sys.executable,str(ROOT/'tools/compress_font_row_planes.py'),'--check'],check=True)
    (tmp_path/'esp_attr.h').write_text('#pragma once\n#define EXT_RAM_BSS_ATTR\n')
    (tmp_path/'esp_heap_caps.h').write_text("""#pragma once
#include <stdlib.h>
#define MALLOC_CAP_SPIRAM 1
#define MALLOC_CAP_8BIT 2
static unsigned allocations, frees;
static void *heap_caps_malloc(size_t n,unsigned caps){assert(n==626196&&caps==3);allocations++;return malloc(n);}
static void scratch_free(void *p){if(p)frees++;free(p);}
#define free scratch_free
""")
    (tmp_path/'miniz.h').write_text(original.MINIZ)
    pack=original.load('native32_planes_test',ROOT/'tools/compress_font_native32.py')
    _,native=pack.source_data()
    bitmap=zlib.decompress((ROOT/'assets/fonts/pet_cn_16.deflate').read_bytes())
    metric=zlib.decompress((ROOT/'assets/fonts/pet_cn_metrics.deflate').read_bytes())
    for name,data in [('bitmap.bin',bitmap),('native32.bin',native),('metrics.bin',metric)]:(tmp_path/name).write_bytes(data)
    code=original.HARNESS.replace('{0,169664,554086,30579}','{0,169664,626196,30579}')
    code=code.replace('assert(out==(calls<3?pet_font_bitmap:pet_font_native32_bitmap));','assert(calls==2 || out==(calls<3?pet_font_bitmap:pet_font_native32_bitmap));')
    code=code.replace('unsigned count=calls;assert(', 'assert(allocations==frees);unsigned count=calls;assert(')
    src=tmp_path/'init.c';src.write_text(code)
    asm=original.asm_assets(tmp_path);text=asm.read_text();section='.section __TEXT,__const' if sys.platform=='darwin' else '.section .rodata'
    name='pet_cn_16_row_planes'
    text+=section+'\n.globl _binary_'+name+'_deflate_start\n.globl _binary_'+name+'_deflate_end\n_binary_'+name+'_deflate_start:\n.incbin "'+str(ROOT/'assets/fonts'/(name+'.deflate'))+'"\n_binary_'+name+'_deflate_end:\n'
    asm.write_text(text);exe=tmp_path/'init'
    subprocess.run(['cc','-std=gnu11','-O1','-Wall','-Wextra','-Werror','-fsanitize=address,undefined','-DLV_CONF_SKIP',
        '-DPET_FONT_NATIVE_32=1','-DPET_FONT_ROW_PLANES=1','-DPET_FONT_BITMAP_PACKED=1','-DPET_FONT_METRICS_PACKED=1',
        '-I',str(tmp_path),'-I',str(ROOT/'main'),'-I',str(original.LVGL),str(src),str(asm),'-lz','-o',str(exe)],check=True)
    for stage,kind in [(0,0),(2,4),*((s,k) for s in [1,2,3] for k in range(4))]:
        subprocess.run([str(exe),str(stage),str(kind),*(str(tmp_path/n) for n in ['bitmap.bin','native32.bin','metrics.bin'])],check=True,timeout=10)
