$ErrorActionPreference = "Stop"

$Root = Resolve-Path (Join-Path $PSScriptRoot "..")
Push-Location $Root

Write-Host "1/3 Frontend derleniyor..."
Push-Location (Join-Path $Root "frontend")
npm ci
npm run build
Pop-Location

Write-Host "2/3 Python bağımlılıkları ve PyInstaller kuruluyor..."
python -m pip install --upgrade pip
pip install -r backend/requirements.txt pyinstaller

Write-Host "3/3 TobySatranc.exe oluşturuluyor..."
pyinstaller `
  --noconfirm `
  --clean `
  --onefile `
  --name TobySatranc `
  --paths backend `
  --add-data "frontend/dist;frontend/dist" `
  --hidden-import uvicorn.logging `
  --hidden-import uvicorn.loops.auto `
  --hidden-import uvicorn.protocols.http.auto `
  --hidden-import uvicorn.protocols.websockets.auto `
  --hidden-import uvicorn.lifespan.on `
  backend/app.py

Write-Host "Hazır: dist\TobySatranc.exe"
Pop-Location
