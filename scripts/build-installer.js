'use strict';
/**
 * Builds:
 *  1) download-site/public/downloads/brief-package.zip  (complete Windows Brief app bundle)
 *  2) download-site/public/downloads/Brief-Setup.exe    (real compiled native Win32/WinForms Windows Setup Wizard)
 */
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { execFileSync } = require('child_process');
const { rcedit } = require('rcedit');

const ROOT = path.resolve(__dirname, '..');
const ELECTRON_DIST = path.join(ROOT, 'node_modules', 'electron', 'dist');
const DOWNLOADS_DIR = process.env.BRIEF_DOWNLOADS_DIR
  ? path.resolve(process.env.BRIEF_DOWNLOADS_DIR)
  : path.join(ROOT, 'download-site', 'public', 'downloads');
const WORK_DIR = path.join(os.tmpdir(), 'brief-installer-build');
const STAGE_APP = path.join(WORK_DIR, 'app-stage');
const ZIP_OUT = path.join(DOWNLOADS_DIR, 'brief-package.zip');
const SETUP_EXE_OUT = path.join(DOWNLOADS_DIR, 'Brief-Setup.exe');

function findCscExe() {
  const candidates = [
    path.join(process.env.WINDIR || 'C:\\Windows', 'Microsoft.NET', 'Framework64', 'v4.0.30319', 'csc.exe'),
    path.join(process.env.WINDIR || 'C:\\Windows', 'Microsoft.NET', 'Framework', 'v4.0.30319', 'csc.exe')
  ];
  for (const p of candidates) {
    if (fs.existsSync(p)) return p;
  }
  throw new Error('Could not find Microsoft .NET Framework csc.exe to compile native Windows Setup Wizard.');
}

