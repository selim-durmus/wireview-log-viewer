# WireView Log Viewer

A local history viewer for the Thermal Grizzly **WireView Pro II** GPU power monitor. It reads the device's log over USB, or from a WireView2 export. It cleans up the data, puts real dates on it and shows it as zoomable charts with an event list. Nothing leaves your PC.

> Unofficial community project, not affiliated with or endorsed by Thermal Grizzly or ElmorLabs. "WireView" is their trademark.

It comes in two forms:

- **Windows app** (`WireViewLogViewer.exe`): talks to the device directly and reads Windows' power history itself. No exports needed.
- **Browser page** (`index.html`): offline; drop a `.wvl` file (or CSV export) from WireView2 on it.

## Features

- Synced, zoomable charts for power, per-pin current (in amps or as deviation from the average), per-pin voltage and temperature
- Quick ranges: last 24 h, 48 h, 7 days, all. The last choice is remembered.
- An overview strip with a draggable window, plus a strip of power-ons
- Events: current imbalance, pin over-current, over-power, over-temperature
  - Rules default to the device's own alarm settings
  - Each event has a before / peak / after pin table
- Pin health: each pin's share of current under load
- Real dates and times, although the device has no clock (see below)
- Export the visible range or the event list as CSV
- Windows app only:
  - Live readings and a 5-minute per-pin chart
  - History updates straight from the device in under a second
  - Clock sync

## Windows app

Requirements:
- Windows 10/11 with the [.NET 10 Desktop Runtime](https://dotnet.microsoft.com/download/dotnet/10.0)
- The WebView2 Runtime (already part of Windows 11)

Close WireView2 first; only one app can use the device at a time. Then run `WireViewLogViewer.exe`.

- **Connects automatically** and shows live readings: power, per-pin current against the pin limit, temperatures, fan, cable rating and faults.
- **Update history** reads the device memory directly. With *Update when connected* (on by default), this happens every time the app connects.
  - The first read takes about 30 s.
  - After that, only data written since the last download is read, usually 1–2 memory blocks (well under a second). Everything older is taken from the previous download.
  - Before reusing it, the app spot-checks that the device still holds that older data. If not (a different device, or cleared memory), it reads everything.
  - *Full re-read* forces a complete read.
  - Downloads are kept in `%LOCALAPPDATA%\WireViewLogViewer\history\`: the 10 newest plus the first one of each month.
- **Clock sync:** after a download, the app waits for the device's next sample (up to one logging interval). That ties the current power-on to the PC clock within about ±2 s.
- **Dates for older power-ons** come from the Windows System event log, read directly. The events are archived in `%LOCALAPPDATA%\WireViewLogViewer\power-events.json`, so old dates survive after Windows rolls its log over.
- **Read-only:** the app never changes device settings and never updates firmware. It only pauses and resumes the display updates while reading, as WireView2 does.

The exe is not code-signed, so Windows SmartScreen may warn you the first time.

## Browser page

Open `index.html` (it works offline from the file system) and drop in one of these:

1. **`.wvl` (preferred).** In WireView2 (tested with 1.0.8 and firmware v05), open **Logging**, click **Read**, wait for all cycles, then **Save file…**. The `.wvl` holds the whole history.
2. **CSV exports.** One or more per-cycle **Export CSV…** files, or the live monitoring export.
3. **Optional, for dates:** double-click `export-power-events.cmd` and drop the `power-events-….csv` it saves to Downloads. The page remembers it.

## What it fixes compared to WireView2

- **"Power cycles" that aren't.** WireView2 starts a new "cycle" at every corrupted record, giving hundreds of roughly one-hour cycles. The viewer drops those records and shows the real power-ons.
- **Unreadable graphs.** Each WireView2 "cycle" starts with a junk row at uptime 0, which squeezes the real data to the right edge of the chart.
- **No dates.** The device only records uptime since power-on.
- **Damaged samples.** Samples cut at flash page boundaries are repaired where possible; values that can't be recovered show as gaps.

## How the dates work

The WireView logs 0 V on the 12 V side whenever the PC sleeps or shuts down. Every lasting 0 V ↔ 12 V change should therefore line up with a sleep, wake, shutdown, boot or power-loss event in Windows' System event log.

The matcher fits each power-on as `time = start + rate × uptime`. The rate matters because the WireView's clock drifts: the test unit runs about 0.09% slow, roughly 1.3 min per day. On the test data, power-ons with many sleep/wake cycles matched almost every change, typically within ±20 s. Power-ons with only one change are placed between their dated neighbours and marked "best guess". In the app, the clock sync dates the current power-on directly, and a time you enter by hand always wins.

## .wvl / device memory format (as decoded)

- The history is an 8 MiB region of the device's SPI flash (`0x00800000`–`0x00FFFFFF`). It's used as a ring buffer of 4096-byte sectors; a `.wvl` file is a raw dump of it.
- Each sector holds 195 records of 21 bytes: `u32 LE uptime ms | tIn | tOut | ext1 | ext2 (°C) | V1–V6 (×0.1 V) | I1–I6 (×0.1 A) | cable capability`.
- The low 2 bits of the uptime field are the record type: 0 is a measurement, 2 a power-on marker. The counter is 32-bit and wraps after about 49.7 days.
- A record crossing a 256-byte page boundary loses the 4 bytes after the boundary; the rest of the record is shifted down by 4.
- 0xFF bytes are erased flash and are treated as missing.
- Over USB (CDC serial, VID 0483 / PID 5740), pages are read with command `0A <addr LE32> <len LE32>`, up to 256 bytes at a time.

Protocol sources, both MIT-licensed:
- Thermal Grizzly's [WireViewPro2-Python](https://github.com/ElmorLabs-ThermalGrizzly/WireViewPro2-Python) sample
- The protocol notes in [Gustav0ar/wireview-pro-ii](https://github.com/Gustav0ar/wireview-pro-ii/blob/main/docs/protocol.md)

No code from WireView2 was used.

## Building

```bash
cd app
dotnet publish -c Release -o ../dist
```

This produces `dist/WireViewLogViewer.exe`, a single file of about 1.6 MB that needs the .NET 10 Desktop Runtime. The page files (`index.html`, `js/`) are embedded into the exe at build time.

## Project layout

- `index.html`: the page, including styles
- `js/decoder.js`: `.wvl` and CSV decoding (also loads in Node: `require('./js/decoder.js')`)
- `js/align.js`: matches power-ons to the Windows power history
- `js/app.js`: charts and UI, plus the device panel when running inside the app
- `app/`: the Windows app (C#, WinForms + WebView2)
  - `Device.cs`: USB protocol
  - `DeviceService.cs`: live readings, history download, clock sync
  - `PowerHistory.cs`: Windows event log
  - `MainForm.cs`: host and bridge
- `export-power-events.ps1` / `.cmd`: power history export for the browser page
- `tools/probe/`: read-only command-line check of the device protocol
- `tools/inctest/`: offline tests of the incremental reader, run as `inctest <older.wvl> <newer.wvl> <newest.wvl>`

## License

MIT. See [LICENSE](LICENSE).
