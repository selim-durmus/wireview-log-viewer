// Owns the device connection: live polling, history download and clock sync.
namespace WireViewViewer;

public sealed class DeviceService : IDisposable
{
    readonly Action<string, object?> _emit;
    WireViewDevice? _dev;
    System.Threading.Timer? _live;
    volatile bool _paused;
    int _liveBusy;

    public DeviceService(Action<string, object?> emit) { _emit = emit; }

    public bool Connected => _dev != null;

    public object Connect(string? port)
    {
        Disconnect();
        _dev = WireViewDevice.Connect(port);
        _live = new System.Threading.Timer(_ => PollLive(), null, 0, 1000);
        return _dev.Info!;
    }

    public void Disconnect()
    {
        _live?.Dispose(); _live = null;
        _dev?.Dispose(); _dev = null;
    }

    void Lost(Exception ex)
    {
        Disconnect();
        _emit("device.status", new { connected = false, error = "Connection to the WireView was lost: " + ex.Message });
    }

    void PollLive()
    {
        var dev = _dev;
        if (dev == null || _paused || Interlocked.Exchange(ref _liveBusy, 1) == 1) return;
        try { _emit("device.live", dev.ReadSensors()); }
        catch (Exception ex) when (ex is TimeoutException or IOException or InvalidOperationException or UnauthorizedAccessException) { Lost(ex); }
        finally { Interlocked.Exchange(ref _liveBusy, 0); }
    }

    // Clears the fault warnings (active and logged), then asks the display to leave its fault
    // screen, as WireView2 does. A fault whose cause is still present comes straight back.
    public object ClearFaults()
    {
        var dev = _dev ?? throw new InvalidOperationException("Connect the WireView first.");
        var before = dev.ReadSensors();
        dev.ClearFaults(WireViewDevice.KnownFaults, WireViewDevice.KnownFaults);
        Thread.Sleep(150);
        dev.Screen(0xEF);
        Thread.Sleep(150);
        var after = dev.ReadSensors();
        if ((after.FaultStatus & WireViewDevice.KnownFaults) == 0 && (after.FaultLog & WireViewDevice.KnownFaults) != 0)
        {
            dev.ClearFaultsDirect(WireViewDevice.KnownFaults, WireViewDevice.KnownFaults);
            Thread.Sleep(150);
            dev.Screen(0xEF);
            Thread.Sleep(150);
            after = dev.ReadSensors();
        }
        _emit("device.live", after);
        return new { before = new { active = before.FaultStatus, logged = before.FaultLog }, after = new { active = after.FaultStatus, logged = after.FaultLog } };
    }

    public sealed record DownloadResult(string FileName, string Url, string Path, long NewestTick, int UsedSectors, int IntervalS,
        double ReadEpoch, bool Incremental, int PagesRead, double Seconds);

    const int Sectors = WireViewDevice.HistoryLength / WireViewDevice.Sector, Pages = WireViewDevice.Sector / WireViewDevice.Page;
    int _pagesRead;

    // Reads the 8 MiB history region. After the first download only the part written since the
    // previous download is read; everything older is taken from that saved download.
    public DownloadResult DownloadHistory(bool forceFull = false)
    {
        var dev = _dev ?? throw new InvalidOperationException("Connect the WireView first.");
        var sw = System.Diagnostics.Stopwatch.StartNew();
        _pagesRead = 0;
        byte[]? buf = null;
        bool incremental = false;
        _paused = true;
        while (Volatile.Read(ref _liveBusy) == 1) Thread.Sleep(5);
        try
        {
            dev.Screen(0xF0); // pause display updates while reading, as WireView2 does
            var previous = forceFull ? null : LoadPrevious(dev.Info!.Uid);
            if (previous != null) buf = TryIncremental((sec, pg) => ReadPage(dev, sec, pg), previous, (d, t) => _emit("download.progress", new { phase = "Reading new data", done = d, total = t }));
            incremental = buf != null;
            buf ??= FullRead(dev);
        }
        catch (Exception ex) when (ex is TimeoutException or IOException) { Lost(ex); throw; }
        finally
        {
            try { dev.Screen(0xF1); } catch { /* reported by the next poll */ }
            _paused = false;
        }
        var readEpoch = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds() / 1000.0;
        var name = $"log-{DateTime.Now:yyyyMMdd-HHmmss}.wvl";
        var path = System.IO.Path.Combine(AppPaths.History, name);
        File.WriteAllBytes(path, buf);
        File.WriteAllText(System.IO.Path.ChangeExtension(path, ".json"), System.Text.Json.JsonSerializer.Serialize(new
        {
            uid = dev.Info!.Uid, firmware = dev.Info.BuildInfo, savedAt = DateTimeOffset.Now, incremental, pagesRead = _pagesRead,
        }));
        PruneDownloads();
        var (tick, nextSlot) = FindNewest(buf);
        int interval = dev.Info?.Config?.LoggingIntervalS is > 0 and var i ? i : 60;
        if (nextSlot >= 0) _ = Task.Run(() => SyncClock(dev, buf, nextSlot, tick, interval, readEpoch));
        int used = Enumerable.Range(0, Sectors).Count(s => !PageErased(buf, s));
        return new DownloadResult(name, "https://app.wireview/history/" + name, path, tick, used, interval, readEpoch,
            incremental, _pagesRead, Math.Round(sw.Elapsed.TotalSeconds, 1));
    }

