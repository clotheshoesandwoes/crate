' crate — launch hidden, open browser
Set sh = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")
sh.CurrentDirectory = fso.GetParentFolderName(WScript.ScriptFullName)
sh.Run "cmd /c node server.js", 0, False
WScript.Sleep 900
sh.Run "http://127.0.0.1:8823", 1, False
