#pragma once

#include <stdbool.h>
#include <stdint.h>
#include <string.h>
#include "mbedtls/ecdsa.h"
#include "mbedtls/sha256.h"

static inline int pet_codex_hex_nibble(char digit) {
  if (digit >= '0' && digit <= '9') return digit - '0';
  if (digit >= 'a' && digit <= 'f') return digit - 'a' + 10;
  return -1;
}

static inline bool pet_codex_usage_authorized(const char *public_key_hex, const char *id,
                                              const uint8_t *module, size_t size,
                                              bool has_network_policy, bool radio) {
  static const char section[] = "hachi.codex-use.v1";
  static const char domain[] = "hachi/codex-usage/v1";
  static const uint8_t wasm_header[] = {0, 'a', 's', 'm', 1, 0, 0, 0};
  enum { NAME_BYTES = sizeof(section) - 1, SCALAR_BYTES = 32,
         TRAILER_BYTES = 3 + NAME_BYTES + 2 * SCALAR_BYTES };
  if (radio || has_network_policy ||
      (strcmp(id, "token-fishing-arcade") && strcmp(id, "token-ocean-voyage") &&
       strcmp(id, "token-world-atlas")) ||
      size < sizeof(wasm_header) + TRAILER_BYTES || memcmp(module, wasm_header, sizeof(wasm_header)))
    return false;
  size_t unsigned_size = size - TRAILER_BYTES;
  const uint8_t *trailer = module + unsigned_size;
  if (trailer[0] != 0 || trailer[1] != TRAILER_BYTES - 2 || trailer[2] != NAME_BYTES ||
      memcmp(trailer + 3, section, NAME_BYTES)) return false;

  uint8_t key[1 + 2 * SCALAR_BYTES];
  if (strlen(public_key_hex) != 2 * sizeof(key)) return false;
  for (size_t index = 0; index < sizeof(key); index++) {
    int high = pet_codex_hex_nibble(public_key_hex[2 * index]);
    int low = pet_codex_hex_nibble(public_key_hex[2 * index + 1]);
    if (high < 0 || low < 0) return false;
    key[index] = (uint8_t)(high * 16 + low);
  }
  if (key[0] != 4) return false;

  uint8_t digest[32];
  mbedtls_sha256_context sha;
  mbedtls_sha256_init(&sha);
  bool hashed = !mbedtls_sha256_starts(&sha, 0) &&
                !mbedtls_sha256_update(&sha, (const uint8_t *)domain, sizeof(domain)) &&
                !mbedtls_sha256_update(&sha, (const uint8_t *)id, strlen(id) + 1) &&
                !mbedtls_sha256_update(&sha, module, unsigned_size) &&
                !mbedtls_sha256_finish(&sha, digest);
  mbedtls_sha256_free(&sha);
  if (!hashed) return false;

  const uint8_t *signature = trailer + 3 + NAME_BYTES;
  mbedtls_ecp_group group;
  mbedtls_ecp_point point;
  mbedtls_mpi r, s;
  mbedtls_ecp_group_init(&group);
  mbedtls_ecp_point_init(&point);
  mbedtls_mpi_init(&r);
  mbedtls_mpi_init(&s);
  bool verified = !mbedtls_ecp_group_load(&group, MBEDTLS_ECP_DP_SECP256R1) &&
                  !mbedtls_ecp_point_read_binary(&group, &point, key, sizeof(key)) &&
                  !mbedtls_ecp_check_pubkey(&group, &point) &&
                  !mbedtls_mpi_read_binary(&r, signature, SCALAR_BYTES) &&
                  !mbedtls_mpi_read_binary(&s, signature + SCALAR_BYTES, SCALAR_BYTES) &&
                  !mbedtls_ecdsa_verify(&group, digest, sizeof(digest), &point, &r, &s);
  mbedtls_mpi_free(&s);
  mbedtls_mpi_free(&r);
  mbedtls_ecp_point_free(&point);
  mbedtls_ecp_group_free(&group);
  return verified;
}
