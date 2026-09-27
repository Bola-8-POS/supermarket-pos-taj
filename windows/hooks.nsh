; windows/hooks.nsh — Tauri v2 NSIS installer hooks for the store print
; broker.
;
; Tauri v2 does NOT support !include for a second local .nsh file — the full
; macro body must live in this one file. Macros are inlined into the
; bundler's template sections rather than compiled as standalone functions,
; so every register a macro touches is Push'd on entry and Pop'd on exit —
; leaving one dirty would corrupt whatever the template does immediately
; after the hook returns.
!include "LogicLib.nsh"

; BrokerStep runs one ExecWait, tolerates a documented "benign" exit code in
; either of two slots (repeat the first when only one applies) alongside 0,
; and never fails the install: a store that cannot reach the print broker
; today can still ring up sales, so refusing to finish the install over one
; netsh/certutil/sc hiccup would be worse than a printer that needs a manual
; repair afterward. Exit codes are compared as strings (S==) because
; certutil's not-found code is a negative HRESULT and an unset/empty
; comparison value would read as 0 under a numeric compare. The warning
; dialog is skipped in passive or silent mode (the updater installs in
; passive mode, where a modal box would hold the update open indefinitely)
; — DetailPrint always records the failure in the install log either way.
!macro BrokerStep cmd label benign1 benign2
  Push $0
  ClearErrors
  ExecWait '${cmd}' $0
  ${If} ${Errors}
    DetailPrint "${label} failed (the process could not start)"
    ${If} $PassiveMode != 1
    ${AndIfNot} ${Silent}
      MessageBox MB_OK|MB_ICONEXCLAMATION "${label} failed (the process could not start). Printing may not work until it is repaired."
    ${EndIf}
  ${ElseIfNot} $0 S== "0"
  ${AndIfNot} $0 S== "${benign1}"
  ${AndIfNot} $0 S== "${benign2}"
    DetailPrint "${label} failed (code $0)"
    ${If} $PassiveMode != 1
    ${AndIfNot} ${Silent}
      MessageBox MB_OK|MB_ICONEXCLAMATION "${label} failed (code $0). Printing may not work until it is repaired."
    ${EndIf}
  ${EndIf}
  Pop $0
!macroend

