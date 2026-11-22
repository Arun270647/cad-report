' Starts the worker supervisor with NO console window (used by the at-logon scheduled task).
' Usage: wscript.exe //B //Nologo launch-hidden.vbs "C:\Program Files\nodejs\node.exe"
' Waits for the supervisor, so the scheduled task shows "Running" and Task Scheduler's restart-on-failure applies.
Option Explicit
Dim sh, fso, here, node
Set sh = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")
here = fso.GetParentFolderName(WScript.ScriptFullName)
node = "node"
If WScript.Arguments.Count > 0 Then node = WScript.Arguments(0)
sh.CurrentDirectory = here
WScript.Quit sh.Run("""" & node & """ """ & here & "\supervisor.mjs""", 0, True)
