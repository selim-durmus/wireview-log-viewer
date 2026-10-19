// WireView Pro II USB protocol (read-only subset).
// Sources: Thermal Grizzly's MIT sample (ElmorLabs-ThermalGrizzly/WireViewPro2-Python) and the
// MIT-licensed protocol notes in Gustav0ar/wireview-pro-ii (docs/protocol.md).
using System.IO.Ports;
using System.Text;
using Microsoft.Win32;

namespace WireViewViewer;

public sealed record DeviceInfo(string Port, int FirmwareVersion, string Uid, string ProductName, string BuildInfo, DeviceConfig? Config);

public sealed record DeviceConfig(
    int Version, string FriendlyName, double TempLimitC, int CurrentLimitA, double WireLimitA, int PowerLimitW,
    int ImbalanceLimitPct, int ImbalanceMinA, int ShutdownWaitS, int LoggingIntervalS, int AveragingMs,
    int DisplayFaults, int BuzzerFaults, int SoftPowerFaults, int HardPowerFaults);

public sealed record PinReading(double V, double A);

public sealed record SensorReading(
    double TempIn, double TempOut, double? Ext1, double? Ext2, int FanPct, PinReading[] Pins,
    double AvgV, int CableCapabilityW, int FaultStatus, int FaultLog);

public sealed class WireViewDevice : IDisposable
{
    public const int Vid = 0x0483, Pid = 0x5740;
    public const uint HistoryAddress = 0x0080_0000;
    public const int HistoryLength = 0x0080_0000, Sector = 4096, Page = 256;
    const string Welcome = "Thermal Grizzly WireView Pro II";
    static readonly int[] AveragingMs = { 22, 44, 89, 177, 354, 709, 1417 };

    readonly SerialPort _sp;
    readonly object _io = new();
    public DeviceInfo? Info { get; private set; }

    WireViewDevice(string port)
    {
        _sp = new SerialPort(port, 115200, Parity.None, 8, StopBits.One)
        {
            Handshake = System.IO.Ports.Handshake.None, ReadTimeout = 1000, WriteTimeout = 1000, ReadBufferSize = 64 * 1024,
        };
    }

    // COM ports of attached WireView Pro II devices, from the USB enumeration in the registry.
    public static List<string> FindPorts()
    {
        var present = SerialPort.GetPortNames().ToHashSet(StringComparer.OrdinalIgnoreCase);
        var found = new List<string>();
        using var usb = Registry.LocalMachine.OpenSubKey($@"SYSTEM\CurrentControlSet\Enum\USB\VID_{Vid:X4}&PID_{Pid:X4}");
        if (usb == null) return found;
        foreach (var inst in usb.GetSubKeyNames())
        {
            using var dp = usb.OpenSubKey($@"{inst}\Device Parameters");
            if (dp?.GetValue("PortName") is string name && present.Contains(name) && !found.Contains(name)) found.Add(name);
        }
        return found;
    }

    public static WireViewDevice Connect(string? port = null)
    {
        var ports = port != null ? new List<string> { port } : FindPorts();
        if (ports.Count == 0) throw new InvalidOperationException("No WireView Pro II found. Check the USB cable, and close WireView2 if it's open.");
        Exception? last = null;
        foreach (var p in ports)
        {
            var dev = new WireViewDevice(p);
            try { dev.DoHandshake(); return dev; }
            catch (Exception ex) { last = ex; dev.Dispose(); }
        }
        throw new InvalidOperationException("Could not talk to the WireView: " + last?.Message, last);
    }

    void DoHandshake()
    {
        try { _sp.Open(); }
        catch (UnauthorizedAccessException) { throw new InvalidOperationException($"{_sp.PortName} is in use. Close WireView2 (or any other app using the device) and try again."); }
        _sp.DiscardInBuffer();
        // Greeting: raise DTR without sending a command. Already-initialized devices may stay silent.
        _sp.DtrEnable = true;
        var hello = ReadExact(Welcome.Length + 1, 1000, allowShort: true);
        _sp.DtrEnable = false;
        if (hello.Length > 0)
        {
            var text = Encoding.ASCII.GetString(hello).TrimEnd('\0');
            if (!text.StartsWith(Welcome, StringComparison.Ordinal)) throw new InvalidOperationException("Unexpected greeting from device.");
        }
        Thread.Sleep(20);
        _sp.DiscardInBuffer();
        var vendor = Command(new byte[] { 0x01 }, 3);
        if (vendor[0] != 0xEF || (vendor[1] != 0x05 && vendor[1] != 0x06)) throw new InvalidOperationException($"Not a WireView Pro II (id {vendor[0]:X2}{vendor[1]:X2}).");
        var uid = Convert.ToHexString(Command(new byte[] { 0x02 }, 12));
        var build = Command(new byte[] { 0x0D }, 68);
        string Str(int off) => Encoding.ASCII.GetString(build, off, 32).Split('\0')[0];
        DeviceConfig? cfg = null;
        try { cfg = ReadConfig(); } catch { /* older firmware: settings unknown */ }
        Screen(0xF1);
        Info = new DeviceInfo(_sp.PortName, vendor[2], uid, Str(3), Str(35), cfg);
    }