    // Every download holds the whole device memory, so older copies are redundant until the device
    // starts overwriting its oldest data. Keep the 10 newest plus the first download of each month.
    static void PruneDownloads()
    {
        var files = new DirectoryInfo(AppPaths.History).GetFiles("log-*.wvl").OrderByDescending(f => f.Name).ToList();
        var keep = files.Take(10).Select(f => f.Name).ToHashSet();
        foreach (var month in files.GroupBy(f => f.Name.Length >= 10 ? f.Name.Substring(4, 6) : f.Name))
            keep.Add(month.OrderBy(f => f.Name).First().Name);
        foreach (var f in files.Where(f => !keep.Contains(f.Name)))
        {
            try { f.Delete(); File.Delete(System.IO.Path.ChangeExtension(f.FullName, ".json")); } catch (IOException) { /* in use: try next time */ }
        }
    }

    byte[] ReadPage(WireViewDevice dev, int sector, int page)
    {
        _pagesRead++;
        return dev.ReadFlash(WireViewDevice.HistoryAddress + (uint)(sector * WireViewDevice.Sector + page * WireViewDevice.Page), WireViewDevice.Page);
    }

    static bool PageErased(byte[] buf, int sector)
    {
        int off = sector * WireViewDevice.Sector;
        for (int i = 0; i < WireViewDevice.Page; i++) if (buf[off + i] != 0xFF) return false;
        return true;
    }

    // Erased sectors are detected from their first page, so only used sectors are read in full.
    byte[] FullRead(WireViewDevice dev)
    {
        var buf = new byte[WireViewDevice.HistoryLength];
        Array.Fill(buf, (byte)0xFF);
        var used = new List<int>();
        for (int s = 0; s < Sectors; s++)
        {
            var page = ReadPage(dev, s, 0);
            page.CopyTo(buf, s * WireViewDevice.Sector);
            if (page.Any(b => b != 0xFF)) used.Add(s);
            if (s % 64 == 0) _emit("download.progress", new { phase = "Finding used memory", done = s, total = Sectors });
        }
        int total = used.Count * (Pages - 1), done = 0;
        foreach (var s in used)
            for (int p = 1; p < Pages; p++)
            {
                ReadPage(dev, s, p).CopyTo(buf, s * WireViewDevice.Sector + p * WireViewDevice.Page);
                if (++done % 128 == 0) _emit("download.progress", new { phase = "Reading history", done, total });
            }
        return buf;
    }

    // newest earlier download of this device (downloads from before sidecar files are accepted too;
    // the consistency check below rejects a file that doesn't match the device)
    static byte[]? LoadPrevious(string uid)
    {
        foreach (var f in new DirectoryInfo(AppPaths.History).GetFiles("log-*.wvl").OrderByDescending(f => f.Name))
        {
            if (f.Length != WireViewDevice.HistoryLength) continue;
            var meta = System.IO.Path.ChangeExtension(f.FullName, ".json");
            if (File.Exists(meta))
            {
                try
                {
                    using var doc = System.Text.Json.JsonDocument.Parse(File.ReadAllText(meta));
                    if (doc.RootElement.TryGetProperty("uid", out var u) && u.GetString() != uid) continue;
                }
                catch (System.Text.Json.JsonException) { continue; }
            }
            return File.ReadAllBytes(f.FullName);
        }
        return null;
    }

    // Flash bits only change from 1 to 0 when written; data disappears only when a whole sector is
    // erased. So every byte written in the earlier download must still be there.
    static bool Consistent(byte[] previous, int sector, byte[] page)
    {
        int off = sector * WireViewDevice.Sector;
        for (int i = 0; i < page.Length; i++)
            if (previous[off + i] != 0xFF && page[i] != previous[off + i]) return false;
        return true;
    }

