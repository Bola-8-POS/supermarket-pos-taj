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

; `broker.exe install` once hung for 10+ minutes in a fresh Sandbox guest, behind
; a visible console window, while ExecWait waited forever. BrokerInstallStep runs
; it hidden through nsExec, bounded, with its output in $INSTDIR\logs\broker-install.log
; (the broker prints no secrets). Normal install takes seconds; 120 s is generous
; headroom from that evidence. nsExec's /TIMEOUT is the wait for OUTPUT (it resets
; whenever the child prints), which suits a hang with no output; on timeout nsExec
; returns "timeout" and terminates that child by handle (nsExec.dll imports
; TerminateProcess), never by image name. Failure policy is BrokerStep's: never
; fails the install, MessageBox only when interactive, DetailPrint + log always.
!ifndef BROKER_INSTALL_TIMEOUT_MS
  !define BROKER_INSTALL_TIMEOUT_MS 120000
!endif
!macro BrokerInstallStep
  Push $0
  Push $1
  Push $2
  CreateDirectory "$INSTDIR\logs"
  nsExec::ExecToStack /TIMEOUT=${BROKER_INSTALL_TIMEOUT_MS} '"$INSTDIR\broker\broker.exe" install'
  Pop $0
  Pop $1
  ClearErrors
  FileOpen $2 "$INSTDIR\logs\broker-install.log" w
  ${IfNot} ${Errors}
    FileWrite $2 "broker.exe install, result: $0$\r$\noutput: $1$\r$\n"
    FileClose $2
  ${EndIf}
  ${If} $0 S== "timeout"
    DetailPrint "Registering the print broker service failed (no output for ${BROKER_INSTALL_TIMEOUT_MS} ms, the process was stopped). See $INSTDIR\logs\broker-install.log"
    ${If} $PassiveMode != 1
    ${AndIfNot} ${Silent}
      MessageBox MB_OK|MB_ICONEXCLAMATION "Registering the print broker service timed out after ${BROKER_INSTALL_TIMEOUT_MS} ms and was stopped. Printing may not work until it is repaired. Log: $INSTDIR\logs\broker-install.log"
    ${EndIf}
  ${ElseIf} $0 S== "error"
    DetailPrint "Registering the print broker service failed (the process could not start)"
    ${If} $PassiveMode != 1
    ${AndIfNot} ${Silent}
      MessageBox MB_OK|MB_ICONEXCLAMATION "Registering the print broker service failed (the process could not start). Printing may not work until it is repaired."
    ${EndIf}
  ${ElseIfNot} $0 S== "0"
    DetailPrint "Registering the print broker service failed (code $0). See $INSTDIR\logs\broker-install.log"
    ${If} $PassiveMode != 1
    ${AndIfNot} ${Silent}
      MessageBox MB_OK|MB_ICONEXCLAMATION "Registering the print broker service failed (code $0). Printing may not work until it is repaired. Log: $INSTDIR\logs\broker-install.log"
    ${EndIf}
  ${EndIf}
  Pop $2
  Pop $1
  Pop $0
!macroend

