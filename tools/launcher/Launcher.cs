// 브리티 메신저 캘린더 실행기: 같은 폴더의 runtime\electron.exe 를 켠다(.cmd 대신 아이콘 있는 실행 파일).
// build-launcher.ps1 이 Windows에 들어 있는 C# 컴파일러로 만든다. SAMPLE 이면 샘플(--demo)로 켠다.
using System;
using System.Diagnostics;
using System.IO;
using System.Reflection;
using System.Security.AccessControl;
using System.Security.Principal;
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

    // 켜자마자 0x80000003으로 꺼진 실제 원인(2026-11-13, 26H2 PC 진단): runtime 폴더 권한에 다른 앱의 AppContainer
    // 패키지 SID(S-1-15-2-…) 항목만 있고 '모든 응용 프로그램 패키지'(S-1-15-2-1)가 없으면 Electron이 시작 때 검사해 스스로 멈춘다
    // (electron\shell\browser\win\install_dir_access.cc). Codex 등 샌드박스를 쓰는 앱이 그 폴더에서 일하면 이런 항목이 붙는다.
    // Electron이 알려 주는 고침과 똑같이 runtime 폴더에만 S-1-15-2-1 읽기·실행(OI)(CI)을 더한다. 그 조건일 때만 손댄다.
    const string AllApplicationPackages = "S-1-15-2-1";

    static bool EnsurePackageAccess(string runtime)
    {
        try
        {
            var dir = new DirectoryInfo(runtime);
            DirectorySecurity security = dir.GetAccessControl(AccessControlSections.Access);
            bool hasPackage = false, hasAll = false;
            foreach (FileSystemAccessRule rule in security.GetAccessRules(true, true, typeof(SecurityIdentifier)))
            {
                string sid = rule.IdentityReference.Value;
                if (rule.AccessControlType != AccessControlType.Allow) continue;
                if (sid == AllApplicationPackages)
                {
                    if ((rule.FileSystemRights & FileSystemRights.ReadAndExecute) == FileSystemRights.ReadAndExecute) hasAll = true;
                }
                else if (sid.StartsWith("S-1-15-2-", StringComparison.Ordinal)) hasPackage = true;
            }
            if (!hasPackage || hasAll) return true;
            security.AddAccessRule(new FileSystemAccessRule(new SecurityIdentifier(AllApplicationPackages), FileSystemRights.ReadAndExecute,
                InheritanceFlags.ContainerInherit | InheritanceFlags.ObjectInherit, PropagationFlags.None, AccessControlType.Allow));
            dir.SetAccessControl(security);
            return true;
        }
        catch
        {
            return false;
        }
    }

    // 그 밖의 까닭으로 0x80000003이 나면 한 번만 샌드박스 없이 다시 켜고, 된 PC는 다음부터 그렇게 켠다(no-sandbox.txt).
    const int StatusBreakpoint = unchecked((int)0x80000003);
    const string NoSandboxNote = "no-sandbox.txt";

    static Process StartElectron(string electron, string root, bool noSandbox)
    {
        string args = noSandbox ? Arguments + " --no-sandbox" : Arguments;
        return Process.Start(new ProcessStartInfo(electron, args) { WorkingDirectory = root, UseShellExecute = false });
    }

    // 켠 뒤 8초 안에 그 오류 코드로 꺼졌는지 본다. 이미 켜진 캘린더로 넘겨지고 꺼지는 경우(코드 0)는 정상이다.
    static bool CrashedOnStart(Process process)
    {
        if (!process.WaitForExit(8000)) return false;
        return process.ExitCode == StatusBreakpoint;
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
        bool accessOk = EnsurePackageAccess(Path.Combine(root, "runtime"));
        string note = Path.Combine(root, NoSandboxNote);
        try
        {
            if (File.Exists(note))
            {
                using (StartElectron(electron, root, true)) { }
                return 0;
            }
            using (Process first = StartElectron(electron, root, false))
            {
                if (!CrashedOnStart(first)) return 0;
            }
            using (Process retry = StartElectron(electron, root, true))
            {
                if (CrashedOnStart(retry))
                {
                    string fix = accessOk ? "" :
                        "runtime 폴더 권한을 고치지 못했습니다. 명령 프롬프트에서 아래를 실행한 뒤 다시 열어 보세요.\n" +
                        "icacls \"" + Path.Combine(root, "runtime") + "\" /grant *S-1-15-2-1:(OI)(CI)(RX)\n\n";
                    MessageBox.Show("캘린더가 켜지자마자 꺼졌습니다(오류 0x80000003).\n\n" + fix +
                        "그래도 안 되면 GitHub 첫 화면 '켜지지 않을 때'의 진단 도구를 받아 실행하고, 바탕 화면에 생긴 캘린더-진단.txt를 만든 분에게 보내 주세요.",
                        Title, MessageBoxButtons.OK, MessageBoxIcon.Warning);
                    return 1;
                }
            }
            try { File.WriteAllText(note, "이 PC에서는 캘린더와 샘플을 --no-sandbox로 켭니다(켜자마자 꺼지는 문제 피하기). 이 파일을 지우면 다음에 다시 시험합니다.\r\n"); } catch { }
            return 0;
        }
        catch (Exception error)
        {
            MessageBox.Show("캘린더를 켜지 못했습니다.\n" + error.Message, Title, MessageBoxButtons.OK, MessageBoxIcon.Warning);
            return 1;
        }
    }
}
