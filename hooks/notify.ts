export type Os = 'windows' | 'mac' | 'other'

// Windows: a toast under PowerShell's own app id (an unregistered id shows nothing).
// The text arrives in the environment, so no quoting of it can break the script.
const WINDOWS_TOAST = [
  "$ErrorActionPreference = 'Stop'",
  '[void][Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime]',
  '$xml = [Windows.UI.Notifications.ToastNotificationManager]::GetTemplateContent([Windows.UI.Notifications.ToastTemplateType]::ToastText02)',
  "$lines = $xml.GetElementsByTagName('text')",
  '[void]$lines.Item(0).AppendChild($xml.CreateTextNode($env:WD_TITLE))',
  '[void]$lines.Item(1).AppendChild($xml.CreateTextNode($env:WD_BODY))',
  '$toast = [Windows.UI.Notifications.ToastNotification]::new($xml)',
  "[Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier('{1AC14E77-02E7-4E5D-B744-2EB1AE5198B7}\\WindowsPowerShell\\v1.0\\powershell.exe').Show($toast)",
].join('\n')

// macOS: the text goes in as arguments of the script.
const MAC_SCRIPT = ['on run argv', 'display notification (item 2 of argv) with title (item 1 of argv)', 'end run']

/** The command that raises a desktop notification on `os`, or undefined where there is none to run. */
export function notifyCommand(os: Os, title: string, body: string): { argv: string[]; env?: Record<string, string> } | undefined {
  if (os === 'windows') {
    return {
      argv: ['powershell.exe', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-WindowStyle', 'Hidden', '-Command', WINDOWS_TOAST],
      env: { WD_TITLE: title, WD_BODY: body },
    }
  }
  if (os === 'mac') return { argv: ['osascript', ...MAC_SCRIPT.flatMap(line => ['-e', line]), title, body] }
  return undefined
}
