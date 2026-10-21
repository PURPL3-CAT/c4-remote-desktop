# Building a Windows installer

The current packaging target is Windows x64. The installer includes the Electron
app and a PyInstaller-built input bridge, so friends do not need Node.js or
Python installed.

## Build

1. Install Node.js and Python 3.13 x64 on the build machine.
2. From the project directory, run `npm ci`.
3. Create the local build environment once:

   ```powershell
   py -3.13 -m venv .venv
   ```

4. Build the installer:

   ```powershell
   npm run package:win
   ```

The installer is written to `release/`. Give friends the generated
`c4-Ignition-setup-1.0.0-x64.exe`, not the project folder or the unpacked
application.

## Before distributing

- Test install, first-run enrollment, app restart, remote connection, input,
  revocation, and uninstall on a clean Windows account or VM.
- This setup is not code-signed. Windows may show SmartScreen or publisher
  warnings; do not tell recipients to bypass warnings unless they have
  independently verified the installer. A code-signing certificate is needed
  for a verified publisher identity.
- The first local enrollment and any Windows/macOS screen-capture permission
  approval must happen on the host device. After enrollment, capture is
  unattended until revoked. Protect and share the access code as a secret.
- The app still uses the public PeerJS signaling service and Google STUN. The
  installer does not remove that third-party service dependency.
- This build recipe currently targets Windows x64 only. macOS/Linux need
  platform-specific builds, input-bridge dependencies, signing, and testing.
