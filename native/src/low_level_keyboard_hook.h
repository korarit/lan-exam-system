// native/src/low_level_keyboard_hook.h — interface ของ hook ฝั่ง Windows
#pragma once

// ตั้งค่า hook + thread ของตัวเอง (WH_KEYBOARD_LL)
// คืน true เมื่อ install สำเร็จ
bool os_guardInstallLowLevelHook();

// ปลด hook แล้วจบ thread (เรียกเสมอเมื่อจบสอบ / จบแอป)
bool os_guardUninstallLowLevelHook();

// ส่งสัญญาณ event ที่ HookProc ลบจากปุ่ม (ถูกเรียกบน hook thread)
void os_guardNotifyBlocked(const char* shortcutCode);
