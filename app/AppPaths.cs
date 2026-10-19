namespace WireViewViewer;

public static class AppPaths
{
    public static string Data { get; } = Ensure(Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "WireViewLogViewer"));
    public static string History { get; } = Ensure(Path.Combine(Data, "history"));
    public static string WebView { get; } = Ensure(Path.Combine(Data, "WebView2"));

    static string Ensure(string dir) { Directory.CreateDirectory(dir); return dir; }
}
