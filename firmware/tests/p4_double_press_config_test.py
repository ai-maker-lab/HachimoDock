"""Compile production configuration migration against an in-memory NVS fake."""
from pathlib import Path
import subprocess

ROOT = Path(__file__).resolve().parents[1]


def test_v9_nvs_blob_keeps_custom_bindings_and_adds_disabled_doubles(tmp_path):
    source = (ROOT / "main/pet_p4_input.c").read_text(encoding="utf-8")
    header = (ROOT / "main/pet_p4_input.h").read_text(encoding="utf-8")
    defines = "\n".join(line for line in header.splitlines() if line.startswith("#define PET_P4_INPUT_"))
    types = source[source.index("typedef struct {\n  char event["):source.index("typedef enum {")]
    config = source[source.index("static bool event_is_allowed("):source.index("static pet_p4_input_binding_t *find_binding(")]
    harness = r'''
#include <assert.h>
#include <stdint.h>
#include <stdbool.h>
#include <stdio.h>
#include <string.h>
#define PET_P4_INPUT_NVS_NAMESPACE "pet_input"
#define PET_P4_INPUT_NVS_KEY "config"
#define ESP_OK 0
#define ESP_ERR_NVS_NOT_FOUND 1
#define NVS_READWRITE 1
#define NVS_READONLY 0
#define ESP_LOGI(...) log_stub(__VA_ARGS__)
#define ESP_LOGW(...) log_stub(__VA_ARGS__)
typedef int esp_err_t;
typedef int nvs_handle_t;
static const char *TAG="test";
static unsigned char blob[8192];
static size_t blob_size;
static void log_stub(const char *tag,const char *fmt,...){(void)tag;(void)fmt;}
static const char *esp_err_to_name(int e){(void)e;return "test";}
static int nvs_open(const char *name,int flags,nvs_handle_t *out){(void)name;(void)flags;*out=1;return ESP_OK;}
static void nvs_close(nvs_handle_t h){(void)h;}
static int nvs_commit(nvs_handle_t h){(void)h;return ESP_OK;}
static int nvs_get_blob(nvs_handle_t h,const char *key,void *out,size_t *size){
  (void)h;(void)key;assert(*size>=blob_size);memcpy(out,blob,blob_size);*size=blob_size;return ESP_OK;
}
static int nvs_set_blob(nvs_handle_t h,const char *key,const void *in,size_t size){
  (void)h;(void)key;assert(size<=sizeof(blob));memcpy(blob,in,size);blob_size=size;return ESP_OK;
}
static void copy_text(char *out,size_t n,const char *text){snprintf(out,n,"%s",text);}
''' + defines + "\n" + types + "\nstatic pet_p4_input_config_t g_config;\n" + config + r'''
int main(void){
  pet_p4_input_config_t defaults;load_default_config(&defaults);
  assert(defaults.binding_count==19&&config_is_valid(&defaults));
  struct {uint32_t version,count;pet_p4_input_binding_t bindings[16];} old={.version=9};
  for(unsigned i=0;i<defaults.binding_count;i++){
    if(strstr(defaults.bindings[i].event,".double_press"))continue;
    old.bindings[old.count++]=defaults.bindings[i];
  }
  assert(old.count==16);
  strcpy(old.bindings[0].action,"agent_prompt");strcpy(old.bindings[0].value,"custom prompt");
  memcpy(blob,&old,sizeof(old));blob_size=sizeof(old);
  load_persisted_config();
  assert(g_config.version==10&&g_config.binding_count==19&&config_is_valid(&g_config));
  assert(!strcmp(g_config.bindings[0].action,"agent_prompt"));
  assert(!strcmp(g_config.bindings[0].value,"custom prompt"));
  for(unsigned i=16;i<19;i++){
    assert(strstr(g_config.bindings[i].event,".double_press"));
    assert(!strcmp(g_config.bindings[i].action,"disabled"));
  }
  assert(blob_size==sizeof(g_config));
  load_persisted_config();assert(g_config.binding_count==19);
  // Unknown versions and partial blobs fall back to safe defaults.
  old.version=99;memcpy(blob,&old,sizeof(old));blob_size=sizeof(old);
  load_persisted_config();assert(!strcmp(g_config.bindings[0].action,"page_enter"));
  blob_size=7;load_persisted_config();assert(config_is_valid(&g_config));
  return 0;
}
'''
    file = tmp_path / "config.c"
    file.write_text(harness, encoding="utf-8")
    binary = tmp_path / "config"
    subprocess.run(["cc", "-std=c11", "-Wall", "-Wextra", "-Werror", str(file), "-o", str(binary)], check=True)
    subprocess.run([str(binary)], check=True)