    public static byte[]? TryIncremental(Func<int, int, byte[]> readPage, byte[] previous, Action<int, int>? progress = null)
    {
        int newest = NewestSector(previous);
        if (newest < 0) return null;
        var buf = (byte[])previous.Clone();
        var touched = new HashSet<int>();

        // walk forward from the earlier newest sector until reaching erased memory
        int sector = newest, erasedSeen = 0;
        for (int step = 0; step < Sectors; step++, sector = (sector + 1) % Sectors)
        {
            var first = readPage(sector, 0);
            touched.Add(sector);
            if (first.All(b => b == 0xFF))
            {
                // the firmware erases the sector(s) ahead of where it writes; mirror that, then stop
                bool wasUsed = !PageErased(buf, sector);
                Array.Fill(buf, (byte)0xFF, sector * WireViewDevice.Sector, WireViewDevice.Sector);
                if (step == 0 || !wasUsed || ++erasedSeen >= 4) break;
                continue;
            }
            if (erasedSeen > 0) { touched.Remove(sector); break; } // old data after the erased gap
            if (step == 0 && !Consistent(previous, sector, first)) return null;
            first.CopyTo(buf, sector * WireViewDevice.Sector);
            for (int p = 1; p < Pages; p++)
                readPage(sector, p).CopyTo(buf, sector * WireViewDevice.Sector + p * WireViewDevice.Page);
            progress?.Invoke(step + 1, step + 2);
        }
        if (PageErased(buf, newest)) return null; // the earlier data is gone: memory was cleared

        // spot-check that the device still holds the rest of the earlier download unchanged
        var probes = new List<int> { (newest - 1 + Sectors) % Sectors };
        var older = Enumerable.Range(0, Sectors).Where(s => !touched.Contains(s) && !PageErased(previous, s)).ToList();
        for (int k = 0; k < 6 && older.Count > 0; k++) probes.Add(older[k * older.Count / 6]);
        foreach (var s in probes.Distinct().Where(s => !touched.Contains(s) && !PageErased(previous, s)))
            if (!Consistent(previous, s, readPage(s, 0))) return null;
        return buf;
    }

    // newest sector = the last used one before the longest run of erased sectors (ring buffer)
    static int NewestSector(byte[] buf)
    {
        int n = buf.Length / WireViewDevice.Sector;
        int bestLen = 0, bestStart = -1;
        for (int s = 0; s < n; s++)
        {
            if (!PageErased(buf, s)) continue;
            int len = 0;
            while (len < n && PageErased(buf, (s + len) % n)) len++;
            if (len > bestLen) { bestLen = len; bestStart = s; }
            if (len >= n) break;
            s += len - 1;
        }
        return bestLen == 0 || bestLen == n ? -1 : (bestStart - 1 + n) % n;
    }

    static (long tick, int nextSlotOffset) FindNewest(byte[] buf)
    {
        int newest = NewestSector(buf);
        if (newest < 0) return (-1, -1);
        int bestStart = (newest + 1) % (buf.Length / WireViewDevice.Sector);
        int baseOff = newest * WireViewDevice.Sector;
        for (int k = 194; k >= 0; k--)
        {
            int off = baseOff + k * 21;
            if (BitConverter.ToUInt32(buf, off) == uint.MaxValue) continue;
            long tick = BitConverter.ToUInt32(buf, off);
            int next = k < 194 ? off + 21 : bestStart * WireViewDevice.Sector;
            return (tick, next);
        }
        return (-1, -1);
    }

    // Waits for the device to write its next sample; that moment ties device uptime to the PC clock.
    void SyncClock(WireViewDevice dev, byte[] snapshot, int nextSlot, long lastTick, int intervalS, double readEpoch)
    {
        uint pageAddr = (uint)(nextSlot & ~(WireViewDevice.Page - 1));
        var before = snapshot.AsSpan((int)pageAddr, WireViewDevice.Page).ToArray();
        var deadline = Environment.TickCount64 + (intervalS + 15) * 1000L;
        try
        {
            while (Environment.TickCount64 < deadline && _dev == dev)
            {
                Thread.Sleep(1000);
                var now = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds() / 1000.0;
                var page = dev.ReadFlash(WireViewDevice.HistoryAddress + pageAddr, WireViewDevice.Page);
                if (page.AsSpan().SequenceEqual(before)) continue;
                int rel = nextSlot - (int)pageAddr;
                long tick = rel + 4 <= WireViewDevice.Page && BitConverter.ToUInt32(page, rel) != uint.MaxValue
                    ? BitConverter.ToUInt32(page, rel) : lastTick + intervalS * 1000L;
                _emit("clock.sync", new { tick, epoch = now - 0.5, precise = true });
                return;
            }
        }
        catch { /* fall back below */ }
        if (_dev == dev) _emit("clock.sync", new { tick = lastTick, epoch = readEpoch - intervalS / 2.0, precise = false });
    }

    public void Dispose() => Disconnect();
}
