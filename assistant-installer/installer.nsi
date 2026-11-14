; Supermarket POS Assistant: the separate, optional installer for the local assistant add-on.
;
; It only lays down files under Program Files (an admin-owned location the POS app trusts) and registers an
; uninstaller. It never starts anything: the POS app starts llama-server itself, after it has verified manifest.json
; (signed) and every file's SHA-256. Built by scripts/assistant-build-installer.mjs, which passes:
;   /DSTAGE_DIR=<dir holding manifest.json, manifest.json.sig, runtime\, models\>
;   /DOUT_FILE=<installer exe to write>
;   /DVERSION=<x.y.z>
; Silent install: <installer>.exe /S. This script is compiled on the dev PC but only ever RUN in Windows Sandbox.

Unicode true
!include "LogicLib.nsh"

!ifndef STAGE_DIR
  !error "pass /DSTAGE_DIR=<stage dir>"
!endif
!ifndef OUT_FILE
  !error "pass /DOUT_FILE=<installer exe>"
!endif
!ifndef VERSION
  !define VERSION "0.0.0"
!endif

!define PRODUCT "Supermarket POS Assistant"
!define UNINST_KEY "Software\Microsoft\Windows\CurrentVersion\Uninstall\SupermarketPOSAssistant"

; llama-server.exe needs the Visual C++ 2015-2022 x64 runtime. The POS installer pack installs it; this add-on does not carry it.
!define VCRT_KEY "SOFTWARE\Microsoft\VisualStudio\14.0\VC\Runtimes\x64"
!define VCRT_EXIT_CODE 3
!define VCRT_MESSAGE "Install the Supermarket POS first. The assistant needs the Visual C++ runtime that the POS installer provides.$\r$\n$\r$\nInstale primero Supermarket POS. El asistente necesita el runtime de Visual C++ que instala el instalador del POS."

Name "${PRODUCT}"
OutFile "${OUT_FILE}"
RequestExecutionLevel admin
InstallDir "$PROGRAMFILES64\${PRODUCT}"
SetCompressor /SOLID lzma
ShowInstDetails nevershow
ShowUninstDetails nevershow

; Runs before any section, so a machine without the runtime gets nothing written: exit code ${VCRT_EXIT_CODE}, a message
; (shown only when not silent), no files, no registry key, no uninstaller.
Function .onInit
  SetRegView 64
  ReadRegDWORD $0 HKLM "${VCRT_KEY}" "Installed"
  ${If} $0 != 1
    SetRegView 32
    ReadRegDWORD $0 HKLM "${VCRT_KEY}" "Installed"
    SetRegView 64
  ${EndIf}
  ${If} $0 != 1
    MessageBox MB_OK|MB_ICONSTOP "${VCRT_MESSAGE}" /SD IDOK
    SetErrorLevel ${VCRT_EXIT_CODE}
    Abort
  ${EndIf}
FunctionEnd

; The uninstaller removes the whole install dir, so refuse any /D= or typed path that is not our own folder name.
Function .onVerifyInstDir
  StrLen $0 "${PRODUCT}"
  StrCpy $1 "$INSTDIR" "" -$0
  StrCmp $1 "${PRODUCT}" +2
    Abort
FunctionEnd

Section "Install"
  SetRegView 64
  SetOutPath "$INSTDIR"
  ; An upgrade must leave exactly the files the new manifest lists: no leftovers from an older runtime or model.
  RMDir /r "$INSTDIR\runtime"
  RMDir /r "$INSTDIR\models"
  Delete "$INSTDIR\manifest.json"
  Delete "$INSTDIR\manifest.json.sig"
  File /r "${STAGE_DIR}\*.*"
  WriteUninstaller "$INSTDIR\uninstall.exe"
  WriteRegStr HKLM "${UNINST_KEY}" "DisplayName" "${PRODUCT}"
  WriteRegStr HKLM "${UNINST_KEY}" "DisplayVersion" "${VERSION}"
  WriteRegStr HKLM "${UNINST_KEY}" "InstallLocation" "$INSTDIR"
  WriteRegStr HKLM "${UNINST_KEY}" "UninstallString" '"$INSTDIR\uninstall.exe"'
  WriteRegStr HKLM "${UNINST_KEY}" "QuietUninstallString" '"$INSTDIR\uninstall.exe" /S'
  WriteRegDWORD HKLM "${UNINST_KEY}" "NoModify" 1
  WriteRegDWORD HKLM "${UNINST_KEY}" "NoRepair" 1
SectionEnd

Section "Uninstall"
  SetRegView 64
  ; Never stops or kills anything by name: a running POS holds the child in its own Job Object and the files
  ; simply fail to delete until the POS is closed; the assistant is then reported unavailable on the next start.
  RMDir /r "$INSTDIR"
  DeleteRegKey HKLM "${UNINST_KEY}"
SectionEnd
