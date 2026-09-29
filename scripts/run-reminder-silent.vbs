' Run the reminder script with a fully hidden window; no console flashes.
' Same shape as dashboard/start-dashboard-silent.vbs: wscript.exe hosts it and
' shell.Run is called with window style 0 (hidden), so the node child never gets
' a visible window. The scheduled task MUST target wscript.exe, not node.exe --
' node.exe is a console-subsystem program and Windows Task Scheduler launches it
' in the interactive session, which always flashes a black window. The hourly
' "threshold check" task made that visible every hour at :05 (reported 2026-09-27).
'
' Keep this file ASCII-only. cscript decodes a BOM-less .vbs as ANSI (GBK on this
' machine), where a full-width CJK punctuation byte (U+3002 ends in 0x82) is a
' valid GBK lead byte -- it then swallows the following CR/LF, merging the comment
' with the next line and commenting out real code. Verified by test.
Option Explicit

Dim fso
Dim shell
Dim scriptDir
Dim command
Dim exitCode

Set fso = CreateObject("Scripting.FileSystemObject")
Set shell = CreateObject("WScript.Shell")

scriptDir = fso.GetParentFolderName(WScript.ScriptFullName)
shell.CurrentDirectory = scriptDir

command = "node """ & fso.BuildPath(scriptDir, "remind.js") & """" & JoinReminderArgs()
' Third arg True = wait for the child, so wscript stays alive and holds the
' hidden process. WScript.Quit forwards the real exit code to Task Scheduler,
' keeping the --strict "overdue items" exit code 1 visible.
exitCode = shell.Run(command, 0, True)
WScript.Quit exitCode

' Forward wscript's own command-line arguments to remind.js verbatim.
' Quote each one so arguments containing spaces (e.g. --out="C:\a b\x.json")
' are not split apart.
Function JoinReminderArgs()
  Dim i
  Dim s
  s = ""
  For i = 0 To WScript.Arguments.Count - 1
    s = s & " """ & WScript.Arguments(i) & """"
  Next
  JoinReminderArgs = s
End Function
