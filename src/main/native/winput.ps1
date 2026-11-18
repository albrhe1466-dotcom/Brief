# Locally - Windows input host.
# A long-lived PowerShell process that performs REAL OS-level input with user32.dll
# (SetCursorPos + SendInput). It reads one JSON command per line on stdin and writes
# one JSON reply per line on stdout. It never touches the network.

$ErrorActionPreference = 'Stop'
[Console]::InputEncoding = [System.Text.Encoding]::UTF8
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8

Add-Type -AssemblyName System.Drawing
Add-Type -AssemblyName WindowsBase
Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes
$source = @"
using System;
using System.Text;
using System.Drawing;
using System.Drawing.Drawing2D;
using System.Threading;
using System.Diagnostics;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Windows.Automation;

public static class LocallyInput
{
    [StructLayout(LayoutKind.Sequential)]
    public struct POINT { public int X; public int Y; }

    [StructLayout(LayoutKind.Sequential)]
    public struct RECT { public int Left; public int Top; public int Right; public int Bottom; }

    [StructLayout(LayoutKind.Sequential)]
    public struct MOUSEINPUT
    {
        public int dx;
        public int dy;
        public uint mouseData;
        public uint dwFlags;
        public uint time;
        public IntPtr dwExtraInfo;
    }

    [StructLayout(LayoutKind.Sequential)]
    public struct KEYBDINPUT
    {
        public ushort wVk;
        public ushort wScan;
        public uint dwFlags;
        public uint time;
        public IntPtr dwExtraInfo;
    }

    [StructLayout(LayoutKind.Sequential)]
    public struct HARDWAREINPUT
    {
        public uint uMsg;
        public ushort wParamL;
        public ushort wParamH;
    }

    [StructLayout(LayoutKind.Explicit)]
    public struct InputUnion
    {
        [FieldOffset(0)] public MOUSEINPUT mi;
        [FieldOffset(0)] public KEYBDINPUT ki;
        [FieldOffset(0)] public HARDWAREINPUT hi;
    }

    [StructLayout(LayoutKind.Sequential)]
    public struct INPUT
    {
        public uint type;
        public InputUnion U;
    }