; Starts the service and appends the start exit code and the resulting
; `sc query` to broker-install.log, so a service that does not stay up is
; visible next time. 1056 (already running) is benign. Same failure policy as
; BrokerStep: DetailPrint always, MessageBox only when interactive.
!macro BrokerStartStep
  Push $0
  Push $1
  Push $2
  Push $3
  nsExec::ExecToStack /TIMEOUT=30000 '"$SYSDIR\sc.exe" start PrintBrokerService'
  Pop $0
  Pop $1
  Sleep 2000
  nsExec::ExecToStack /TIMEOUT=15000 '"$SYSDIR\sc.exe" query PrintBrokerService'
  Pop $2
  Pop $3
  ClearErrors
  FileOpen $2 "$INSTDIR\logs\broker-install.log" a
  ${IfNot} ${Errors}
    FileSeek $2 0 END
    FileWrite $2 "sc start, result: $0$\r$\noutput: $1$\r$\nsc query: $3$\r$\n"
    FileClose $2
  ${EndIf}
  ${IfNot} $0 S== "0"
  ${AndIfNot} $0 S== "1056"
    DetailPrint "Starting the print broker service failed (code $0). See $INSTDIR\logs\broker-install.log"
    ${If} $PassiveMode != 1
    ${AndIfNot} ${Silent}
      MessageBox MB_OK|MB_ICONEXCLAMATION "Starting the print broker service failed (code $0). Printing may not work until it is repaired. Log: $INSTDIR\logs\broker-install.log"
    ${EndIf}
  ${EndIf}
  Pop $3
  Pop $2
  Pop $1
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
  nsExec::ExecToStack '"$SYSDIR\sc.exe" query PrintBrokerService'
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
    nsExec::Exec '"$SYSDIR\curl.exe" -s -m 2 -o NUL http://127.0.0.1:8973/health'
    Pop $2
    ${Do}
      nsExec::ExecToStack '"$SYSDIR\cmd.exe" /s /c ""$SYSDIR\sc.exe" query PrintBrokerService | "$SYSDIR\findstr.exe" /C:"STOPPED""'
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

; PosctlTrusted: posctl.exe and vc_redist.x64.exe run ELEVATED (here, and from the SYSTEM scheduled tasks). A folder that
; ordinary users can write to would let any of them swap those binaries for code that runs as SYSTEM, so every posctl and
; VC++ step requires $INSTDIR to be under $PROGRAMFILES64\ (a perMachine install puts it there). `==` is case-insensitive
; in NSIS, which is what a path prefix needs. Leaves $6 = "1" (go on) or "0" (skip every posctl step; say so). The
; Tauri NSIS template has no .onVerifyInstDir hook, so the directory page cannot refuse a custom folder: the steps are
; skipped instead and the print broker install is unaffected. $INSTDIR is normalized first (GetFullPathName resolves
; "..": vc_redist has no trust check of its own) and refused when that fails or the result still has ".." or an 8.3 "~".
; `notice` = 1 also raises a message box (not in passive or silent mode, as everywhere in this file).
!macro PosctlTrusted notice
  Push $0
  Push $7
  Push $8
  Push $9
  StrCpy $6 "0"
  ClearErrors
  GetFullPathName $7 "$INSTDIR"
  ${IfNot} ${Errors}
    StrLen $0 "$PROGRAMFILES64\"
    StrCpy $8 "$7" $0
    ${If} $8 == "$PROGRAMFILES64\"
      StrCpy $6 "1"
      ; after normalization no ".." can remain and no 8.3 "~" short name may hide another folder
      StrLen $0 "$7"
      ${While} $0 > 0
        IntOp $0 $0 - 1
        StrCpy $8 "$7" 1 $0
        StrCpy $9 "$7" 2 $0
        ${If} $8 == "~"
        ${OrIf} $9 == ".."
          StrCpy $6 "0"
        ${EndIf}
      ${EndWhile}
    ${EndIf}
  ${EndIf}
  ${If} $6 == "0"
    DetailPrint "Store server steps skipped: $INSTDIR is not under Program Files."
    ${If} ${notice} == 1
      ${If} $PassiveMode != 1
      ${AndIfNot} ${Silent}
        MessageBox MB_OK|MB_ICONEXCLAMATION "The store server tools were not set up because this app is installed outside Program Files. Reinstall to the default folder to use a store server."
      ${EndIf}
    ${EndIf}
  ${EndIf}
  Pop $9
  Pop $8
  Pop $7
  Pop $0
!macroend

