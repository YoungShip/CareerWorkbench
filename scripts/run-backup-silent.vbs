' ASCII only: wscript uses the Windows ANSI code page for BOM-less VBS.
' Wait for completion and forward the backup exit code to Task Scheduler.
Option Explicit
Dim fso, shell, scriptDir, command, exitCode
Set fso = CreateObject("Scripting.FileSystemObject")
Set shell = CreateObject("WScript.Shell")
scriptDir = fso.GetParentFolderName(WScript.ScriptFullName)
shell.CurrentDirectory = scriptDir
command = "node """ & fso.BuildPath(scriptDir, "backup-tracker.js") & """ --push"
exitCode = shell.Run(command, 0, True)
WScript.Quit exitCode
