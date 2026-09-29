Option Explicit
' CareerWorkbench: hidden host for the local dashboard, preserving the child exit code.
Dim shell, fso, folder, args, i, result
Set shell = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")
folder = fso.GetParentFolderName(WScript.ScriptFullName)
shell.CurrentDirectory = folder
args = ""
For i = 0 To WScript.Arguments.Count - 1
  If WScript.Arguments(i) = "--open" Then args = " --open"
Next
result = shell.Run("node """ & fso.BuildPath(folder, "serve.js") & """ hold" & args, 0, True)
WScript.Quit result