param([uint32]$CalendarHandle)
$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class ReplyVoice {
    [StructLayout(LayoutKind.Sequential)]
    struct Keyboard { public ushort key, scan; public uint flags, time; public UIntPtr extra; }
    [StructLayout(LayoutKind.Sequential)]
    struct Mouse { public int x, y; public uint data, flags, time; public UIntPtr extra; }
    [StructLayout(LayoutKind.Explicit)]
    struct Payload {
        [FieldOffset(0)] public Keyboard keyboard;
        [FieldOffset(0)] public Mouse mouse;
    }
    [StructLayout(LayoutKind.Sequential)]
    struct Input { public uint type; public Payload value; }
    [DllImport("user32.dll")] static extern IntPtr GetForegroundWindow();
    [DllImport("user32.dll")] static extern short GetAsyncKeyState(int key);
    [DllImport("user32.dll")] static extern uint SendInput(uint count, Input[] input, int size);
    static Input Key(ushort key, bool up) {
        return new Input { type = 1, value = new Payload { keyboard = new Keyboard { key = key, flags = up ? 2u : 0u } } };
    }
    public static bool Start(uint handle) {
        if (handle == 0 || unchecked((uint)GetForegroundWindow().ToInt64()) != handle) return true;
        foreach (int key in new int[] { 0x10, 0x11, 0x12, 0x5B, 0x5C }) {
            if (GetAsyncKeyState(key) < 0) return false;
        }
        Input[] keys = { Key(0x5B,false), Key(0x48,false), Key(0x48,true), Key(0x5B,true) };
        return SendInput(4,keys,Marshal.SizeOf(typeof(Input))) == 4;
    }
}
'@
[Console]::WriteLine('ready')
if ([Console]::ReadLine() -eq 'start' -and -not [ReplyVoice]::Start($CalendarHandle)) { exit 1 }
