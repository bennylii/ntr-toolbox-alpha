' Silent launcher for the daemon tray (no console window).
' Double-click this file; put a shortcut in shell:startup for autostart.
Set fso = CreateObject("Scripting.FileSystemObject")
Set sh = CreateObject("WScript.Shell")
dir = fso.GetParentFolderName(WScript.ScriptFullName)
sh.Run "powershell -NoProfile -ExecutionPolicy Bypass -File """ & dir & "\tray.ps1""", 0, False
