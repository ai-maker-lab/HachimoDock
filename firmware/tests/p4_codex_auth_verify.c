#include <stdio.h>
#include <stdlib.h>

#include "pet_p4_codex_auth.h"

int main(int argc, char **argv) {
  if (argc != 4 && argc != 6) return 2;
  FILE *file = fopen(argv[3], "rb");
  if (!file) return 2;
  if (fseek(file, 0, SEEK_END)) { fclose(file); return 2; }
  long bytes = ftell(file);
  if (bytes < 1 || fseek(file, 0, SEEK_SET)) { fclose(file); return 2; }
  uint8_t *module = malloc((size_t)bytes);
  if (!module) { fclose(file); return 2; }
  size_t size = fread(module, 1, (size_t)bytes, file);
  fclose(file);
  bool network = argc == 6 && strcmp(argv[4], "0");
  bool radio = argc == 6 && strcmp(argv[5], "0");
  int result = size != (size_t)bytes ? 2 :
      !pet_codex_usage_authorized(argv[1], argv[2], module, size, network, radio);
  free(module);
  return result;
}
