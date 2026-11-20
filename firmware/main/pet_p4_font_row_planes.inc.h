/* Boot-only lossless alternative. Scratch is released before runtime tasks start. */
#include "esp_heap_caps.h"
#include <stdlib.h>
#include "pet_p4_font_row_planes_size.h"
extern const unsigned char font_planes[] asm("_binary_pet_cn_16_row_planes_deflate_start");
extern const unsigned char font_planes_end[] asm("_binary_pet_cn_16_row_planes_deflate_end");
static bool prepare_bitmap_after_columns(void) {
  uint8_t *planes=heap_caps_malloc(PET_FONT_PLANE_BYTES,MALLOC_CAP_SPIRAM|MALLOC_CAP_8BIT);
  if(!planes)return false;
  size_t consumed=(size_t)(font_planes_end-font_planes),decoded=PET_FONT_PLANE_BYTES;
  tinfl_init(&inflater);
  bool ok=consumed==PET_FONT_PLANE_PACKED_BYTES &&
    tinfl_decompress(&inflater,font_planes,&consumed,planes,planes,&decoded,
      TINFL_FLAG_PARSE_ZLIB_HEADER|TINFL_FLAG_USING_NON_WRAPPING_OUTPUT_BUF)==TINFL_STATUS_DONE &&
    consumed==PET_FONT_PLANE_PACKED_BYTES && decoded==PET_FONT_PLANE_BYTES &&
    tinfl_get_adler32(&inflater)==PET_FONT_PLANE_ADLER;
  memset(pet_font_bitmap,0,sizeof(pet_font_bitmap));
  size_t row=0;
  for(size_t i=0;ok && i<PET_FONT_METRIC_RECORDS;i++) {
    const lv_font_fmt_txt_glyph_dsc_t *g=&pet_font_metrics[i];
    size_t width=g->box_w,height=g->box_h,offset=g->bitmap_index;
    if(width>16 || row>PET_FONT_PLANE_ROWS || height>PET_FONT_PLANE_ROWS-row ||
       offset>sizeof(pet_font_bitmap) || (width*height+7)/8>sizeof(pet_font_bitmap)-offset) {ok=false;break;}
    for(size_t y=0;y<height;y++,row++) {
      unsigned bits=planes[row]|((unsigned)planes[PET_FONT_PLANE_ROWS+row]<<8);
      if(bits>>width){ok=false;break;}
      for(size_t x=0;x<width;x++) {
        size_t bit=y*width+x;
        pet_font_bitmap[offset+bit/8]|=((bits>>(width-x-1))&1U)<<(7-bit%8);
      }
    }
  }
  free(planes);
  if(!ok || row!=PET_FONT_PLANE_ROWS)return false;
  uint32_t fnv=UINT32_C(2166136261);
  for(size_t i=0;i<sizeof(pet_font_bitmap);i++)fnv=(fnv^pet_font_bitmap[i])*UINT32_C(16777619);
  return fnv==PET_FONT_PLANE_FNV;
}