; VcRuntimeStep: posctl.exe is built with a static CRT, but every other store server binary (Postgres, PostgREST, Caddy,
; Supabase tools) needs the VC++ 2015-2022 x64 runtime, which a clean Windows lacks. The elevated installer ALWAYS runs
; the redistributable bundled beside posctl.exe (src-tauri/posctl/vc_redist.x64.exe: taken from the signed backend pack at
; release time, never downloaded here): its "Installed" registry value is also 1 for an older runtime, so a registry check
; would skip a needed upgrade, and the redistributable itself answers 1638 when a newer one is present. This is the ONE
; thing the installer does for the store server besides scheduling its tasks; it never provisions, starts or stops a
; service. Leaves $3 = "1" (go on) or "0" (the redistributable failed: the caller skips the pack install; the tasks are
; registered regardless, they are what keeps a provisioned PC's boot gate alive). 0 = installed, 1638 = a newer runtime is
; already present, 3010 = installed and a reboot is needed (a note and the reboot flag, not a failure).
!macro VcRuntimeStep
  Push $0
  StrCpy $3 "1"
  ${If} ${FileExists} "$INSTDIR\posctl\vc_redist.x64.exe"
    ClearErrors
    ExecWait '"$INSTDIR\posctl\vc_redist.x64.exe" /install /quiet /norestart' $0
    ${If} ${Errors}
      StrCpy $3 "0"
      DetailPrint "The VC++ runtime installer could not start."
      ${If} $PassiveMode != 1
      ${AndIfNot} ${Silent}
        MessageBox MB_OK|MB_ICONEXCLAMATION "The VC++ runtime installer could not start. The store server will not run until it is installed; run this installer again."
      ${EndIf}
    ${ElseIf} $0 S== "0"
    ${OrIf} $0 S== "1638"
      DetailPrint "VC++ runtime ready (code $0)."
    ${ElseIf} $0 S== "3010"
      SetRebootFlag true
      DetailPrint "VC++ runtime installed; a restart is needed before the store server can start."
    ${Else}
      StrCpy $3 "0"
      DetailPrint "The VC++ runtime installer failed (code $0)."
      ${If} $PassiveMode != 1
      ${AndIfNot} ${Silent}
        MessageBox MB_OK|MB_ICONEXCLAMATION "The VC++ runtime installer failed (code $0). The store server will not run until it is installed; run this installer again."
      ${EndIf}
    ${EndIf}
  ${EndIf}
  Pop $0
!macroend

; RecoverStep: finish or undo an update that the installer's own `schtasks /End` may have killed mid-flight (the UpdateCheck and
; Recover tasks run `posctl update`). Run it only with the tasks ended and posctl.exe present. Exit 0 covers both "nothing to
; recover" and "recovered" (store-server commands/update.rs: Report::new(OpCode::Ok, ...)); 4 = NOT_PROVISIONED (a cloud-mode PC
; has no update to recover) is benign, as for `tasks install`. Anything else (17 = recovery needed, 3, a start
; failure) is logged with its code (10 = lock busy is logged only: another operation is already on it) and answered with ONE fixed message, then the install or uninstall goes on: it never blocks
; and never re-runs the update. There is no --wait-lock on `update` (that flag belongs to tasks/pack), so none is passed.
; The message is a plain English literal, like every other user-facing string in this file (there is no LangString here);
; passive and silent runs (the updater) skip the dialog, and DetailPrint always records the failure.
!macro RecoverStep
  Push $0
  ClearErrors
  DetailPrint "Finishing an interrupted store server update, this can take several minutes..."
  ExecWait '"$INSTDIR\posctl\posctl.exe" update --recover --quiet' $0
  ${If} ${Errors}
    DetailPrint "Finishing an interrupted store server update failed (the process could not start)"
    StrCpy $0 "start"
  ${ElseIf} $0 S== "0"
  ${OrIf} $0 S== "4"
    StrCpy $0 ""
  ${ElseIf} $0 S== "10"
    ; LOCK_HELD: another posctl operation (a task, or a person) holds update.lock and is doing the recovery or update itself; benign
    DetailPrint "Finishing an interrupted store server update skipped (code 10: another operation holds the update lock)"
    StrCpy $0 ""
  ${Else}
    DetailPrint "Finishing an interrupted store server update failed (code $0)"
  ${EndIf}
  ${If} $0 != ""
    ${If} $PassiveMode != 1
    ${AndIfNot} ${Silent}
      MessageBox MB_OK|MB_ICONEXCLAMATION "An interrupted store server update could not be finished. Run posctl update --recover as an administrator, or restart this PC."
    ${EndIf}
  ${EndIf}
  Pop $0
