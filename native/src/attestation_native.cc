// native/src/attestation_native.cc — Native attestation signer (N-API)
//
// ทำหน้าที่เดียว: ตรวจ sha256 ของไฟล์ที่กำลังรันอยู่ (app.asar) ด้วยโค้ด native
// แล้วเซ็น canonical payload ด้วย Ed25519 seed ต่อเครื่องที่ JS ส่งเข้ามาตอน boot
// - attestationSetDeviceSeed(hex64) ตั้ง seed (ไม่ persist ใน addon; อยู่ใน memory เท่านั้น)
// - JS เรียกได้แค่ attestationSign(requestJson) — อ่านไฟล์เองไม่ได้
// - ถ้าไฟล์หาย/อ่านไม่ได้/hash ไม่ตรง/ยังไม่ตั้ง seed → คืน null (ไม่เซ็น)
// - root ของ resources มาจากตำแหน่ง .node ที่โหลดอยู่จริง ไม่ได้มาจาก JS
#include "napi.h"

#include <algorithm>
#include <cstdint>
#include <cstdlib>
#include <cstring>
#include <fstream>
#include <map>
#include <mutex>
#include <string>
#include <utility>
#include <vector>

#include "vendor/sha256.h"
#include "vendor/tweetnacl_ed25519.h"

/*
 * ไม่มี signing key ฝังในไบนารีอีกต่อไป (เดิม kSeedShareA/B อยู่ในไฟล์นี้)
 * - JS/TS สร้าง per-device Ed25519 keypair แล้วส่ง seed เข้ามาผ่าน attestationSetDeviceSeed()
 * - seed อยู่ในหน่วยความจำของ process เท่านั้น, ไม่ถูกเขียนลงดิสก์แบบ plaintext
 * - host ตรวจ public key กับ signed device roster (ไม่เชื่อ key ที่ client ส่งมา)
 */

#if defined(_WIN32)
#define WIN32_LEAN_AND_MEAN
#include <windows.h>
#else
#include <dlfcn.h>
#endif

#include <filesystem>

namespace {

namespace fs = std::filesystem;

/* ---------- minimal JSON parser (only what the fixed request shape needs) ---------- */

struct JsonValue {
  enum Type { Null, Bool, Number, String, Array, Object } type = Null;
  bool boolean = false;
  double number = 0;
  std::string string;
  std::vector<JsonValue> array;
  std::map<std::string, JsonValue> object;
};

class JsonParser {
 public:
  explicit JsonParser(const std::string& text) : text_(text) {}

  bool Parse(JsonValue& out) {
    SkipWhitespace();
    if (!ParseValue(out)) return false;
    SkipWhitespace();
    return pos_ == text_.size();
  }

 private:
  const std::string& text_;
  size_t pos_ = 0;

  void SkipWhitespace() {
    while (pos_ < text_.size()) {
      const char c = text_[pos_];
      if (c == ' ' || c == '\t' || c == '\n' || c == '\r') {
        ++pos_;
      } else {
        break;
      }
    }
  }

  bool ParseValue(JsonValue& out) {
    SkipWhitespace();
    if (pos_ >= text_.size()) return false;
    const char c = text_[pos_];
    if (c == '"') {
      out.type = JsonValue::String;
      return ParseString(out.string);
    }
    if (c == '{') return ParseObject(out);
    if (c == '[') return ParseArray(out);
    if (c == 't' && text_.compare(pos_, 4, "true") == 0) {
      pos_ += 4;
      out.type = JsonValue::Bool;
      out.boolean = true;
      return true;
    }
    if (c == 'f' && text_.compare(pos_, 5, "false") == 0) {
      pos_ += 5;
      out.type = JsonValue::Bool;
      out.boolean = false;
      return true;
    }
    if (c == 'n' && text_.compare(pos_, 4, "null") == 0) {
      pos_ += 4;
      out.type = JsonValue::Null;
      return true;
    }
    if (c == '-' || (c >= '0' && c <= '9')) {
      char* end = nullptr;
      out.number = std::strtod(text_.c_str() + pos_, &end);
      if (end == text_.c_str() + pos_) return false;
      pos_ = static_cast<size_t>(end - text_.c_str());
      out.type = JsonValue::Number;
      return true;
    }
    return false;
  }

