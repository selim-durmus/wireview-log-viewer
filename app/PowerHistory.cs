// Reads boot / shutdown / sleep / wake / power-loss events from the Windows System log and keeps
// them in a local archive, so dates survive after Windows rolls old events out of its log.
using System.Diagnostics.Eventing.Reader;
using System.Globalization;
using System.Text.Json;
using System.Xml.Linq;

namespace WireViewViewer;

public sealed record PowerEvent(double t, string kind);

public static class PowerHistory
{
    const string Query =
        "*[System[(Provider[@Name='Microsoft-Windows-Kernel-General'] and (EventID=12 or EventID=13))" +
        " or (Provider[@Name='Microsoft-Windows-Power-Troubleshooter'] and EventID=1)" +
        " or (Provider[@Name='Microsoft-Windows-Kernel-Power'] and EventID=42)" +
        " or (Provider[@Name='EventLog'] and EventID=6008)]]";

    static string ArchivePath => Path.Combine(AppPaths.Data, "power-events.json");

    public static (List<PowerEvent> events, int fromWindows, string? error) LoadAndUpdate()
    {
        var archive = LoadArchive();
        int fresh = 0;
        string? error = null;
        try
        {
            var read = ReadWindowsLog();
            fresh = read.Count;
            archive.AddRange(read);
        }
        catch (Exception ex) { error = ex.Message; }
        // merge: same kind within 90 s is the same event
        var merged = new List<PowerEvent>();
        foreach (var e in archive.OrderBy(e => e.t))
        {
            bool dup = false;
            for (int k = merged.Count - 1; k >= 0 && e.t - merged[k].t < 90; k--)
                if (merged[k].kind == e.kind) { dup = true; break; }
            if (!dup) merged.Add(e);
        }
        try { File.WriteAllText(ArchivePath, JsonSerializer.Serialize(merged)); } catch { /* read-only folder: keep in memory */ }
        return (merged, fresh, error);
    }

    static List<PowerEvent> LoadArchive()
    {
        try { return JsonSerializer.Deserialize<List<PowerEvent>>(File.ReadAllText(ArchivePath)) ?? new(); }
        catch { return new(); }
    }

    static double Epoch(DateTime utc) => (utc.ToUniversalTime() - DateTime.UnixEpoch).TotalSeconds;

    static List<PowerEvent> ReadWindowsLog()
    {
        var list = new List<PowerEvent>();
        var sleeps = new List<double>();
        var pending42 = new List<double>();
        using var reader = new EventLogReader(new EventLogQuery("System", PathType.LogName, Query));
        for (var rec = reader.ReadEvent(); rec != null; rec = reader.ReadEvent())
        {
            using (rec)
            {
                if (rec.TimeCreated is not DateTime created) continue;
                switch (rec.ProviderName, rec.Id)
                {
                    case ("Microsoft-Windows-Kernel-General", 12): list.Add(new(Epoch(created), "boot")); break;
                    case ("Microsoft-Windows-Kernel-General", 13): list.Add(new(Epoch(created), "shutdown")); break;
                    case ("Microsoft-Windows-Kernel-Power", 42): pending42.Add(Epoch(created)); break;
                    case ("Microsoft-Windows-Power-Troubleshooter", 1):
                        var data = XDocument.Parse(rec.ToXml()).Descendants().Where(x => x.Name.LocalName == "Data")
                            .ToDictionary(x => (string?)x.Attribute("Name") ?? "", x => x.Value);
                        if (data.TryGetValue("SleepTime", out var s) && TryUtc(s, out var st)) { list.Add(new(Epoch(st), "sleep")); sleeps.Add(Epoch(st)); }
                        if (data.TryGetValue("WakeTime", out var w) && TryUtc(w, out var wt)) list.Add(new(Epoch(wt), "wake"));
                        break;
                    case ("EventLog", 6008):
                        // property 7 holds two SYSTEMTIMEs: local, then UTC (last known running time)
                        if (rec.Properties.Count > 7 && rec.Properties[7].Value is byte[] b && b.Length >= 32)
                        {
                            ushort W(int i) => BitConverter.ToUInt16(b, 16 + 2 * i);
                            try { list.Add(new(Epoch(new DateTime(W(0), W(1), W(3), W(4), W(5), W(6), W(7), DateTimeKind.Utc)), "powerloss")); }
                            catch (ArgumentOutOfRangeException) { /* malformed record */ }
                        }
                        break;
                }
            }
        }
        // "entering sleep" only where no Power-Troubleshooter record covers it
        foreach (var t in pending42)
            if (!sleeps.Any(s => Math.Abs(s - t) < 180)) list.Add(new(t, "sleep"));
        return list;
    }

    static bool TryUtc(string s, out DateTime utc) =>
        DateTime.TryParse(s, CultureInfo.InvariantCulture, DateTimeStyles.AdjustToUniversal | DateTimeStyles.AssumeUniversal, out utc);
}
