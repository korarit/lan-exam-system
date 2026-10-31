{
  "targets": [
    {
      "target_name": "os_guard",
      "sources": [
        "src/os_guard.cc",
        "src/attestation_native.cc",
        "src/process_mitigations.cc",
        "src/vendor/tweetnacl_ed25519.c",
        "src/vendor/sha256.c"
      ],
      "include_dirs": [
        "src",
        "<!(node -p \"require('node-addon-api').include_dir\")"
      ],
      "defines": ["NAPI_DISABLE_CPP_EXCEPTIONS"],
      "conditions": [
        [
          'OS=="win"',
          {
            "sources": ["src/low_level_keyboard_hook.cc"],
            "libraries": ["user32.lib"],
            "msvs_settings": {
              "VCCLCompilerTool": {
                "AdditionalOptions": ["/std:c++17"]
              }
            }
          },
          {
            "cflags_cc": ["-std=c++17"]
          }
        ],
        [
          'OS=="linux"',
          {
            "libraries": ["-ldl"]
          }
        ]
      ]
    }
  ]
}
