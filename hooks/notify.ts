export type Os = 'windows' | 'mac' | 'other'

// macOS: the text goes in as arguments of the script.
const MAC_SCRIPT = ['on run argv', 'display notification (item 2 of argv) with title (item 1 of argv)', 'end run']

/** A script shipped under hooks/win, run by wscript.exe: it has no console, so no window opens (`$.process.run` cannot hide one). */
export function winScript(root: string, name: string): string[] {
  return ['wscript.exe', '//B', '//Nologo', `${root}\\hooks\\win\\${name}`]
}

/** The command that raises a desktop notification on `os` (`root` the plugin's directory), or undefined where there is none to run. */
export function notifyCommand(os: Os, title: string, body: string, root: string): { argv: string[]; env?: Record<string, string> } | undefined {
  // the toast itself is toast.ps1; the text goes in through the environment so no quoting of it can break the script
  if (os === 'windows') return { argv: winScript(root, 'toast.vbs'), env: { WD_TITLE: title, WD_BODY: body } }
  if (os === 'mac') return { argv: ['osascript', ...MAC_SCRIPT.flatMap(line => ['-e', line]), title, body] }
  return undefined
}
