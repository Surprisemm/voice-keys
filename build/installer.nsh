; Extra pages and steps of the Voice Keys installer (electron-builder NSIS hooks).
; Before the installation starts the user chooses which shortcuts to create; the shortcuts are made here instead of by electron-builder.

; both boxes are ticked by default, also in silent installs where the page is not shown
!macro customInit
  StrCpy $shortcutDesktop "1"
  StrCpy $shortcutStartMenu "1"
!macroend

; page after the folder page and before the files are copied
!macro customPageAfterChangeDir
  !include nsDialogs.nsh
  Var shortcutDesktop
  Var shortcutStartMenu
  Var chkDesktop
  Var chkStartMenu

  Function shortcutsPageCreate
    !insertmacro MUI_HEADER_TEXT "Ярлыки программы" "Выберите, какие ярлыки создать перед установкой."
    nsDialogs::Create 1018
    Pop $0
    ${If} $0 == error
      Abort
    ${EndIf}
    ${NSD_CreateLabel} 0 0 100% 24u "Voice Keys можно запускать с ярлыка. Отметьте, где он нужен:"
    Pop $0
    ${NSD_CreateCheckbox} 8u 34u 100% 12u "Создать ярлык на рабочем столе"
    Pop $chkDesktop
    ${NSD_CreateCheckbox} 8u 54u 100% 12u "Создать ярлык в меню «Пуск»"
    Pop $chkStartMenu
    ${If} $shortcutDesktop == "1"
      ${NSD_Check} $chkDesktop
    ${EndIf}
    ${If} $shortcutStartMenu == "1"
      ${NSD_Check} $chkStartMenu
    ${EndIf}
    ; the next page is the installation itself
    GetDlgItem $0 $HWNDPARENT 1
    SendMessage $0 ${WM_SETTEXT} 0 "STR:Установить"
    nsDialogs::Show
  FunctionEnd

  Function shortcutsPageLeave
    ${NSD_GetState} $chkDesktop $shortcutDesktop
    ${NSD_GetState} $chkStartMenu $shortcutStartMenu
  FunctionEnd

  Page custom shortcutsPageCreate shortcutsPageLeave
!macroend

!macro customInstall
  ${If} $shortcutDesktop == "1"
    CreateShortCut "$newDesktopLink" "$appExe" "" "$appExe" 0 "" "" "${APP_DESCRIPTION}"
    ClearErrors
    WinShell::SetLnkAUMI "$newDesktopLink" "${APP_ID}"
  ${EndIf}
  ${If} $shortcutStartMenu == "1"
    !insertmacro createMenuDirectory
    CreateShortCut "$newStartMenuLink" "$appExe" "" "$appExe" 0 "" "" "${APP_DESCRIPTION}"
    ClearErrors
    WinShell::SetLnkAUMI "$newStartMenuLink" "${APP_ID}"
    StrCpy $launchLink "$newStartMenuLink"
  ${EndIf}
  ; the uninstall button in the program folder; it starts the uninstaller, which asks whether to delete the data
  CreateShortCut "$INSTDIR\Удалить Voice Keys.lnk" "$INSTDIR\${UNINSTALL_FILENAME}" "" "$INSTDIR\${UNINSTALL_FILENAME}" 0 "" "" "Удалить Voice Keys с компьютера"
  System::Call 'Shell32::SHChangeNotify(i 0x8000000, i 0, i 0, i 0)'
!macroend

; first page of the uninstaller: a confirmation with the checkbox for the data of the program
!macro customUnWelcomePage
  !include nsDialogs.nsh
  Var deleteDataChoice
  Var chkDeleteData

  Function un.deleteDataPageCreate
    !insertmacro MUI_HEADER_TEXT "Удаление Voice Keys" "Программа будет полностью удалена с компьютера."
    nsDialogs::Create 1018
    Pop $0
    ${If} $0 == error
      Abort
    ${EndIf}
    ${NSD_CreateLabel} 0 0 100% 36u "Будут удалены файлы программы, ярлыки и запись в списке приложений.$\r$\n$\r$\nНастройки, профили, записи голоса и обученный классификатор по умолчанию остаются: при повторной установке они подхватятся."
    Pop $0
    ${NSD_CreateCheckbox} 8u 54u 100% 12u "Удалить данные"
    Pop $chkDeleteData
    ${NSD_CreateLabel} 20u 68u 90% 36u "Настройки, профили команд, записи голоса, обученная модель, журнал и установленный Python для обучения (папка %APPDATA%\Voice Keys). Это нельзя отменить."
    Pop $0
    GetDlgItem $0 $HWNDPARENT 1
    SendMessage $0 ${WM_SETTEXT} 0 "STR:Удалить"
    nsDialogs::Show
  FunctionEnd

  Function un.deleteDataPageLeave
    ${NSD_GetState} $chkDeleteData $deleteDataChoice
  FunctionEnd

  UninstPage custom un.deleteDataPageCreate un.deleteDataPageLeave
!macroend

; electron-builder removes the shortcuts only if it created them itself, so the uninstaller does it here
!macro customUnInstall
  ${ifNot} ${isKeepShortcuts}
    WinShell::UninstShortcut "$oldDesktopLink"
    Delete "$oldDesktopLink"
    WinShell::UninstShortcut "$oldStartMenuLink"
    Delete "$oldStartMenuLink"
  ${endIf}

  ; the data is deleted only on the user's choice (never when the uninstaller runs for an update); the data folder is per user
  ${ifNot} ${isUpdated}
  ${AndIf} $deleteDataChoice == "1"
    ${if} $installMode == "all"
      SetShellVarContext current
    ${endif}
    RMDir /r "$APPDATA\${APP_FILENAME}"
    !ifdef APP_PACKAGE_NAME
      RMDir /r "$APPDATA\${APP_PACKAGE_NAME}"
    !endif
    ${if} $installMode == "all"
      SetShellVarContext all
    ${endif}
  ${endIf}
!macroend
