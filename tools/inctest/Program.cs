// Offline check of the incremental history reader against a simulated device.
using WireViewViewer;

const int SEC = 4096, PAGE = 256;
byte[] Load(string p) => File.ReadAllBytes(p);
(byte[]? result, int pages) Run(byte[] previous, byte[] device)
{
    int pages = 0;
    var r = DeviceService.TryIncremental((s, p) => { pages++; return device.AsSpan(s * SEC + p * PAGE, PAGE).ToArray(); }, previous);
    return (r, pages);
}
void Check(string name, byte[] previous, byte[] device, bool expectFallback = false)
{
    var (r, pages) = Run(previous, device);
    string verdict = r == null ? "fell back to full read" : r.AsSpan().SequenceEqual(device) ? "identical to device" : "MISMATCH";
    bool ok = expectFallback ? r == null : r != null && r.AsSpan().SequenceEqual(device);
    Console.WriteLine($"{(ok ? "PASS" : "FAIL")}  {name}: {verdict}, {pages} pages read");
}

// usage: inctest <older.wvl> <newer.wvl> <newest.wvl>  (three downloads of the same device, oldest first)
if (args.Length < 3) { Console.WriteLine("usage: inctest <older.wvl> <newer.wvl> <newest.wvl>"); return; }
var a = Load(args[0]);
var b = Load(args[1]);
var c = Load(args[2]);
Check("newer -> newest", b, c);
Check("older -> newest", a, c);
Check("nothing new", c, c);

// ring buffer wrapped: new data fills the rest of memory, wraps to the oldest sector, erases the next one
var wrapped = (byte[])c.Clone();
for (int s = 748; s < 2047; s++) Array.Copy(c, 100 * SEC, wrapped, s * SEC, SEC);
Array.Copy(c, 101 * SEC, wrapped, 2047 * SEC, SEC);
Array.Fill(wrapped, (byte)0xFF, 0, SEC);
Check("ring buffer wrapped", c, wrapped);

// memory cleared / different device: must not reuse the old file
var cleared = new byte[c.Length]; Array.Fill(cleared, (byte)0xFF);
Array.Copy(c, 0, cleared, 0, 20 * SEC);
Check("memory cleared since last time", c, cleared, expectFallback: true);
var other = new byte[c.Length]; Array.Fill(other, (byte)0xFF);
Array.Copy(c, 0, other, 50 * SEC, 760 * SEC);              // same kind of data, different positions
Check("memory of a different device", c, other, expectFallback: true);
