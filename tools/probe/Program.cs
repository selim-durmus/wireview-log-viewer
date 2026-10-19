// Read-only check of the WireView protocol against a connected device.
using System.Diagnostics;
using WireViewViewer;

Console.WriteLine("ports: " + string.Join(",", WireViewDevice.FindPorts()));
using var dev = WireViewDevice.Connect();
Console.WriteLine(dev.Info);
for (int i = 0; i < 2; i++) { var s = dev.ReadSensors(); Console.WriteLine($"sensors: in {s.TempIn} out {s.TempOut} fan {s.FanPct}% cap {s.CableCapabilityW}W faults {s.FaultStatus:X}/{s.FaultLog:X} pins " + string.Join(" ", s.Pins.Select(p => $"{p.V:F2}V/{p.A:F2}A"))); Thread.Sleep(500); }
var wvl = args.Length > 0 ? File.ReadAllBytes(args[0]) : null;
var sw = Stopwatch.StartNew();
int same = 0, diff = 0;
foreach (var sector in new[] { 0, 1, 100, 300, 2047 })
  for (int p = 0; p < 16; p++)
  {
    int off = sector * 4096 + p * 256;
    var page = dev.ReadFlash(WireViewDevice.HistoryAddress + (uint)off, 256);
    if (wvl != null) { if (page.AsSpan().SequenceEqual(wvl.AsSpan(off, 256))) same++; else diff++; }
  }
Console.WriteLine($"80 page reads in {sw.ElapsedMilliseconds} ms; match with .wvl: {same} same, {diff} different");
