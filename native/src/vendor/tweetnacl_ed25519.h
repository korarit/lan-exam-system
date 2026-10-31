/* ============================================================
 * TweetNaCl Ed25519 subset — public domain.
 * Upstream: https://tweetnacl.cr.yp.to/20140427/tweetnacl.c
 * ============================================================ */
#ifndef ZTEXAM_TWEETNACL_ED25519_H
#define ZTEXAM_TWEETNACL_ED25519_H

#ifdef __cplusplus
extern "C" {
#endif

/* sk = 64 bytes (seed || public key), pk = 32 bytes */
int crypto_sign_seed_keypair(unsigned char *pk, unsigned char *sk,
                             const unsigned char *seed);
/* sm = message || 64-byte signature; returns 0 on success */
int crypto_sign(unsigned char *sm, unsigned long long *smlen,
                const unsigned char *m, unsigned long long n,
                const unsigned char *sk);

#ifdef __cplusplus
}
#endif

#endif
