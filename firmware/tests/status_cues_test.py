"""Host-executed cue persistence/gain, plus transport and rendering contracts."""
from pathlib import Path
import subprocess
import tempfile
ROOT = Path(__file__).resolve().parents[1]


def test_cue_storage_defaults_validation_commit_and_gain():
    with tempfile.TemporaryDirectory() as tmp:
        p = Path(tmp)
        (p/'esp_err.h').write_text('#pragma once\ntypedef int esp_err_t;\n#define ESP_OK 0\n#define ESP_ERR_INVALID_ARG 1\n')
        (p/'nvs.h').write_text('''#pragma once
#include <stddef.h>
#include "esp_err.h"
typedef int nvs_handle_t;
#define NVS_READONLY 0
#define NVS_READWRITE 1
int nvs_open(const char*,int,nvs_handle_t*);
int nvs_get_blob(nvs_handle_t,const char*,void*,size_t*);
int nvs_set_blob(nvs_handle_t,const char*,const void*,size_t);
int nvs_commit(nvs_handle_t);
void nvs_close(nvs_handle_t);
''')
        (p/'test.c').write_text(r'''
#include "pet_p4_status_cues.h"
#include "nvs.h"
#include <assert.h>
#include <stdlib.h>
static pet_p4_status_cues_t disk;
static int mode, fail;
int nvs_open(const char *ns,int access,nvs_handle_t *h) {
 assert(!strcmp(ns,"pet_cues")); (void)access;*h=1;return 0;
}
int nvs_get_blob(nvs_handle_t h,const char *key,void *out,size_t *n) {
 (void)h;assert(!strcmp(key,"config"));if(!mode)return 2;
 disk=(pet_p4_status_cues_t){1,1,70,0};
 if(mode==2)disk.version=9;if(mode==3)disk.enabled=2;if(mode==4)disk.volume=101;if(mode==6)disk.reserved=1;
 memcpy(out,&disk,sizeof(disk));*n=mode==5?1:sizeof(disk);return 0;
}
int nvs_set_blob(nvs_handle_t h,const char *key,const void *in,size_t n) {
 (void)h;assert(!strcmp(key,"config"));assert(n==sizeof(disk));memcpy(&disk,in,n);return 0;
}
int nvs_commit(nvs_handle_t h){(void)h;return fail;}
void nvs_close(nvs_handle_t h){(void)h;}
int main(int argc,char **argv){
 assert(argc==2);mode=atoi(argv[1]);pet_p4_status_cues_init();
 pet_p4_status_cues_t c=pet_p4_status_cues_get();
 assert(c.enabled==(mode==1));assert(c.volume==(mode==1?70:30));
 assert(!pet_p4_status_cues_set(0,30));
 assert(disk.version==1&&!disk.enabled&&disk.volume==30);
 assert(pet_p4_status_cues_set(1,101)==ESP_ERR_INVALID_ARG);
 assert(!pet_p4_status_cues_set(1,40));c=pet_p4_status_cues_get();
 assert(c.enabled&&c.volume==40&&disk.version==1);
 fail=7;assert(pet_p4_status_cues_set(0,20)==7);assert(pet_p4_status_cues_get().enabled);
 uint8_t pcm[]={0xff,0x7f,0,0x80,0xe8,3,0x18,0xfc};
 pet_p4_status_cues_scale(pcm,sizeof(pcm),30);
 assert((int16_t)(pcm[0]|pcm[1]<<8)==9830);
 assert((int16_t)(pcm[2]|pcm[3]<<8)==-9830);
 assert((int16_t)(pcm[4]|pcm[5]<<8)==300);
 assert((int16_t)(pcm[6]|pcm[7]<<8)==-300);
 uint8_t clip[]={0xff,0x7f,0,0x80};pet_p4_status_cues_scale(clip,4,200);
 assert(clip[0]==255&&clip[1]==127&&clip[2]==0&&clip[3]==128);
 pet_p4_status_cues_scale(clip,4,0);assert(!clip[0]&&!clip[1]&&!clip[2]&&!clip[3]);return 0;
}
''')
        binary=p/'test'
        subprocess.run(['cc','-std=c11','-Wall','-Wextra','-Werror','-Wno-misleading-indentation','-I',str(p),'-I',str(ROOT/'main'),str(ROOT/'main/pet_p4_status_cues.c'),str(p/'test.c'),'-o',str(binary)],check=True)
        for mode in range(7):
            subprocess.run([str(binary),str(mode)],check=True)


def test_disabled_gate_precedes_appearance_and_embedded_sources():
    audio=(ROOT/'main/pet_p4_audio.c').read_text()
    task=audio.split('static void playback_task(',1)[1].split('static void audio_task(',1)[0]
    assert task.index('if (status_cue && !pet_p4_status_cues_get().enabled)') < task.index('pet_p4_asset_audio_override_path') < task.index('pet_p4_system_cue_pcm')
    assert 'bool status_cue = pet_p4_system_cue_family(request.family)' in task
    assert 'if (status_cue) {' in task
    assert task.index('pet_p4_status_cues_scale') < task.index('esp_codec_dev_write')
    assert '#define PET_P4_AUDIO_PLAYBACK_VOLUME 100' in audio
    families=(ROOT/'main/pet_p4_system_cues.c').read_text().split('bool pet_p4_system_cue_family',1)[1].split('/*',1)[0]
    for family in ('done','error','waiting_user'):
        assert f'"{family}"' in families


