// Microphone capture through WASAPI (shared mode, event-driven), for Voice Keys.
// Writes one JSON header line to stdout, then raw mono float32 little-endian samples at the device's mix rate.
// Stops when stdin is closed. Build: node scripts/build-native.js (uses the csc.exe that ships with Windows).
//   WasapiCapture.exe [--device "<label>"] [--list]
using System;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;

static class Program
{
    const int eCapture = 1, eConsole = 0, DEVICE_STATE_ACTIVE = 1;
    const int AUDCLNT_STREAMFLAGS_EVENTCALLBACK = 0x00040000;
    const uint AUDCLNT_BUFFERFLAGS_SILENT = 2;
    static readonly Guid IID_IAudioClient = new Guid("1CB9AD4C-DBFA-4c32-B178-C2F568A703B2");
    static readonly Guid IID_IAudioClient3 = new Guid("7ED4EE07-8E67-4CD4-8C1A-2B7A5987AD42");
    static readonly Guid IID_IAudioCaptureClient = new Guid("C8ADBD64-E71E-48a0-A4DE-185C395CD317");

    [ComImport, Guid("BCDE0395-E52F-467C-8E3D-C4579291692E")] class MMDeviceEnumeratorCom { }

    [ComImport, Guid("A95664D2-9614-4F35-A746-DE8DB63617E6"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    interface IMMDeviceEnumerator
    {
        [PreserveSig] int EnumAudioEndpoints(int dataFlow, int stateMask, out IMMDeviceCollection devices);
        [PreserveSig] int GetDefaultAudioEndpoint(int dataFlow, int role, out IMMDevice endpoint);
        [PreserveSig] int GetDevice([MarshalAs(UnmanagedType.LPWStr)] string id, out IMMDevice device);
        [PreserveSig] int RegisterEndpointNotificationCallback(IntPtr client);
        [PreserveSig] int UnregisterEndpointNotificationCallback(IntPtr client);
    }
    [ComImport, Guid("0BD7A1BE-7A1A-44DB-8397-CC5392387B5E"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    interface IMMDeviceCollection
    {
        [PreserveSig] int GetCount(out uint count);
        [PreserveSig] int Item(uint index, out IMMDevice device);
    }
    [ComImport, Guid("D666063F-1587-4E43-81F1-B948E807363F"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    interface IMMDevice
    {
        [PreserveSig] int Activate(ref Guid iid, int clsCtx, IntPtr activationParams, [MarshalAs(UnmanagedType.IUnknown)] out object iface);
        [PreserveSig] int OpenPropertyStore(int access, out IPropertyStore properties);
        [PreserveSig] int GetId([MarshalAs(UnmanagedType.LPWStr)] out string id);
        [PreserveSig] int GetState(out int state);
    }
    [ComImport, Guid("886D8EEB-8CF2-4446-8D02-CDBA1DBDCF99"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    interface IPropertyStore
    {
        [PreserveSig] int GetCount(out uint count);
        [PreserveSig] int GetAt(uint index, out PropertyKey key);
        [PreserveSig] int GetValue(ref PropertyKey key, out PropVariant value);
        [PreserveSig] int SetValue(ref PropertyKey key, ref PropVariant value);
        [PreserveSig] int Commit();
    }
    [StructLayout(LayoutKind.Sequential)] struct PropertyKey { public Guid fmtid; public uint pid; }
    [StructLayout(LayoutKind.Explicit, Size = 24)] struct PropVariant { [FieldOffset(0)] public ushort vt; [FieldOffset(8)] public IntPtr ptr; }

    [ComImport, Guid("7ED4EE07-8E67-4CD4-8C1A-2B7A5987AD42"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    interface IAudioClient3
    {
        // IAudioClient
        [PreserveSig] int Initialize(int shareMode, int streamFlags, long bufferDuration, long periodicity, IntPtr format, ref Guid sessionGuid);
        [PreserveSig] int GetBufferSize(out uint frames);
        [PreserveSig] int GetStreamLatency(out long latency);
        [PreserveSig] int GetCurrentPadding(out uint padding);
        [PreserveSig] int IsFormatSupported(int shareMode, IntPtr format, out IntPtr closest);
        [PreserveSig] int GetMixFormat(out IntPtr format);
        [PreserveSig] int GetDevicePeriod(out long defaultPeriod, out long minimumPeriod);
        [PreserveSig] int Start();
        [PreserveSig] int Stop();
        [PreserveSig] int Reset();
        [PreserveSig] int SetEventHandle(IntPtr eventHandle);
        [PreserveSig] int GetService(ref Guid iid, [MarshalAs(UnmanagedType.IUnknown)] out object service);
        // IAudioClient2
        [PreserveSig] int IsOffloadCapable(int category, out bool capable);
        [PreserveSig] int SetClientProperties(IntPtr properties);
        [PreserveSig] int GetBufferSizeLimits(IntPtr format, bool eventDriven, out long minDuration, out long maxDuration);
        // IAudioClient3
        [PreserveSig] int GetSharedModeEnginePeriod(IntPtr format, out uint defaultPeriodFrames, out uint fundamentalPeriodFrames, out uint minPeriodFrames, out uint maxPeriodFrames);
        [PreserveSig] int GetCurrentSharedModeEnginePeriod(out IntPtr format, out uint currentPeriodFrames);
        [PreserveSig] int InitializeSharedAudioStream(int streamFlags, uint periodFrames, IntPtr format, ref Guid sessionGuid);
    }
    [ComImport, Guid("1CB9AD4C-DBFA-4c32-B178-C2F568A703B2"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    interface IAudioClient
    {
        [PreserveSig] int Initialize(int shareMode, int streamFlags, long bufferDuration, long periodicity, IntPtr format, ref Guid sessionGuid);
        [PreserveSig] int GetBufferSize(out uint frames);
        [PreserveSig] int GetStreamLatency(out long latency);
        [PreserveSig] int GetCurrentPadding(out uint padding);
        [PreserveSig] int IsFormatSupported(int shareMode, IntPtr format, out IntPtr closest);
        [PreserveSig] int GetMixFormat(out IntPtr format);
        [PreserveSig] int GetDevicePeriod(out long defaultPeriod, out long minimumPeriod);
        [PreserveSig] int Start();
        [PreserveSig] int Stop();
        [PreserveSig] int Reset();
        [PreserveSig] int SetEventHandle(IntPtr eventHandle);
        [PreserveSig] int GetService(ref Guid iid, [MarshalAs(UnmanagedType.IUnknown)] out object service);
    }
    [ComImport, Guid("C8ADBD64-E71E-48a0-A4DE-185C395CD317"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    interface IAudioCaptureClient
    {
        [PreserveSig] int GetBuffer(out IntPtr data, out uint frames, out uint flags, out ulong devicePosition, out ulong qpcPosition);
        [PreserveSig] int ReleaseBuffer(uint frames);
        [PreserveSig] int GetNextPacketSize(out uint frames);
    }

    [DllImport("kernel32.dll")] static extern IntPtr CreateEvent(IntPtr attributes, bool manualReset, bool initialState, string name);
    [DllImport("kernel32.dll")] static extern uint WaitForSingleObject(IntPtr handle, uint milliseconds);
    [DllImport("ole32.dll")] static extern int PropVariantClear(ref PropVariant value);
    [DllImport("avrt.dll", CharSet = CharSet.Unicode)] static extern IntPtr AvSetMmThreadCharacteristics(string task, ref uint index);

    static void Check(int hr, string what) { if (hr < 0) throw new Exception(what + " (0x" + hr.ToString("X8") + ")"); }

    static string FriendlyName(IMMDevice device)
    {
        IPropertyStore store; Check(device.OpenPropertyStore(0, out store), "OpenPropertyStore");
        PropertyKey key = new PropertyKey { fmtid = new Guid("a45c254e-df1c-4efd-8020-67d146a850e0"), pid = 14 };
        PropVariant value; Check(store.GetValue(ref key, out value), "GetValue");
        string name = value.vt == 31 ? Marshal.PtrToStringUni(value.ptr) : "";
        PropVariantClear(ref value);
        return name ?? "";
    }

    // Chromium labels look like "Default - Microphone (Realtek) (0bda:4014)" or "По умолчанию — Analogue 1 + 2 (Focusrite USB Audio)";
    // WASAPI names have neither the prefix (with a hyphen, en dash or em dash) nor the vendor id.
    static string Clean(string label)
    {
        string text = (label ?? "").Trim();
        string[] prefixes = { "Default", "Communications", "По умолчанию", "По-умолчанию", "Связь" };
        foreach (string prefix in prefixes)
        {
            if (!text.StartsWith(prefix, StringComparison.OrdinalIgnoreCase)) continue;
            int at = prefix.Length;
            while (at < text.Length && text[at] == ' ') at++;
            if (at < text.Length && (text[at] == '-' || text[at] == '–' || text[at] == '—')) { text = text.Substring(at + 1).Trim(); break; }
        }
        int open = text.LastIndexOf(" (");
        if (open > 0 && text.EndsWith(")") && text.Length - open <= 14 && text.IndexOf(':', open) > 0) text = text.Substring(0, open);
        return text.Trim();
    }

    static string Json(string text) { return "\"" + (text ?? "").Replace("\\", "\\\\").Replace("\"", "\\\"") + "\""; }

    static int Main(string[] args)
    {
        Console.OutputEncoding = new UTF8Encoding(false);
        string wanted = null; bool list = false;
        for (int i = 0; i < args.Length; i++)
        {
            if (args[i] == "--device" && i + 1 < args.Length) wanted = args[++i];
            else if (args[i] == "--list") list = true;
        }
        try { return Run(wanted, list); }
        catch (Exception error) { Console.Error.WriteLine("ERROR: " + error.Message); return 2; }
    }

    static int Run(string wanted, bool list)
    {
        IMMDeviceEnumerator enumerator = (IMMDeviceEnumerator)new MMDeviceEnumeratorCom();
        IMMDevice chosen = null; string chosenName = ""; bool matched = false;
        IMMDeviceCollection collection; Check(enumerator.EnumAudioEndpoints(eCapture, DEVICE_STATE_ACTIVE, out collection), "EnumAudioEndpoints");
        uint count; Check(collection.GetCount(out count), "GetCount");
        string target = Clean(wanted);
        for (uint i = 0; i < count; i++)
        {
            IMMDevice device; Check(collection.Item(i, out device), "Item");
            string name = FriendlyName(device);
            if (list) Console.WriteLine(name);
            if (chosen == null && target.Length > 0 && (string.Equals(name, target, StringComparison.OrdinalIgnoreCase) || name.IndexOf(target, StringComparison.OrdinalIgnoreCase) >= 0 || target.IndexOf(name, StringComparison.OrdinalIgnoreCase) >= 0 && name.Length > 3))
            { chosen = device; chosenName = name; matched = true; }
        }
        if (list) return 0;
        if (chosen == null)
        {
            Check(enumerator.GetDefaultAudioEndpoint(eCapture, eConsole, out chosen), "GetDefaultAudioEndpoint");
            chosenName = FriendlyName(chosen);
        }

        object raw; Guid iid3 = IID_IAudioClient3, iid1 = IID_IAudioClient;
        IAudioClient3 client3 = null; IAudioClient client = null;
        if (chosen.Activate(ref iid3, 23, IntPtr.Zero, out raw) >= 0) client3 = (IAudioClient3)raw;
        else { Check(chosen.Activate(ref iid1, 23, IntPtr.Zero, out raw), "Activate"); client = (IAudioClient)raw; }

        IntPtr format; Guid session = Guid.Empty;
        Check(client3 != null ? client3.GetMixFormat(out format) : client.GetMixFormat(out format), "GetMixFormat");
        ushort tag = (ushort)Marshal.ReadInt16(format, 0), channels = (ushort)Marshal.ReadInt16(format, 2), bits = (ushort)Marshal.ReadInt16(format, 14);
        int rate = Marshal.ReadInt32(format, 4);
        bool isFloat = tag == 3 || (tag == 0xFFFE && Marshal.ReadInt32(format, 24) == 3);
        if (!(isFloat && bits == 32) && !(bits == 16 || bits == 24 || bits == 32)) throw new Exception("Unsupported mix format: tag " + tag + ", " + bits + " bit");

        string api = "IAudioClient"; double periodMs = 10;
        bool started = false;
        if (client3 != null)
        {
            uint def, fundamental, min, max;
            if (client3.GetSharedModeEnginePeriod(format, out def, out fundamental, out min, out max) >= 0 && min > 0
                && client3.InitializeSharedAudioStream(AUDCLNT_STREAMFLAGS_EVENTCALLBACK, min, format, ref session) >= 0)
            { api = "IAudioClient3"; periodMs = 1000.0 * min / rate; started = true; }
            else
            {   // the engine did not accept the short period: ask the same device through the plain interface
                chosen.Activate(ref iid1, 23, IntPtr.Zero, out raw); client = (IAudioClient)raw; client3 = null;
                Check(client.GetMixFormat(out format), "GetMixFormat");
            }
        }
        if (!started)
        {
            long defPeriod, minPeriod; client.GetDevicePeriod(out defPeriod, out minPeriod);
            Check(client.Initialize(0, AUDCLNT_STREAMFLAGS_EVENTCALLBACK, 0, 0, format, ref session), "Initialize");
            periodMs = defPeriod / 10000.0;
        }

        IntPtr wake = CreateEvent(IntPtr.Zero, false, false, null);
        object serviceRaw; Guid iidCapture = IID_IAudioCaptureClient;
        if (client3 != null) { Check(client3.SetEventHandle(wake), "SetEventHandle"); Check(client3.GetService(ref iidCapture, out serviceRaw), "GetService"); }
        else { Check(client.SetEventHandle(wake), "SetEventHandle"); Check(client.GetService(ref iidCapture, out serviceRaw), "GetService"); }
        IAudioCaptureClient capture = (IAudioCaptureClient)serviceRaw;

        Stream output = Console.OpenStandardOutput();
        byte[] header = Encoding.UTF8.GetBytes("{\"rate\":" + rate + ",\"channels\":" + channels + ",\"device\":" + Json(chosenName) + ",\"matched\":" + (matched ? "true" : "false") + ",\"api\":" + Json(api) + ",\"periodMs\":" + periodMs.ToString("0.##", System.Globalization.CultureInfo.InvariantCulture) + "}\n");
        output.Write(header, 0, header.Length); output.Flush();

        Thread watcher = new Thread(() => { try { while (Console.OpenStandardInput().ReadByte() >= 0) { } } catch { } Environment.Exit(0); });
        watcher.IsBackground = true; watcher.Start();

        uint mmcssIndex = 0; try { AvSetMmThreadCharacteristics("Pro Audio", ref mmcssIndex); } catch { }
        Thread.CurrentThread.Priority = ThreadPriority.Highest;
        int hrStart = client3 != null ? client3.Start() : client.Start(); Check(hrStart, "Start");

        float[] mono = new float[4096]; byte[] bytes = new byte[mono.Length * 4];
        while (true)
        {
            WaitForSingleObject(wake, 200);
            uint packet;
            while (true)
            {
                int hr = capture.GetNextPacketSize(out packet); Check(hr, "GetNextPacketSize");
                if (packet == 0) break;
                IntPtr data; uint frames, flags; ulong devicePosition, qpcPosition;
                Check(capture.GetBuffer(out data, out frames, out flags, out devicePosition, out qpcPosition), "GetBuffer");
                int done = 0;
                while (done < frames)
                {
                    int part = (int)Math.Min(mono.Length, frames - done);
                    if ((flags & AUDCLNT_BUFFERFLAGS_SILENT) != 0) Array.Clear(mono, 0, part);
                    else Convert(data, done, part, channels, bits, isFloat, mono);
                    Buffer.BlockCopy(mono, 0, bytes, 0, part * 4);
                    output.Write(bytes, 0, part * 4);
                    done += part;
                }
                Check(capture.ReleaseBuffer(frames), "ReleaseBuffer");
            }
            output.Flush();
        }
    }

    // Averages the channels of `count` frames starting at frame `start` into mono float.
    static unsafe void Convert(IntPtr data, int start, int count, int channels, int bits, bool isFloat, float[] mono)
    {
        int bytesPerSample = bits / 8, stride = channels * bytesPerSample;
        byte* basePointer = (byte*)data.ToPointer();
        for (int i = 0; i < count; i++)
        {
            byte* frame = basePointer + (long)(start + i) * stride; float sum = 0;
            for (int c = 0; c < channels; c++)
            {
                byte* p = frame + c * bytesPerSample;
                if (isFloat) sum += *(float*)p;
                else if (bits == 16) sum += *(short*)p / 32768f;
                else if (bits == 24) sum += ((p[0] | p[1] << 8 | (sbyte)p[2] << 16) / 8388608f);
                else sum += *(int*)p / 2147483648f;
            }
            mono[i] = sum / channels;
        }
    }
}
