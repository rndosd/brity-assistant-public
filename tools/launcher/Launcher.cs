// 브리티 메신저 캘린더 실행기: 같은 폴더의 runtime\electron.exe 를 켠다(.cmd 대신 아이콘 있는 실행 파일).
// build-launcher.ps1 이 Windows에 들어 있는 C# 컴파일러로 만든다. SAMPLE 이면 샘플(--demo)로 켠다.
using System;
using System.Diagnostics;
using System.IO;
using System.Reflection;
using System.Windows.Forms;

[assembly: AssemblyTitle("브리티 메신저 캘린더")]
[assembly: AssemblyProduct("브리티 메신저 캘린더")]
[assembly: AssemblyDescription("브리티 메신저 캘린더 실행기")]

static class Launcher
{
    const string Title = "브리티 메신저 캘린더";
#if SAMPLE
    const string Arguments = "--demo";
#else
    const string Arguments = "--brity";
#endif

    // 앱의 업데이트 버튼이 받아 둔 패치를 다 바꾸지 못하고 끊겼으면(update-staging\pending.txt) 켜기 전에 마저 바꾼다.
    static void FinishPendingUpdate(string root)
    {
        string pending = Path.Combine(root, "update-staging", "pending.txt");
        if (!File.Exists(pending)) return;
        try
        {
            string staging = Path.GetFullPath(File.ReadAllText(pending).Trim());
            string allowed = Path.GetFullPath(Path.Combine(root, "update-staging")) + Path.DirectorySeparatorChar;
            string script = Path.Combine(staging, "update-apply.ps1");
            if (!staging.StartsWith(allowed, StringComparison.OrdinalIgnoreCase) || !File.Exists(script)) { File.Delete(pending); return; }
            string powershell = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.System), @"WindowsPowerShell\v1.0\powershell.exe");
            string args = "-NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -WindowStyle Hidden -File \"" + script + "\" -Root \"" + root.TrimEnd('\\') + "\" -Staging \"" + staging + "\" -NoRestart -Quiet";
            using (Process process = Process.Start(new ProcessStartInfo(powershell, args) { UseShellExecute = false, CreateNoWindow = true }))
            {
                process.WaitForExit(120000);
            }
        }
        catch
        {
            // 바꾸지 못하면 지금 판으로 켠다. 앱에서 다시 업데이트할 수 있다.
        }
        try { if (File.Exists(pending)) File.Delete(pending); } catch { }
    }

    [STAThread]
    static int Main()
    {
        string root = AppDomain.CurrentDomain.BaseDirectory;
        string electron = Path.Combine(root, "runtime", "electron.exe");
        if (!File.Exists(electron))
        {
            MessageBox.Show("ZIP 전체를 푼 폴더에서 실행해 주세요.\n이 파일과 같은 곳에 runtime 폴더가 있어야 합니다.", Title, MessageBoxButtons.OK, MessageBoxIcon.Warning);
            return 1;
        }
        // 업데이트가 앱 파일을 바꾸는 중이면 끝날 때까지 기다린다(기다리기만 하고 바로 놓는다).
        using (var mutex = new System.Threading.Mutex(false, @"Local\SchoolCalendarUpdate"))
        {
            bool owned = false;
            try { owned = mutex.WaitOne(120000); } catch (System.Threading.AbandonedMutexException) { owned = true; }
            if (owned) mutex.ReleaseMutex();
        }
#if !SAMPLE
        FinishPendingUpdate(root);
#endif
        try
        {
            Process.Start(new ProcessStartInfo(electron, Arguments) { WorkingDirectory = root, UseShellExecute = false });
            return 0;
        }
        catch (Exception error)
        {
            MessageBox.Show("캘린더를 켜지 못했습니다.\n" + error.Message, Title, MessageBoxButtons.OK, MessageBoxIcon.Warning);
            return 1;
        }
    }
}
