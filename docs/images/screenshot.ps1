param([Parameter(Mandatory)][string]$Name)

Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing

$screen  = [System.Windows.Forms.Screen]::PrimaryScreen.Bounds
$bmp     = New-Object System.Drawing.Bitmap($screen.Width, $screen.Height)
$g       = [System.Drawing.Graphics]::FromImage($bmp)
$g.CopyFromScreen($screen.Location, [System.Drawing.Point]::Empty, $screen.Size)
$g.Dispose()

$out = Join-Path $PSScriptRoot "$Name.png"
$bmp.Save($out, [System.Drawing.Imaging.ImageFormat]::Png)
$bmp.Dispose()

Write-Host "Saved: $out"