  bool ParseString(std::string& out) {
    if (pos_ >= text_.size() || text_[pos_] != '"') return false;
    ++pos_;
    out.clear();
    while (pos_ < text_.size()) {
      const unsigned char c = static_cast<unsigned char>(text_[pos_++]);
      if (c == '"') return true;
      if (c == '\\') {
        if (pos_ >= text_.size()) return false;
        const char esc = text_[pos_++];
        switch (esc) {
          case '"': out.push_back('"'); break;
          case '\\': out.push_back('\\'); break;
          case '/': out.push_back('/'); break;
          case 'b': out.push_back('\b'); break;
          case 'f': out.push_back('\f'); break;
          case 'n': out.push_back('\n'); break;
          case 'r': out.push_back('\r'); break;
          case 't': out.push_back('\t'); break;
          case 'u': {
            unsigned int cp = 0;
            if (!ParseHex4(cp)) return false;
            if (cp >= 0xD800 && cp <= 0xDBFF) {
              if (pos_ + 2 > text_.size() || text_[pos_] != '\\' || text_[pos_ + 1] != 'u') return false;
              pos_ += 2;
              unsigned int low = 0;
              if (!ParseHex4(low) || low < 0xDC00 || low > 0xDFFF) return false;
              cp = 0x10000 + ((cp - 0xD800) << 10) + (low - 0xDC00);
            }
            AppendUtf8(out, cp);
            break;
          }
          default:
            return false;
        }
      } else {
        out.push_back(static_cast<char>(c));
      }
    }
    return false;
  }

  bool ParseHex4(unsigned int& value) {
    if (pos_ + 4 > text_.size()) return false;
    value = 0;
    for (int i = 0; i < 4; ++i) {
      const char c = text_[pos_++];
      value <<= 4;
      if (c >= '0' && c <= '9') {
        value |= static_cast<unsigned int>(c - '0');
      } else if (c >= 'a' && c <= 'f') {
        value |= static_cast<unsigned int>(c - 'a' + 10);
      } else if (c >= 'A' && c <= 'F') {
        value |= static_cast<unsigned int>(c - 'A' + 10);
      } else {
        return false;
      }
    }
    return true;
  }

  static void AppendUtf8(std::string& out, unsigned int cp) {
    if (cp <= 0x7F) {
      out.push_back(static_cast<char>(cp));
    } else if (cp <= 0x7FF) {
      out.push_back(static_cast<char>(0xC0 | (cp >> 6)));
      out.push_back(static_cast<char>(0x80 | (cp & 0x3F)));
    } else if (cp <= 0xFFFF) {
      out.push_back(static_cast<char>(0xE0 | (cp >> 12)));
      out.push_back(static_cast<char>(0x80 | ((cp >> 6) & 0x3F)));
      out.push_back(static_cast<char>(0x80 | (cp & 0x3F)));
    } else {
      out.push_back(static_cast<char>(0xF0 | (cp >> 18)));
      out.push_back(static_cast<char>(0x80 | ((cp >> 12) & 0x3F)));
      out.push_back(static_cast<char>(0x80 | ((cp >> 6) & 0x3F)));
      out.push_back(static_cast<char>(0x80 | (cp & 0x3F)));
    }
  }

  bool ParseArray(JsonValue& out) {
    if (text_[pos_] != '[') return false;
    ++pos_;
    out.type = JsonValue::Array;
    SkipWhitespace();
    if (pos_ < text_.size() && text_[pos_] == ']') {
      ++pos_;
      return true;
    }
    for (;;) {
      JsonValue item;
      if (!ParseValue(item)) return false;
      out.array.push_back(std::move(item));
      SkipWhitespace();
      if (pos_ >= text_.size()) return false;
      if (text_[pos_] == ',') {
        ++pos_;
        continue;
      }
      if (text_[pos_] == ']') {
        ++pos_;
        return true;
      }
      return false;
    }
  }

