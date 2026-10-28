{
  "targets": [
    {
      "target_name": "os_guard",
      "sources": ["src/os_guard.cc", "src/low_level_keyboard_hook.cc"],
      "include_dirs": ["<!(node -p \"require('node-addon-api').include_dir\")"],
      "defines": ["NAPI_DISABLE_CPP_EXCEPTIONS"],
      "conditions": [
        [
          'OS=="win"',
          {
            "libraries": ["user32.lib"],
            "msvs_settings": {
              "VCCLCompilerTool": {
                "AdditionalOptions": ["/std:c++17"]
              }
            }
          }
        ]
      ]
    }
  ]
}
