$ErrorActionPreference = "Stop"

$InstallDir = if ($env:TOBY_INSTALL_DIR) { $env:TOBY_INSTALL_DIR } else { Join-Path $PSScriptRoot ".." }
$ManifestUrl = "https://toby.tribychess.org/toby_manifest.json"

Write-Host "Toby 2.0 Windows manifest kontrol ediliyor..."
$Manifest = Invoke-RestMethod -Uri $ManifestUrl
$Filename = $Manifest.windows.light.fichier
$DownloadUrl = "https://toby.tribychess.org/$Filename"
$ZipPath = Join-Path $InstallDir $Filename

Write-Host "İndiriliyor: $DownloadUrl"
Invoke-WebRequest -Uri $DownloadUrl -OutFile $ZipPath

Write-Host "Arşiv açılıyor: $InstallDir"
Expand-Archive -Path $ZipPath -DestinationPath $InstallDir -Force
Remove-Item -Path $ZipPath -Force

Write-Host "Kurulum tamamlandı: $(Join-Path $InstallDir 'Toby\toby.exe')"
