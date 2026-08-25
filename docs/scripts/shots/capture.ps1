# Docs screenshot capture — Windows only.
#
# Companion to screenshots.mjs (which only generates placeholders). This takes the real shots:
# it captures the pgCowboy window's CLIENT rect in physical pixels, so a figure is framed by the
# app's own content edge rather than a hand-drawn crop. That is the whole point — the assets were
# previously cropped by hand in the Greenshot editor, which left six different sizes and a 1-2px
# rim of desktop bleeding through the window edge (visible as a teal last row in the dark shots).
#
# Usage (dot-source, then drive it):
#   . docs/scripts/shots/capture.ps1
#   $saved = Get-OsTheme                       # snapshot BEFORE touching anything
#   Set-ClientSize 1672 1915
#   Save-ClientShot docs/src/assets/usage/operations-overview-light.png
#   Set-OsTheme dark
#   Save-ClientShot docs/src/assets/usage/operations-overview-dark.png
#   Set-OsTheme $saved                         # ALWAYS restore
#
# Coordinates everywhere are CLIENT-relative physical pixels, which is exactly the pixel grid of
# the PNGs this writes. So a control located at (x,y) in a capture is clicked with the same (x,y).
#
# Two gotchas worth knowing before you add a figure:
#   * A dialog that declares [autofocus] puts a BLINKING CARET in a text field. It lands in some
#     captures and not others, so a light/dark pair taken either side of it differs by more than
#     the theme. Click the dialog's heading first to blur the field.
#   * Personal data is redacted with -Redact (see shots.json), not sanitised at the source.

Add-Type -AssemblyName System.Drawing

