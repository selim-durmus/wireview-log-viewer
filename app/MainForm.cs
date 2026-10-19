using System.Collections.Concurrent;
using System.Reflection;
using System.Text.Json;
using System.Text.Json.Nodes;
using Microsoft.Web.WebView2.Core;
using Microsoft.Web.WebView2.WinForms;

namespace WireViewViewer;

// Hosts the viewer page (embedded web files) in WebView2 and answers its requests.
public sealed class MainForm : Form
{
    const string Origin = "https://app.wireview/";
    static readonly JsonSerializerOptions Json = new(JsonSerializerDefaults.Web);

    readonly WebView2 _web = new() { Dock = DockStyle.Fill, DefaultBackgroundColor = Color.FromArgb(13, 13, 13) };
    readonly DeviceService _device;
    readonly ConcurrentDictionary<string, string> _openTokens = new();
    readonly string? _startFile;

    public MainForm(string? startFile)
    {
        _startFile = startFile;
        Text = "WireView Log Viewer";
        BackColor = Color.FromArgb(13, 13, 13);
        StartPosition = FormStartPosition.CenterScreen;
        Size = new Size(1500, 950);
        MinimumSize = new Size(800, 600);
        try { Icon = Icon.ExtractAssociatedIcon(Application.ExecutablePath); } catch { /* default icon */ }
        Controls.Add(_web);
        _device = new DeviceService(Emit);
        Load += async (_, _) => await InitAsync();
        FormClosed += (_, _) => _device.Dispose();
    }

    async Task InitAsync()
    {
        try
        {
            var env = await CoreWebView2Environment.CreateAsync(null, AppPaths.WebView);
            await _web.EnsureCoreWebView2Async(env);
        }
        catch (WebView2RuntimeNotFoundException)
        {
            MessageBox.Show("This app needs the Microsoft Edge WebView2 Runtime. Install it from Microsoft and start the app again.", Text);
            Close();
            return;
        }
        var core = _web.CoreWebView2;
        core.Settings.IsStatusBarEnabled = false;
        core.Settings.AreDefaultContextMenusEnabled = true;
        core.AddWebResourceRequestedFilter(Origin + "*", CoreWebView2WebResourceContext.All);
        core.WebResourceRequested += OnResource;
        core.WebMessageReceived += (_, e) => _ = HandleAsync(e.TryGetWebMessageAsString());
        core.NewWindowRequested += (_, e) => { e.Handled = true; OpenExternal(e.Uri); };
        core.NavigationStarting += (_, e) => { if (!e.Uri.StartsWith(Origin)) { e.Cancel = true; OpenExternal(e.Uri); } };
        core.Navigate(Origin + "index.html");
    }

    static void OpenExternal(string uri)
    {
        if (uri.StartsWith("https://", StringComparison.OrdinalIgnoreCase))
            System.Diagnostics.Process.Start(new System.Diagnostics.ProcessStartInfo(uri) { UseShellExecute = true });
    }

    // ---- local resources ----
    void OnResource(object? sender, CoreWebView2WebResourceRequestedEventArgs e)
    {
        var path = Uri.UnescapeDataString(new Uri(e.Request.Uri).AbsolutePath.TrimStart('/'));
        Stream? body = null;
        string type = "application/octet-stream";
        if (path.StartsWith("history/"))
        {
            var name = Path.GetFileName(path);
            var file = Path.Combine(AppPaths.History, name);
            if (name.EndsWith(".wvl", StringComparison.OrdinalIgnoreCase) && File.Exists(file)) body = File.OpenRead(file);
        }
        else if (path.StartsWith("open/") && _openTokens.TryGetValue(path[5..], out var real) && File.Exists(real))
        {
            body = File.OpenRead(real);
        }
        else
        {
            body = Assembly.GetExecutingAssembly().GetManifestResourceStream("web/" + path);
            type = Path.GetExtension(path) switch { ".html" => "text/html; charset=utf-8", ".js" => "text/javascript; charset=utf-8", ".css" => "text/css", _ => type };
        }
        var env = _web.CoreWebView2.Environment;
        e.Response = body == null
            ? env.CreateWebResourceResponse(null, 404, "Not found", "")
            : env.CreateWebResourceResponse(body, 200, "OK", $"Content-Type: {type}\r\nCache-Control: no-store");
    }

    // ---- bridge ----
    void Emit(string evt, object? data)
    {
        var json = JsonSerializer.Serialize(new { @event = evt, data }, Json);
        if (IsDisposed) return;
        try { BeginInvoke(() => { if (_web.CoreWebView2 != null) _web.CoreWebView2.PostWebMessageAsJson(json); }); }
        catch (InvalidOperationException) { /* window closing */ }
    }

    async Task HandleAsync(string message)
    {
        var req = JsonNode.Parse(message)!;
        var id = req["id"]?.GetValue<int>() ?? 0;
        var method = req["method"]?.GetValue<string>() ?? "";
        var args = req["params"];
        object? result = null;
        string? error = null;
        try
        {
            result = await Task.Run(() => Dispatch(method, args));
        }
        catch (Exception ex) { error = ex.Message; }
        var json = JsonSerializer.Serialize(new { id, result, error }, Json);
        _web.CoreWebView2.PostWebMessageAsJson(json);
    }

    object? Dispatch(string method, JsonNode? args)
    {
        switch (method)
        {
            case "app.info":
                string? startUrl = null, startName = null;
                if (_startFile != null && File.Exists(_startFile))
                {
                    var token = Guid.NewGuid().ToString("N");
                    _openTokens[token] = _startFile;
                    startUrl = Origin + "open/" + token;
                    startName = Path.GetFileName(_startFile);
                }
                return new { version = Application.ProductVersion, dataDir = AppPaths.Data, startUrl, startName };
            case "power.events":
                var (events, fresh, err) = PowerHistory.LoadAndUpdate();
                return new { events, fromWindows = fresh, error = err };
            case "device.ports":
                return WireViewDevice.FindPorts();
            case "device.connect":
                return _device.Connect(args?["port"]?.GetValue<string>());
            case "device.disconnect":
                _device.Disconnect();
                return true;
            case "device.clearFaults":
                return _device.ClearFaults();
            case "device.download":
                return _device.DownloadHistory(args?["full"]?.GetValue<bool>() ?? false);
            case "history.list":
                return new DirectoryInfo(AppPaths.History).GetFiles("*.wvl").OrderByDescending(f => f.Name)
                    .Select(f => new { name = f.Name, url = Origin + "history/" + f.Name, size = f.Length }).ToList();
            case "history.reveal":
                var target = args?["name"]?.GetValue<string>();
                var p = target != null ? Path.Combine(AppPaths.History, Path.GetFileName(target)) : AppPaths.History;
                System.Diagnostics.Process.Start("explorer.exe", File.Exists(p) ? $"/select,\"{p}\"" : $"\"{AppPaths.History}\"");
                return true;
            default:
                throw new InvalidOperationException("Unknown request " + method);
        }
    }
}