; WaitBrokerStopped runs after every `sc.exe stop PrintBrokerService`:
; sc.exe stop returns as soon as the stop request is accepted, while the
; service can still be reported STOP_PENDING for a moment afterward. The
; install section's File copy of broker.exe follows immediately after
; PREINSTALL, so without this wait an upgrade can hit a locked file (a modal
; NSIS error even in passive mode). Bounded at 20 iterations of 500ms (10s
; total) — a service that never reaches STOPPED gets a logged warning, not a
; hang. A `sc query` that itself reports 1060 (service not installed) exits
; the wait immediately: a fresh install has nothing to wait for.
;
; `nsExec::ExecToStack` pushes two values (the output text, then the exit
; code on top), not one — every call here is followed by two Pops: the first
; into $0 (the exit code, checked below) and the second into $2 (the output
; text, deliberately discarded; $2 is saved/restored around the whole macro
; like every other register it touches, so this never disturbs a caller's
; own $2, e.g. ReadCertSubject's return value). The loop itself uses
; LogicLib's `${Do}`/`${ExitDo}`/`${Loop}` rather than named labels, because
; this macro is `!insertmacro`d twice (PREINSTALL and PREUNINSTALL) — fixed
; labels inlined into the same compiled script twice would be a duplicate-
; label error; LogicLib's constructs generate a fresh unique label pair on
; every expansion.
!macro WaitBrokerStopped
  Push $0
  Push $1
  Push $2
  StrCpy $1 0
  nsExec::ExecToStack 'cmd /c sc query PrintBrokerService'
  Pop $0
  Pop $2
  ${IfNot} $0 S== "1060"
    ; The service exists, so it may still be the previous release's binary,
    ; whose request loop (broker/src/http.rs) only checks its shutdown flag
    ; when a request arrives. The app has already exited by PREINSTALL, so
    ; nothing would ever arrive on its own; send one loopback request here to
    ; wake that loop so it sees the flag and returns. `nsExec::Exec` pushes
    ; one value (unlike `ExecToStack`'s two), so one Pop balances it. A 401
    ; is fine: the old loop checks shutdown before authenticating the
    ; request. Never `taskkill` here: the service would die without
    ; reporting STOPPED, and the SCM's restart policy would relaunch the old
    ; binary while the File copy below is replacing it.
    nsExec::Exec 'cmd /c curl.exe -s -m 2 -o NUL http://127.0.0.1:8973/health'
    Pop $2
    ${Do}
      nsExec::ExecToStack 'cmd /c sc query PrintBrokerService | findstr /C:"STOPPED"'
      Pop $0
      Pop $2
      ${If} $0 S== "0"
        ${ExitDo}
      ${EndIf}
      IntOp $1 $1 + 1
      ${If} $1 >= 20
        DetailPrint "Store Print Broker did not report STOPPED after 10s; continuing anyway."
        ${ExitDo}
      ${EndIf}
      Sleep 500
    ${Loop}
  ${EndIf}
  Pop $2
  Pop $1
  Pop $0
!macroend

; Reads the code-signing certificate's subject CN that scripts/generate-
; build-cert.ps1 writes at build time to $INSTDIR\cert\subject.txt — a
; one-line, no-trailing-newline ASCII resource (see that script's own doc
; comment on why ASCII with no BOM). Leaves the value in $2 for the caller;
; $2 is empty when the file is missing, so the caller skips its delstore
; step and logs why. The file is not expected to carry a trailing CR/LF, but
; the trim is conditional rather than an unconditional last-character strip
; — an unconditional strip would eat the CN's real last character on a file
; that never had a newline to begin with.
!macro ReadCertSubject
  Push $3
  Push $4
  StrCpy $2 ""
  ${IfNot} ${FileExists} "$INSTDIR\cert\subject.txt"
    DetailPrint "$INSTDIR\cert\subject.txt not found; skipping root certificate cleanup."
  ${Else}
    FileOpen $3 "$INSTDIR\cert\subject.txt" r
    FileRead $3 $2
    FileClose $3
    StrCpy $4 $2 1 -1
    ${If} $4 == "$\n"
      StrCpy $2 $2 -1
    ${ElseIf} $4 == "$\r"
      StrCpy $2 $2 -1
    ${EndIf}
  ${EndIf}
  Pop $4
  Pop $3
!macroend

; PREINSTALL runs before files are copied. On an upgrade, PrintBrokerService
; is normally still running (AutoStart) and holds a lock on broker.exe, so
; the section's File copy of the upgraded binary needs the service stopped
; and actually STOPPED (not merely STOP_PENDING) first. 1060/1062 (service
; not installed / not started) are benign — both are the normal state on a
; fresh install.
!macro NSIS_HOOK_PREINSTALL
  !insertmacro BrokerStep 'sc.exe stop PrintBrokerService' "Stopping the previous print broker service" "1060" "1062"
  !insertmacro WaitBrokerStopped
!macroend

!macro NSIS_HOOK_POSTINSTALL
  Push $1
  Push $2
  ; ProgramData is not a fixed constant here — read it, with the documented
  ; fallback for the rare case it is unset. $1 is used for nothing else in
  ; this macro; the subject-file read below uses $3 (see ReadCertSubject).
  ReadEnvStr $1 PROGRAMDATA
  ${If} $1 == ""
    StrCpy $1 "C:\ProgramData"
  ${EndIf}

  !insertmacro BrokerStep '"$INSTDIR\broker\broker.exe" install' "Registering the print broker service" "0" "0"

  ; Data-folder ACL: SYSTEM and Administrators full control, the service's
  ; own virtual account modify (it writes the ledger and rotates the secret
  ; file), interactive Users read-only (the desktop app runs as a standard
  ; user and reads client-secret.txt to authenticate to the broker, but must
  ; not be able to replace or corrupt the config or the secret).
  !insertmacro BrokerStep 'icacls "$1\PrintBroker" /setowner *S-1-5-32-544 /T /C' "Setting the print broker data folder owner" "0" "0"
  !insertmacro BrokerStep 'icacls "$1\PrintBroker" /inheritance:r /grant:r "*S-1-5-18:(OI)(CI)F" /grant:r "*S-1-5-32-544:(OI)(CI)F" /grant:r "NT SERVICE\PrintBrokerService:(OI)(CI)M" /grant:r "*S-1-5-32-545:(OI)(CI)RX" /T /C' "Setting the print broker data folder permissions" "0" "0"

  ; Delete-then-add so an upgrade never accumulates a second identically
  ; named rule (netsh's `add` is not idempotent by name). "1": no matching
  ; rule to delete, the normal case on a fresh install.
  !insertmacro BrokerStep 'netsh advfirewall firewall delete rule name="Store Print Broker"' "Removing a previous print broker firewall rule" "1" "1"
  !insertmacro BrokerStep 'netsh advfirewall firewall add rule name="Store Print Broker" dir=in action=allow program="$INSTDIR\broker\broker.exe" protocol=TCP localport=8973 profile=private remoteip=LocalSubnet' "Adding the print broker firewall rule" "0" "0"

  !insertmacro BrokerStep 'sc.exe start PrintBrokerService' "Starting the print broker service" "1056" "1056"

  ; Root store cleanup runs BEFORE the fresh -addstore so an upgrade never
  ; accumulates a second root certificate for this build's subject, and a
  ; customer's first post-this-wave build also removes the one fixed legacy
  ; subject every earlier build shipped, whatever this customer's own
  ; subject is now.
  !insertmacro ReadCertSubject
  ${If} $2 != ""
    !insertmacro BrokerStep 'certutil -delstore Root "$2"' "Removing the previous print broker root certificate" "0" "0"
    ${If} $2 != "Taj House of Spice Supermarket POS"
      !insertmacro BrokerStep 'certutil -delstore Root "Taj House of Spice Supermarket POS"' "Removing the legacy print broker root certificate" "0" "0"
    ${EndIf}
  ${EndIf}
  !insertmacro BrokerStep 'certutil -f -addstore Root "$INSTDIR\cert\selfsigned.cer"' "Adding the print broker root certificate" "0" "0"

  Pop $2
  Pop $1
!macroend

; $UpdateMode is set to 1 by the bundler's own template on the updater path
; only — a manual reinstall (uninstall-first) runs the old uninstaller with
; $UpdateMode unset, and that path must still clean up. Skipping this whole
; block on the updater path matters: deleting a still-stopping service here
; would leave it marked for deletion, and the following install's
; `broker.exe install` would then fail with 1072.
!macro NSIS_HOOK_PREUNINSTALL
  ${If} $UpdateMode != 1
    Push $2
    !insertmacro BrokerStep 'sc.exe stop PrintBrokerService' "Stopping the print broker service" "1060" "1062"
    !insertmacro WaitBrokerStopped
    !insertmacro BrokerStep '"$INSTDIR\broker\broker.exe" uninstall' "Removing the print broker service registration" "0" "0"
    !insertmacro BrokerStep 'netsh advfirewall firewall delete rule name="Store Print Broker"' "Removing the print broker firewall rule" "1" "1"
    !insertmacro ReadCertSubject
    ${If} $2 != ""
      !insertmacro BrokerStep 'certutil -delstore Root "$2"' "Removing the print broker root certificate" "0" "0"
    ${EndIf}
    Pop $2
  ${EndIf}
!macroend

; The print broker's data folder (%ProgramData%\PrintBroker\ — the ledger
; and the per-store secret) is deliberately kept on uninstall, as
; broker/install/mod.rs::uninstall() itself documents, so a reinstall does
; not silently mint a new secret and break every already-configured LAN
; client's credential.
!macro NSIS_HOOK_POSTUNINSTALL
  DetailPrint "Print broker data folder kept (ledger and secret survive uninstall)."
!macroend