if (-not ('Win32Shot' -as [type])) {
Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;
public struct RECT { public int Left, Top, Right, Bottom; }
public struct POINT { public int X, Y; }
public class Win32Shot {
  [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
  [DllImport("user32.dll")] public static extern bool GetClientRect(IntPtr h, out RECT r);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
  [DllImport("user32.dll")] public static extern bool ClientToScreen(IntPtr h, ref POINT p);
  [DllImport("user32.dll")] public static extern bool SetWindowPos(IntPtr h, IntPtr after, int x, int y, int cx, int cy, uint flags);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
  [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
  [DllImport("user32.dll")] public static extern void mouse_event(uint flags, uint dx, uint dy, int data, UIntPtr extra);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern IntPtr SendMessageTimeout(IntPtr h, uint msg, UIntPtr wp, string lp, uint flags, uint timeout, out UIntPtr res);

  public static readonly IntPtr HWND_TOPMOST   = new IntPtr(-1);
  public static readonly IntPtr HWND_NOTOPMOST = new IntPtr(-2);
  public const uint SWP_NOSIZE = 0x0001, SWP_NOMOVE = 0x0002, SWP_NOACTIVATE = 0x0010, SWP_SHOWWINDOW = 0x0040;
  public const uint MOUSEEVENTF_LEFTDOWN = 0x0002, MOUSEEVENTF_LEFTUP = 0x0004, MOUSEEVENTF_WHEEL = 0x0800;
}
"@
}

# System-DPI-aware so every rect below is in PHYSICAL pixels. Without this, PowerShell 5.1 is
# DPI-unaware and Windows virtualizes GetClientRect/CopyFromScreen down to logical pixels — at the
# 175% scaling this machine uses, a 1672x1915 capture would silently come back 955x1094.
$null = [Win32Shot]::SetProcessDPIAware()

function Get-AppWindow {
  param([string]$ProcessName = 'pgCowboy')
  $p = Get-Process -Name $ProcessName -ErrorAction SilentlyContinue |
       Where-Object { $_.MainWindowHandle -ne [IntPtr]::Zero } | Select-Object -First 1
  if (-not $p) { throw "No '$ProcessName' window found. Is the app running?" }
  return $p.MainWindowHandle
}

function Get-ClientRect {
  param([IntPtr]$Hwnd = (Get-AppWindow))
  $r = New-Object RECT
  $null = [Win32Shot]::GetClientRect($Hwnd, [ref]$r)
  $o = New-Object POINT
  $o.X = 0; $o.Y = 0
  $null = [Win32Shot]::ClientToScreen($Hwnd, [ref]$o)
  [pscustomobject]@{ X = $o.X; Y = $o.Y; Width = $r.Right - $r.Left; Height = $r.Bottom - $r.Top }
}

# Converge on an EXACT client size. Setting the outer size instead would land off by the border
# thickness, and asking for a logical size cannot hit an odd physical height at all (175% scaling
# quantizes to 1.75px steps) — so measure the outer/client delta and correct for it.
function Set-ClientSize {
  param([int]$Width, [int]$Height, [int]$X = 40, [int]$Y = 20, [IntPtr]$Hwnd = (Get-AppWindow))
  for ($i = 0; $i -lt 6; $i++) {
    $c = Get-ClientRect $Hwnd
    if ($c.Width -eq $Width -and $c.Height -eq $Height) { break }
    $w = New-Object RECT
    $null = [Win32Shot]::GetWindowRect($Hwnd, [ref]$w)
    $outerW = $w.Right - $w.Left
    $outerH = $w.Bottom - $w.Top
    $null = [Win32Shot]::SetWindowPos($Hwnd, [IntPtr]::Zero, $X, $Y,
             $outerW + ($Width - $c.Width), $outerH + ($Height - $c.Height),
             [Win32Shot]::SWP_NOACTIVATE -bor [Win32Shot]::SWP_SHOWWINDOW)
    Start-Sleep -Milliseconds 150
  }
  $c = Get-ClientRect $Hwnd
  if ($c.Width -ne $Width -or $c.Height -ne $Height) {
    Write-Warning "client is $($c.Width)x$($c.Height), wanted ${Width}x${Height}"
  }
  return $c
}

# Capture the client rect. Goes TOPMOST for the duration so nothing can overlay the window --
# CopyFromScreen reads the desktop framebuffer, so an obstruction would land in the PNG.
# CopyFromScreen also does NOT draw the mouse cursor, which is what lets a hover-triggered
# popover (the '?' hint) be captured without a pointer artifact in the shot.
function Save-ClientShot {
  param(
    [Parameter(Mandatory)][string]$Path,
    [int]$Crop = 0,                   # keep only the top $Crop rows (strip figures)
    [int[]]$Callout,                  # x,y,w,h -- the green highlight box
    [object[]]$Redact,                # @(@(x,y,w,h), ...) -- regions to pixelate
    [int]$Block = 14,                 # pixelation block size
    [int]$SettleMs = 250,
    [IntPtr]$Hwnd = (Get-AppWindow)
  )
  $null = [Win32Shot]::SetWindowPos($Hwnd, [Win32Shot]::HWND_TOPMOST, 0, 0, 0, 0,
            [Win32Shot]::SWP_NOMOVE -bor [Win32Shot]::SWP_NOSIZE -bor [Win32Shot]::SWP_NOACTIVATE)
  $null = [Win32Shot]::SetForegroundWindow($Hwnd)
  Start-Sleep -Milliseconds $SettleMs
  try {
    $c = Get-ClientRect $Hwnd
    $h = if ($Crop -gt 0) { [Math]::Min($Crop, $c.Height) } else { $c.Height }
    $bmp = New-Object System.Drawing.Bitmap($c.Width, $h)
    $g = [System.Drawing.Graphics]::FromImage($bmp)
    $g.CopyFromScreen($c.X, $c.Y, 0, 0, (New-Object System.Drawing.Size($c.Width, $h)))
    # Redact BEFORE the callout, so a highlight box is never itself smeared.
    # PowerShell flattens @(@(x,y,w,h)) down to a bare 4-int array, so a caller passing ONE rect
    # the obvious way would otherwise silently redact nothing. Re-wrap that case.
    $rects = @()
    if ($Redact) {
      if ($Redact.Count -eq 4 -and $Redact[0] -isnot [System.Array]) { $rects = @(, $Redact) }
      else { $rects = $Redact }
    }
    foreach ($r in $rects) {
      if (-not $r -or $r.Count -ne 4) { continue }
      $rx = [int]$r[0]; $ry = [int]$r[1]; $rw = [int]$r[2]; $rh = [int]$r[3]
      if ($rw -le 0 -or $rh -le 0) { continue }
      # Downscale the region with averaging, then blow it back up. The DOWNSCALE is what destroys
      # the information -- a plain nearest-neighbour shrink would keep one original pixel per block
      # and leave the text partly legible when enlarged, so HighQualityBicubic here is load-bearing.
      # The UPSCALE below is presentation only: the pixels are already gone by then, so drawing
      # them back smoothly (a soft frosted patch) is exactly as irreversible as hard blocks.
      # Do not "harden" this by reverting the upscale to NearestNeighbor -- it buys no safety.
      $sw = [Math]::Max(1, [int][Math]::Ceiling($rw / $Block))
      $sh = [Math]::Max(1, [int][Math]::Ceiling($rh / $Block))
      $small = New-Object System.Drawing.Bitmap($sw, $sh)
      $sg = [System.Drawing.Graphics]::FromImage($small)
      $sg.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
      $sg.DrawImage($bmp, (New-Object System.Drawing.Rectangle(0, 0, $sw, $sh)),
                    $rx, $ry, $rw, $rh, [System.Drawing.GraphicsUnit]::Pixel)
      $sg.Dispose()
      $g.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
      $g.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::Half
      $g.DrawImage($small, (New-Object System.Drawing.Rectangle($rx, $ry, $rw, $rh)),
                   0, 0, $sw, $sh, [System.Drawing.GraphicsUnit]::Pixel)
      $small.Dispose()
    }
    if ($Callout -and $Callout.Count -eq 4) {
      # Same mark the hand-annotated originals used: flat #3DC46C, 4px, square corners, no AA.
      $g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::None
      $pen = New-Object System.Drawing.Pen([System.Drawing.Color]::FromArgb(255, 61, 196, 108), 4)
      $pen.Alignment = [System.Drawing.Drawing2D.PenAlignment]::Inset
      $g.DrawRectangle($pen, $Callout[0], $Callout[1], $Callout[2], $Callout[3])
      $pen.Dispose()
    }
    $g.Dispose()
    $full = if ([System.IO.Path]::IsPathRooted($Path)) { $Path } else { Join-Path (Get-Location) $Path }
    $dir = Split-Path $full -Parent
    if (-not (Test-Path $dir)) { $null = New-Item -ItemType Directory -Force $dir }
    $bmp.Save($full, [System.Drawing.Imaging.ImageFormat]::Png)
    $bmp.Dispose()
    "{0}  {1}x{2}" -f $Path, $c.Width, $h
  } finally {
    $null = [Win32Shot]::SetWindowPos($Hwnd, [Win32Shot]::HWND_NOTOPMOST, 0, 0, 0, 0,
              [Win32Shot]::SWP_NOMOVE -bor [Win32Shot]::SWP_NOSIZE -bor [Win32Shot]::SWP_NOACTIVATE)
  }
}

$script:ThemeKey = 'HKCU:\SOFTWARE\Microsoft\Windows\CurrentVersion\Themes\Personalize'

function Get-OsTheme {
  $v = Get-ItemProperty $script:ThemeKey
  if ($v.AppsUseLightTheme -eq 0) { 'dark' } else { 'light' }
}

# Flip the OS appearance and let the app repaint IN PLACE. config.yaml has ui.theme: system and
# applyTheme() listens on prefers-color-scheme, so the window keeps its scroll position, staged
# edits and open dialogs across the flip -- which is what makes a light/dark pair differ by
# nothing but the theme. Restore the caller's snapshot when done; this is the only system state
# the capture session touches.
function Set-OsTheme {
  param([Parameter(Mandatory)][ValidateSet('light', 'dark')][string]$Theme, [int]$SettleMs = 700)
  $light = if ($Theme -eq 'light') { 1 } else { 0 }
  Set-ItemProperty $script:ThemeKey -Name AppsUseLightTheme    -Value $light -Type DWord
  Set-ItemProperty $script:ThemeKey -Name SystemUsesLightTheme -Value $light -Type DWord
  # Setting the values alone does not repaint running apps; WebView2 only re-evaluates
  # prefers-color-scheme once it sees the broadcast.
  $res = [UIntPtr]::Zero
  $null = [Win32Shot]::SendMessageTimeout([IntPtr]0xffff, 0x001A, [UIntPtr]::Zero, 'ImmersiveColorSet', 2, 400, [ref]$res)
  Start-Sleep -Milliseconds $SettleMs
}

function Invoke-ClientClick {
  param([Parameter(Mandatory)][int]$X, [Parameter(Mandatory)][int]$Y,
        [int]$SettleMs = 350, [switch]$HoverOnly, [IntPtr]$Hwnd = (Get-AppWindow))
  $c = Get-ClientRect $Hwnd
  $null = [Win32Shot]::SetForegroundWindow($Hwnd)
  $null = [Win32Shot]::SetCursorPos($c.X + $X, $c.Y + $Y)
  Start-Sleep -Milliseconds 90
  if (-not $HoverOnly) {
    [Win32Shot]::mouse_event([Win32Shot]::MOUSEEVENTF_LEFTDOWN, 0, 0, 0, [UIntPtr]::Zero)
    Start-Sleep -Milliseconds 40
    [Win32Shot]::mouse_event([Win32Shot]::MOUSEEVENTF_LEFTUP, 0, 0, 0, [UIntPtr]::Zero)
  }
  Start-Sleep -Milliseconds $SettleMs
}

# Scroll a panel by wheel notches (negative = down). The app's panels scroll independently, so
# the cursor must sit OVER the panel being scrolled -- pass -X/-Y inside it.
function Invoke-ClientScroll {
  param([Parameter(Mandatory)][int]$Notches, [int]$X = 836, [int]$Y = 1000,
        [int]$SettleMs = 400, [IntPtr]$Hwnd = (Get-AppWindow))
  $c = Get-ClientRect $Hwnd
  $null = [Win32Shot]::SetForegroundWindow($Hwnd)
  $null = [Win32Shot]::SetCursorPos($c.X + $X, $c.Y + $Y)
  Start-Sleep -Milliseconds 90
  $step = if ($Notches -lt 0) { -120 } else { 120 }
  for ($i = 0; $i -lt [Math]::Abs($Notches); $i++) {
    [Win32Shot]::mouse_event([Win32Shot]::MOUSEEVENTF_WHEEL, 0, 0, $step, [UIntPtr]::Zero)
    Start-Sleep -Milliseconds 30
  }
  Start-Sleep -Milliseconds $SettleMs
}

# Park the cursor somewhere inert. Needed before a capture that must NOT show a hover state --
# the app highlights rows and buttons under the pointer, and a stray hover is the kind of
# difference that makes a light/dark pair read as a page jump.
function Reset-Cursor {
  param([IntPtr]$Hwnd = (Get-AppWindow))
  $c = Get-ClientRect $Hwnd
  $null = [Win32Shot]::SetCursorPos($c.X + $c.Width - 3, $c.Y + 3)
  Start-Sleep -Milliseconds 150
}

function Send-ClientText {
  param([Parameter(Mandatory)][string]$Text, [int]$SettleMs = 500)
  $wsh = New-Object -ComObject WScript.Shell
  $wsh.SendKeys($Text)
  Start-Sleep -Milliseconds $SettleMs
}

# e.g. '{ESC}', '{ENTER}', '{TAB}', '^a'
function Send-ClientKey {
  param([Parameter(Mandatory)][string]$Key, [int]$SettleMs = 400)
  $wsh = New-Object -ComObject WScript.Shell
  $wsh.SendKeys($Key)
  Start-Sleep -Milliseconds $SettleMs
}
