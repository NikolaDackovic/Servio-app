; Servio: dodatna prečica "Servio ADMIN" (isti program sa --admin otvara ADMIN prozor)
!macro customInstall
  CreateShortCut "$DESKTOP\Servio ADMIN.lnk" "$INSTDIR\${APP_EXECUTABLE_FILENAME}" "--admin" "$INSTDIR\resources\app-resources\branding\admin-icon.ico" 0
  CreateShortCut "$SMPROGRAMS\Servio ADMIN.lnk" "$INSTDIR\${APP_EXECUTABLE_FILENAME}" "--admin" "$INSTDIR\resources\app-resources\branding\admin-icon.ico" 0
  ; stare prečice iz verzije "POS Kasa"
  Delete "$DESKTOP\POS Kasa.lnk"
  Delete "$SMPROGRAMS\POS Kasa.lnk"
!macroend
!macro customUnInstall
  Delete "$DESKTOP\Servio ADMIN.lnk"
  Delete "$SMPROGRAMS\Servio ADMIN.lnk"
!macroend
