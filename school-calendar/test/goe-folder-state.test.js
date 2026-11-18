'use strict';

const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const path = require('node:path');
const { test } = require('node:test');

test('GOE 폴더 판정은 실제 Windows 선택 컨트롤의 양쪽 상태를 비교한다', { skip: process.platform !== 'win32' }, () => {
  const script = `
    $ErrorActionPreference = 'Stop'
    $ProgressPreference = 'SilentlyContinue'
    Add-Type -AssemblyName UIAutomationClient, UIAutomationTypes, System.Windows.Forms
    Add-Type -ReferencedAssemblies System.Windows.Forms -TypeDefinition @"
using System;
using System.Runtime.InteropServices;
using System.Threading;
using System.Windows.Forms;
public static class FolderFixture {
    public static IntPtr Inbox, Sent, Plain;
    static Form form;
    [DllImport("user32.dll", CharSet=CharSet.Unicode)]
    static extern IntPtr CreateWindowEx(int ex, string cls, string name, int style, int x, int y,
        int width, int height, IntPtr parent, IntPtr menu, IntPtr instance, IntPtr data);
    [DllImport("user32.dll")] static extern IntPtr SendMessage(IntPtr button, int msg, IntPtr value, IntPtr data);
    static Thread thread;
    static ManualResetEvent ready = new ManualResetEvent(false);
    public static void Start() {
        thread = new Thread(delegate() {
            using (form = new Form()) {
                Inbox = Button("Inbox", 3); Sent = Button("Sent", 3); Plain = Button("Plain", 0);
                ready.Set();
                Application.Run();
            }
        });
        thread.IsBackground = true;
        thread.SetApartmentState(ApartmentState.STA);
        thread.Start();
        if (!ready.WaitOne(5000)) throw new TimeoutException();
    }
    static IntPtr Button(string name, int buttonType) {
        return CreateWindowEx(0,"Button",name,0x50000000 | buttonType,0,0,50,25,
            form.Handle,IntPtr.Zero,IntPtr.Zero,IntPtr.Zero);
    }
    public static void Select(bool a, bool b) {
        SendMessage(Inbox, 0xF1, (IntPtr)(a ? 1 : 0), IntPtr.Zero);
        SendMessage(Sent, 0xF1, (IntPtr)(b ? 1 : 0), IntPtr.Zero);
    }
    public static void Stop() {
        form.Invoke((MethodInvoker)delegate { Application.ExitThread(); });
        if (!thread.Join(5000)) throw new TimeoutException();
    }
}
"@
    . $env:GOE_STATE_HELPER
    [FolderFixture]::Start()
    try {
        $ae = [System.Windows.Automation.AutomationElement]
        $inbox = $ae::FromHandle([FolderFixture]::Inbox)
        $sent = $ae::FromHandle([FolderFixture]::Sent)
        $plain = $ae::FromHandle([FolderFixture]::Plain)
        [FolderFixture]::Select($true,$false)
        Get-GoeFolderState $inbox $sent
        [FolderFixture]::Select($false,$true)
        Get-GoeFolderState $inbox $sent
        [FolderFixture]::Select($true,$true)
        Get-GoeFolderState $inbox $sent
        [FolderFixture]::Select($false,$false)
        Get-GoeFolderState $inbox $sent
        Get-GoeFolderState $plain $plain
        Get-GoeFolderState $inbox $plain
    } finally { [FolderFixture]::Stop() }
  `;
  const output = execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
    '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')], {
    timeout: 30_000, encoding: 'utf8',
    env: { ...process.env, GOE_STATE_HELPER: path.resolve(__dirname, '../../collector/goe/goe-folder-state.ps1') }
  });
  assert.deepEqual(output.trim().split(/\r?\n/), ['inbox', 'sent', 'ambiguous', 'ambiguous', 'unsupported', 'ambiguous']);
});
