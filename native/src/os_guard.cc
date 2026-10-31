// native/src/os_guard.cc — ZT-Exam Native OS Guard (N-API addon)
// Interface ที่ preload ของ Main process (native-bridge.ts) เรียก:
//   start(onBlockedShortcut: (code: string) => void): boolean|null
//   stop(): void
//   isRunning(): boolean
// ทำงานจริงเฉพาะ Windows (WH_KEYBOARD_LL) — แพลตฟอร์มอื่น start() คืน false
// ให้ชั้น TypeScript เข้าสู่โหมด Detect & Report (FocusGuard) แทน
#include "napi.h"
#include <atomic>
#include <mutex>
#include <string>

std::atomic<bool>              g_hookRunning{ false };
std::mutex                     g_stateMutex;
std::string                    g_lastBlocked;
Napi::ThreadSafeFunction       g_eventTsfn;

#if defined(_WIN32)
bool os_guardInstallLowLevelHook();
bool os_guardUninstallLowLevelHook();
#endif

// native/src/attestation_native.cc — native file hash + Ed25519 signer
void RegisterAttestationFunctions(Napi::Env env, Napi::Object exports);

namespace {

Napi::Value Start(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  {
    std::lock_guard<std::mutex> lock(g_stateMutex);
    if (g_hookRunning.load()) return Napi::Boolean::New(env, true); // idempotent
  }
  if (info.Length() < 1 || !info[0].IsFunction()) {
    Napi::TypeError::New(env, "start(callback) ต้องได้รับ callback (code: string)").ThrowAsJavaScriptException();
    return env.Undefined();
  }
  Napi::Function jsCallback = info[0].As<Napi::Function>();
  Napi::ThreadSafeFunction tsfn =
      Napi::ThreadSafeFunction::New(env, jsCallback, "os_guard_event", 0, 1,
      [](Napi::Env finalizeEnv) {
        (void)finalizeEnv;
      });
  {
    std::lock_guard<std::mutex> lock(g_stateMutex);
    g_eventTsfn = std::move(tsfn);
  }

#if defined(_WIN32)
  const bool installed = os_guardInstallLowLevelHook();
  if (!installed) {
    std::lock_guard<std::mutex> lock(g_stateMutex);
    if (g_eventTsfn) {
      g_eventTsfn.Release();
      g_eventTsfn = Napi::ThreadSafeFunction();
    }
    return Napi::Boolean::New(env, false);
  }
  return Napi::Boolean::New(env, true);
#else
  // macOS / Linux: ไม่ติดตั้ง hook ระดับ OS — ให้ bridge ใช้ fallback (Detect & Report)
  std::lock_guard<std::mutex> lock(g_stateMutex);
  if (g_eventTsfn) {
    g_eventTsfn.Abort();
    g_eventTsfn = Napi::ThreadSafeFunction();
  }
  return Napi::Boolean::New(env, false);
#endif
}

Napi::Value Stop(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
#if defined(_WIN32)
  const bool unhooked = os_guardUninstallLowLevelHook();
#else
  const bool unhooked = true;
#endif
  {
    std::lock_guard<std::mutex> lock(g_stateMutex);
    if (g_eventTsfn) {
      g_eventTsfn.Release();
      g_eventTsfn = Napi::ThreadSafeFunction();
    }
  }
  return Napi::Boolean::New(env, unhooked);
}

Napi::Value IsRunning(const Napi::CallbackInfo& info) {
  return Napi::Boolean::New(info.Env(), g_hookRunning.load());
}

Napi::Value GetLastBlocked(const Napi::CallbackInfo& info) {
  std::lock_guard<std::mutex> lock(g_stateMutex);
  return Napi::String::New(info.Env(), g_lastBlocked);
}

Napi::Object Init(Napi::Env env, Napi::Object exports) {
  exports.Set("start", Napi::Function::New(env, Start));
  exports.Set("stop", Napi::Function::New(env, Stop));
  exports.Set("isRunning", Napi::Function::New(env, IsRunning));
  exports.Set("lastBlocked", Napi::Function::New(env, GetLastBlocked));
  RegisterAttestationFunctions(env, exports);
  return exports;
}

} // namespace

NODE_API_MODULE(os_guard, Init)
