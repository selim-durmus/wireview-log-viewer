namespace WireViewViewer;

static class Program
{
    [STAThread]
    static void Main(string[] args)
    {
        ApplicationConfiguration.Initialize();
        Application.Run(new MainForm(args.FirstOrDefault(a => a.EndsWith(".wvl", StringComparison.OrdinalIgnoreCase) || a.EndsWith(".csv", StringComparison.OrdinalIgnoreCase))));
    }
}
