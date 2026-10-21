$ErrorActionPreference = "Stop"

$root = Split-Path -Parent $PSScriptRoot
$python = Join-Path $root ".venv\Scripts\python.exe"

if (-not (Test-Path -LiteralPath $python -PathType Leaf)) {
    throw "Project Python environment not found at $python. Create it with: py -3.13 -m venv .venv"
}

Push-Location $root
try {
    & $python -m pip install --disable-pip-version-check -r requirements-input.txt
    if ($LASTEXITCODE -ne 0) {
        throw "Installing the pinned input-bridge dependencies failed."
    }

    & $python -m PyInstaller `
        --noconfirm `
        --clean `
        --onedir `
        --name c4-input `
        --distpath (Join-Path $root "build\python") `
        --workpath (Join-Path $root "build\pyinstaller") `
        (Join-Path $root "c4-input.py")
    if ($LASTEXITCODE -ne 0) {
        throw "Packaging the Python input bridge failed."
    }

    & npx electron-builder --win nsis --x64
    if ($LASTEXITCODE -ne 0) {
        throw "Building the Windows installer failed."
    }
}
finally {
    Pop-Location
}
