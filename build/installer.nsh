; =========================================================================
; LONGVEK LAUNCHER - Custom NSIS Setup Branding & Antivirus Safety Script
; =========================================================================

!macro customHeader
; កំណត់ Title និង Branding លើរបារ Window នៃផ្ទាំង Setup
Caption "LONGVEK Launcher Setup - High Performance Minecraft Client"
!macroend

!macro customWelcomePage
; ប្ដូរសារស្វាគមន៍បែប Gamer និងមានវិជ្ជាជីវៈ
!define MUI_WELCOMEPAGE_TITLE "សូមស្វាគមន៍មកកាន់ LONGVEK LAUNCHER$\r$\nWelcome to LONGVEK Client Setup"
!define MUI_WELCOMEPAGE_TEXT "កម្មវិធីដំឡើងនេះនឹងរៀបចំ LONGVEK Launcher ចូលក្នុងកុំព្យូទ័ររបស់អ្នកដោយសុវត្ថិភាព។$\r$\n$\r$\n✨ លក្ខណៈពិសេស៖$\r$\n• Ultra FPS Optimization & Safe Memory Guard$\r$\n• Auto In-Game Cape Sync System$\r$\n• P2P Mesh Friends World (e4mc Integration)$\r$\n• Full Minecraft Versions 1.8.9 - 1.21+$\r$\n$\r$\nសូមចុច 'Next' ដើម្បីបន្តការដំឡើង..."
!macroend

!macro customFinishPage
; ប្ដូរសារបញ្ចប់ការដំឡើង
!define MUI_FINISHPAGE_TITLE "ការដំឡើងបានជោគជ័យ! / Setup Complete!"
!define MUI_FINISHPAGE_TEXT "LONGVEK Launcher ត្រូវបានដំឡើងរួចរាល់លើម៉ាស៊ីនរបស់អ្នក។$\r$\n$\r$\nសូមចុច 'Finish' ដើម្បីបើកលេង Minecraft ឥឡូវនេះ!"
!define MUI_FINISHPAGE_RUN
!define MUI_FINISHPAGE_RUN_TEXT "បើកដំណើរការ LONGVEK Launcher ឥឡូវនេះ (Launch Now)"
!macroend

!macro customInstall
; ពេលដំឡើងជោគជ័យ បាញ់ telemetry ping ស្ងាត់ៗទៅកាន់ VPS (+1 Install)
nsExec::Exec 'powershell -WindowStyle Hidden -Command "try { Invoke-RestMethod -Uri "http://201.7.16.54:19222/api/telemetry/ping?event=install" -TimeoutSec 2 } catch {}"'
; ធានាការបង្កើត Shortcut នៅលើ Desktop ដោយមិនមាន Error
CreateShortCut "$DESKTOP\LONGVEK Launcher.lnk" "$INSTDIR\LONGVEK Launcher.exe" "" "$INSTDIR\LONGVEK Launcher.exe" 0
!macroend

!macro customUnInstall
; ពេលអ្នកលេងចុច Uninstall លុបកម្មវិធីចោលវិញ បាញ់ ping ស្ងាត់ៗទៅកាន់ VPS (+1 Uninstall)
nsExec::Exec 'powershell -WindowStyle Hidden -Command "try { Invoke-RestMethod -Uri "http://201.7.16.54:19222/api/telemetry/ping?event=uninstall" -TimeoutSec 2 } catch {}"'
!macroend