def test_protocol_validation_and_ble_control_contract():
    protocol=(ROOT/'main/pet_p4_protocol.c').read_text()
    handler=protocol.split('strcmp(topic, "config/status-cues")',1)[1].split('strncmp(topic, "state/"',1)[0]
    for token in ('cJSON_IsBool','cJSON_IsNumber','volume->valuedouble != (double)volume->valueint','pet_p4_status_cues_set','send_protocol_ack_if_requested','status_cues_persist_failed'):
        assert token in handler
    assert '"statusCueConfig", true' in protocol and '"statusCues"' in protocol
    ble=(ROOT/'main/pet_p4_ble.c').read_text()
    assert 'pet_p4_ble_dispatch_line(line)' in ble
    assert '\\"topic\\":\\"protocol/ack' in ble
    desktop=(ROOT.parent/'pc/src-tauri/src/lib.rs').read_text()
    assert 'if topic == "config/status-cues" { return true; }' in desktop


def test_session_pills_preserve_status_selection_and_cache():
    renderer=(ROOT/'main/pet_p4_renderer.c').read_text()
    for label in ('进行中','已完成','等你回复','出错'):
        assert f'"{label}"' in renderer
    for rgb in ('24, 112, 68','235, 89, 82','255, 163, 31','22, 93, 151', '226, 242, 255', '230, 246, 233'):
        assert f'rgb565({rgb})' in renderer
    queue=renderer.split('static void draw_session_queue_uncached',1)[1].split('static uint64_t session_cache',1)[0]
    assert 'draw_session_leading_mark(x, y, h, marker_status, status)' in queue
    assert 'is_selected ? selection : status' not in queue
    assert 'pill_width + 8' in queue and 'body_ink' in queue
    signature=renderer.split('static uint64_t session_overlay_signature',1)[1].split('static void',1)[0]
    assert 'item->state' in signature and 'now_ms' not in signature
    assert 'draw_session_progress_dot(now_ms' in renderer


def test_production_pill_helpers_on_host():
    renderer=(ROOT/'main/pet_p4_renderer.c').read_text()
    helpers=renderer.split('static const char *session_status_label(',1)[1].split('/* Called after the appearance attempt',1)[0]
    helpers='static const char *session_status_label('+helpers
    harness=r'''
#include <assert.h>
#include <stdint.h>
#include <string.h>
#include <stdbool.h>
typedef enum {PET_P4_VIEW_STATUS_IDLE, PET_P4_VIEW_STATUS_WORKING, PET_P4_VIEW_STATUS_DONE,
 PET_P4_VIEW_STATUS_WAITING, PET_P4_VIEW_STATUS_ERROR} pet_p4_view_status_t;
static int rect_x,rect_y,rect_w,rect_h,text_x,text_y,text_h,dot_x,dot_y;
static uint16_t rect_color,text_color;
static const char *text;
static uint16_t rgb565(int r,int g,int b){return ((r>>3)<<11)|((g>>2)<<5)|(b>>3);}
static uint16_t view_status_color(pet_p4_view_status_t s){return (uint16_t)(s+10);}
/* Font advance stub: CN16 with one pixel spacing, production UTF8 measurement is covered by existing contracts. */
static int utf8_text_width(const char *s,int limit,int scale){(void)limit;assert(scale==1);return (int)strlen(s)/3*17;}
static void fill_round_rect(int x,int y,int w,int h,int radius,uint16_t color){
 assert(radius==15);rect_x=x;rect_y=y;rect_w=w;rect_h=h;rect_color=color;
}
static void draw_text_line_vcenter(const char *s,int x,int y,int h,int w,uint16_t c,int scale,bool ellipsis){
 assert(scale==1&&!ellipsis);assert(w>=utf8_text_width(s,-1,1));
 text=s;text_x=x;text_y=y;text_h=h;text_color=c;
}
static void fill_ellipse(int x,int y,int rx,int ry,uint16_t c){assert(rx==2&&ry==2&&c==rgb565(255,255,255));dot_x=x;dot_y=y;}
'''+helpers+r'''
int main(void){
 assert(session_status_pill_width(PET_P4_VIEW_STATUS_IDLE)==0);
 const char *labels[]={"", "进行中", "已完成", "等你回复", "出错"};
 for(int s=1;s<=4;s++){
   draw_session_status_pill(s,586,50);
   assert(!strcmp(text,labels[s]));assert(rect_y==50&&rect_h==30);
   assert(rect_x+rect_w==586&&rect_color==s+10);
   assert(text_x==rect_x+10&&text_y==50&&text_h==30&&text_color==rgb565(255,255,255));
 }
 draw_session_status_pill(PET_P4_VIEW_STATUS_WORKING,586,50);
 for(int frame=0;frame<8;frame++){
   draw_session_progress_dot(frame*150,586,50);
   assert(dot_x-2>text_x+utf8_text_width("进行中",-1,1));
   assert(dot_x+2<586&&dot_y-2>50&&dot_y+2<80);
 }
 return 0;
}
'''
    with tempfile.TemporaryDirectory() as tmp:
        p=Path(tmp);(p/'test.c').write_text(harness)
        subprocess.run(['cc','-std=c11','-Wall','-Wextra','-Werror',str(p/'test.c'),'-o',str(p/'test')],check=True)
        subprocess.run([str(p/'test')],check=True)
