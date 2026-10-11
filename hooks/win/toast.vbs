' Runs toast.ps1 with its window hidden (Run style 0) and passes on its exit code.
' wscript.exe has no console of its own, so nothing flashes before the hide takes effect.
Set fso = CreateObject("Scripting.FileSystemObject")
dir = fso.GetParentFolderName(WScript.ScriptFullName)
cmd = "powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File """ & dir & "\toast.ps1"""
WScript.Quit CreateObject("WScript.Shell").Run(cmd, 0, True)
