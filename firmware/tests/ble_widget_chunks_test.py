"""Host execution of the production widget chunk receiver, no hardware access."""
from pathlib import Path
import subprocess


def test_all_widget_chunk_paths(tmp_path):
    code = (Path(__file__).parents[1] / 'main/pet_p4_miniapp.c').read_text()
    receiver = code[code.index('bool pet_p4_miniapp_install_chunk('):code.index('/* A same-version hot update')]
    source = r'''
#include <assert.h>
#include <stdbool.h>
#include <stdint.h>
#include <stdlib.h>
#include <string.h>
#include <stdio.h>
static bool pet_p4_miniapp_storage_busy(void){return false;}
#define PET_P4_MINIAPP_SPRITE_ID_MAX 16
#define MINIAPP_SPRITE_FILE_MAX 12296
#define PET_IMAGE_MAX_BYTES 100000
#define PET_IMAGE_HEADER 12
typedef struct { const char *path,*data; long index; bool valid; } cJSON;
static struct {char widget_json[8192],buttons_json[2048];size_t widget_len,buttons_len;uint32_t widget_next_index,buttons_next_index;int sprites;} g_staging;
static uint8_t g_image_staging[100001]; static size_t g_image_used; static uint32_t g_image_next;static char g_image_id[16];
static const char *json_string(const cJSON*p,const char*k){return !strcmp(k,"path")?p->path:p->data;}
static long json_index(const cJSON*p){return p->index;}
static bool transfer_matches(const cJSON*p){(void)p;return true;}
static void set_error(char*e,size_t n,const char*m){snprintf(e,n,"%s",m);}
static bool safe_id(const char*s,size_t n){return strlen(s)<n&&!strchr(s,'/');}
static int sprite_pack_find(const int*p,const char*s){(void)s;return *p?0:-1;}
static bool append_sprite_file(int*p,const char*s,const uint8_t*b,size_t n,char*e,size_t z){(void)s;(void)b;(void)n;(void)e;(void)z;*p=1;return true;}
static bool verify_chunk_integrity(const cJSON*p,const uint8_t*b,size_t n,char*e,size_t z){(void)b;(void)n;(void)e;(void)z;return p->valid;}
// Decode a hex transport in this harness; production decoder's capacity contract.
static bool decode_chunk(const char*d,char*t,size_t cap,size_t*u,size_t*now,bool reset,char*e,size_t z){
 size_t n=strlen(d)/2,off=reset?0:*u;(void)e;(void)z;
 if(off+n>=cap)return false;
 for(size_t i=0;i<n;i++){unsigned v;sscanf(d+2*i,"%2x",&v);t[off+i]=(char)v;}
 *u=off+n;*now=n;t[*u]=0;return true;
}
''' + receiver + r'''
static void reset(void){memset(&g_staging,0,sizeof(g_staging));g_image_used=0;g_image_next=0;g_image_id[0]=0;}
int main(void){char error[128];
 const char*paths[]={"runtime/widget.json","buttons.json","runtime/sprites/test.p4s","runtime/images/test.p4i","component.json","negative-screen.json","share.json"};
 for(size_t i=0;i<7;i++){
  reset();cJSON p={paths[i],"6162",1,true};
  if(i<4)assert(!pet_p4_miniapp_install_chunk(&p,error,sizeof(error)));
  p.index=0;
  if(i==2)p.data="5034533108080100";
  if(i==3)p.data="503449310808010064000000";
  assert(pet_p4_miniapp_install_chunk(&p,error,sizeof(error)));
  assert(pet_p4_miniapp_install_chunk(&p,error,sizeof(error))); // ACK-loss duplicate
  p.index=1;p.data="6162";p.valid=false;
  if(i<4)assert(!pet_p4_miniapp_install_chunk(&p,error,sizeof(error)));
  p.valid=true;assert(pet_p4_miniapp_install_chunk(&p,error,sizeof(error)));
  if(i<4){p.index=3;assert(!pet_p4_miniapp_install_chunk(&p,error,sizeof(error)));p.index=2;assert(pet_p4_miniapp_install_chunk(&p,error,sizeof(error)));p.index=0;assert(!pet_p4_miniapp_install_chunk(&p,error,sizeof(error)));}
 }
 reset();cJSON complete={"runtime/sprites/test.p4s","5034533108080100",0,true};
 assert(pet_p4_miniapp_install_chunk(&complete,error,sizeof(error)));assert(!g_staging.sprites);
 char pixels[385];for(int j=0;j<192;j++){pixels[j*2]='6';pixels[j*2+1]='1';}pixels[384]=0;
 complete.index=1;complete.data=pixels;assert(pet_p4_miniapp_install_chunk(&complete,error,sizeof(error)));
 assert(g_staging.sprites&&g_image_used==200&&g_image_staging[199]=='a');
 reset();complete=(cJSON){"runtime/widget.json","6162",0,true};
 assert(pet_p4_miniapp_install_chunk(&complete,error,sizeof(error)));complete.index=1;complete.data="6364";
 assert(pet_p4_miniapp_install_chunk(&complete,error,sizeof(error)));assert(!strcmp(g_staging.widget_json,"abcd"));
 reset();cJSON p={"runtime/widget.json","61",0,true};
 assert(pet_p4_miniapp_install_chunk(&p,error,sizeof(error)));
 g_staging.widget_len=8191;p.index=1;assert(!pet_p4_miniapp_install_chunk(&p,error,sizeof(error)));
 reset();p=(cJSON){"buttons.json","61",0,true};assert(pet_p4_miniapp_install_chunk(&p,error,sizeof(error)));
 g_staging.buttons_len=2047;p.index=1;assert(!pet_p4_miniapp_install_chunk(&p,error,sizeof(error)));
 reset();p=(cJSON){"runtime/sprites/test.p4s","50345331ffffff00",0,true};assert(!pet_p4_miniapp_install_chunk(&p,error,sizeof(error)));
 reset();p=(cJSON){"runtime/images/test.p4i","5034493108080100ffffffff",0,true};assert(!pet_p4_miniapp_install_chunk(&p,error,sizeof(error)));
 return 0;}
'''
    path = tmp_path / 'chunks.c'
    path.write_text(source)
    binary = tmp_path / 'chunks'
    subprocess.run(['cc', '-std=c11', '-Wall', '-Wextra', '-Werror', '-fsanitize=address,undefined', str(path), '-o', str(binary)], check=True)
    subprocess.run([str(binary)], check=True)