!macroend

; PREINSTALL runs before files are copied. On an upgrade, PrintBrokerService
; is normally still running (AutoStart) and holds a lock on broker.exe, so
; the section's File copy of the upgraded binary needs the service stopped
; and actually STOPPED (not merely STOP_PENDING) first. 1060/1062 (service
; not installed / not started) are benign — both are the normal state on a
; fresh install.
!macro NSIS_HOOK_PREINSTALL
  ; StoreRoleStep asks only on a FRESH install: an existing $INSTDIR\posctl means this is an upgrade or reinstall.
  StrCpy $StoreRoleUpgrade "0"
  ${If} ${FileExists} "$INSTDIR\posctl"
    StrCpy $StoreRoleUpgrade "1"
  ${EndIf}
  ; An older v1.11.x install may have no posctl\ folder: its uninstall entry still says "installed".
  ReadRegStr $0 HKLM "Software\Microsoft\Windows\CurrentVersion\Uninstall\Supermarket POS" "UninstallString"
  ${If} $0 != ""
    StrCpy $StoreRoleUpgrade "1"
  ${EndIf}
  !insertmacro BrokerStep '"$SYSDIR\sc.exe" stop PrintBrokerService' "Stopping the previous print broker service" "1060" "1062"
  !insertmacro WaitBrokerStopped
  ; posctl: the Health, Canary, Recover, UpdateCheck, Backup and BackupVerify tasks run posctl.exe from $INSTDIR\posctl (Health every minute). End any running
  ; instance (it holds the file the installer is about to replace; 1 = not running or not registered, the normal case),
  ; then remove the tasks, waiting up to 30 s for the update.lock that a running Health holds. POSTINSTALL registers them
  ; again, so the action path follows an app update. The names follow tasks.rs all_tasks() (a test pins that).
  Push $6
  !insertmacro PosctlTrusted 0
  ${If} $6 == "1"
  ${AndIf} ${FileExists} "$INSTDIR\posctl\posctl.exe"
    !insertmacro BrokerStep '"$SYSDIR\schtasks.exe" /End /TN "\SupermarketPOS\Health"' "Stopping the store server health task" "1" "1"
    !insertmacro BrokerStep '"$SYSDIR\schtasks.exe" /End /TN "\SupermarketPOS\Canary"' "Stopping the store server canary task" "1" "1"
    !insertmacro BrokerStep '"$SYSDIR\schtasks.exe" /End /TN "\SupermarketPOS\Recover"' "Stopping the store server recover task" "1" "1"
    !insertmacro BrokerStep '"$SYSDIR\schtasks.exe" /End /TN "\SupermarketPOS\UpdateCheck"' "Stopping the store server update check task" "1" "1"
    !insertmacro BrokerStep '"$SYSDIR\schtasks.exe" /End /TN "\SupermarketPOS\Backup"' "Stopping the store server backup task" "1" "1"
    !insertmacro BrokerStep '"$SYSDIR\schtasks.exe" /End /TN "\SupermarketPOS\BackupVerify"' "Stopping the store server backup verify task" "1" "1"
    !insertmacro BrokerStep '"$INSTDIR\posctl\posctl.exe" tasks remove --wait-lock 30' "Pausing the store server tasks" "0" "0"
  ${EndIf}
  Pop $6
!macroend

