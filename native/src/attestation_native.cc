// native/src/attestation_native.cc — Native attestation signer (N-API)
//
// ทำหน้าที่เดียว: ตรวจ sha256 ของไฟล์ที่กำลังรันอยู่ (app.asar) ด้วยโค้ด native
// แล้วเซ็น canonical payload ด้วย Ed25519 seed ที่ฝังมาใน build
// - JS เรียกได้แค่ attestationSign(requestJson) — อ่านไฟล์เองไม่ได้
// - ถ้าไฟล์หาย/อ่านไม่ได้/hash ไม่ตรง → คืน null (ไม่เซ็น)
// - root ของ resources มาจากตำแหน่ง .node ที่โหลดอยู่จริง ไม่ได้มาจาก JS
#include "napi.h"

#include <cstdint>
#include <cstdlib>
#include <cstring>
#include <fstream>
#include <map>
#include <string>
#include <vector>

#include "vendor/sha256.h"
#include "vendor/tweetnacl_ed25519.h"

#if defined(__has_include)
#if __has_include("generated/native_attestation_key.h")
#include "generated/native_attestation_key.h"
#define ZTEXAM_HAS_NATIVE_ATTESTATION_KEY 1
#endif
#endif
#if !defined(ZTEXAM_HAS_NATIVE_ATTESTATION_KEY)
#pragma message("native attestation key header missing — run `npm run keys:native` or `npm run build:native`")
#endif

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

bool GetStringArrayField(const JsonValue& root, const char* key, std::vector<std::string>& out) {
  const auto it = root.object.find(key);
  if (it == root.object.end() || it->second.type != JsonValue::Array) return false;
  out.clear();
  for (const auto& item : it->second.array) {
    if (item.type != JsonValue::String) return false;
    out.push_back(item.string);
  }
  return true;
}

/* ---------- crypto helpers ---------- */

struct KeyMaterial {
  bool ok = false;
  unsigned char secret_key[64] = {};
  unsigned char public_key[32] = {};
};

const KeyMaterial& GetKeyMaterial() {
#if defined(ZTEXAM_HAS_NATIVE_ATTESTATION_KEY)
  static const KeyMaterial material = [] {
    KeyMaterial result;
    if (crypto_sign_seed_keypair(result.public_key, result.secret_key,
                                 zt_exam_native_attestation::kSigningSeed) == 0) {
      result.ok = true;
    }
    return result;
  }();
  return material;
#else
  static const KeyMaterial material;
  return material;
#endif
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

std::string BuildPayload(const std::string& challengeId, const std::string& serverNonce,
                         const std::string& manifestHash,
                         const std::vector<std::string>& sampleDigests,
                         const std::string& expectedAsarSha256) {
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
  payload += expectedAsarSha256;
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
  std::string expectedAsarSha256;
  std::vector<std::string> sampleDigests;
  if (!GetStringField(request, "challengeId", challengeId)) return env.Null();
  if (!GetStringField(request, "serverNonce", serverNonce)) return env.Null();
  if (!GetStringField(request, "manifestHash", manifestHash)) return env.Null();
  if (!GetStringArrayField(request, "sampleDigests", sampleDigests)) return env.Null();
  if (!GetStringField(request, "expectedAsarSha256", expectedAsarSha256)) return env.Null();

  std::string targetRelativePath = "app.asar";
  const auto targetIt = request.object.find("targetRelativePath");
  if (targetIt != request.object.end()) {
    if (targetIt->second.type != JsonValue::String) return env.Null();
    if (!targetIt->second.string.empty()) targetRelativePath = targetIt->second.string;
  }

  fs::path root;
  if (!ResolveResourcesRoot(root)) return env.Null();
  fs::path target;
  if (!ResolveTargetPath(root, targetRelativePath, target)) return env.Null();

  std::string actualHash;
  if (!HashFile(target, actualHash)) return env.Null();
  if (actualHash != ToLowerHex(expectedAsarSha256)) return env.Null();

  const KeyMaterial& key = GetKeyMaterial();
  if (!key.ok) return env.Null();

  const std::string payload =
      BuildPayload(challengeId, serverNonce, manifestHash, sampleDigests, expectedAsarSha256);
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
  const KeyMaterial& key = GetKeyMaterial();
  if (!key.ok) return Napi::String::New(env, "");
  return Napi::String::New(env, ToHex(key.public_key, sizeof(key.public_key)));
}

}  // namespace

void RegisterAttestationFunctions(Napi::Env env, Napi::Object exports) {
  exports.Set("attestationSign", Napi::Function::New(env, AttestationSign));
  exports.Set("attestationPublicKey", Napi::Function::New(env, AttestationPublicKey));
}