  bool ParseObject(JsonValue& out) {
    if (text_[pos_] != '{') return false;
    ++pos_;
    out.type = JsonValue::Object;
    SkipWhitespace();
    if (pos_ < text_.size() && text_[pos_] == '}') {
      ++pos_;
      return true;
    }
    for (;;) {
      SkipWhitespace();
      std::string key;
      if (!ParseString(key)) return false;
      SkipWhitespace();
      if (pos_ >= text_.size() || text_[pos_] != ':') return false;
      ++pos_;
      JsonValue value;
      if (!ParseValue(value)) return false;
      out.object[key] = std::move(value);
      SkipWhitespace();
      if (pos_ >= text_.size()) return false;
      if (text_[pos_] == ',') {
        ++pos_;
        continue;
      }
      if (text_[pos_] == '}') {
        ++pos_;
        return true;
      }
      return false;
    }
  }
};

bool GetStringField(const JsonValue& root, const char* key, std::string& out) {
  const auto it = root.object.find(key);
  if (it == root.object.end() || it->second.type != JsonValue::String) return false;
  out = it->second.string;
  return true;
}

struct SampleRange {
  std::string relative_path;
  uint64_t offset = 0;
  uint64_t length = 0;
};

struct TargetFile {
  std::string relative_path;
  std::string sha256;
};

bool GetNumberField(const JsonValue& root, const char* key, double& out) {
  const auto it = root.object.find(key);
  if (it == root.object.end() || it->second.type != JsonValue::Number) return false;
  out = it->second.number;
  return true;
}

bool GetSampleRanges(const JsonValue& root, std::vector<SampleRange>& out) {
  const auto it = root.object.find("sampleRanges");
  if (it == root.object.end() || it->second.type != JsonValue::Array) return false;
  out.clear();
  if (it->second.array.size() > 64) return false;
  for (const auto& item : it->second.array) {
    if (item.type != JsonValue::Object) return false;
    SampleRange range;
    double offset = 0;
    double length = 0;
    if (!GetStringField(item, "relativePath", range.relative_path)) return false;
    if (!GetNumberField(item, "offset", offset) || offset < 0) return false;
    if (!GetNumberField(item, "length", length) || length <= 0 ||
        length > static_cast<double>(64 * 1024)) {
      return false;
    }
    range.offset = static_cast<uint64_t>(offset);
    range.length = static_cast<uint64_t>(length);
    out.push_back(std::move(range));
  }
  return true;
}

bool GetTargets(const JsonValue& root, std::vector<TargetFile>& out) {
  const auto it = root.object.find("targets");
  if (it == root.object.end() || it->second.type != JsonValue::Array) return false;
  out.clear();
  if (it->second.array.size() > 64) return false;
  for (const auto& item : it->second.array) {
    if (item.type != JsonValue::Object) return false;
    TargetFile target;
    if (!GetStringField(item, "relativePath", target.relative_path)) return false;
    if (!GetStringField(item, "sha256", target.sha256)) return false;
    if (target.sha256.size() != 64) return false;
    out.push_back(std::move(target));
  }
  return true;
}

/* ---------- crypto helpers ---------- */

struct KeyMaterial {
  bool ok = false;
  unsigned char secret_key[64] = {};
  unsigned char public_key[32] = {};
};

std::mutex g_key_mutex;
KeyMaterial g_key_material;

/** คัดลอก key ใต้ mutex (กัน race ระหว่าง set seed กับการเซ็น) */
bool GetKeySnapshot(KeyMaterial& out) {
  std::lock_guard<std::mutex> lock(g_key_mutex);
  out = g_key_material;
  return out.ok;
}

/** ล้างหน่วยความจำแบบไม่ให้ compiler optimize ทิ้ง */
void WipeBytes(unsigned char* data, size_t length) {
  volatile unsigned char* cursor = data;
  while (length-- > 0) *cursor++ = 0;
}

bool ParseHex32(const std::string& hex, unsigned char out[32]) {
  if (hex.size() != 64) return false;
  auto nibble = [](char c) -> int {
    if (c >= '0' && c <= '9') return c - '0';
    if (c >= 'a' && c <= 'f') return c - 'a' + 10;
    if (c >= 'A' && c <= 'F') return c - 'A' + 10;
    return -1;
  };
  for (size_t i = 0; i < 32; ++i) {
    const int high = nibble(hex[i * 2]);
    const int low = nibble(hex[i * 2 + 1]);
    if (high < 0 || low < 0) return false;
    out[i] = static_cast<unsigned char>((high << 4) | low);
  }
  return true;
}

/**
 * ตั้ง per-device seed (hex 64 ตัว) — เรียกจาก main process ตอน boot
 * - seed ว่าง = ล้าง key (fail-closed)
 * - คืน false เมื่อรูปแบบผิด/derive key ไม่สำเร็จ
 */
Napi::Value AttestationSetDeviceSeed(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  if (info.Length() < 1 || !info[0].IsString()) return Napi::Boolean::New(env, false);
  const std::string hex = info[0].As<Napi::String>().Utf8Value();
  if (hex.empty()) {
    std::lock_guard<std::mutex> lock(g_key_mutex);
    WipeBytes(g_key_material.secret_key, sizeof(g_key_material.secret_key));
    WipeBytes(g_key_material.public_key, sizeof(g_key_material.public_key));
    g_key_material.ok = false;
    return Napi::Boolean::New(env, true);
  }
  unsigned char seed[32] = {};
  if (!ParseHex32(hex, seed)) return Napi::Boolean::New(env, false);
  unsigned char public_key[32] = {};
  unsigned char secret_key[64] = {};
  const int result = crypto_sign_seed_keypair(public_key, secret_key, seed);
  WipeBytes(seed, sizeof(seed));
  if (result != 0) {
    WipeBytes(secret_key, sizeof(secret_key));
    return Napi::Boolean::New(env, false);
  }
  {
    std::lock_guard<std::mutex> lock(g_key_mutex);
    std::memcpy(g_key_material.secret_key, secret_key, sizeof(secret_key));
    std::memcpy(g_key_material.public_key, public_key, sizeof(public_key));
    g_key_material.ok = true;
  }
  WipeBytes(secret_key, sizeof(secret_key));
  return Napi::Boolean::New(env, true);
}

std::string ToHex(const unsigned char* bytes, size_t length) {
  static const char kHex[] = "0123456789abcdef";
  std::string out;
  out.reserve(length * 2);
  for (size_t i = 0; i < length; ++i) {
    out.push_back(kHex[bytes[i] >> 4]);
    out.push_back(kHex[bytes[i] & 0x0F]);
  }
  return out;
}

std::string ToLowerHex(const std::string& value) {
  std::string out = value;
  for (char& c : out) {
    if (c >= 'A' && c <= 'F') c = static_cast<char>(c - 'A' + 'a');
  }
  return out;
}

std::string Base64Encode(const unsigned char* data, size_t length) {
  static const char kTable[] =
      "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
  std::string out;
  out.reserve(((length + 2) / 3) * 4);
  size_t i = 0;
  for (; i + 2 < length; i += 3) {
    const uint32_t chunk = (static_cast<uint32_t>(data[i]) << 16) |
                           (static_cast<uint32_t>(data[i + 1]) << 8) |
                           static_cast<uint32_t>(data[i + 2]);
    out.push_back(kTable[(chunk >> 18) & 0x3F]);
    out.push_back(kTable[(chunk >> 12) & 0x3F]);
    out.push_back(kTable[(chunk >> 6) & 0x3F]);
    out.push_back(kTable[chunk & 0x3F]);
  }
  if (i < length) {
    uint32_t chunk = static_cast<uint32_t>(data[i]) << 16;
    const bool hasSecond = (i + 1 < length);
    if (hasSecond) chunk |= static_cast<uint32_t>(data[i + 1]) << 8;
    out.push_back(kTable[(chunk >> 18) & 0x3F]);
    out.push_back(kTable[(chunk >> 12) & 0x3F]);
    out.push_back(hasSecond ? kTable[(chunk >> 6) & 0x3F] : '=');
    out.push_back('=');
  }
  return out;
}

bool HashFile(const fs::path& file, std::string& hex) {
  std::ifstream stream(file, std::ios::binary);
  if (!stream.is_open()) return false;
  zt_sha256_ctx ctx;
  zt_sha256_init(&ctx);
  char buffer[64 * 1024];
  while (stream) {
    stream.read(buffer, static_cast<std::streamsize>(sizeof(buffer)));
    const std::streamsize count = stream.gcount();
    if (count > 0) {
      zt_sha256_update(&ctx, reinterpret_cast<const uint8_t*>(buffer),
                       static_cast<size_t>(count));
    }
  }
  if (stream.bad()) return false;
  unsigned char digest[32];
  zt_sha256_final(&ctx, digest);
  hex = ToHex(digest, sizeof(digest));
  return true;
}

bool HashRange(const fs::path& file, uint64_t offset, uint64_t length, std::string& hex) {
  std::ifstream stream(file, std::ios::binary);
  if (!stream.is_open()) return false;
  stream.seekg(static_cast<std::streamoff>(offset), std::ios::beg);
  if (!stream) return false;
  zt_sha256_ctx ctx;
  zt_sha256_init(&ctx);
  char buffer[64 * 1024];
  uint64_t remaining = length;
  while (remaining > 0) {
    const std::streamsize want = static_cast<std::streamsize>(
        remaining < sizeof(buffer) ? remaining : sizeof(buffer));
    stream.read(buffer, want);
    const std::streamsize count = stream.gcount();
    if (count <= 0) return false;
    zt_sha256_update(&ctx, reinterpret_cast<const uint8_t*>(buffer),
                     static_cast<size_t>(count));
    remaining -= static_cast<uint64_t>(count);
  }
  unsigned char digest[32];
  zt_sha256_final(&ctx, digest);
  hex = ToHex(digest, sizeof(digest));
  return true;
}

/* ---------- module/root discovery (never trusts JS for the path) ---------- */

fs::path ResolveModulePath() {
#if defined(_WIN32)
  HMODULE module = nullptr;
  if (!GetModuleHandleExW(GET_MODULE_HANDLE_EX_FLAG_FROM_ADDRESS |
                              GET_MODULE_HANDLE_EX_FLAG_UNCHANGED_REFCOUNT,
                          reinterpret_cast<LPCWSTR>(reinterpret_cast<void*>(&ResolveModulePath)),
                          &module)) {
    return fs::path();
  }
  std::wstring buffer(MAX_PATH, L'\0');
  for (;;) {
    const DWORD length = GetModuleFileNameW(module, buffer.data(),
                                            static_cast<DWORD>(buffer.size()));
    if (length == 0) return fs::path();
    if (length < buffer.size()) {
      buffer.resize(length);
      break;
    }
    buffer.resize(buffer.size() * 2);
  }
  return fs::path(buffer);
#else
  Dl_info info = {};
  if (dladdr(reinterpret_cast<void*>(&ResolveModulePath), &info) == 0 ||
      info.dli_fname == nullptr) {
    return fs::path();
  }
  return fs::path(info.dli_fname);
#endif
}

bool ResolveResourcesRoot(fs::path& root) {
  const fs::path module = ResolveModulePath();
  if (module.empty()) return false;
  fs::path dir = module.parent_path();
  for (int depth = 0; depth < 10 && !dir.empty(); ++depth) {
    std::error_code ec;
    if (fs::is_regular_file(dir / "app.asar", ec)) {
      root = dir;
      return true;
    }
    // addon ปกติอยู่ที่ resources/native/os_guard.node
    if (dir.filename() == fs::path("native")) {
      const fs::path parent = dir.parent_path();
      if (!parent.empty()) {
        root = parent;
        return true;
      }
    }
    const fs::path next = dir.parent_path();
    if (next == dir) break;
    dir = next;
  }
  return false;
}

bool ResolveTargetPath(const fs::path& root, const std::string& relative, fs::path& target) {
  if (relative.empty() || relative.size() > 300) return false;
  const fs::path relativePath = fs::u8path(relative);
  if (relativePath.is_absolute() || relativePath.has_root_name() ||
      relativePath.has_root_directory()) {
    return false;
  }
  for (const auto& part : relativePath) {
    if (part == fs::path("..")) return false;
  }
  const fs::path candidate = root / relativePath;
  std::error_code ec;
  const fs::path canonicalRoot = fs::weakly_canonical(root, ec);
  if (ec) return false;
  const fs::path canonicalTarget = fs::weakly_canonical(candidate, ec);
  if (ec) return false;
  const std::string rootText = canonicalRoot.generic_string();
  const std::string targetText = canonicalTarget.generic_string();
  if (targetText.size() <= rootText.size()) return false;
  if (targetText.compare(0, rootText.size(), rootText) != 0) return false;
  if (targetText[rootText.size()] != '/') return false;
  target = canonicalTarget;
  return true;
}

/**
 * canonical targets — ต้องตรงกับ TS (canonicalizeNativeTargets) ทุกไบต์:
 * เรียงตาม relativePath, sha256 ตัวพิมพ์เล็ก, "path:sha256" คั่นด้วย ','
 */
std::string CanonicalTargets(const std::vector<TargetFile>& targets) {
  std::vector<std::pair<std::string, std::string>> normalized;
  normalized.reserve(targets.size());
  for (const auto& target : targets) {
    normalized.emplace_back(target.relative_path, ToLowerHex(target.sha256));
  }
  std::sort(normalized.begin(), normalized.end(),
            [](const auto& a, const auto& b) { return a.first < b.first; });
  std::string out;
  for (size_t i = 0; i < normalized.size(); ++i) {
    if (i > 0) out += ',';
    out += normalized[i].first;
    out += ':';
    out += normalized[i].second;
  }
  return out;
}

std::string BuildPayload(const std::string& challengeId, const std::string& serverNonce,
                         const std::string& manifestHash,
                         const std::vector<std::string>& sampleDigests,
                         const std::string& canonicalTargets) {
  std::string payload = challengeId;
  payload += '|';
  payload += serverNonce;
  payload += '|';
  payload += manifestHash;
  payload += '|';
  for (size_t i = 0; i < sampleDigests.size(); ++i) {
    if (i > 0) payload += ',';
    payload += sampleDigests[i];
  }
  payload += '|';
  payload += canonicalTargets;
  return payload;
}

Napi::Value AttestationSign(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  if (info.Length() < 1 || !info[0].IsString()) return env.Null();

  const std::string requestJson = info[0].As<Napi::String>().Utf8Value();
  JsonValue request;
  JsonParser parser(requestJson);
  if (!parser.Parse(request) || request.type != JsonValue::Object) return env.Null();

  std::string challengeId;
  std::string serverNonce;
  std::string manifestHash;
  std::vector<SampleRange> sampleRanges;
  std::vector<TargetFile> targets;
  if (!GetStringField(request, "challengeId", challengeId)) return env.Null();
  if (!GetStringField(request, "serverNonce", serverNonce)) return env.Null();
  if (!GetStringField(request, "manifestHash", manifestHash)) return env.Null();
  if (!GetSampleRanges(request, sampleRanges)) return env.Null();
  if (!GetTargets(request, targets)) return env.Null();
  if (targets.empty()) return env.Null();

  fs::path root;
  if (!ResolveResourcesRoot(root)) return env.Null();

  // 1) ตรวจทุก target ทั้งไฟล์ (asar + addons) — JS กำหนดรายการที่ตรวจไม่ได้
  for (const auto& target : targets) {
    fs::path path;
    if (!ResolveTargetPath(root, target.relative_path, path)) return env.Null();
    std::string actualHash;
    if (!HashFile(path, actualHash)) return env.Null();
    if (actualHash != ToLowerHex(target.sha256)) return env.Null();
  }

  // 2) native อ่าน+hash ช่วงที่ host สุ่มถามเอง — ไม่ใช้ sampleDigests ที่ JS ส่งมา
  std::vector<std::string> sampleDigests;
  sampleDigests.reserve(sampleRanges.size());
  for (const auto& range : sampleRanges) {
    fs::path path;
    if (!ResolveTargetPath(root, range.relative_path, path)) return env.Null();
    std::string digest;
    if (!HashRange(path, range.offset, range.length, digest)) return env.Null();
    sampleDigests.push_back(std::move(digest));
  }

  KeyMaterial key;
  if (!GetKeySnapshot(key)) return env.Null();

  const std::string payload = BuildPayload(challengeId, serverNonce, manifestHash, sampleDigests,
                                           CanonicalTargets(targets));
  std::vector<unsigned char> signedMessage(payload.size() + 64);
  unsigned long long signedLength = 0;
  if (crypto_sign(signedMessage.data(), &signedLength,
                  reinterpret_cast<const unsigned char*>(payload.data()), payload.size(),
                  key.secret_key) != 0 ||
      signedLength != payload.size() + 64) {
    return env.Null();
  }
  return Napi::String::New(env, Base64Encode(signedMessage.data(), 64));
}

Napi::Value AttestationPublicKey(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  KeyMaterial key;
  if (!GetKeySnapshot(key)) return Napi::String::New(env, "");
  return Napi::String::New(env, ToHex(key.public_key, sizeof(key.public_key)));
}

}  // namespace

void RegisterAttestationFunctions(Napi::Env env, Napi::Object exports) {
  exports.Set("attestationSetDeviceSeed", Napi::Function::New(env, AttestationSetDeviceSeed));
  exports.Set("attestationSign", Napi::Function::New(env, AttestationSign));
  exports.Set("attestationPublicKey", Napi::Function::New(env, AttestationPublicKey));
}