; StoreRoleStep (Plan 11a): a fresh interactive install asks once whether this PC is the store server or a till, and runs
; posctl in its own visible elevated console (the installer is perMachine, so the console is elevated and shows the
; first administrator's PIN once; the PIN never passes through this script). Asked only when ALL hold: not silent, not the
; updater's passive run (PassiveMode / UpdateMode are Tauri's template variables), no store.env, not provisioned, and the
; HKLM marker StoreRoleAsked is absent and PREINSTALL found no earlier install ($StoreRoleUpgrade, set when $INSTDIR\posctl
; exists). The marker is written whenever the question is asked and deleted on uninstall.
; A non-zero exit is reported. Needs $1 = ProgramData and a trusted $INSTDIR (the caller checks PosctlTrusted).
Var StoreRoleUpgrade
!macro StoreRoleStep
  Push $0
  Push $2
  ${IfNot} ${Silent}
  ${AndIf} $StoreRoleUpgrade != 1
  ${AndIf} $PassiveMode != 1
  ${AndIf} $UpdateMode != 1
  ${AndIfNot} ${FileExists} "$1\SupermarketPOS\client\store.env"
  ${AndIfNot} ${FileExists} "$1\SupermarketPOS\state\provisioned.json"
    ReadRegStr $2 HKLM "Software\SupermarketPOS" "StoreRoleAsked"
    ${If} $2 == ""
      WriteRegStr HKLM "Software\SupermarketPOS" "StoreRoleAsked" "1"
      StrCpy $0 0
      ClearErrors
      ${If} ${Cmd} `MessageBox MB_YESNO|MB_ICONQUESTION "Make this PC the store server?$\r$\n$\r$\nYes sets up the store server on this PC. No lets you connect it to a store server on this network as a till." IDYES`
        ExecWait '"$INSTDIR\posctl\posctl.exe" provision --console' $0
      ${ElseIf} ${Cmd} `MessageBox MB_YESNO|MB_ICONQUESTION "Is this PC a till for a store server on this network?" IDYES`
        ExecWait '"$INSTDIR\posctl\posctl.exe" pair join --prompt --console' $0
      ${EndIf}
      ${If} ${Errors}
      ${OrIf} $0 != 0
        MessageBox MB_OK|MB_ICONEXCLAMATION "Store setup did not finish (exit code $0). Open the POS app, Store server, Finish setup."
      ${EndIf}
    ${EndIf}
  ${EndIf}
  Pop $2
  Pop $0
!macroend