    public delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);

    [DllImport("user32.dll", SetLastError = true)] static extern uint SendInput(uint nInputs, INPUT[] pInputs, int cbSize);
    [DllImport("user32.dll", SetLastError = true)] static extern bool SetCursorPos(int X, int Y);
    [DllImport("user32.dll")] static extern bool GetCursorPos(out POINT lpPoint);
    [DllImport("user32.dll")] static extern uint MapVirtualKey(uint uCode, uint uMapType);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern short VkKeyScan(char ch);
    [DllImport("user32.dll")] static extern uint GetDoubleClickTime();
    [DllImport("user32.dll")] static extern IntPtr GetForegroundWindow();
    [DllImport("user32.dll")] static extern bool SetForegroundWindow(IntPtr hWnd);
    [DllImport("user32.dll")] static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);
    [DllImport("user32.dll")] static extern bool IsIconic(IntPtr hWnd);
    [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr hWnd);
    [DllImport("user32.dll")] static extern bool BringWindowToTop(IntPtr hWnd);
    [DllImport("user32.dll")] static extern bool GetWindowRect(IntPtr hWnd, out RECT rect);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetWindowText(IntPtr hWnd, StringBuilder text, int count);
    [DllImport("user32.dll")] static extern int GetWindowTextLength(IntPtr hWnd);
    [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint processId);
    [DllImport("user32.dll")] static extern bool AttachThreadInput(uint idAttach, uint idAttachTo, bool fAttach);
    [DllImport("user32.dll")] static extern bool EnumWindows(EnumWindowsProc lpEnumFunc, IntPtr lParam);
    [DllImport("user32.dll")] static extern IntPtr GetWindow(IntPtr hWnd, uint uCmd);
    [DllImport("kernel32.dll")] static extern uint GetCurrentThreadId();
    [DllImport("user32.dll", SetLastError = true)] static extern bool SetProcessDpiAwarenessContext(IntPtr value);
    [DllImport("user32.dll", SetLastError = true)] static extern IntPtr SetThreadDpiAwarenessContext(IntPtr value);
    [DllImport("user32.dll")] static extern IntPtr GetThreadDpiAwarenessContext();
    [DllImport("user32.dll")] static extern int GetAwarenessFromDpiAwarenessContext(IntPtr value);
    [DllImport("user32.dll")] static extern bool SetProcessDPIAware();
    [StructLayout(LayoutKind.Sequential)]
    public struct ICONINFO
    {
        public bool fIcon;
        public int xHotspot;
        public int yHotspot;
        public IntPtr hbmMask;
        public IntPtr hbmColor;
    }

    [DllImport("user32.dll")] static extern int GetSystemMetrics(int nIndex);
    [DllImport("user32.dll")] static extern short GetAsyncKeyState(int vKey);
    [DllImport("user32.dll", SetLastError = true)] static extern bool SetSystemCursor(IntPtr hcur, uint id);
    [DllImport("user32.dll", SetLastError = true)] static extern IntPtr CopyIcon(IntPtr hIcon);
    [DllImport("user32.dll", SetLastError = true)] static extern bool DestroyIcon(IntPtr hIcon);
    [DllImport("user32.dll", SetLastError = true)] static extern bool GetIconInfo(IntPtr hIcon, out ICONINFO piconinfo);
    [DllImport("user32.dll", SetLastError = true)] static extern IntPtr CreateIconIndirect(ref ICONINFO piconinfo);
    [DllImport("gdi32.dll")] static extern bool DeleteObject(IntPtr hObject);
    [DllImport("user32.dll", CharSet = CharSet.Unicode, SetLastError = true)] static extern IntPtr LoadCursorFromFile(string lpFileName);
    [DllImport("user32.dll", SetLastError = true)] static extern bool SystemParametersInfo(uint uiAction, uint uiParam, IntPtr pvParam, uint fWinIni);
    [DllImport("user32.dll")] static extern bool PostMessage(IntPtr hWnd, uint Msg, IntPtr wParam, IntPtr lParam);
    [DllImport("winmm.dll")] public static extern uint timeBeginPeriod(uint uPeriod);
    [DllImport("winmm.dll")] public static extern uint timeEndPeriod(uint uPeriod);

    const uint INPUT_MOUSE = 0;
    const uint INPUT_KEYBOARD = 1;
    const uint MOUSEEVENTF_MOVE = 0x0001;
    const uint MOUSEEVENTF_LEFTDOWN = 0x0002;
    const uint MOUSEEVENTF_LEFTUP = 0x0004;
    const uint MOUSEEVENTF_RIGHTDOWN = 0x0008;
    const uint MOUSEEVENTF_RIGHTUP = 0x0010;
    const uint MOUSEEVENTF_MIDDLEDOWN = 0x0020;
    const uint MOUSEEVENTF_MIDDLEUP = 0x0040;
    const uint MOUSEEVENTF_WHEEL = 0x0800;
    const uint MOUSEEVENTF_HWHEEL = 0x1000;
    const uint MOUSEEVENTF_VIRTUALDESK = 0x4000;
    const uint MOUSEEVENTF_ABSOLUTE = 0x8000;
    const uint KEYEVENTF_EXTENDEDKEY = 0x0001;
    const uint KEYEVENTF_KEYUP = 0x0002;
    const uint KEYEVENTF_UNICODE = 0x0004;
    static readonly IntPtr PER_MONITOR_AWARE_V2 = new IntPtr(-4);

    public static string DpiMode = "unknown";
    static Dictionary<string, IntPtr> cursorCache = new Dictionary<string, IntPtr>();
    static bool blackCursorActive = false;

    static IntPtr BuildCursorFromBitmap(Bitmap bmp, int hotX, int hotY, string tag)
    {
        int W = bmp.Width;
        int H = bmp.Height;
        try
        {
            string curPath = System.IO.Path.Combine(System.IO.Path.GetTempPath(), "locally_cursor_v2_" + tag + "_" + W + ".cur");
            int xorBytes = W * H * 4;
            int andRowBytes = ((W + 31) / 32) * 4;
            int andBytes = andRowBytes * H;
            int dibBytes = 40 + xorBytes + andBytes;
            using (System.IO.FileStream fs = new System.IO.FileStream(curPath, System.IO.FileMode.Create, System.IO.FileAccess.Write, System.IO.FileShare.Read))
            using (System.IO.BinaryWriter bw = new System.IO.BinaryWriter(fs))
            {
                bw.Write((ushort)0);
                bw.Write((ushort)2);
                bw.Write((ushort)1);
                bw.Write((byte)(W >= 256 ? 0 : W));
                bw.Write((byte)(H >= 256 ? 0 : H));
                bw.Write((byte)0);
                bw.Write((byte)0);
                bw.Write((ushort)hotX);
                bw.Write((ushort)hotY);
                bw.Write((uint)dibBytes);
                bw.Write((uint)22);
                bw.Write((uint)40);
                bw.Write((int)W);
                bw.Write((int)(H * 2));
                bw.Write((ushort)1);
                bw.Write((ushort)32);
                bw.Write((uint)0);
                bw.Write((uint)(xorBytes + andBytes));
                bw.Write((int)0);
                bw.Write((int)0);
                bw.Write((uint)0);
                bw.Write((uint)0);
                for (int y = H - 1; y >= 0; y--)
                {
                    for (int x = 0; x < W; x++)
                    {
                        Color c = bmp.GetPixel(x, y);
                        bw.Write(c.B);
                        bw.Write(c.G);
                        bw.Write(c.R);
                        bw.Write(c.A);
                    }
                }
                for (int i = 0; i < andBytes; i++) bw.Write((byte)0);
            }
            IntPtr loaded = LoadCursorFromFile(curPath);
            if (loaded != IntPtr.Zero) return loaded;
        }
        catch { }

        IntPtr hIcon = bmp.GetHicon();
        IntPtr fallback = IntPtr.Zero;
        ICONINFO ii;
        if (GetIconInfo(hIcon, out ii))
        {
            ii.fIcon = false;
            ii.xHotspot = hotX;
            ii.yHotspot = hotY;
            fallback = CreateIconIndirect(ref ii);
            if (ii.hbmMask != IntPtr.Zero) DeleteObject(ii.hbmMask);
            if (ii.hbmColor != IntPtr.Zero) DeleteObject(ii.hbmColor);
        }
        DestroyIcon(hIcon);
        return fallback;
    }

    static IntPtr EnsureProviderCursor(string style, string openAiLogoPath)
    {
        string key = (style ?? "gemini").Trim().ToLowerInvariant();
        if (key == "claude") key = "anthropic";
        if (key != "gemini" && key != "openai" && key != "anthropic" && key != "openrouter") key = "gemini";
        IntPtr cached;
        if (cursorCache.TryGetValue(key, out cached) && cached != IntPtr.Zero) return cached;

        const int W = 48;
        const int H = 48;
        using (Bitmap bmp = new Bitmap(W, H, System.Drawing.Imaging.PixelFormat.Format32bppArgb))
        using (Graphics g = Graphics.FromImage(bmp))
        {
            g.SmoothingMode = SmoothingMode.AntiAlias;
            g.InterpolationMode = InterpolationMode.HighQualityBicubic;
            g.Clear(Color.Transparent);

            if (key == "gemini")
            {
                // Cyan -> Blue -> Purple arrow with thick rounded white outline (Gemini look)
                PointF[] pts = new PointF[] {
                    new PointF(7f, 6f),
                    new PointF(38f, 20f),
                    new PointF(23f, 25f),
                    new PointF(18f, 40f)
                };
                using (GraphicsPath path = new GraphicsPath())
                {
                    path.AddPolygon(pts);
                    using (Pen halo = new Pen(Color.FromArgb(110, 147, 197, 253), 10f)) { halo.LineJoin = LineJoin.Round; g.DrawPath(halo, path); }
                    using (Pen whiteRim = new Pen(Color.White, 6.2f)) { whiteRim.LineJoin = LineJoin.Round; g.DrawPath(whiteRim, path); }
                    using (LinearGradientBrush br = new LinearGradientBrush(new PointF(7f, 6f), new PointF(38f, 36f), Color.FromArgb(255, 56, 210, 255), Color.FromArgb(255, 168, 85, 247)))
                    {
                        ColorBlend cb = new ColorBlend(3);
                        cb.Positions = new float[] { 0f, 0.5f, 1f };
                        cb.Colors = new Color[] { Color.FromArgb(255, 45, 212, 245), Color.FromArgb(255, 59, 130, 246), Color.FromArgb(255, 168, 85, 247) };
                        br.InterpolationColors = cb;
                        g.FillPath(br, path);
                    }
                }
            }
            else if (key == "anthropic")
            {
                // Orange-to-red sleek notched chevron cursor (Claude look)
                PointF[] pts = new PointF[] {
                    new PointF(5f, 6f),
                    new PointF(41f, 11f),
                    new PointF(24f, 23f),
                    new PointF(21f, 43f)
                };
                using (GraphicsPath path = new GraphicsPath())
                {
                    path.AddPolygon(pts);
                    using (Pen edge = new Pen(Color.FromArgb(220, 255, 255, 255), 3.4f)) { edge.LineJoin = LineJoin.Round; g.DrawPath(edge, path); }
                    using (Pen roundBody = new Pen(Color.FromArgb(255, 249, 115, 22), 3.0f)) { roundBody.LineJoin = LineJoin.Round; g.DrawPath(roundBody, path); }
                    using (LinearGradientBrush br = new LinearGradientBrush(new PointF(5f, 6f), new PointF(39f, 40f), Color.FromArgb(255, 255, 72, 20), Color.FromArgb(255, 251, 170, 28)))
                    {
                        ColorBlend cb = new ColorBlend(3);
                        cb.Positions = new float[] { 0f, 0.55f, 1f };
                        cb.Colors = new Color[] { Color.FromArgb(255, 255, 68, 22), Color.FromArgb(255, 249, 115, 22), Color.FromArgb(255, 251, 176, 30) };
                        br.InterpolationColors = cb;
                        g.FillPath(br, path);
                    }
                }
            }
            else if (key == "openai")
            {
                // Sage-teal rounded triangle with crisp white OpenAI logo inside (ChatGPT/Codex look)
                PointF[] pts = new PointF[] {
                    new PointF(6f, 6f),
                    new PointF(42f, 17f),
                    new PointF(17f, 42f)
                };
                Color teal = Color.FromArgb(255, 108, 158, 149);
                using (GraphicsPath path = new GraphicsPath())
                {
                    path.AddPolygon(pts);
                    using (Pen rim = new Pen(Color.FromArgb(215, 255, 255, 255), 7.5f)) { rim.LineJoin = LineJoin.Round; g.DrawPath(rim, path); }
                    using (Pen bodyStroke = new Pen(teal, 5.2f)) { bodyStroke.LineJoin = LineJoin.Round; g.DrawPath(bodyStroke, path); }
                    using (SolidBrush br = new SolidBrush(teal)) { g.FillPath(br, path); }
                }
                bool drewLogo = false;
                try
                {
                    if (!string.IsNullOrEmpty(openAiLogoPath) && System.IO.File.Exists(openAiLogoPath))
                    {
                        using (Bitmap rawLogo = new Bitmap(openAiLogoPath))
                        using (Bitmap whiteLogo = new Bitmap(rawLogo.Width, rawLogo.Height, System.Drawing.Imaging.PixelFormat.Format32bppArgb))
                        {
                            for (int ly = 0; ly < rawLogo.Height; ly++)
                            {
                                for (int lx = 0; lx < rawLogo.Width; lx++)
                                {
                                    Color px = rawLogo.GetPixel(lx, ly);
                                    if (px.A > 15) whiteLogo.SetPixel(lx, ly, Color.FromArgb(px.A, 255, 255, 255));
                                }
                            }
                            g.DrawImage(whiteLogo, new Rectangle(12, 12, 18, 18));
                            drewLogo = true;
                        }
                    }
                }
                catch { }
                if (!drewLogo)
                {
                    using (Pen wp = new Pen(Color.White, 1.5f))
                    {
                        for (int a = 0; a < 6; a++)
                        {
                            double ang = a * Math.PI / 3.0;
                            float ox = 20.5f + (float)(Math.Cos(ang) * 3.5);
                            float oy = 20.5f + (float)(Math.Sin(ang) * 3.5);
                            g.DrawEllipse(wp, ox - 3.2f, oy - 3.2f, 6.4f, 6.4f);
                        }
                    }
                }
            }
            else
            {
                // Black cursor for OpenRouter
                PointF[] pts = new PointF[] {
                    new PointF(5f, 4f),
                    new PointF(34f, 22f),
                    new PointF(21f, 25f),
                    new PointF(27f, 40f),
                    new PointF(22f, 42f),
                    new PointF(16f, 27f),
                    new PointF(6f, 34f)
                };
                using (GraphicsPath path = new GraphicsPath())
                {
                    path.AddPolygon(pts);
                    using (Pen outline = new Pen(Color.White, 3.0f)) { outline.LineJoin = LineJoin.Round; g.DrawPath(outline, path); }
                    using (SolidBrush fill = new SolidBrush(Color.FromArgb(255, 6, 7, 10))) { g.FillPath(fill, path); }
                }
            }

            IntPtr h = BuildCursorFromBitmap(bmp, 5, 5, key);
            if (h != IntPtr.Zero) cursorCache[key] = h;
            return h;
        }
    }

    public static bool SetBlackCursor(bool enabled, string style, string openAiLogoPath)
    {
        if (enabled)
        {
            IntPtr h = EnsureProviderCursor(style, openAiLogoPath);
            if (h == IntPtr.Zero) return false;
            uint[] ids = new uint[] { 32512, 32513, 32514, 32515, 32649, 32650 };
            bool anyOk = false;
            foreach (uint id in ids)
            {
                IntPtr copy = CopyIcon(h);
                if (copy != IntPtr.Zero)
                {
                    if (SetSystemCursor(copy, id)) anyOk = true;
                    else DestroyIcon(copy);
                }
            }
            blackCursorActive = anyOk;
            return anyOk;
        }
        else
        {
            if (blackCursorActive)
            {
                SystemParametersInfo(0x0057, 0, IntPtr.Zero, 0);
                blackCursorActive = false;
            }
            return true;
        }
    }

    public static bool SetBlackCursor(bool enabled) { return SetBlackCursor(enabled, "gemini", ""); }

    public static string InitDpi()
    {
        bool ok = false;
        try { ok = SetProcessDpiAwarenessContext(PER_MONITOR_AWARE_V2); } catch { ok = false; }
        if (!ok) { try { SetProcessDPIAware(); } catch { } }
        EnsureThreadDpi();
        int a = -1;
        try { a = GetAwarenessFromDpiAwarenessContext(GetThreadDpiAwarenessContext()); } catch { }
        DpiMode = a == 2 ? "per-monitor" : (a == 1 ? "system" : (a == 0 ? "unaware" : "unknown"));
        return DpiMode;
    }

    static void EnsureThreadDpi()
    {
        try { SetThreadDpiAwarenessContext(PER_MONITOR_AWARE_V2); } catch { }
    }

    static void Send(INPUT[] inputs)
    {
        uint sent = SendInput((uint)inputs.Length, inputs, Marshal.SizeOf(typeof(INPUT)));
        if (sent != inputs.Length)
        {
            int err = Marshal.GetLastWin32Error();
            throw new Exception("SendInput was blocked (sent " + sent + "/" + inputs.Length + ", error " + err + "). The target window may be running as Administrator (UIPI) or the secure desktop (UAC / lock screen) is active.");
        }
    }

    static INPUT MouseInput(uint flags, uint data)
    {
        INPUT i = new INPUT();
        i.type = INPUT_MOUSE;
        i.U.mi.dx = 0;
        i.U.mi.dy = 0;
        i.U.mi.mouseData = data;
        i.U.mi.dwFlags = flags;
        i.U.mi.time = 0;
        i.U.mi.dwExtraInfo = IntPtr.Zero;
        return i;
    }

    static bool IsExtended(ushort vk)
    {
        switch (vk)
        {
            case 0x21: case 0x22: case 0x23: case 0x24:
            case 0x25: case 0x26: case 0x27: case 0x28:
            case 0x2C: case 0x2D: case 0x2E:
            case 0x5B: case 0x5C: case 0x5D:
            case 0x6F: case 0x90: case 0xA3: case 0xA5:
            case 0xAD: case 0xAE: case 0xAF: case 0xB0: case 0xB1: case 0xB2: case 0xB3:
                return true;
        }
        return false;
    }

    static INPUT KeyInput(ushort vk, bool up)
    {
        INPUT i = new INPUT();
        i.type = INPUT_KEYBOARD;
        i.U.ki.wVk = vk;
        i.U.ki.wScan = (ushort)MapVirtualKey(vk, 0);
        uint flags = up ? KEYEVENTF_KEYUP : 0;
        if (IsExtended(vk)) flags |= KEYEVENTF_EXTENDEDKEY;
        i.U.ki.dwFlags = flags;
        i.U.ki.time = 0;
        i.U.ki.dwExtraInfo = IntPtr.Zero;
        return i;
    }

    static INPUT UnicodeInput(char c, bool up)
    {
        INPUT i = new INPUT();
        i.type = INPUT_KEYBOARD;
        i.U.ki.wVk = 0;
        i.U.ki.wScan = (ushort)c;
        i.U.ki.dwFlags = KEYEVENTF_UNICODE | (up ? KEYEVENTF_KEYUP : 0);
        i.U.ki.time = 0;
        i.U.ki.dwExtraInfo = IntPtr.Zero;
        return i;
    }

    public static int[] GetPos()
    {
        EnsureThreadDpi();
        POINT p;
        GetCursorPos(out p);
        return new int[] { p.X, p.Y };
    }

    public static bool CanInjectInput()
    {
        EnsureThreadDpi();
        POINT p;
        if (!GetCursorPos(out p)) return false;
        return SetCursorPos(p.X, p.Y);
    }

    public static int[] VirtualScreen()
    {
        EnsureThreadDpi();
        return new int[] { GetSystemMetrics(76), GetSystemMetrics(77), GetSystemMetrics(78), GetSystemMetrics(79) };
    }

    static void MovePointerAbs(int x, int y)
    {
        int vl = GetSystemMetrics(76);
        int vt = GetSystemMetrics(77);
        int vw = Math.Max(1, GetSystemMetrics(78));
        int vh = Math.Max(1, GetSystemMetrics(79));
        int absX = (int)Math.Max(0, Math.Min(65535, Math.Round(((x - vl) + 0.5) * 65535.0 / vw)));
        int absY = (int)Math.Max(0, Math.Min(65535, Math.Round(((y - vt) + 0.5) * 65535.0 / vh)));
        INPUT mi = new INPUT();
        mi.type = INPUT_MOUSE;
        mi.U.mi.dx = absX;
        mi.U.mi.dy = absY;
        mi.U.mi.mouseData = 0;
        mi.U.mi.dwFlags = MOUSEEVENTF_MOVE | MOUSEEVENTF_ABSOLUTE | MOUSEEVENTF_VIRTUALDESK;
        mi.U.mi.time = 0;
        mi.U.mi.dwExtraInfo = IntPtr.Zero;
        Send(new INPUT[] { mi });
        SetCursorPos(x, y);
    }

    public static int[] MoveSmooth(int x, int y, int ms)
    {
        EnsureThreadDpi();
        POINT start;
        GetCursorPos(out start);
        if (ms > 0)
        {
            // True 120 FPS (8.33ms frame interval) smooth cubic ease-in-out glide with real pointer events
            int steps = Math.Max(16, Math.Min(240, (int)Math.Ceiling(ms * 0.12)));
            Stopwatch sw = Stopwatch.StartNew();
            for (int s = 1; s <= steps; s++)
            {
                double t = (double)s / steps;
                double e = t < 0.5 ? 4 * t * t * t : 1 - Math.Pow(-2 * t + 2, 3) / 2;
                int cx = (int)Math.Round(start.X + (x - start.X) * e);
                int cy = (int)Math.Round(start.Y + (y - start.Y) * e);
                MovePointerAbs(cx, cy);
                double targetMs = t * ms;
                while (sw.Elapsed.TotalMilliseconds < targetMs)
                {
                    double rem = targetMs - sw.Elapsed.TotalMilliseconds;
                    if (rem >= 2.0) Thread.Sleep(1);
                    else Thread.SpinWait(200);
                }
            }
        }
        if (!SetCursorPos(x, y))
        {
            int err = Marshal.GetLastWin32Error();
            throw new Exception("SetCursorPos failed (error " + err + ")." + (err == 5 ? " Access denied: the PC is locked, a UAC / secure-desktop prompt is open, or Locally was started outside your interactive desktop session (for example from a service or remote shell)." : ""));
        }
        MovePointerAbs(x, y);
        // Verify physical alignment; if external user mouse movement shifted the pointer mid-glide, smoothly re-align to exact target
        POINT chk;
        if (GetCursorPos(out chk) && (Math.Abs(chk.X - x) > 3 || Math.Abs(chk.Y - y) > 3))
        {
            for (int r = 1; r <= 6; r++)
            {
                double rt = r / 6.0;
                MovePointerAbs((int)Math.Round(chk.X + (x - chk.X) * rt), (int)Math.Round(chk.Y + (y - chk.Y) * rt));
                Thread.Sleep(6);
            }
            MovePointerAbs(x, y);
        }
        return GetPos();
    }

    static uint DownFlag(string button)
    {
        if (button == "right") return MOUSEEVENTF_RIGHTDOWN;
        if (button == "middle") return MOUSEEVENTF_MIDDLEDOWN;
        return MOUSEEVENTF_LEFTDOWN;
    }

    static uint UpFlag(string button)
    {
        if (button == "right") return MOUSEEVENTF_RIGHTUP;
        if (button == "middle") return MOUSEEVENTF_MIDDLEUP;
        return MOUSEEVENTF_LEFTUP;
    }

    public static void Click(string button, int count)
    {
        EnsureThreadDpi();
        if (count < 1) count = 1;
        int gap = (int)Math.Min(90, Math.Max(30, GetDoubleClickTime() / 5));
        for (int c = 0; c < count; c++)
        {
            Send(new INPUT[] { MouseInput(DownFlag(button), 0) });
            Thread.Sleep(35);
            Send(new INPUT[] { MouseInput(UpFlag(button), 0) });
            if (c < count - 1) Thread.Sleep(gap);
        }
    }

    public static void MouseButton(string button, bool down)
    {
        EnsureThreadDpi();
        Send(new INPUT[] { MouseInput(down ? DownFlag(button) : UpFlag(button), 0) });
    }

    public static void Drag(int x1, int y1, int x2, int y2, int ms)
    {
        MoveSmooth(x1, y1, 150);
        Thread.Sleep(60);
        Send(new INPUT[] { MouseInput(MOUSEEVENTF_LEFTDOWN, 0) });
        Thread.Sleep(65);
        try
        {
            MoveSmooth(x2, y2, Math.Max(220, ms));
            Thread.Sleep(60);
        }
        finally
        {
            Send(new INPUT[] { MouseInput(MOUSEEVENTF_LEFTUP, 0) });
        }
    }

    public static void DrawPath(int[] xs, int[] ys, int msPerSeg)
    {
        if (xs == null || ys == null || xs.Length < 2 || ys.Length != xs.Length) return;
        EnsureThreadDpi();
        MoveSmooth(xs[0], ys[0], 140);
        Thread.Sleep(55);
        Send(new INPUT[] { MouseInput(MOUSEEVENTF_LEFTDOWN, 0) });
        Thread.Sleep(65);
        try
        {
            int segMs = Math.Max(14, Math.Min(120, msPerSeg));
            for (int i = 1; i < xs.Length; i++)
            {
                int sx = xs[i - 1], sy = ys[i - 1];
                int tx = xs[i], ty = ys[i];
                double dist = Math.Sqrt((tx - sx) * (tx - sx) + (ty - sy) * (ty - sy));
                int sub = Math.Max(2, Math.Min(24, (int)Math.Ceiling(dist / 4.0)));
                Stopwatch sw = Stopwatch.StartNew();
                for (int s = 1; s <= sub; s++)
                {
                    double t = (double)s / sub;
                    int cx = (int)Math.Round(sx + (tx - sx) * t);
                    int cy = (int)Math.Round(sy + (ty - sy) * t);
                    MovePointerAbs(cx, cy);
                    double targetMs = t * segMs;
                    while (sw.Elapsed.TotalMilliseconds < targetMs)
                    {
                        double rem = targetMs - sw.Elapsed.TotalMilliseconds;
                        if (rem >= 2.0) Thread.Sleep(1);
                        else Thread.SpinWait(150);
                    }
                }
            }
            MovePointerAbs(xs[xs.Length - 1], ys[ys.Length - 1]);
            Thread.Sleep(65);
        }
        finally
        {
            Send(new INPUT[] { MouseInput(MOUSEEVENTF_LEFTUP, 0) });
        }
    }

    public static void Scroll(int dx, int dy)
    {
        EnsureThreadDpi();
        // dy > 0 scrolls down (content moves up). Windows wheel delta: positive = up.
        int vSteps = Math.Abs(dy);
        for (int i = 0; i < vSteps; i++)
        {
            int delta = dy > 0 ? -120 : 120;
            Send(new INPUT[] { MouseInput(MOUSEEVENTF_WHEEL, unchecked((uint)delta)) });
            if (i < vSteps - 1) Thread.Sleep(10);
        }
        int hSteps = Math.Abs(dx);
        for (int i = 0; i < hSteps; i++)
        {
            int delta = dx > 0 ? 120 : -120;
            Send(new INPUT[] { MouseInput(MOUSEEVENTF_HWHEEL, unchecked((uint)delta)) });
            if (i < hSteps - 1) Thread.Sleep(10);
        }
    }

    public static void TypeText(string text, int charDelay, bool softNewline)
    {
        EnsureThreadDpi();
        foreach (char ch in text)
        {
            if (ch == '\r') continue;
            if (ch == '\n')
            {
                if (softNewline)
                {
                    // Shift+Enter continues on a new line inside chat boxes & rich editors without submitting early.
                    Send(new INPUT[] {
                        KeyInput(0x10, false), KeyInput(0x0D, false),
                        KeyInput(0x0D, true), KeyInput(0x10, true)
                    });
                }
                else
                {
                    Send(new INPUT[] { KeyInput(0x0D, false), KeyInput(0x0D, true) });
                }
            }
            else if (ch == '\t')
            {
                Send(new INPUT[] { KeyInput(0x09, false), KeyInput(0x09, true) });
            }
            else if (ch >= 0x20 && ch <= 0x7E)
            {
                short vkRes = VkKeyScan(ch);
                int vk = vkRes & 0xFF;
                int shiftState = (vkRes >> 8) & 0xFF;
                if (vkRes != -1 && vk != 0 && vk != 0xFF && (shiftState == 0 || shiftState == 1))
                {
                    if (shiftState == 1)
                    {
                        Send(new INPUT[] {
                            KeyInput(0x10, false),
                            KeyInput((ushort)vk, false),
                            KeyInput((ushort)vk, true),
                            KeyInput(0x10, true)
                        });
                    }
                    else
                    {
                        Send(new INPUT[] { KeyInput((ushort)vk, false), KeyInput((ushort)vk, true) });
                    }
                }
                else
                {
                    Send(new INPUT[] { UnicodeInput(ch, false), UnicodeInput(ch, true) });
                }
            }
            else
            {
                Send(new INPUT[] { UnicodeInput(ch, false), UnicodeInput(ch, true) });
            }
            if (charDelay > 0) Thread.Sleep(charDelay);
        }
    }

    public static void KeyCombo(int[] vks, int holdMs)
    {
        EnsureThreadDpi();
        List<INPUT> down = new List<INPUT>();
        foreach (int vk in vks) down.Add(KeyInput((ushort)vk, false));
        Send(down.ToArray());
        Thread.Sleep(Math.Max(20, holdMs));
        List<INPUT> up = new List<INPUT>();
        for (int i = vks.Length - 1; i >= 0; i--) up.Add(KeyInput((ushort)vks[i], true));
        Send(up.ToArray());
    }

    static HashSet<int> HeldVks = new HashSet<int>();

    public static void KeyState(int vk, bool down)
    {
        EnsureThreadDpi();
        if (down) HeldVks.Add(vk);
        else HeldVks.Remove(vk);
        Send(new INPUT[] { KeyInput((ushort)vk, !down) });
    }

    public static void ReleaseAll()
    {
        EnsureThreadDpi();
        foreach (int hvk in HeldVks)
        {
            try { Send(new INPUT[] { KeyInput((ushort)hvk, true) }); } catch { }
        }
        HeldVks.Clear();
        int[] mods = new int[] { 0x10, 0x11, 0x12, 0x5B, 0x5C, 0xA0, 0xA1, 0xA2, 0xA3, 0xA4, 0xA5 };
        foreach (int vk in mods)
        {
            if ((GetAsyncKeyState(vk) & 0x8000) != 0)
            {
                try { Send(new INPUT[] { KeyInput((ushort)vk, true) }); } catch { }
            }
        }
        if ((GetAsyncKeyState(0x01) & 0x8000) != 0) { try { Send(new INPUT[] { MouseInput(MOUSEEVENTF_LEFTUP, 0) }); } catch { } }
        if ((GetAsyncKeyState(0x02) & 0x8000) != 0) { try { Send(new INPUT[] { MouseInput(MOUSEEVENTF_RIGHTUP, 0) }); } catch { } }
        if ((GetAsyncKeyState(0x04) & 0x8000) != 0) { try { Send(new INPUT[] { MouseInput(MOUSEEVENTF_MIDDLEUP, 0) }); } catch { } }
    }

    static string TitleOf(IntPtr h)
    {
        int len = GetWindowTextLength(h);
        if (len <= 0) return "";
        StringBuilder sb = new StringBuilder(len + 1);
        GetWindowText(h, sb, sb.Capacity);
        return sb.ToString();
    }

    static string ProcessOf(IntPtr h)
    {
        try
        {
            uint pid;
            GetWindowThreadProcessId(h, out pid);
            return Process.GetProcessById((int)pid).ProcessName;
        }
        catch { return ""; }
    }

    public static string[] Foreground()
    {
        EnsureThreadDpi();
        IntPtr h = GetForegroundWindow();
        RECT r;
        GetWindowRect(h, out r);
        return new string[] { TitleOf(h), ProcessOf(h), r.Left + "," + r.Top + "," + r.Right + "," + r.Bottom, h.ToInt64().ToString() };
    }

    public static List<string[]> ListWindows()
    {
        EnsureThreadDpi();
        List<string[]> list = new List<string[]>();
        EnumWindows(delegate (IntPtr h, IntPtr l)
        {
            if (!IsWindowVisible(h)) return true;
            if (GetWindow(h, 4) != IntPtr.Zero) return true; // has owner -> skip tool windows
            string t = TitleOf(h);
            if (t.Length == 0) return true;
            RECT r;
            GetWindowRect(h, out r);
            list.Add(new string[] { t, ProcessOf(h), r.Left + "," + r.Top + "," + r.Right + "," + r.Bottom, IsIconic(h) ? "minimized" : "normal", h.ToInt64().ToString() });
            return true;
        }, IntPtr.Zero);
        return list;
    }

    static bool IsBriefWindow(string t, string p)
    {
        string tl = (t ?? "").Trim().ToLowerInvariant();
        string pl = (p ?? "").Trim().ToLowerInvariant();
        if (pl == "locally" || pl == "brief") return true;
        if (tl == "locally" || tl == "brief" || tl.StartsWith("brief desktop layer") || tl.StartsWith("brief status widget") || tl.StartsWith("locally ")) return true;
        return false;
    }

    public static string FocusWindow(string query)
    {
        EnsureThreadDpi();
        string q = (query ?? "").Trim().ToLowerInvariant();
        IntPtr found = IntPtr.Zero;
        string foundTitle = "";
        EnumWindows(delegate (IntPtr h, IntPtr l)
        {
            if (!IsWindowVisible(h)) return true;
            if (GetWindow(h, 4) != IntPtr.Zero) return true;
            string t = TitleOf(h);
            if (t.Length == 0) return true;
            string p = ProcessOf(h);
            if (IsBriefWindow(t, p) && q != "brief" && q != "locally") return true;
            if (t.ToLowerInvariant().Contains(q) || p.ToLowerInvariant() == q || p.ToLowerInvariant().Contains(q))
            {
                found = h;
                foundTitle = t;
                return false;
            }
            return true;
        }, IntPtr.Zero);
        if (found == IntPtr.Zero) return null;
        if (IsIconic(found)) ShowWindow(found, 9);
        IntPtr fg = GetForegroundWindow();
        uint dummy;
        uint fgThread = GetWindowThreadProcessId(fg, out dummy);
        uint myThread = GetCurrentThreadId();
        bool attached = false;
        if (fgThread != myThread) attached = AttachThreadInput(myThread, fgThread, true);
        // An ALT tap lets a background process take the foreground legitimately.
        try { Send(new INPUT[] { KeyInput(0x12, false), KeyInput(0x12, true) }); } catch { }
        BringWindowToTop(found);
        SetForegroundWindow(found);
        Thread.Sleep(45);
        if (GetForegroundWindow() != found)
        {
            BringWindowToTop(found);
            SetForegroundWindow(found);
        }
        if (attached) AttachThreadInput(myThread, fgThread, false);
        return foundTitle;
    }

    public static string ControlWindow(string query, string action)
    {
        EnsureThreadDpi();
        string q = (query ?? "").Trim().ToLowerInvariant();
        string act = (action ?? "").Trim().ToLowerInvariant();
        if (q.Length == 0) throw new Exception("Target window name or process is required.");
        if (q == "locally" || q == "brief") throw new Exception("Refused to minimize or close Brief via window_control.");
        IntPtr found = IntPtr.Zero;
        string foundTitle = "";
        EnumWindows(delegate (IntPtr h, IntPtr l)
        {
            if (!IsWindowVisible(h)) return true;
            if (GetWindow(h, 4) != IntPtr.Zero) return true;
            string t = TitleOf(h);
            if (t.Length == 0) return true;
            string p = ProcessOf(h);
            string tl = t.ToLowerInvariant();
            string pl = p.ToLowerInvariant();
            if (IsBriefWindow(t, p)) return true;
            if (tl.Contains(q) || pl == q || pl.Contains(q))
            {
                found = h;
                foundTitle = t;
                return false;
            }
            return true;
        }, IntPtr.Zero);
        if (found == IntPtr.Zero) return null;
        if (act == "minimize" || act == "shrink") ShowWindow(found, 6);
        else if (act == "maximize") ShowWindow(found, 3);
        else if (act == "restore") ShowWindow(found, 9);
        else if (act == "close") PostMessage(found, 0x0010, IntPtr.Zero, IntPtr.Zero);
        else throw new Exception("Unknown window action: " + action);
        return foundTitle;
    }

    public static List<string> ControlOtherWindows(string keepQuery, string action)
    {
        EnsureThreadDpi();
        string kq = (keepQuery ?? "").Trim().ToLowerInvariant();
        string act = (action ?? "minimize").Trim().ToLowerInvariant();
        if (act != "minimize" && act != "close") throw new Exception("Action must be 'minimize' or 'close'.");
        List<string> affected = new List<string>();
        EnumWindows(delegate (IntPtr h, IntPtr l)
        {
            if (!IsWindowVisible(h)) return true;
            if (GetWindow(h, 4) != IntPtr.Zero) return true;
            string t = TitleOf(h);
            if (t.Length == 0) return true;
            string p = ProcessOf(h);
            string tl = t.ToLowerInvariant();
            string pl = p.ToLowerInvariant();
            if (IsBriefWindow(t, p)) return true;
            if (tl == "program manager" || tl == "windows input experience" || tl == "search" || pl == "textinputhost" || pl == "shellexperiencehost" || pl == "searchhost" || pl == "startmenuexperiencehost") return true;
            if (pl == "explorer" && (tl == "" || tl == "program manager")) return true;
            if (kq.Length > 0 && (tl.Contains(kq) || pl == kq || pl.Contains(kq))) return true;
            if (act == "minimize")
            {
                if (!IsIconic(h)) { ShowWindow(h, 6); affected.Add(t); }
            }
            else
            {
                PostMessage(h, 0x0010, IntPtr.Zero, IntPtr.Zero);
                affected.Add(t);
            }
            return true;
        }, IntPtr.Zero);
        return affected;
    }

    static void CollectTabsShallow(AutomationElement el, int depth, ref int budget, List<AutomationElement> outTabs)
    {
        if (el == null || depth > 14 || budget <= 0 || outTabs.Count >= 50) return;
        budget--;
        try
        {
            ControlType ct = el.Current.ControlType;
            if (ct == ControlType.Document || ct == ControlType.MenuBar || ct == ControlType.Menu || ct == ControlType.StatusBar || ct == ControlType.ScrollBar || ct == ControlType.ToolBar) return;
            if (ct == ControlType.TabItem)
            {
                outTabs.Add(el);
                return;
            }
            AutomationElement child = TreeWalker.ControlViewWalker.GetFirstChild(el);
            int guard = 0;
            int maxChildren = (ct == ControlType.Tab) ? 60 : 25;
            while (child != null && guard < maxChildren && budget > 0 && outTabs.Count < 50)
            {
                guard++;
                CollectTabsShallow(child, depth + 1, ref budget, outTabs);
                child = TreeWalker.ControlViewWalker.GetNextSibling(child);
            }
        }
        catch { }
    }

    public static List<string[]> ListBrowserTabs(string browserQuery)
    {
        EnsureThreadDpi();
        string bq = (browserQuery ?? "").Trim().ToLowerInvariant();
        List<string[]> tabs = new List<string[]>();
        string[] browsers = new string[] { "chrome", "msedge", "brave", "opera", "firefox", "vivaldi", "arc" };
        EnumWindows(delegate (IntPtr h, IntPtr l)
        {
            if (!IsWindowVisible(h)) return true;
            if (GetWindow(h, 4) != IntPtr.Zero) return true;
            string t = TitleOf(h);
            if (t.Length == 0) return true;
            string p = ProcessOf(h);
            string pl = p.ToLowerInvariant();
            bool isBrowser = false;
            foreach (string b in browsers) { if (pl == b || pl.Contains(b)) { isBrowser = true; break; } }
            if (!isBrowser) return true;
            if (bq.Length > 0 && !pl.Contains(bq) && !t.ToLowerInvariant().Contains(bq)) return true;
            try
            {
                AutomationElement winEl = AutomationElement.FromHandle(h);
                if (winEl == null) return true;
                List<AutomationElement> foundTabs = new List<AutomationElement>();
                int budget = 900;
                CollectTabsShallow(winEl, 0, ref budget, foundTabs);
                foreach (AutomationElement tab in foundTabs)
                {
                    try
                    {
                        string tabName = tab.Current.Name ?? "";
                        if (tabName.Length == 0) continue;
                        System.Windows.Rect rect = tab.Current.BoundingRectangle;
                        string rStr = (!rect.IsEmpty && rect.Width > 2 && rect.Height > 2)
                            ? ((int)Math.Round(rect.Left) + "," + (int)Math.Round(rect.Top) + "," + (int)Math.Round(rect.Right) + "," + (int)Math.Round(rect.Bottom))
                            : "";
                        bool selected = false;
                        try
                        {
                            object selObj;
                            if (tab.TryGetCurrentPattern(SelectionItemPattern.Pattern, out selObj))
                                selected = ((SelectionItemPattern)selObj).Current.IsSelected;
                        }
                        catch { }
                        tabs.Add(new string[] { p, t, h.ToInt64().ToString(), tabName, selected ? "1" : "0", rStr });
                    }
                    catch { }
                }
            }
            catch { }
            return true;
        }, IntPtr.Zero);
        return tabs;
    }

    public static List<string[]> InspectForegroundUI(int maxItems)
    {
        EnsureThreadDpi();
        List<string[]> items = new List<string[]>();
        IntPtr fg = GetForegroundWindow();
        if (fg == IntPtr.Zero) return items;
        string fgT = TitleOf(fg);
        string fgP = ProcessOf(fg);
        if (IsBriefWindow(fgT, fgP)) return items;
        int limit = Math.Max(20, Math.Min(260, maxItems > 0 ? maxItems : 200));
        try
        {
            AutomationElement root = AutomationElement.FromHandle(fg);
            if (root == null) return items;
            Stopwatch sw = Stopwatch.StartNew();
            Queue<AutomationElement> q = new Queue<AutomationElement>();
            q.Enqueue(root);
            int visited = 0;
            while (q.Count > 0 && items.Count < limit && visited < 4500 && sw.ElapsedMilliseconds < 460)
            {
                AutomationElement cur = q.Dequeue();
                visited++;
                try
                {
                    if (cur.Current.IsOffscreen) continue;
                    ControlType ct = cur.Current.ControlType;
                    string typeName = (ct != null && ct.ProgrammaticName != null) ? ct.ProgrammaticName.Replace("ControlType.", "") : "";
                    string name = (cur.Current.Name ?? "").Trim();
                    string autoId = (cur.Current.AutomationId ?? "").Trim();
                    bool isInput = (ct == ControlType.Edit || ct == ControlType.ComboBox || ct == ControlType.Document);
                    if (ct == ControlType.Document)
                    {
                        isInput = false;
                        try
                        {
                            object vpObj;
                            if (cur.TryGetCurrentPattern(ValuePattern.Pattern, out vpObj) && vpObj != null && !((ValuePattern)vpObj).Current.IsReadOnly) isInput = true;
                        }
                        catch { }
                    }
                    else if (!isInput)
                    {
                        try
                        {
                            object vpObj;
                            if (cur.TryGetCurrentPattern(ValuePattern.Pattern, out vpObj))
                            {
                                ValuePattern vp = (ValuePattern)vpObj;
                                if (vp != null && !vp.Current.IsReadOnly && ct != ControlType.ScrollBar && ct != ControlType.Slider)
                                    isInput = true;
                            }
                        }
                        catch { }
                    }
                    bool isClickable = isInput || ct == ControlType.Button || ct == ControlType.SplitButton || ct == ControlType.Hyperlink || ct == ControlType.MenuItem || ct == ControlType.TabItem || ct == ControlType.CheckBox || ct == ControlType.RadioButton || ct == ControlType.TreeItem || ct == ControlType.ListItem || ct == ControlType.Slider;
                    if (isClickable && (isInput || name.Length > 0 || autoId.Length > 0))
                    {
                        System.Windows.Rect rect = cur.Current.BoundingRectangle;
                        if (!rect.IsEmpty && rect.Width >= 6 && rect.Height >= 6 && rect.Width < 3600 && rect.Height < 1400)
                        {
                            int cx = (int)Math.Round(rect.Left + rect.Width / 2.0);
                            int cy = (int)Math.Round(rect.Top + rect.Height / 2.0);
                            string rStr = ((int)Math.Round(rect.Left)) + "," + ((int)Math.Round(rect.Top)) + "," + ((int)Math.Round(rect.Right)) + "," + ((int)Math.Round(rect.Bottom));
                            string safeName = name.Replace('\r', ' ').Replace('\n', ' ');
                            if (safeName.Length > 70) safeName = safeName.Substring(0, 70);
                            items.Add(new string[] { typeName, safeName, autoId, cx.ToString(), cy.ToString(), rStr, isInput ? "1" : "0" });
                        }
                    }
                    if (ct == ControlType.ScrollBar) continue;
                    AutomationElement child = TreeWalker.ControlViewWalker.GetFirstChild(cur);
                    int guard = 0;
                    while (child != null && guard < 64 && q.Count < 1400 && sw.ElapsedMilliseconds < 280)
                    {
                        guard++;
                        q.Enqueue(child);
                        child = TreeWalker.ControlViewWalker.GetNextSibling(child);
                    }
                }
                catch { }
            }
        }
        catch { }
        return items;
    }

    public static string[] GetFocusedElementInfo()
    {
        EnsureThreadDpi();
        try
        {
            AutomationElement el = AutomationElement.FocusedElement;
            if (el == null) return new string[] { "", "", "0" };
            ControlType ct = el.Current.ControlType;
            string typeName = (ct != null && ct.ProgrammaticName != null) ? ct.ProgrammaticName.Replace("ControlType.", "") : "";
            string name = (el.Current.Name ?? "").Trim();
            bool canType = (ct == ControlType.Edit || ct == ControlType.ComboBox);
            if (!canType)
            {
                try
                {
                    object vpObj;
                    if (el.TryGetCurrentPattern(ValuePattern.Pattern, out vpObj))
                    {
                        ValuePattern vp = (ValuePattern)vpObj;
                        if (vp != null && !vp.Current.IsReadOnly) canType = true;
                    }
                }
                catch { }
            }
            if (!canType && ct == ControlType.Document && el.Current.IsKeyboardFocusable)
            {
                string nm = name.ToLowerInvariant();
                if (nm.Contains("text editor") || nm.Contains("notepad") || nm.Contains("rich text")) canType = true;
            }
            return new string[] { typeName, name, canType ? "1" : "0" };
        }
        catch { return new string[] { "", "", "0" }; }
    }

    public static byte[] CaptureRegionPngBytes(int x, int y, int w, int h)
    {
        EnsureThreadDpi();
        int cw = Math.Max(16, w);
        int ch = Math.Max(16, h);
        using (Bitmap bmp = new Bitmap(cw, ch, System.Drawing.Imaging.PixelFormat.Format24bppRgb))
        using (Graphics g = Graphics.FromImage(bmp))
        using (System.IO.MemoryStream ms = new System.IO.MemoryStream())
        {
            g.CopyFromScreen(x, y, 0, 0, new Size(cw, ch), CopyPixelOperation.SourceCopy);
            bmp.Save(ms, System.Drawing.Imaging.ImageFormat.Png);
            return ms.ToArray();
        }
    }

    public static string CaptureRegionBase64(int x, int y, int w, int h, bool pngFormat, bool withGrid)
    {
        byte[] raw = CaptureRegionPngBytes(x, y, w, h);
        if (!withGrid && pngFormat) return Convert.ToBase64String(raw);
        using (System.IO.MemoryStream msIn = new System.IO.MemoryStream(raw))
        using (Image srcImg = Image.FromStream(msIn))
        using (Bitmap bmp = new Bitmap(srcImg.Width, srcImg.Height, System.Drawing.Imaging.PixelFormat.Format24bppRgb))
        using (Graphics g = Graphics.FromImage(bmp))
        {
            g.DrawImage(srcImg, 0, 0, srcImg.Width, srcImg.Height);
            if (withGrid)
            {
                int gw = bmp.Width;
                int gh = bmp.Height;
                using (Pen gridPen = new Pen(Color.FromArgb(90, 0, 210, 255), Math.Max(1f, gw / 1600f)))
                using (Font f = new Font("Consolas", Math.Max(11f, gw / 115f), FontStyle.Bold))
                using (SolidBrush bgBrush = new SolidBrush(Color.FromArgb(185, 10, 14, 24)))
                using (SolidBrush fgBrush = new SolidBrush(Color.FromArgb(245, 125, 225, 255)))
                {
                    gridPen.DashPattern = new float[] { 6f, 6f };
                    for (int k = 100; k <= 900; k += 100)
                    {
                        float px = (k / 1000f) * gw;
                        float py = (k / 1000f) * gh;
                        g.DrawLine(gridPen, px, 0, px, gh);
                        g.DrawLine(gridPen, 0, py, gw, py);
                        string lbl = k.ToString();
                        SizeF sz = g.MeasureString(lbl, f);
                        g.FillRectangle(bgBrush, px + 2, 2, sz.Width + 4, sz.Height);
                        g.DrawString(lbl, f, fgBrush, px + 4, 2);
                        g.FillRectangle(bgBrush, 2, py + 2, sz.Width + 4, sz.Height);
                        g.DrawString(lbl, f, fgBrush, 4, py + 2);
                    }
                }
            }
            using (System.IO.MemoryStream msOut = new System.IO.MemoryStream())
            {
                if (pngFormat) bmp.Save(msOut, System.Drawing.Imaging.ImageFormat.Png);
                else SaveJpegHQ(bmp, msOut, 95L);
                return Convert.ToBase64String(msOut.ToArray());
            }
        }
    }

    private static void SaveJpegHQ(Bitmap bmp, System.IO.Stream outStream, long quality)
    {
        System.Drawing.Imaging.ImageCodecInfo jpgCodec = null;
        foreach (var codec in System.Drawing.Imaging.ImageCodecInfo.GetImageEncoders())
        {
            if (codec.FormatID == System.Drawing.Imaging.ImageFormat.Jpeg.Guid) { jpgCodec = codec; break; }
        }
        if (jpgCodec != null)
        {
            using (var ep = new System.Drawing.Imaging.EncoderParameters(1))
            {
                ep.Param[0] = new System.Drawing.Imaging.EncoderParameter(System.Drawing.Imaging.Encoder.Quality, quality);
                bmp.Save(outStream, jpgCodec, ep);
                return;
            }
        }
        bmp.Save(outStream, System.Drawing.Imaging.ImageFormat.Jpeg);
    }

    public static string DrawVisionGrid(string b64Input)
    {
        if (string.IsNullOrEmpty(b64Input)) return b64Input;
        byte[] raw = Convert.FromBase64String(b64Input);
        using (System.IO.MemoryStream msIn = new System.IO.MemoryStream(raw))
        using (Image srcImg = Image.FromStream(msIn))
        using (Bitmap bmp = new Bitmap(srcImg.Width, srcImg.Height, System.Drawing.Imaging.PixelFormat.Format24bppRgb))
        using (Graphics g = Graphics.FromImage(bmp))
        {
            g.DrawImage(srcImg, 0, 0, srcImg.Width, srcImg.Height);
            int w = bmp.Width;
            int h = bmp.Height;
            using (Pen minorPen = new Pen(Color.FromArgb(40, 0, 210, 255), 1f))
            using (Pen gridPen = new Pen(Color.FromArgb(95, 0, 210, 255), Math.Max(1f, w / 1600f)))
            using (Font f = new Font("Consolas", Math.Max(12f, w / 110f), FontStyle.Bold))
            using (SolidBrush bgBrush = new SolidBrush(Color.FromArgb(195, 10, 14, 24)))
            using (SolidBrush fgBrush = new SolidBrush(Color.FromArgb(250, 145, 232, 255)))
            {
                minorPen.DashPattern = new float[] { 3f, 7f };
                gridPen.DashPattern = new float[] { 6f, 6f };
                for (int k = 50; k <= 950; k += 100)
                {
                    float x = (k / 1000f) * w;
                    float y = (k / 1000f) * h;
                    g.DrawLine(minorPen, x, 0, x, h);
                    g.DrawLine(minorPen, 0, y, w, y);
                }
                for (int k = 100; k <= 900; k += 100)
                {
                    float x = (k / 1000f) * w;
                    float y = (k / 1000f) * h;
                    g.DrawLine(gridPen, x, 0, x, h);
                    g.DrawLine(gridPen, 0, y, w, y);
                    string lbl = k.ToString();
                    SizeF sz = g.MeasureString(lbl, f);
                    g.FillRectangle(bgBrush, x + 2, 2, sz.Width + 4, sz.Height);
                    g.DrawString(lbl, f, fgBrush, x + 4, 2);
                    g.FillRectangle(bgBrush, 2, y + 2, sz.Width + 4, sz.Height);
                    g.DrawString(lbl, f, fgBrush, 4, y + 2);
                }
            }
            using (System.IO.MemoryStream msOut = new System.IO.MemoryStream())
            {
                SaveJpegHQ(bmp, msOut, 95L);
                return Convert.ToBase64String(msOut.ToArray());
            }
        }
    }
}
"@

