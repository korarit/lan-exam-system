/* ============================================================
 * Portable SHA-256 — public domain (FIPS 180-4).
 * Used by the native attestation signer to hash app.asar.
 * ============================================================ */
#ifndef ZTEXAM_SHA256_H
#define ZTEXAM_SHA256_H

#include <stddef.h>
#include <stdint.h>

#ifdef __cplusplus
extern "C" {
#endif

typedef struct {
  uint32_t state[8];
  uint64_t bitlen;
  uint8_t data[64];
  size_t datalen;
} zt_sha256_ctx;

void zt_sha256_init(zt_sha256_ctx *ctx);
void zt_sha256_update(zt_sha256_ctx *ctx, const uint8_t *data, size_t len);
void zt_sha256_final(zt_sha256_ctx *ctx, uint8_t out[32]);

#ifdef __cplusplus
}
#endif

#endif