!macro NSIS_HOOK_POSTINSTALL
  Push $1
  Push $2
  Push $3
  Push $4
  Push $5
  Push $6
  ; ProgramData is not a fixed constant here — read it, with the documented
  ; fallback for the rare case it is unset. $1 is used for nothing else in
  ; this macro; the subject-file read below uses $3 (see ReadCertSubject).
  ReadEnvStr $1 PROGRAMDATA
  ${If} $1 == ""
    StrCpy $1 "C:\ProgramData"
  ${EndIf}

  !insertmacro BrokerInstallStep

  ; Data-folder ACL: SYSTEM and Administrators full control, the service's
  ; own virtual account modify (it writes the ledger and rotates the secret
  ; file), interactive Users read-only (the desktop app runs as a standard
  ; user and reads client-secret.txt to authenticate to the broker, but must
  ; not be able to replace or corrupt the config or the secret).
  ; The (OI)(CI) grants go on the FOLDER ONLY (no /T): applied with /T to a file
  ; that inherits everything, /inheritance:r strips its inherited ACEs and the
  ; (OI)(CI) grants do not land on a leaf, leaving an EMPTY DACL (the service
  ; then cannot read broker-config.json and stops). The children are then reset
  ; to inherit from the folder. Ownership keeps /T (works on an empty DACL).
  !insertmacro BrokerStep '"$SYSDIR\icacls.exe" "$1\PrintBroker" /setowner *S-1-5-32-544 /T /C' "Setting the print broker data folder owner" "0" "0"
  !insertmacro BrokerStep '"$SYSDIR\icacls.exe" "$1\PrintBroker" /inheritance:r /grant:r "*S-1-5-18:(OI)(CI)F" /grant:r "*S-1-5-32-544:(OI)(CI)F" /grant:r "NT SERVICE\PrintBrokerService:(OI)(CI)M" /grant:r "*S-1-5-32-545:(OI)(CI)RX"' "Setting the print broker data folder permissions" "0" "0"
  !insertmacro BrokerStep '"$SYSDIR\icacls.exe" "$1\PrintBroker\*" /reset /T /C' "Resetting the print broker data files to inherit" "0" "0"
  ; broker-config.json is read only by the service (broker/src/config.rs; the app
  ; reads client-secret.txt, src-tauri/src/commands/broker_secret.rs), and it holds
  ; the bearer secret: explicit protected ACL, no Users.
  !insertmacro BrokerStep '"$SYSDIR\icacls.exe" "$1\PrintBroker\broker-config.json" /inheritance:r /grant:r "*S-1-5-18:F" /grant:r "*S-1-5-32-544:F" /grant:r "NT SERVICE\PrintBrokerService:M"' "Protecting the print broker config" "0" "0"

  ; Delete-then-add so an upgrade never accumulates a second identically
  ; named rule (netsh's `add` is not idempotent by name). "1": no matching
  ; rule to delete, the normal case on a fresh install.
  !insertmacro BrokerStep '"$SYSDIR\netsh.exe" advfirewall firewall delete rule name="Store Print Broker"' "Removing a previous print broker firewall rule" "1" "1"
  !insertmacro BrokerStep '"$SYSDIR\netsh.exe" advfirewall firewall add rule name="Store Print Broker" dir=in action=allow program="$INSTDIR\broker\broker.exe" protocol=TCP localport=8973 profile=private remoteip=LocalSubnet' "Adding the print broker firewall rule" "0" "0"

  !insertmacro BrokerStartStep

  ; posctl: the VC++ runtime, then schedule the store server Health and Canary tasks (idempotent), then unpack the
  ; bundled backend pack (a signed pack that is already installed is a benign no-op; an empty dev placeholder is skipped).
  ; The tasks are registered whatever the runtime installer did: they are what gates a provisioned PC's sign-in on its
  ; lockout canary, and PREINSTALL just removed them. Only the pack install waits for the runtime.
  ; 4 = NOT_PROVISIONED: a cloud-mode PC has no store server, so there is nothing to schedule. The database engine and
  ; its services are NOT touched here: they belong to `posctl provision`, never to the installer.
  ; --wait-lock 30: the per-minute Health task may hold update.lock for a few seconds.
  ; $INSTDIR must be under Program Files (PosctlTrusted), which is also what posctl's own trust check for tasks demands.
  StrCpy $5 0
  !insertmacro PosctlTrusted 1
  ${If} $6 == "1"
  ${AndIf} ${FileExists} "$INSTDIR\posctl\posctl.exe"
    !insertmacro VcRuntimeStep
    !insertmacro BrokerStep '"$INSTDIR\posctl\posctl.exe" tasks install --wait-lock 30' "Registering the store server tasks" "4" "4"
    !insertmacro RecoverStep
    ${If} $3 == "1"
    ${AndIf} ${FileExists} "$INSTDIR\posctl\backend.pospack"
      FileOpen $4 "$INSTDIR\posctl\backend.pospack" r
      FileSeek $4 0 END $5
      FileClose $4
      ${If} $5 > 0
        !insertmacro BrokerStep '"$INSTDIR\posctl\posctl.exe" pack install --file "$INSTDIR\posctl\backend.pospack" --wait-lock 30' "Unpacking the store server backend pack" "0" "0"
      ${EndIf}
    ${EndIf}
    !insertmacro StoreRoleStep
  ${EndIf}

  ; Root store cleanup runs BEFORE the fresh -addstore so an upgrade never
  ; accumulates a second root certificate for this build's subject, and a
  ; customer's first post-this-wave build also removes the one fixed legacy
  ; subject every earlier build shipped, whatever this customer's own
  ; subject is now.
  !insertmacro ReadCertSubject
  ${If} $2 != ""
    !insertmacro BrokerStep '"$SYSDIR\certutil.exe" -delstore Root "$2"' "Removing the previous print broker root certificate" "0" "0"
    ${If} $2 != "Taj House of Spice Supermarket POS"
      !insertmacro BrokerStep '"$SYSDIR\certutil.exe" -delstore Root "Taj House of Spice Supermarket POS"' "Removing the legacy print broker root certificate" "0" "0"
    ${EndIf}
  ${EndIf}
  !insertmacro BrokerStep '"$SYSDIR\certutil.exe" -f -addstore Root "$INSTDIR\cert\selfsigned.cer"' "Adding the print broker root certificate" "0" "0"

  Pop $6
  Pop $5
  Pop $4
  Pop $3
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
    !insertmacro BrokerStep '"$SYSDIR\sc.exe" stop PrintBrokerService' "Stopping the print broker service" "1060" "1062"
    !insertmacro WaitBrokerStopped
    !insertmacro BrokerStep '"$INSTDIR\broker\broker.exe" uninstall' "Removing the print broker service registration" "0" "0"
    !insertmacro BrokerStep '"$SYSDIR\netsh.exe" advfirewall firewall delete rule name="Store Print Broker"' "Removing the print broker firewall rule" "1" "1"
    !insertmacro ReadCertSubject
    ${If} $2 != ""
      !insertmacro BrokerStep '"$SYSDIR\certutil.exe" -delstore Root "$2"' "Removing the print broker root certificate" "0" "0"
    ${EndIf}
    ; posctl: the scheduled tasks would otherwise run a posctl.exe that no longer exists. The store server services and
    ; data are deliberately kept (an app uninstall must not delete the engine); `posctl unprovision` removes them.
    Push $6
    !insertmacro PosctlTrusted 0
    ${If} $6 == "1"
    ${AndIf} ${FileExists} "$INSTDIR\posctl\posctl.exe"
      !insertmacro BrokerStep '"$SYSDIR\schtasks.exe" /End /TN "\SupermarketPOS\Health"' "Stopping the store server health task" "1" "1"
      !insertmacro BrokerStep '"$SYSDIR\schtasks.exe" /End /TN "\SupermarketPOS\Canary"' "Stopping the store server canary task" "1" "1"
      !insertmacro BrokerStep '"$SYSDIR\schtasks.exe" /End /TN "\SupermarketPOS\Recover"' "Stopping the store server recover task" "1" "1"
      !insertmacro BrokerStep '"$SYSDIR\schtasks.exe" /End /TN "\SupermarketPOS\UpdateCheck"' "Stopping the store server update check task" "1" "1"
      !insertmacro BrokerStep '"$SYSDIR\schtasks.exe" /End /TN "\SupermarketPOS\Backup"' "Stopping the store server backup task" "1" "1"
      !insertmacro BrokerStep '"$SYSDIR\schtasks.exe" /End /TN "\SupermarketPOS\BackupVerify"' "Stopping the store server backup verify task" "1" "1"
      !insertmacro RecoverStep
      !insertmacro BrokerStep '"$INSTDIR\posctl\posctl.exe" tasks remove --wait-lock 30' "Removing the store server tasks" "0" "0"
    ${EndIf}
    Pop $6
    Pop $2
  ${EndIf}
!macroend

; The print broker's data folder (%ProgramData%\PrintBroker\ — the ledger
; and the per-store secret) is deliberately kept on uninstall, as
; broker/install/mod.rs::uninstall() itself documents, so a reinstall does
; not silently mint a new secret and break every already-configured LAN
; client's credential.
!macro NSIS_HOOK_POSTUNINSTALL
  ; a later fresh install asks the store role question again
  DeleteRegValue HKLM "Software\SupermarketPOS" "StoreRoleAsked"
  DeleteRegKey /ifempty HKLM "Software\SupermarketPOS"
  DetailPrint "Print broker data folder kept (ledger and secret survive uninstall)."
  DetailPrint "Store server services and data kept (run posctl unprovision to remove them)."
  ; Known leftover: uninstalling removes the tasks but leaves an empty SupermarketPOS folder in Task Scheduler (harmless).
!macroend
