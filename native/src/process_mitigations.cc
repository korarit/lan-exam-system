// native/src/process_mitigations.cc — Windows process mitigation policies
// เป้าหมาย: "กัน" injection ระดับ OS ก่อนการตรวจจับ (VULN-01/05/16)
// - Extension point disable: ตัด AppInit_DLLs / legacy injection points
// - Image load: ห้ามโหลด image จาก network และจาก low-integrity path
// - Control Flow Guard: กันการกระโดดไปโค้ดที่ไม่อยู่ใน CFG (ถ้าไบนารีรองรับ)
// หมายเหตุ: ไม่เปิด Dynamic Code Policy เพราะ V8 JIT ต้องใช้ executable memory
#include "napi.h"

#include <string>
#include <vector>

#if defined(_WIN32)
#define WIN32_LEAN_AND_MEAN
#include <windows.h>

namespace {

std::string JsonEscape(const std::string& value) {
  std::string out;
  out.reserve(value.size() + 8);
  for (const char c : value) {
    switch (c) {
      case '"': out += "\\\""; break;
      case '\\': out += "\\\\"; break;
      case '\n': out += "\\n"; break;
      case '\r': out += "\\r"; break;
      case '\t': out += "\\t"; break;
      default:
        if (static_cast<unsigned char>(c) < 0x20) {
          out += '?';
        } else {
          out += c;
        }
    }
  }
  return out;
}

std::string BuildJson(bool ok, const std::vector<std::string>& applied,
                      const std::vector<std::string>& failed,
                      const std::vector<std::string>& skipped) {
  std::string json = "{\"ok\":";
  json += ok ? "true" : "false";
  json += ",\"applied\":[";
  for (size_t i = 0; i < applied.size(); ++i) {
    if (i > 0) json += ',';
    json += '"' + JsonEscape(applied[i]) + '"';
  }
  json += "],\"failed\":[";
  for (size_t i = 0; i < failed.size(); ++i) {
    if (i > 0) json += ',';
    json += '"' + JsonEscape(failed[i]) + '"';
  }
  json += "],\"skipped\":[";
  for (size_t i = 0; i < skipped.size(); ++i) {
    if (i > 0) json += ',';
    json += '"' + JsonEscape(skipped[i]) + '"';
  }
  json += "],\"platform\":\"win32\"}";
  return json;
}

template <typename Policy>
bool Apply(PROCESS_MITIGATION_POLICY kind, const Policy& policy) {
  return ::SetProcessMitigationPolicy(kind, const_cast<Policy*>(&policy), sizeof(Policy)) != FALSE;
}

}  // namespace
#endif

Napi::Value ApplyProcessMitigations(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
#if defined(_WIN32)
  std::vector<std::string> applied;
  std::vector<std::string> failed;
  std::vector<std::string> skipped;

  PROCESS_MITIGATION_EXTENSION_POINT_DISABLE_POLICY extensionPolicy = {};
  extensionPolicy.DisableExtensionPoints = 1;
  if (Apply(ProcessExtensionPointDisablePolicy, extensionPolicy)) {
    applied.push_back("extension-point-disable");
  } else {
    failed.push_back("extension-point-disable");
  }

  PROCESS_MITIGATION_IMAGE_LOAD_POLICY imagePolicy = {};
  imagePolicy.NoRemoteImages = 1;
  imagePolicy.NoLowMandatoryLabelImages = 1;
  if (Apply(ProcessImageLoadPolicy, imagePolicy)) {
    applied.push_back("image-load-policy");
  } else {
    failed.push_back("image-load-policy");
  }

  PROCESS_MITIGATION_CONTROL_FLOW_GUARD_POLICY cfgPolicy = {};
  cfgPolicy.EnableControlFlowGuard = 1;
  if (Apply(ProcessControlFlowGuardPolicy, cfgPolicy)) {
    applied.push_back("control-flow-guard");
  } else {
    // ไบนารีอาจไม่ได้ compile ด้วย CFG — ไม่ถือว่าแอปพัง
    skipped.push_back("control-flow-guard");
  }

  return Napi::String::New(env, BuildJson(failed.empty(), applied, failed, skipped));
#else
#if defined(__APPLE__)
  const char* platform = "darwin";
#elif defined(__linux__)
  const char* platform = "linux";
#else
  const char* platform = "unknown";
#endif
  std::string json = "{\"ok\":true,\"applied\":[],\"failed\":[],\"skipped\":[],\"platform\":\"";
  json += platform;
  json += "\"}";
  return Napi::String::New(env, json);
#endif
}

void RegisterProcessMitigationFunctions(Napi::Env env, Napi::Object exports) {
  exports.Set("applyProcessMitigations", Napi::Function::New(env, ApplyProcessMitigations));
}
