; Compile-only harness for windows/hooks.nsh: defines the two variables Tauri's template provides, then expands
; every hook macro once. Nothing is executed; a syntax or register-balance error fails the compile.
Unicode true
!include "LogicLib.nsh"
Name "hooks-compile"
OutFile "hooks-compile.exe"
RequestExecutionLevel user
Var PassiveMode
Var UpdateMode
!include "${HOOKS_NSH}"
Section "t"
  !insertmacro NSIS_HOOK_PREINSTALL
  !insertmacro NSIS_HOOK_POSTINSTALL
  !insertmacro NSIS_HOOK_PREUNINSTALL
  !insertmacro NSIS_HOOK_POSTUNINSTALL
SectionEnd