    public DeviceConfig ReadConfig()
    {
        lock (_io)
        {
            _sp.DiscardInBuffer();
            _sp.Write(new byte[] { 0x05 }, 0, 1);
            var head = ReadExact(4, 1000);
            int size = head[2] switch { 0 => 72, 1 => 74, 2 => 96, _ => throw new InvalidOperationException("Unknown settings format " + head[2]) };
            var b = head.Concat(ReadExact(size - 4, 1000)).ToArray();
            int u16(int o) => BitConverter.ToUInt16(b, o);
            double i16x10(int o) => BitConverter.ToInt16(b, o) / 10.0;
            int avg = head[2] >= 1 && b[64] < AveragingMs.Length ? AveragingMs[b[64]] : 0;
            return new DeviceConfig(head[2], Encoding.ASCII.GetString(b, 3, 32).Split('\0')[0], i16x10(54), b[56], b[57] / 10.0, u16(58),
                b[60], b[61], b[62], b[63], avg, u16(46), u16(48), u16(50), u16(52));
        }
    }

    public SensorReading ReadSensors()
    {
        var b = Command(new byte[] { 0x04 }, 100);
        double t(int o) => BitConverter.ToInt16(b, o) / 10.0;
        double? ext(int o) { var v = t(o); return v <= -99 ? null : v; }
        var pins = new PinReading[6];
        for (int j = 0; j < 6; j++)
        {
            int o = 12 + j * 12;
            pins[j] = new PinReading(BitConverter.ToInt16(b, o) / 1000.0, BitConverter.ToUInt32(b, o + 4) / 1000.0);
        }
        int cap = b[94] switch { 0 => 600, 1 => 450, 2 => 300, 3 => 150, _ => 0 };
        return new SensorReading(t(0), t(2), ext(4), ext(6), b[10], pins, BitConverter.ToUInt16(b, 92) / 1000.0, cap,
            BitConverter.ToUInt16(b, 96), BitConverter.ToUInt16(b, 98));
    }

    public byte[] ReadFlash(uint address, int length)
    {
        var cmd = new byte[9];
        cmd[0] = 0x0A;
        BitConverter.GetBytes(address).CopyTo(cmd, 1);
        BitConverter.GetBytes(length).CopyTo(cmd, 5);
        for (int attempt = 1; ; attempt++)
        {
            try { return Command(cmd, length, 2000); }
            catch (TimeoutException) when (attempt < 3) { Thread.Sleep(10); }
        }
    }

    public void Screen(byte sub) { lock (_io) { _sp.Write(new byte[] { 0x0C, sub }, 0, 2); } }

    // Command 0E: the device ANDs its active and logged fault registers with these masks,
    // so a 0 bit clears that fault. Only the six known fault bits are ever cleared.
    public const int KnownFaults = 0x3F;
    public void ClearFaults(int activeToClear, int loggedToClear)
    {
        int keepActive = ~(activeToClear & KnownFaults) & 0xFFFF, keepLogged = ~(loggedToClear & KnownFaults) & 0xFFFF;
        var cmd = new byte[] { 0x0E, (byte)keepActive, (byte)(keepActive >> 8), (byte)keepLogged, (byte)(keepLogged >> 8) };
        lock (_io) { _sp.Write(cmd, 0, cmd.Length); }
    }

    // Same command with the masks sent as given. Used only as a fallback if the device kept
    // logged faults after ClearFaults; with AND semantics this form changes no known fault bit.
    public void ClearFaultsDirect(int active, int logged)
    {
        var cmd = new byte[] { 0x0E, (byte)active, (byte)(active >> 8), (byte)logged, (byte)(logged >> 8) };
        lock (_io) { _sp.Write(cmd, 0, cmd.Length); }
    }

    byte[] Command(byte[] cmd, int responseLength, int timeoutMs = 1000)
    {
        lock (_io)
        {
            _sp.DiscardInBuffer();
            _sp.Write(cmd, 0, cmd.Length);
            return ReadExact(responseLength, timeoutMs);
        }
    }

    byte[] ReadExact(int n, int timeoutMs, bool allowShort = false)
    {
        var buf = new byte[n];
        int got = 0;
        var deadline = Environment.TickCount64 + timeoutMs;
        while (got < n)
        {
            var left = deadline - Environment.TickCount64;
            if (left <= 0) break;
            _sp.ReadTimeout = (int)Math.Max(1, left);
            try { got += _sp.Read(buf, got, n - got); }
            catch (TimeoutException) { break; }
        }
        if (got == n) return buf;
        if (allowShort) return buf[..got];
        throw new TimeoutException($"Device sent {got} of {n} bytes.");
    }

    public void Dispose()
    {
        try { if (_sp.IsOpen) { _sp.DtrEnable = false; _sp.Close(); } } catch { /* already gone */ }
        _sp.Dispose();
    }
}