Add-Type -TypeDefinition $source -Language CSharp -ReferencedAssemblies @('System.Drawing', 'WindowsBase', 'UIAutomationClient', 'UIAutomationTypes')
$dpi = [LocallyInput]::InitDpi()

$script:OcrReady = $false
$script:OcrAsTask = $null
function Ensure-WinRtOcr {
    if ($script:OcrReady) { return }
    Add-Type -AssemblyName System.Runtime.WindowsRuntime
    $script:OcrAsTask = ([System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object {
        $_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 -and $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation`1'
    })[0]
    [Windows.Media.Ocr.OcrEngine, Windows.Foundation, ContentType=WindowsRuntime] | Out-Null
    [Windows.Graphics.Imaging.BitmapDecoder, Windows.Foundation, ContentType=WindowsRuntime] | Out-Null
    [Windows.Graphics.Imaging.SoftwareBitmap, Windows.Foundation, ContentType=WindowsRuntime] | Out-Null
    $script:OcrReady = $true
}
function Await-OcrTask($op, $resultType) {
    $m = $script:OcrAsTask.MakeGenericMethod($resultType)
    $t = $m.Invoke($null, @($op))
    $t.Wait() | Out-Null
    return $t.Result
}
function Run-RegionOcr([int]$rx, [int]$ry, [int]$rw, [int]$rh) {
    Ensure-WinRtOcr
    [byte[]]$pngBytes = [LocallyInput]::CaptureRegionPngBytes($rx, $ry, $rw, $rh)
    $ms = [System.IO.MemoryStream]::new($pngBytes)
    $ras = [System.IO.WindowsRuntimeStreamExtensions]::AsRandomAccessStream($ms)
    $decoder = Await-OcrTask ([Windows.Graphics.Imaging.BitmapDecoder]::CreateAsync($ras)) ([Windows.Graphics.Imaging.BitmapDecoder])
    $sbmp = Await-OcrTask ($decoder.GetSoftwareBitmapAsync()) ([Windows.Graphics.Imaging.SoftwareBitmap])
    $engine = [Windows.Media.Ocr.OcrEngine]::TryCreateFromUserProfileLanguages()
    if ($null -eq $engine) {
        $avail = [Windows.Media.Ocr.OcrEngine]::AvailableRecognizerLanguages
        if ($avail -and $avail.Count -gt 0) { $engine = [Windows.Media.Ocr.OcrEngine]::TryCreateFromLanguage($avail[0]) }
    }
    if ($null -eq $engine) { return @{ text = ''; lines = @(); words = @() } }
    $ocrRes = Await-OcrTask ($engine.RecognizeAsync($sbmp)) ([Windows.Media.Ocr.OcrResult])
    $lineOut = @()
    $wordOut = @()
    foreach ($ln in $ocrRes.Lines) {
        $wordsInLn = @($ln.Words)
        if ($wordsInLn.Count -eq 0) { continue }
        $minX = 999999; $minY = 999999; $maxX = -999999; $maxY = -999999
        foreach ($wd in $wordsInLn) {
            $r = $wd.BoundingRect
            $wx1 = [int][math]::Round($rx + $r.X)
            $wy1 = [int][math]::Round($ry + $r.Y)
            $wx2 = [int][math]::Round($rx + $r.X + $r.Width)
            $wy2 = [int][math]::Round($ry + $r.Y + $r.Height)
            if ($wx1 -lt $minX) { $minX = $wx1 }
            if ($wy1 -lt $minY) { $minY = $wy1 }
            if ($wx2 -gt $maxX) { $maxX = $wx2 }
            if ($wy2 -gt $maxY) { $maxY = $wy2 }
            $wordOut += @{ text = [string]$wd.Text; x = [int][math]::Round(($wx1 + $wx2) / 2); y = [int][math]::Round(($wy1 + $wy2) / 2); rect = "$wx1,$wy1,$wx2,$wy2" }
        }
        $lineOut += @{ text = [string]$ln.Text; x = [int][math]::Round(($minX + $maxX) / 2); y = [int][math]::Round(($minY + $maxY) / 2); rect = "$minX,$minY,$maxX,$maxY" }
    }
    return @{ text = [string]$ocrRes.Text; lines = $lineOut; words = $wordOut }
}

function Reply($obj) {
    $json = $obj | ConvertTo-Json -Compress -Depth 6
    [Console]::Out.WriteLine($json)
    [Console]::Out.Flush()
}

Reply @{ id = 0; ok = $true; ready = $true; dpi = $dpi; pid = $PID }
try { [LocallyInput]::timeBeginPeriod(1) | Out-Null } catch {}

try {
while ($true) {
    $line = [Console]::In.ReadLine()
    if ($null -eq $line) { break }
    if ($line.Trim().Length -eq 0) { continue }
    $req = $null
    try {
        $req = $line | ConvertFrom-Json
        $result = $null
        switch ($req.cmd) {
            'ping' { $result = @{ dpi = [LocallyInput]::DpiMode } }
            'caninput' { $result = @{ allowed = [LocallyInput]::CanInjectInput() } }
            'setcursor' {
                $st = if ($req.style) { [string]$req.style } else { 'gemini' }
                $lp = if ($req.logoPath) { [string]$req.logoPath } else { '' }
                $result = @{ active = [LocallyInput]::SetBlackCursor([bool]$req.black, $st, $lp) }
            }
            'drawpath' {
                [LocallyInput]::DrawPath([int[]]@($req.xs), [int[]]@($req.ys), [int]$req.msPerSeg)
                $result = @{ drawn = $true; points = @($req.xs).Count }
            }
            'pos' { $p = [LocallyInput]::GetPos(); $result = @{ x = $p[0]; y = $p[1] } }
            'vscreen' { $v = [LocallyInput]::VirtualScreen(); $result = @{ x = $v[0]; y = $v[1]; width = $v[2]; height = $v[3] } }
            'move' { $p = [LocallyInput]::MoveSmooth([int]$req.x, [int]$req.y, [int]$req.ms); $result = @{ x = $p[0]; y = $p[1] } }
            'click' { [LocallyInput]::Click([string]$req.button, [int]$req.count) }
            'button' { [LocallyInput]::MouseButton([string]$req.button, [bool]$req.down) }
            'drag' { [LocallyInput]::Drag([int]$req.x1, [int]$req.y1, [int]$req.x2, [int]$req.y2, [int]$req.ms) }
            'scroll' { [LocallyInput]::Scroll([int]$req.dx, [int]$req.dy) }
            'type' {
                $softNl = if ($null -eq $req.softNewline) { $true } else { [bool]$req.softNewline }
                [LocallyInput]::TypeText([string]$req.text, [int]$req.delay, $softNl)
            }
            'keys' { [LocallyInput]::KeyCombo([int[]]@($req.vks), [int]$req.hold) }
            'keystate' { [LocallyInput]::KeyState([int]$req.vk, [bool]$req.down) }
            'release' { [LocallyInput]::ReleaseAll() }
            'foreground' { $f = [LocallyInput]::Foreground(); $result = @{ title = $f[0]; process = $f[1]; rect = $f[2]; hwnd = $f[3] } }
            'windows' {
                $items = @()
                foreach ($w in [LocallyInput]::ListWindows()) {
                    $items += @{ title = $w[0]; process = $w[1]; rect = $w[2]; state = $w[3]; hwnd = $w[4] }
                }
                $result = @{ windows = $items }
            }
            'focus' {
                $t = [LocallyInput]::FocusWindow([string]$req.query)
                if ($null -eq $t) { throw "No visible window matches '$($req.query)'." }
                $result = @{ title = $t }
            }
            'wincontrol' {
                $t = [LocallyInput]::ControlWindow([string]$req.query, [string]$req.action)
                if ($null -eq $t) { throw "No target window matches '$($req.query)'." }
                $result = @{ title = $t; action = [string]$req.action }
            }
            'wincontrolother' {
                $list = [LocallyInput]::ControlOtherWindows([string]$req.keep, [string]$req.action)
                $result = @{ count = $list.Count; windows = @($list); action = [string]$req.action }
            }
            'browsertabs' {
                $tabs = @()
                foreach ($tb in [LocallyInput]::ListBrowserTabs([string]$req.browser)) {
                    $tabs += @{ process = $tb[0]; windowTitle = $tb[1]; hwnd = $tb[2]; title = $tb[3]; active = ($tb[4] -eq '1'); rect = $tb[5] }
                }
                $result = @{ tabs = $tabs }
            }
            'inspectui' {
                $els = @()
                foreach ($el in [LocallyInput]::InspectForegroundUI([int]$req.max)) {
                    $els += @{ type = $el[0]; name = $el[1]; autoId = $el[2]; x = [int]$el[3]; y = [int]$el[4]; rect = $el[5]; isInput = ($el[6] -eq '1') }
                }
                $result = @{ elements = $els }
            }
            'focused' {
                $fe = [LocallyInput]::GetFocusedElementInfo()
                $result = @{ type = $fe[0]; name = $fe[1]; canType = ($fe[2] -eq '1') }
            }
            'drawgrid' {
                $gB64 = [LocallyInput]::DrawVisionGrid([string]$req.base64)
                $result = @{ base64 = $gB64 }
            }
            'capture' {
                $b64 = [LocallyInput]::CaptureRegionBase64([int]$req.x, [int]$req.y, [int]$req.width, [int]$req.height, [bool]$req.png, [bool]$req.grid)
                $result = @{ base64 = $b64; width = [int]$req.width; height = [int]$req.height; mime = if ($req.png) { 'image/png' } else { 'image/jpeg' } }
            }
            'ocr' {
                $result = Run-RegionOcr ([int]$req.x) ([int]$req.y) ([int]$req.width) ([int]$req.height)
            }
            'startapps' {
                $apps = @()
                try { $apps = @(Get-StartApps | Select-Object Name, AppID) } catch { $apps = @() }
                $result = @{ apps = $apps }
            }
            default { throw "Unknown command '$($req.cmd)'." }
        }
        Reply @{ id = $req.id; ok = $true; result = $result }
    }
    catch {
        $rid = 0
        if ($null -ne $req -and $null -ne $req.id) { $rid = $req.id }
        Reply @{ id = $rid; ok = $false; error = $_.Exception.Message }
    }
}
}
finally {
    try { [LocallyInput]::SetBlackCursor($false) | Out-Null } catch {}
    try { [LocallyInput]::timeEndPeriod(1) | Out-Null } catch {}
}
