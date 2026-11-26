$ErrorActionPreference = 'Stop'

Add-Type -ReferencedAssemblies 'System.Web.Extensions.dll' -TypeDefinition @'
using System;
using System.Collections.Concurrent;
using System.Collections.Generic;
using System.ComponentModel;
using System.Globalization;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;
using System.Web.Script.Serialization;

public static class CalendarFileWatch
{
    private static readonly IntPtr InvalidHandle = new IntPtr(-1);
    private const int BufferSize = 32 * 1024;
    private const int MaxDirectories = 512;
    private const int NotifyFileName = 0x00000001;
    private const int NotifyExtended = 2;
    private const int ErrorIoPending = 997;
    private const int ErrorNotifyEnumDir = 1022;
    private const int WaitTimeout = 258;

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, ExactSpelling = true, SetLastError = true)]
    private static extern IntPtr CreateFileW(string path, uint access, uint share, IntPtr security,
        uint disposition, uint flags, IntPtr template);

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, ExactSpelling = true)]
    private static extern uint GetDriveTypeW(string root);

    [StructLayout(LayoutKind.Sequential)]
    private struct FileIdDescriptor
    {
        public uint Size;
        public uint Type;
        public long FileId;
        public long UnionPadding;
    }

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern IntPtr OpenFileById(IntPtr volumeHint, ref FileIdDescriptor descriptor,
        uint access, uint share, IntPtr security, uint flags);

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, ExactSpelling = true, SetLastError = true)]
    private static extern uint GetFinalPathNameByHandleW(IntPtr handle, [Out] StringBuilder path, uint length, uint flags);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern IntPtr CreateIoCompletionPort(IntPtr file, IntPtr port, IntPtr key, uint threads);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool ReadDirectoryChangesExW(IntPtr directory, IntPtr buffer, int length,
        bool watchSubtree, int filter, IntPtr bytes, IntPtr overlapped, IntPtr completionRoutine, int infoClass);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool GetQueuedCompletionStatus(IntPtr port, out uint bytes, out IntPtr key,
        out IntPtr overlapped, uint milliseconds);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool PostQueuedCompletionStatus(IntPtr port, uint bytes, IntPtr key, IntPtr overlapped);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool CancelIoEx(IntPtr file, IntPtr overlapped);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool CloseHandle(IntPtr handle);

    private sealed class Command
    {
        public string op { get; set; }
        public string dir { get; set; }
        public string ino { get; set; }
        public object requestId { get; set; }
    }

    private sealed class DirectoryWatch
    {
        public string Path;
        public IntPtr Handle;
        public IntPtr Buffer;
        public IntPtr Overlapped;
        public bool Closing;
        public object CloseRequest;
    }

    private sealed class Service
    {
        private readonly ConcurrentQueue<Command> commands = new ConcurrentQueue<Command>();
        private readonly Dictionary<string, DirectoryWatch> directories =
            new Dictionary<string, DirectoryWatch>(StringComparer.Ordinal);
        private readonly Dictionary<IntPtr, DirectoryWatch> operations = new Dictionary<IntPtr, DirectoryWatch>();
        private readonly List<Command> barriers = new List<Command>();
        private readonly JavaScriptSerializer output = new JavaScriptSerializer();
        private readonly TextWriter writer = new StreamWriter(Console.OpenStandardOutput(), new UTF8Encoding(false)) { AutoFlush = true };
        private IntPtr port;
        private bool stopping;

        public void Run()
        {
            port = CreateIoCompletionPort(InvalidHandle, IntPtr.Zero, IntPtr.Zero, 1);
            if (port == IntPtr.Zero) throw new Win32Exception();
            try
            {
                Write(new { type = "ready" });
                new Thread(ReadCommands) { IsBackground = true }.Start();
                int drainCount = 0;
                while (!stopping || operations.Count > 0)
                {
                    uint bytes;
                    IntPtr key, overlapped;
                    uint wait = barriers.Count == 0 ? uint.MaxValue : 0;
                    bool success = GetQueuedCompletionStatus(port, out bytes, out key, out overlapped, wait);
                    int error = success ? 0 : Marshal.GetLastWin32Error();
                    if (overlapped != IntPtr.Zero) Complete(operations[overlapped], bytes, error);
                    else if (error == WaitTimeout)
                    {
                        ReplyToBarriers(true);
                        drainCount = 0;
                    }
                    else if (!success) throw new Win32Exception(error);
                    else
                    {
                        Command command;
                        if (!stopping && commands.TryDequeue(out command)) RunCommand(command);
                    }
                    if (barriers.Count > 0 && ++drainCount >= 1024)
                    {
                        ReplyToBarriers(false);
                        drainCount = 0;
                    }
                }
            }
            finally
            {
                // In the normal stop path the completion loop drains every cancellation before disposal.
                foreach (DirectoryWatch watch in operations.Values) CloseHandle(watch.Handle);
                CloseHandle(port);
            }
        }

        private void ReadCommands()
        {
            JavaScriptSerializer input = new JavaScriptSerializer { MaxJsonLength = 65536 };
            using (TextReader reader = new StreamReader(Console.OpenStandardInput(), new UTF8Encoding(false)))
            {
                try
                {
                    string line;
                    while ((line = reader.ReadLine()) != null)
                    {
                        Command command = input.Deserialize<Command>(line);
                        if (command == null) break;
                        Queue(command);
                        if (command.op == "stop") return;
                    }
                }
                catch (ArgumentException) { }
                catch (InvalidOperationException) { }
                catch (IOException) { }
            }
            Queue(new Command { op = "stop" });
        }

        private void Queue(Command command)
        {
            commands.Enqueue(command);
            PostQueuedCompletionStatus(port, 0, IntPtr.Zero, IntPtr.Zero);
        }

        private void Write(object message)
        {
            writer.WriteLine(output.Serialize(message));
        }

        private void Reply(Command command, bool ok, string error = null)
        {
            Write(new { type = "ack", requestId = command.requestId, ok = ok, error = error });
        }

        private void ReplyToBarriers(bool drained)
        {
            foreach (Command barrier in barriers) Reply(barrier, drained, drained ? null : "The event queue did not drain.");
            barriers.Clear();
        }

        private void RunCommand(Command command)
        {
            if (command.op == "stop")
            {
                stopping = true;
                ReplyToBarriers(false);
                foreach (DirectoryWatch watch in operations.Values) BeginClose(watch, null);
                return;
            }
            if (command.op == "barrier")
            {
                barriers.Add(command);
                return;
            }
            DirectoryWatch watchForPath;
            directories.TryGetValue(command.dir ?? "", out watchForPath);
            if (command.op == "locate")
            {
                bool available = watchForPath != null && !watchForPath.Closing;
                string found = available ? Locate(watchForPath, command.ino) : null;
                Write(new { type = "ack", requestId = command.requestId, ok = available, path = found });
                return;
            }
            if (String.IsNullOrEmpty(command.dir) || command.dir.Length < 3 ||
                command.dir[1] != ':' || command.dir[2] != '\\')
            {
                Reply(command, false, "A local drive directory is required.");
                return;
            }
            if (command.op == "watch")
            {
                if (watchForPath != null) Reply(command, !watchForPath.Closing);
                else if (operations.Count >= MaxDirectories) Reply(command, false, "Too many watched directories.");
                else Watch(command);
            }
            else if (command.op == "unwatch")
            {
                if (watchForPath == null) Reply(command, true);
                else if (watchForPath.Closing) Reply(command, false);
                else BeginClose(watchForPath, command.requestId);
            }
            else Reply(command, false, "Unknown watcher operation.");
        }

        private static string Locate(DirectoryWatch watch, string inode)
        {
            ulong id;
            if (inode == null || inode.Length > 16 ||
                !UInt64.TryParse(inode, NumberStyles.AllowHexSpecifier, CultureInfo.InvariantCulture, out id) || id == 0) return null;
            FileIdDescriptor descriptor = new FileIdDescriptor {
                Size = (uint)Marshal.SizeOf(typeof(FileIdDescriptor)), FileId = unchecked((long)id)
            };
            const uint allShare = 7;
            IntPtr handle = OpenFileById(watch.Handle, ref descriptor, 0, allShare, IntPtr.Zero, 0);
            if (handle == InvalidHandle) return null;
            try
            {
                StringBuilder path = new StringBuilder(512);
                uint length = GetFinalPathNameByHandleW(handle, path, (uint)path.Capacity, 0);
                if (length >= path.Capacity && length <= 32768)
                {
                    path = new StringBuilder((int)length);
                    length = GetFinalPathNameByHandleW(handle, path, (uint)path.Capacity, 0);
                }
                if (length == 0 || length >= path.Capacity) return null;
                string result = path.ToString();
                string drivePrefix = @"\\?\" + watch.Path.Substring(0, 3);
                return result.StartsWith(drivePrefix, StringComparison.OrdinalIgnoreCase) ? result.Substring(4) : null;
            }
            finally
            {
                CloseHandle(handle);
            }
        }

        private void Watch(Command command)
        {
            DirectoryWatch watch = new DirectoryWatch { Path = command.dir };
            try
            {
                uint driveType = GetDriveTypeW(command.dir.Substring(0, 3));
                if (driveType != 2 && driveType != 3 && driveType != 6)
                    throw new IOException("The watcher requires a local drive.");
                const uint fileListDirectory = 1, allShare = 7, openExisting = 3;
                const uint backupSemantics = 0x02000000, overlapped = 0x40000000;
                watch.Handle = CreateFileW(@"\\?\" + command.dir, fileListDirectory, allShare,
                    IntPtr.Zero, openExisting, backupSemantics | overlapped, IntPtr.Zero);
                if (watch.Handle == InvalidHandle) throw new Win32Exception();
                if (CreateIoCompletionPort(watch.Handle, port, new IntPtr(1), 0) == IntPtr.Zero) throw new Win32Exception();
                watch.Buffer = Marshal.AllocHGlobal(BufferSize);
                watch.Overlapped = Marshal.AllocHGlobal(Marshal.SizeOf(typeof(NativeOverlapped)));
                Arm(watch);
            }
            catch (Exception error)
            {
                Release(watch);
                Reply(command, false, error.Message);
                return;
            }
            operations.Add(watch.Overlapped, watch);
            directories.Add(watch.Path, watch);
            Reply(command, true);
        }

        private static void Arm(DirectoryWatch watch)
        {
            Marshal.StructureToPtr(new NativeOverlapped(), watch.Overlapped, false);
            if (ReadDirectoryChangesExW(watch.Handle, watch.Buffer, BufferSize, false, NotifyFileName,
                IntPtr.Zero, watch.Overlapped, IntPtr.Zero, NotifyExtended)) return;
            int error = Marshal.GetLastWin32Error();
            if (error != ErrorIoPending) throw new Win32Exception(error);
        }

        private static void BeginClose(DirectoryWatch watch, object requestId)
        {
            if (watch.Closing) return;
            watch.Closing = true;
            watch.CloseRequest = requestId;
            CancelIoEx(watch.Handle, watch.Overlapped);
        }

        private void Complete(DirectoryWatch watch, uint bytes, int error)
        {
            if (watch.Closing)
            {
                Remove(watch);
                if (watch.CloseRequest != null) Write(new { type = "ack", requestId = watch.CloseRequest, ok = true });
                return;
            }
            try
            {
                if (error != 0 && error != ErrorNotifyEnumDir) throw new Win32Exception(error);
                if (error != 0 || bytes == 0 || !ReadRecords(watch, bytes)) Write(new { type = "overflow", dir = watch.Path });
                Arm(watch);
            }
            catch (Exception failure)
            {
                Remove(watch);
                Write(new { type = "error", dir = watch.Path, error = failure.Message });
            }
        }

        private bool ReadRecords(DirectoryWatch watch, uint bytes)
        {
            // FILE_NOTIFY_EXTENDED_INFORMATION has FileId at byte 64 and its variable UTF-16 filename at byte 84.
            const int nameOffset = 84;
            if (bytes > BufferSize) return false;
            List<object> records = new List<object>();
            for (int offset = 0; ; )
            {
                if (bytes - offset < nameOffset) return false;
                IntPtr entry = IntPtr.Add(watch.Buffer, offset);
                int next = Marshal.ReadInt32(entry, 0);
                int length = Marshal.ReadInt32(entry, 80);
                long recordLength = nameOffset + (long)length;
                if (length <= 0 || length % 2 != 0 || recordLength > bytes - offset) return false;
                if (next != 0 && (next < recordLength || next % 4 != 0 || next > bytes - offset - nameOffset)) return false;
                int action = Marshal.ReadInt32(entry, 4);
                uint attributes = unchecked((uint)Marshal.ReadInt32(entry, 56));
                ulong fileId = unchecked((ulong)Marshal.ReadInt64(entry, 64));
                if (fileId != 0 && (attributes & 16) == 0)
                {
                    string name = Marshal.PtrToStringUni(IntPtr.Add(entry, nameOffset), length / 2);
                    records.Add(new { type = "event", dir = watch.Path, action = action, name = name,
                        ino = fileId.ToString("x", CultureInfo.InvariantCulture), attributes = attributes });
                }
                if (next == 0) break;
                offset += next;
            }
            foreach (object record in records) Write(record);
            return true;
        }

        private void Remove(DirectoryWatch watch)
        {
            operations.Remove(watch.Overlapped);
            directories.Remove(watch.Path);
            Release(watch);
        }

        private static void Release(DirectoryWatch watch)
        {
            if (watch.Handle != IntPtr.Zero && watch.Handle != InvalidHandle) CloseHandle(watch.Handle);
            if (watch.Overlapped != IntPtr.Zero) Marshal.FreeHGlobal(watch.Overlapped);
            if (watch.Buffer != IntPtr.Zero) Marshal.FreeHGlobal(watch.Buffer);
        }
    }

    public static void Run()
    {
        new Service().Run();
    }
}
'@

[CalendarFileWatch]::Run()
