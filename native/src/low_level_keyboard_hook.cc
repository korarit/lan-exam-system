// native/src/low_level_keyboard_hook.cc — Windows Low-Level Keyboard Hook (WH_KEYBOARD_LL)
//
// ติดตั้ง hook บน thread เฉพาะที่มี message loop ของตัวเอง — ปุ่มที่ดักได้:
//   Win key (VK_LWIN/VK_RWIN), Alt+Tab, Alt+Esc, Ctrl+Esc, Alt+F4, PrintScreen
// เมื่อพบ: บล็อกไม่ให้ส่งต่อไปยัง OS (return 1) แล้วแจ้ง callback ผ่าน ThreadSafeFunction
#include "low_level_keyboard_hook.h"
#include "napi.h"

#include <windows.h>
#include <atomic>
#include <chrono>
#include <cstring>
#include <mutex>
#include <string>
#include <thread>

extern std::atomic<bool>        g_hookRunning;
extern std::mutex               g_stateMutex;
extern std::string              g_lastBlocked;
extern Napi::ThreadSafeFunction g_eventTsfn;

namespace {

HHOOK           g_hHook        = nullptr;
std::thread*    g_worker       = nullptr;
std::atomic<DWORD> g_threadId{ 0 };     // thread id ของ hook loop (ใช้โพสต์ WM_QUIT)

const char* ShortcutFromKey(WPARAM key, const KBDLLHOOKSTRUCT* p) {
  const bool altDown  = (p->flags & LLKHF_ALTDOWN) != 0;
  const bool ctrlDown = (::GetAsyncKeyState(VK_CONTROL) & 0x8000) != 0;

  switch (key) {
    case VK_LWIN:
    case VK_RWIN:
      return "win-key";
    case VK_TAB:
      if (altDown) return "alt-tab";
      break;
    case VK_ESCAPE:
      if (altDown) return "alt-esc";
      if (ctrlDown) return "ctrl-esc";
      break;
    case VK_F4:
      if (altDown) return "alt-f4";
      break;
    case VK_SNAPSHOT:
      return "printscreen";
    default:
      break;
  }
  return nullptr;
}

LRESULT CALLBACK LowLevelKeyboardProc(int nCode, WPARAM wParam, LPARAM lParam) {
  if (nCode >= 0 && (wParam == WM_KEYDOWN || wParam == WM_SYSKEYDOWN)) {
    const KBDLLHOOKSTRUCT* p = reinterpret_cast<KBDLLHOOKSTRUCT*>(lParam);
    // VULN-38/62: อินพุตที่ถูกฉีดด้วย SendInput/keybd_event (macro/automation)
    // รายงาน + บล็อกระหว่าง kiosk — ฮาร์ดแวร์จริงและ IME ไม่มี flag นี้
    if ((p->flags & LLKHF_INJECTED) != 0) {
      os_guardNotifyBlocked("synthetic-input");
      return 1;
    }
    const char* shortcut = ShortcutFromKey(wParam, p);
    if (shortcut != nullptr) {
      os_guardNotifyBlocked(shortcut);
      // return 1 = บล็อกปุ่ม (ไม่ส่งต่อให้ OS / แอปอื่น)
      return 1;
    }
  }
  return ::CallNextHookEx(nullptr, nCode, wParam, lParam);
}

void HookThreadMain() {
  g_threadId.store(::GetCurrentThreadId());
  g_hHook = ::SetWindowsHookExW(
      WH_KEYBOARD_LL, LowLevelKeyboardProc, ::GetModuleHandleW(nullptr), 0);
  g_hookRunning.store(g_hHook != nullptr);
  if (g_hHook == nullptr) return;

  MSG msg;
  // GetMessage คืน 0 เมื่อได้รับ WM_QUIT (จาก os_guardUninstallLowLevelHook)
  while (::GetMessageW(&msg, nullptr, 0, 0) > 0) {
    ::TranslateMessage(&msg);
    ::DispatchMessageW(&msg);
  }
  ::UnhookWindowsHookEx(g_hHook);
  g_hHook = nullptr;
}

} // namespace

bool os_guardInstallLowLevelHook() {
  if (g_hookRunning.load()) return true;
  g_threadId.store(0);
  g_worker = new std::thread(HookThreadMain);
  // รอ hook ถูกติดตั้ง (สูงสุด ~1 วินาที)
  for (int i = 0; i < 200 && g_threadId.load() == 0; ++i) {
    std::this_thread::sleep_for(std::chrono::milliseconds(5));
  }
  for (int i = 0; i < 100 && !g_hookRunning.load(); ++i) {
    std::this_thread::sleep_for(std::chrono::milliseconds(5));
  }
  return g_hookRunning.load();
}

bool os_guardUninstallLowLevelHook() {
  if (!g_hookRunning.load()) return true;
  const DWORD threadId = g_threadId.load();
  if (threadId != 0) {
    ::PostThreadMessageW(threadId, WM_QUIT, 0, 0);
  }
  if (g_worker != nullptr) {
    if (g_worker->joinable()) g_worker->join();
    delete g_worker;
    g_worker = nullptr;
  }
  g_threadId.store(0);
  g_hookRunning.store(false);
  return true;
}

void os_guardNotifyBlocked(const char* shortcutCode) {
  {
    std::lock_guard<std::mutex> lock(g_stateMutex);
    g_lastBlocked = shortcutCode;
  }
  auto callback = [](Napi::Env env, Napi::Function jsCallback, const char* code) {
    jsCallback.Call({ Napi::String::New(env, code) });
  };
  // NonBlockingCall เพื่อไม่ให้ hook thread ค้างรอโค้ด JavaScript — event ชั่วคราวแค่ช่วงเดียว
  std::lock_guard<std::mutex> lock(g_stateMutex);
  if (g_eventTsfn) {
    g_eventTsfn.NonBlockingCall(shortcutCode, callback);
  }
}