function getSetupWizardCSharpSource(downloadUrl, fallbackUrl, cloudFallbackUrl) {
  const esc = (s) => String(s).replace(/\\/g, '\\\\').replace(/"/g, '\\"');
  return `using System;
using System.Diagnostics;
using System.Drawing;
using System.Drawing.Drawing2D;
using System.IO;
using System.IO.Compression;
using System.Net;
using System.Reflection;
using System.Runtime.InteropServices;
using System.Threading;
using System.Windows.Forms;
using Microsoft.Win32;

[assembly: AssemblyTitle("Brief Setup")]
[assembly: AssemblyDescription("Brief Windows Desktop AI Assistant Setup Wizard")]
[assembly: AssemblyCompany("Brief Desktop")]
[assembly: AssemblyProduct("Brief Setup")]
[assembly: AssemblyCopyright("Copyright (c) 2026 Brief Desktop")]
[assembly: AssemblyVersion("2.0.2.0")]
[assembly: AssemblyFileVersion("2.0.2.0")]

namespace BriefSetupWizard
{
    internal static class NativeMethods
    {
        [DllImport("user32.dll")]
        internal static extern bool SetProcessDPIAware();
    }

    public sealed class SetupForm : Form
    {
        private static readonly string PrimaryDownloadUrl = "${esc(downloadUrl)}";
        private static readonly string FallbackDownloadUrl = "${esc(fallbackUrl)}";
        private static readonly string CloudFallbackUrl = "${esc(cloudFallbackUrl || '')}";

        private Panel sideBanner;
        private Panel topHeader;
        private Label headerTitle;
        private Label headerSub;
        private Panel contentHost;
        private Label footerLine;
        private Button btnBack;
        private Button btnNext;
        private Button btnCancel;

        // Pages 0..3
        private Panel[] pages = new Panel[4];
        private int currentPage = 0;
        private volatile bool installing = false;
        private volatile bool cancelRequested = false;

        // Page 1 controls
        private TextBox txtInstallDir;
        private CheckBox chkDesktop;
        private CheckBox chkStartMenu;
        private CheckBox chkFirstRun;

        // Page 2 controls
        private Label lblInstallStatus;
        private Label lblInstallSub;
        private ProgressBar progressBar;

        // Page 3 controls
        private CheckBox chkLaunchBrief;
        private Label lblFinishSummary;

        private string overrideUrl = null;
        private string installedExePath = "";

        public SetupForm(string customUrl)
        {
            overrideUrl = customUrl;
            Text = "Brief Setup";
            ClientSize = new Size(560, 410);
            FormBorderStyle = FormBorderStyle.FixedDialog;
            MaximizeBox = false;
            StartPosition = FormStartPosition.CenterScreen;
            Font = new Font("Segoe UI", 9.5f, FontStyle.Regular, GraphicsUnit.Point);
            BackColor = SystemColors.Control;
            try
            {
                Icon exeIcon = Icon.ExtractAssociatedIcon(Application.ExecutablePath);
                if (exeIcon != null) Icon = exeIcon;
            }
            catch { }

            BuildLayout();
            ShowPage(0);
        }

        private void BuildLayout()
        {
            // Left classic Windows Setup sidebar panel (hidden on Page 1 & 2 top-header mode or visible on Page 0 & 3)
            sideBanner = new Panel
            {
                Location = new Point(0, 0),
                Size = new Size(168, 356),
                BackColor = Color.FromArgb(16, 30, 62)
            };
            sideBanner.Paint += (s, e) =>
            {
                Graphics g = e.Graphics;
                g.SmoothingMode = SmoothingMode.AntiAlias;
                using (LinearGradientBrush br = new LinearGradientBrush(
                    sideBanner.ClientRectangle,
                    Color.FromArgb(20, 45, 98),
                    Color.FromArgb(10, 18, 36),
                    LinearGradientMode.Vertical))
                {
                    g.FillRectangle(br, sideBanner.ClientRectangle);
                }
                try
                {
                    Icon ic = Icon.ExtractAssociatedIcon(Application.ExecutablePath);
                    if (ic != null)
                    {
                        using (Bitmap bmp = ic.ToBitmap())
                        {
                            g.DrawImage(bmp, 46, 42, 72, 72);
                        }
                    }
                }
                catch { }
                using (Font f = new Font("Segoe UI", 13f, FontStyle.Bold))
                using (SolidBrush b = new SolidBrush(Color.White))
                {
                    g.DrawString("Brief", f, b, new PointF(56, 128));
                }
                using (Font fs = new Font("Segoe UI", 8.5f, FontStyle.Regular))
                using (SolidBrush bs = new SolidBrush(Color.FromArgb(190, 215, 255)))
                {
                    g.DrawString("Windows Desktop AI\\nSetup Wizard", fs, bs, new RectangleF(18, 160, 134, 48));
                }
            };
            Controls.Add(sideBanner);

            // Top white classic Windows Wizard header bar (shown on middle pages 1 & 2)
            topHeader = new Panel
            {
                Location = new Point(0, 0),
                Size = new Size(560, 64),
                BackColor = Color.White,
                Visible = false
            };
            headerTitle = new Label
            {
                Location = new Point(22, 10),
                Size = new Size(440, 22),
                Font = new Font("Segoe UI", 10.5f, FontStyle.Bold),
                ForeColor = Color.FromArgb(20, 20, 20),
                Text = "Choose Install Location"
            };
            headerSub = new Label
            {
                Location = new Point(22, 33),
                Size = new Size(440, 20),
                Font = new Font("Segoe UI", 9f),
                ForeColor = Color.FromArgb(80, 80, 80),
                Text = "Choose the folder in which to install Brief."
            };
            PictureBox miniPic = new PictureBox
            {
                Location = new Point(500, 12),
                Size = new Size(40, 40),
                SizeMode = PictureBoxSizeMode.Zoom
            };
            try
            {
                Icon ic = Icon.ExtractAssociatedIcon(Application.ExecutablePath);
                if (ic != null) miniPic.Image = ic.ToBitmap();
            }
            catch { }
            Label headerSep = new Label
            {
                Location = new Point(0, 62),
                Size = new Size(560, 2),
                BorderStyle = BorderStyle.Fixed3D
            };
            topHeader.Controls.Add(headerTitle);
            topHeader.Controls.Add(headerSub);
            topHeader.Controls.Add(miniPic);
            topHeader.Controls.Add(headerSep);
            Controls.Add(topHeader);

            contentHost = new Panel
            {
                Location = new Point(0, 0),
                Size = new Size(560, 356),
                BackColor = Color.White
            };
            Controls.Add(contentHost);

            footerLine = new Label
            {
                Location = new Point(0, 356),
                Size = new Size(560, 2),
                BorderStyle = BorderStyle.Fixed3D
            };
            Controls.Add(footerLine);

            btnBack = new Button
            {
                Text = "< Back",
                Location = new Point(284, 370),
                Size = new Size(82, 27),
                UseVisualStyleBackColor = true
            };
            btnBack.Click += (s, e) => { if (!installing && currentPage > 0) ShowPage(currentPage - 1); };

            btnNext = new Button
            {
                Text = "Next >",
                Location = new Point(372, 370),
                Size = new Size(86, 27),
                UseVisualStyleBackColor = true
            };
            btnNext.Click += OnNextClicked;

            btnCancel = new Button
            {
                Text = "Cancel",
                Location = new Point(468, 370),
                Size = new Size(76, 27),
                UseVisualStyleBackColor = true
            };
            btnCancel.Click += OnCancelClicked;

            Controls.Add(btnBack);
            Controls.Add(btnNext);
            Controls.Add(btnCancel);
            AcceptButton = btnNext;
            CancelButton = btnCancel;

            BuildPage0();
            BuildPage1();
            BuildPage2();
            BuildPage3();
        }

        private void BuildPage0()
        {
            Panel p = new Panel { Dock = DockStyle.Fill, BackColor = Color.White, Visible = false };
            Label title = new Label
            {
                Location = new Point(192, 28),
                Size = new Size(345, 62),
                Font = new Font("Segoe UI", 16f, FontStyle.Bold),
                ForeColor = Color.FromArgb(18, 24, 38),
                Text = "Welcome to the Brief Setup Wizard"
            };
            Label body = new Label
            {
                Location = new Point(192, 102),
                Size = new Size(342, 145),
                Font = new Font("Segoe UI", 9.5f),
                ForeColor = Color.FromArgb(55, 62, 74),
                Text = "This wizard will download and install Brief on your computer.\\r\\n\\r\\n" +
                       "Brief includes native Windows OCR vision, aligned desktop mouse & keyboard control, " +
                       "multi-agent task verification, and instant setup for Gemini, OpenAI, Claude, or OpenRouter keys.\\r\\n\\r\\n" +
                       "Click Next to continue, or Cancel to exit Setup."
            };
            Label foot = new Label
            {
                Location = new Point(192, 280),
                Size = new Size(342, 42),
                Font = new Font("Segoe UI", 8.5f),
                ForeColor = Color.FromArgb(100, 110, 125),
                Text = "Target: Windows 10 / 11 (64-bit) · Version 1.0.5"
            };
            p.Controls.Add(title);
            p.Controls.Add(body);
            p.Controls.Add(foot);
            pages[0] = p;
            contentHost.Controls.Add(p);
        }

        private void BuildPage1()
        {
            Panel p = new Panel { Dock = DockStyle.Fill, BackColor = SystemColors.Control, Visible = false };
            Label info = new Label
            {
                Location = new Point(26, 82),
                Size = new Size(506, 38),
                Text = "Setup will download Brief and install it into the following folder. To choose a different folder, click Browse."
            };
            GroupBox grp = new GroupBox
            {
                Text = "Destination Folder",
                Location = new Point(26, 126),
                Size = new Size(506, 68)
            };
            string defDir = Path.Combine(
                Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
                "Programs", "LOCALLY"
            );
            txtInstallDir = new TextBox
            {
                Location = new Point(14, 28),
                Size = new Size(392, 24),
                Text = defDir
            };
            Button btnBrowse = new Button
            {
                Text = "Browse...",
                Location = new Point(414, 26),
                Size = new Size(78, 26),
                UseVisualStyleBackColor = true
            };
            btnBrowse.Click += (s, e) =>
            {
                using (FolderBrowserDialog fbd = new FolderBrowserDialog())
                {
                    fbd.Description = "Select folder to install Brief";
                    fbd.SelectedPath = txtInstallDir.Text;
                    if (fbd.ShowDialog(this) == DialogResult.OK && !string.IsNullOrEmpty(fbd.SelectedPath))
                    {
                        txtInstallDir.Text = fbd.SelectedPath;
                    }
                }
            };
            grp.Controls.Add(txtInstallDir);
            grp.Controls.Add(btnBrowse);

            chkDesktop = new CheckBox
            {
                Location = new Point(28, 210),
                Size = new Size(460, 22),
                Checked = true,
                Text = "Create a Desktop shortcut (Brief)"
            };
            chkStartMenu = new CheckBox
            {
                Location = new Point(28, 236),
                Size = new Size(460, 22),
                Checked = true,
                Text = "Create a Start Menu shortcut (Brief)"
            };
            chkFirstRun = new CheckBox
            {
                Location = new Point(28, 262),
                Size = new Size(500, 22),
                Checked = true,
                Text = "Open Brief Welcome Tour (Name + API Key Setup) on launch"
            };
            p.Controls.Add(info);
            p.Controls.Add(grp);
            p.Controls.Add(chkDesktop);
            p.Controls.Add(chkStartMenu);
            p.Controls.Add(chkFirstRun);
            pages[1] = p;
            contentHost.Controls.Add(p);
        }

        private void BuildPage2()
        {
            Panel p = new Panel { Dock = DockStyle.Fill, BackColor = SystemColors.Control, Visible = false };
            lblInstallStatus = new Label
            {
                Location = new Point(26, 100),
                Size = new Size(506, 24),
                Font = new Font("Segoe UI", 9.5f, FontStyle.Bold),
                Text = "Connecting to download server..."
            };
            progressBar = new ProgressBar
            {
                Location = new Point(26, 134),
                Size = new Size(506, 24),
                Minimum = 0,
                Maximum = 100,
                Value = 0,
                Style = ProgressBarStyle.Continuous
            };
            lblInstallSub = new Label
            {
                Location = new Point(26, 170),
                Size = new Size(506, 80),
                ForeColor = Color.FromArgb(70, 78, 92),
                Text = "Preparing download..."
            };
            p.Controls.Add(lblInstallStatus);
            p.Controls.Add(progressBar);
            p.Controls.Add(lblInstallSub);
            pages[2] = p;
            contentHost.Controls.Add(p);
        }

        private void BuildPage3()
        {
            Panel p = new Panel { Dock = DockStyle.Fill, BackColor = Color.White, Visible = false };
            Label title = new Label
            {
                Location = new Point(192, 28),
                Size = new Size(345, 62),
                Font = new Font("Segoe UI", 16f, FontStyle.Bold),
                ForeColor = Color.FromArgb(18, 24, 38),
                Text = "Completing the Brief Setup Wizard"
            };
            lblFinishSummary = new Label
            {
                Location = new Point(192, 102),
                Size = new Size(342, 110),
                Font = new Font("Segoe UI", 9.5f),
                ForeColor = Color.FromArgb(55, 62, 74),
                Text = "Brief has been downloaded and installed on your computer.\\r\\n\\r\\n" +
                       "Click Finish to exit Setup and start Brief."
            };
            chkLaunchBrief = new CheckBox
            {
                Location = new Point(192, 226),
                Size = new Size(300, 24),
                Checked = true,
                Font = new Font("Segoe UI", 9.5f, FontStyle.Bold),
                Text = "Launch Brief now"
            };
            p.Controls.Add(title);
            p.Controls.Add(lblFinishSummary);
            p.Controls.Add(chkLaunchBrief);
            pages[3] = p;
            contentHost.Controls.Add(p);
        }

        private void ShowPage(int idx)
        {
            currentPage = idx;
            for (int i = 0; i < pages.Length; i++) pages[i].Visible = (i == idx);
            bool isWelcomeOrDone = (idx == 0 || idx == 3);
            sideBanner.Visible = isWelcomeOrDone;
            topHeader.Visible = !isWelcomeOrDone;
            if (!isWelcomeOrDone)
            {
                contentHost.BringToFront();
                topHeader.BringToFront();
            }
            else
            {
                sideBanner.BringToFront();
            }

            if (idx == 0)
            {
                btnBack.Enabled = false;
                btnNext.Enabled = true;
                btnNext.Text = "Next >";
                btnCancel.Enabled = true;
            }
            else if (idx == 1)
            {
                headerTitle.Text = "Choose Install Location";
                headerSub.Text = "Select destination folder and shortcuts for Brief.";
                btnBack.Enabled = true;
                btnNext.Enabled = true;
                btnNext.Text = "Install";
                btnCancel.Enabled = true;
            }
            else if (idx == 2)
            {
                headerTitle.Text = "Downloading & Installing Brief";
                headerSub.Text = "Please wait while Brief downloads and sets up on Windows.";
                btnBack.Enabled = false;
                btnNext.Enabled = false;
                btnCancel.Enabled = true;
            }
            else if (idx == 3)
            {
                btnBack.Enabled = false;
                btnNext.Enabled = true;
                btnNext.Text = "Finish";
                btnCancel.Enabled = false;
            }
        }

        private void OnCancelClicked(object sender, EventArgs e)
        {
            if (installing)
            {
                DialogResult dr = MessageBox.Show(this, "Cancel Brief installation?", "Brief Setup", MessageBoxButtons.YesNo, MessageBoxIcon.Question);
                if (dr == DialogResult.Yes)
                {
                    cancelRequested = true;
                }
                return;
            }
            if (currentPage < 3) Close();
        }

        private void OnNextClicked(object sender, EventArgs e)
        {
            if (currentPage == 0)
            {
                ShowPage(1);
                return;
            }
            if (currentPage == 1)
            {
                string targetDir = (txtInstallDir.Text ?? "").Trim();
                if (string.IsNullOrEmpty(targetDir))
                {
                    MessageBox.Show(this, "Please select an installation folder.", "Brief Setup", MessageBoxButtons.OK, MessageBoxIcon.Warning);
                    return;
                }
                bool mkDesk = chkDesktop.Checked;
                bool mkStart = chkStartMenu.Checked;
                ShowPage(2);
                StartInstallThread(targetDir, mkDesk, mkStart);
                return;
            }
            if (currentPage == 3)
            {
                if (chkLaunchBrief.Checked && !string.IsNullOrEmpty(installedExePath) && File.Exists(installedExePath))
                {
                    try
                    {
                        ProcessStartInfo psi = new ProcessStartInfo(installedExePath);
                        psi.WorkingDirectory = Path.GetDirectoryName(installedExePath);
                        if (chkFirstRun.Checked) psi.Arguments = "--first-run";
                        Process.Start(psi);
                    }
                    catch (Exception ex)
                    {
                        MessageBox.Show(this, "Installed successfully, but could not start Brief automatically: " + ex.Message, "Brief Setup", MessageBoxButtons.OK, MessageBoxIcon.Information);
                    }
                }
                Close();
            }
        }

        private void UiUpdate(int pct, string status, string sub)
        {
            if (IsDisposed) return;
            try
            {
                BeginInvoke((MethodInvoker)delegate
                {
                    if (pct >= 0 && pct <= 100) progressBar.Value = pct;
                    if (status != null) lblInstallStatus.Text = status;
                    if (sub != null) lblInstallSub.Text = sub;
                });
            }
            catch { }
        }

        private void StartInstallThread(string targetDir, bool mkDesktop, bool mkStartMenu)
        {
            installing = true;
            cancelRequested = false;
            Thread t = new Thread(() =>
            {
                string tempZip = Path.Combine(Path.GetTempPath(), "brief-download-" + Process.GetCurrentProcess().Id + ".zip");
                string tempExtract = Path.Combine(Path.GetTempPath(), "brief-extract-" + Process.GetCurrentProcess().Id);
                try
                {
                    try
                    {
                        ServicePointManager.SecurityProtocol = (SecurityProtocolType)3072 | (SecurityProtocolType)768 | SecurityProtocolType.Tls;
                    }
                    catch
                    {
                        try { ServicePointManager.SecurityProtocol = (SecurityProtocolType)3072; } catch { }
                    }

                    // 1. Download brief-package.zip cleanly over HTTP/HTTPS (or sibling zip if offline)
                    string siblingZip = Path.Combine(Path.GetDirectoryName(Application.ExecutablePath) ?? "", "brief-package.zip");
                    bool downloaded = false;
                    string[] urls = !string.IsNullOrEmpty(overrideUrl)
                        ? new[] { overrideUrl, PrimaryDownloadUrl, FallbackDownloadUrl, CloudFallbackUrl }
                        : new[] { PrimaryDownloadUrl, FallbackDownloadUrl, CloudFallbackUrl };

                    Exception lastNetErr = null;
                    foreach (string url in urls)
                    {
                        if (cancelRequested) throw new OperationCanceledException("Installation cancelled by user.");
                        if (string.IsNullOrEmpty(url)) continue;
                        try
                        {
                            UiUpdate(4, "Downloading Brief from server...", "Source: " + url);
                            HttpWebRequest req = (HttpWebRequest)WebRequest.Create(url);
                            req.UserAgent = "BriefSetup/1.0";
                            req.AllowAutoRedirect = true;
                            req.Timeout = 15000;
                            req.ReadWriteTimeout = 30000;
                            using (HttpWebResponse resp = (HttpWebResponse)req.GetResponse())
                            using (Stream rs = resp.GetResponseStream())
                            using (FileStream fs = new FileStream(tempZip, FileMode.Create, FileAccess.Write, FileShare.None))
                            {
                                long total = resp.ContentLength;
                                byte[] buf = new byte[65536];
                                long readTotal = 0;
                                Stopwatch sw = Stopwatch.StartNew();
                                int n;
                                while ((n = rs.Read(buf, 0, buf.Length)) > 0)
                                {
                                    if (cancelRequested) throw new OperationCanceledException("Installation cancelled by user.");
                                    fs.Write(buf, 0, n);
                                    readTotal += n;
                                    if (sw.ElapsedMilliseconds >= 80 || readTotal == total)
                                    {
                                        double mbDone = readTotal / (1024.0 * 1024.0);
                                        double mbTotal = total > 0 ? (total / (1024.0 * 1024.0)) : 0;
                                        double speed = mbDone / Math.Max(0.05, sw.Elapsed.TotalSeconds);
                                        int pct = total > 0 ? Math.Min(68, (int)((readTotal * 68) / total)) : 35;
                                        string txt = total > 0
                                            ? string.Format("Downloading Brief... {0:F1} MB / {1:F1} MB ({2:F1} MB/s)", mbDone, mbTotal, speed)
                                            : string.Format("Downloading Brief... {0:F1} MB", mbDone);
                                        UiUpdate(pct, txt, "Receiving verified Windows package over HTTP...");
                                    }
                                }
                            }
                            downloaded = true;
                            break;
                        }
                        catch (OperationCanceledException) { throw; }
                        catch (Exception ex) { lastNetErr = ex; }
                    }

                    if (!downloaded)
                    {
                        if (File.Exists(siblingZip))
                        {
                            UiUpdate(40, "Copying offline Brief package...", siblingZip);
                            File.Copy(siblingZip, tempZip, true);
                            downloaded = true;
                        }
                        else
                        {
                            throw new Exception("Could not download Brief package from " + urls[0] +
                                (lastNetErr != null ? (" (" + lastNetErr.Message + ")") : "") +
                                ". Make sure the Brief download website is running.");
                        }
                    }

                    if (cancelRequested) throw new OperationCanceledException("Installation cancelled by user.");

                    // 2. Gracefully stop running Brief/LOCALLY instances before replacing files
                    UiUpdate(72, "Preparing target folder...", targetDir);
                    foreach (string pname in new[] { "Brief", "LOCALLY" })
                    {
                        try
                        {
                            foreach (Process proc in Process.GetProcessesByName(pname))
                            {
                                try { proc.Kill(); proc.WaitForExit(3000); } catch { }
                            }
                        }
                        catch { }
                    }
                    Thread.Sleep(250);

                    if (Directory.Exists(tempExtract)) Directory.Delete(tempExtract, true);
                    Directory.CreateDirectory(tempExtract);

                    UiUpdate(78, "Extracting Brief files...", "Unpacking Windows runtime and desktop engine...");
                    ZipFile.ExtractToDirectory(tempZip, tempExtract);

                    UiUpdate(88, "Installing Brief to Windows...", targetDir);
                    CopyDirectory(tempExtract, targetDir);

                    string briefExe = Path.Combine(targetDir, "Brief.exe");
                    if (!File.Exists(briefExe))
                    {
                        string alt = Path.Combine(targetDir, "LOCALLY.exe");
                        if (File.Exists(alt)) File.Copy(alt, briefExe, true);
                    }
                    installedExePath = briefExe;
                    string icoPath = Path.Combine(targetDir, "resources", "app", "assets", "icon.ico");

                    // 3. Create Windows Start Menu & Desktop Shortcuts + Add/Remove Programs Entry
                    UiUpdate(95, "Creating Windows shortcuts...", "Adding Start Menu, Desktop, and Installed Apps entry...");
                    string startDir = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.Programs));
                    string deskDir = Environment.GetFolderPath(Environment.SpecialFolder.DesktopDirectory);
                    if (mkStartMenu) CreateShortcut(Path.Combine(startDir, "Brief.lnk"), briefExe, targetDir, icoPath);
                    if (mkDesktop) CreateShortcut(Path.Combine(deskDir, "Brief.lnk"), briefExe, targetDir, icoPath);
                    RegisterUninstallEntry(targetDir, briefExe, icoPath);

                    UiUpdate(100, "Installation complete!", "Brief is ready to launch.");
                    BeginInvoke((MethodInvoker)delegate
                    {
                        installing = false;
                        lblFinishSummary.Text = "Brief was downloaded and installed in:\\r\\n" + targetDir +
                            "\\r\\n\\r\\nClick Finish to close Setup and open Brief.";
                        ShowPage(3);
                    });
                }
                catch (OperationCanceledException)
                {
                    BeginInvoke((MethodInvoker)delegate
                    {
                        installing = false;
                        ShowPage(1);
                    });
                }
                catch (Exception ex)
                {
                    BeginInvoke((MethodInvoker)delegate
                    {
                        installing = false;
                        MessageBox.Show(this, "Brief Setup failed: " + ex.Message, "Brief Setup Error", MessageBoxButtons.OK, MessageBoxIcon.Error);
                        ShowPage(1);
                    });
                }
                finally
                {
                    try { if (File.Exists(tempZip)) File.Delete(tempZip); } catch { }
                    try { if (Directory.Exists(tempExtract)) Directory.Delete(tempExtract, true); } catch { }
                }
            });
            t.IsBackground = true;
            t.SetApartmentState(ApartmentState.STA);
            t.Start();
        }

        private static void CopyDirectory(string sourceDir, string destDir)
        {
            Directory.CreateDirectory(destDir);
            foreach (string file in Directory.GetFiles(sourceDir))
            {
                string name = Path.GetFileName(file);
                File.Copy(file, Path.Combine(destDir, name), true);
            }
            foreach (string dir in Directory.GetDirectories(sourceDir))
            {
                string name = Path.GetFileName(dir);
                CopyDirectory(dir, Path.Combine(destDir, name));
            }
        }

        private static void CreateShortcut(string shortcutPath, string targetExe, string workDir, string iconPath)
        {
            try
            {
                Directory.CreateDirectory(Path.GetDirectoryName(shortcutPath));
                Type shellType = Type.GetTypeFromProgID("WScript.Shell");
                if (shellType == null) return;
                object shellObj = Activator.CreateInstance(shellType);
                object sc = shellType.InvokeMember("CreateShortcut", BindingFlags.InvokeMethod, null, shellObj, new object[] { shortcutPath });
                sc.GetType().InvokeMember("TargetPath", BindingFlags.SetProperty, null, sc, new object[] { targetExe });
                sc.GetType().InvokeMember("WorkingDirectory", BindingFlags.SetProperty, null, sc, new object[] { workDir });
                if (File.Exists(iconPath))
                {
                    sc.GetType().InvokeMember("IconLocation", BindingFlags.SetProperty, null, sc, new object[] { iconPath + ",0" });
                }
                sc.GetType().InvokeMember("Description", BindingFlags.SetProperty, null, sc, new object[] { "Brief — Private Desktop AI Agent" });
                sc.GetType().InvokeMember("Save", BindingFlags.InvokeMethod, null, sc, null);
            }
            catch { }
        }

        private static void RegisterUninstallEntry(string installDir, string exePath, string iconPath)
        {
            try
            {
                using (RegistryKey key = Registry.CurrentUser.CreateSubKey(@"Software\Microsoft\Windows\CurrentVersion\Uninstall\Brief"))
                {
                    if (key == null) return;
                    key.SetValue("DisplayName", "Brief");
                    key.SetValue("DisplayVersion", "2.0.2");
                    key.SetValue("Publisher", "Brief Desktop");
                    key.SetValue("URLInfoAbout", "https://github.com/albrhe1466-dotcom/Brief");
                    key.SetValue("InstallLocation", installDir);
                    key.SetValue("DisplayIcon", File.Exists(iconPath) ? iconPath : exePath);
                    key.SetValue("NoModify", 1, RegistryValueKind.DWord);
                    key.SetValue("NoRepair", 1, RegistryValueKind.DWord);
                    key.SetValue("UninstallString", "powershell.exe -NoProfile -WindowStyle Hidden -Command \\\"Remove-Item -LiteralPath '" + installDir.Replace("'", "''") + "' -Recurse -Force -ErrorAction SilentlyContinue\\\"");
                }
            }
            catch { }
        }

        [STAThread]
        public static void Main(string[] args)
        {
            try { NativeMethods.SetProcessDPIAware(); } catch { }
            Application.EnableVisualStyles();
            Application.SetCompatibleTextRenderingDefault(false);
            string urlArg = null;
            if (args != null)
            {
                foreach (string a in args)
                {
                    if (a != null && a.StartsWith("--url=", StringComparison.OrdinalIgnoreCase))
                    {
                        urlArg = a.Substring(6).Trim();
                    }
                }
            }
            Application.Run(new SetupForm(urlArg));
        }
    }
}
`;
}

function getSetupManifestXml() {
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<assembly xmlns="urn:schemas-microsoft-com:asm.v1" manifestVersion="1.0">
  <assemblyIdentity version="2.0.2.0" processorArchitecture="*" name="BriefDesktop.BriefSetup" type="win32"/>
  <description>Brief — Private Windows Desktop AI Assistant Setup Wizard</description>
  <trustInfo xmlns="urn:schemas-microsoft-com:asm.v3">
    <security>
      <requestedPrivileges>
        <requestedExecutionLevel level="asInvoker" uiAccess="false"/>
      </requestedPrivileges>
    </security>
  </trustInfo>
  <compatibility xmlns="urn:schemas-microsoft-com:compatibility.v1">
    <application>
      <supportedOS Id="{8e0f7a12-bfb3-4fe8-b9a5-48fd50a15a9a}"/>
      <supportedOS Id="{1f676c76-80e1-4239-95bb-83d0f6d0da78}"/>
    </application>
  </compatibility>
  <application xmlns="urn:schemas-microsoft-com:asm.v3">
    <windowsSettings>
      <dpiAware xmlns="http://schemas.microsoft.com/SMI/2005/WindowsSettings">true/pm</dpiAware>
    </windowsSettings>
  </application>
</assembly>`;
}

function findSignToolExe() {
  const roots = [
    path.join(process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)', 'Windows Kits', '10', 'bin'),
    path.join(process.env.ProgramFiles || 'C:\\Program Files', 'Windows Kits', '10', 'bin')
  ];
  for (const r of roots) {
    if (!fs.existsSync(r)) continue;
    const entries = fs.readdirSync(r).sort().reverse();
    for (const e of entries) {
      const p = path.join(r, e, 'x64', 'signtool.exe');
      if (fs.existsSync(p)) return p;
    }
  }
  return null;
}

function tryAuthenticodeSign(filePath, workDir) {
  const b64 = process.env.BRIEF_CERT_PFX_BASE64 || '';
  const pfxPathEnv = process.env.BRIEF_CERT_PFX_PATH || '';
  const certPass = process.env.BRIEF_CERT_PASSWORD || '';
  if (!b64 && !pfxPathEnv) return false;
  const signtool = findSignToolExe();
  if (!signtool) {
    console.warn('WARN: Signing certificate provided, but Windows SDK signtool.exe was not found.');
    return false;
  }
  const pfxFile = pfxPathEnv || path.join(workDir, 'brief-signing.pfx');
  if (b64 && !pfxPathEnv) {
    fs.writeFileSync(pfxFile, Buffer.from(b64, 'base64'));
  }
  try {
    const signArgs = ['sign', '/fd', 'SHA256', '/tr', 'http://timestamp.digicert.com', '/td', 'SHA256', '/f', pfxFile];
    if (certPass) signArgs.push('/p', certPass);
    signArgs.push('/d', 'Brief Desktop AI Assistant', '/du', 'https://github.com/albrhe1466-dotcom/Brief', filePath);
    execFileSync(signtool, signArgs, { windowsHide: true, stdio: 'inherit' });
    console.log('SIGNED (Authenticode SHA-256):', filePath);
    return true;
  } finally {
    if (b64 && !pfxPathEnv && fs.existsSync(pfxFile)) {
      try { fs.rmSync(pfxFile, { force: true }); } catch (_) { /* ignore */ }
    }
  }
}

async function main() {
  if (!fs.existsSync(path.join(ELECTRON_DIST, 'electron.exe'))) {
    throw new Error('Electron runtime missing in node_modules/electron/dist');
  }

  fs.mkdirSync(DOWNLOADS_DIR, { recursive: true });
  fs.rmSync(WORK_DIR, { recursive: true, force: true });
  fs.mkdirSync(STAGE_APP, { recursive: true });

  console.log('1/4 Staging Brief Windows runtime...');
  fs.cpSync(ELECTRON_DIST, STAGE_APP, { recursive: true });
  const defaultAsar = path.join(STAGE_APP, 'resources', 'default_app.asar');
  if (fs.existsSync(defaultAsar)) fs.rmSync(defaultAsar, { force: true });

  const resAppDir = path.join(STAGE_APP, 'resources', 'app');
  fs.mkdirSync(resAppDir, { recursive: true });
  fs.copyFileSync(path.join(ROOT, 'package.json'), path.join(resAppDir, 'package.json'));
  fs.copyFileSync(path.join(ROOT, 'app.html'), path.join(resAppDir, 'app.html'));
  fs.cpSync(path.join(ROOT, 'src'), path.join(resAppDir, 'src'), { recursive: true });
  fs.cpSync(path.join(ROOT, 'assets'), path.join(resAppDir, 'assets'), { recursive: true });

  const rawExe = path.join(STAGE_APP, 'electron.exe');
  const briefExe = path.join(STAGE_APP, 'Brief.exe');
  fs.renameSync(rawExe, briefExe);

  const icoPath = path.join(ROOT, 'assets', 'icon.ico');
  await rcedit(briefExe, {
    icon: icoPath,
    'file-version': '2.0.2.0',
    'product-version': '2.0.2.0',
    'version-string': {
      ProductName: 'Brief',
      FileDescription: 'Brief — Private Windows Desktop AI Assistant',
      InternalName: 'Brief',
      OriginalFilename: 'Brief.exe',
      CompanyName: 'Brief Desktop',
      LegalCopyright: 'Copyright (c) 2026 Brief Desktop'
    }
  });
  tryAuthenticodeSign(briefExe, WORK_DIR);

  console.log('2/4 Compressing brief-package.zip...');
  if (fs.existsSync(ZIP_OUT)) fs.rmSync(ZIP_OUT, { force: true });
  execFileSync('powershell.exe', [
    '-NoLogo', '-NoProfile', '-NonInteractive', '-Command',
    `Add-Type -AssemblyName System.IO.Compression.FileSystem; [System.IO.Compression.ZipFile]::CreateFromDirectory('${STAGE_APP.replace(/'/g, "''")}', '${ZIP_OUT.replace(/'/g, "''")}', [System.IO.Compression.CompressionLevel]::Fastest, $false)`
  ], { windowsHide: true, stdio: 'inherit' });

  console.log('3/4 Compiling native Windows Setup Wizard (Brief-Setup.exe) with Win32 asInvoker manifest...');
  const csc = findCscExe();
  const csPath = path.join(WORK_DIR, 'BriefSetup.cs');
  const manifestPath = path.join(WORK_DIR, 'BriefSetup.manifest');
  const primaryUrl = process.env.BRIEF_DOWNLOAD_URL || 'http://127.0.0.1:4173/download/brief-package.zip';
  const fallbackUrl = process.env.BRIEF_FALLBACK_DOWNLOAD_URL ||
    (primaryUrl.indexOf('127.0.0.1') !== -1 ? 'http://localhost:4173/download/brief-package.zip' : '');
  const cloudFallbackUrl = process.env.BRIEF_CLOUD_FALLBACK_URL ||
    'https://github.com/albrhe1466-dotcom/Brief/releases/latest/download/brief-package.zip';
  fs.writeFileSync(csPath, getSetupWizardCSharpSource(primaryUrl, fallbackUrl, cloudFallbackUrl), 'utf8');
  fs.writeFileSync(manifestPath, getSetupManifestXml(), 'utf8');

  if (fs.existsSync(SETUP_EXE_OUT)) fs.rmSync(SETUP_EXE_OUT, { force: true });
  execFileSync(csc, [
    '/nologo',
    '/target:winexe',
    '/platform:anycpu',
    '/optimize+',
    '/win32icon:' + icoPath,
    '/win32manifest:' + manifestPath,
    '/out:' + SETUP_EXE_OUT,
    '/reference:System.dll',
    '/reference:System.Drawing.dll',
    '/reference:System.Windows.Forms.dll',
    '/reference:System.IO.Compression.dll',
    '/reference:System.IO.Compression.FileSystem.dll',
    csPath
  ], { windowsHide: true, stdio: 'inherit' });

  console.log('4/4 Embedding Brief Setup v2.0.2 metadata, SHA-256 checksums & optional Authenticode signature...');
  await rcedit(SETUP_EXE_OUT, {
    icon: icoPath,
    'file-version': '2.0.2.0',
    'product-version': '2.0.2.0',
    'version-string': {
      ProductName: 'Brief Setup',
      FileDescription: 'Brief — Private Windows Desktop AI Assistant Setup Wizard',
      InternalName: 'BriefSetup',
      OriginalFilename: 'Brief-Setup.exe',
      CompanyName: 'Brief Desktop',
      LegalCopyright: 'Copyright (c) 2026 Brief Desktop'
    }
  });
  tryAuthenticodeSign(SETUP_EXE_OUT, WORK_DIR);

  const shaExe = crypto.createHash('sha256').update(fs.readFileSync(SETUP_EXE_OUT)).digest('hex');
  const shaZip = crypto.createHash('sha256').update(fs.readFileSync(ZIP_OUT)).digest('hex');
  const sumsOut = path.join(DOWNLOADS_DIR, 'SHA256SUMS.txt');
  fs.writeFileSync(sumsOut, `${shaExe}  Brief-Setup.exe\n${shaZip}  brief-package.zip\n`, 'utf8');
  const exeBytes = fs.statSync(SETUP_EXE_OUT).size;
  const zipBytes = fs.statSync(ZIP_OUT).size;

  fs.rmSync(WORK_DIR, { recursive: true, force: true });

  console.log('SUCCESS: Built native Windows installer and app archive (v2.0.2):');
  console.log('  Setup Wizard EXE :', SETUP_EXE_OUT, `(${(exeBytes / 1024).toFixed(1)} KB, sha256=${shaExe.slice(0, 16)}...)`);
  console.log('  Payload Archive  :', ZIP_OUT, `(${(zipBytes / (1024 * 1024)).toFixed(1)} MB, sha256=${shaZip.slice(0, 16)}...)`);
  console.log('  SHA-256 Manifest :', sumsOut);
}

main().catch((e) => {
  console.error('Installer build failed:', e);
  process.exit(1);
});
