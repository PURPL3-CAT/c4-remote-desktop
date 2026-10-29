const { app, BrowserWindow, desktopCapturer, dialog, ipcMain } = require("electron");
const { spawn } = require("child_process");
const fs = require("fs");
const path = require("path");
const { pathToFileURL } = require("url");
const credentials = require("./c4-identity");

let mainWindow = null;
let python = null;
let shutdownInProgress = false;
let screenCaptureApproved = false;
const authorizedRenderers = new Set();
const inputRates = new Map();
let testModeActive = false;
let testModeStartTime = 0;
const testModeLogPath = path.join(__dirname, "c4-lag-test.log");

async function getConfiguredCaptureSource() {
    const settings = credentials.getCaptureSettings();
    if (!settings.unattendedCapture) {
        throw new Error("Unattended screen sharing has not been enabled on this device.");
    }
    const sources = await desktopCapturer.getSources({
        types: ["screen"],
        thumbnailSize: { width: 1, height: 1 }
    });
    if (sources.length === 0) {
        throw new Error("No capturable screen was found.");
    }

    let source = sources[0];
    if (settings.displayId) {
        if (settings.displayId.startsWith("id:")) {
            source = sources.find(candidate => candidate.display_id === settings.displayId.slice(3));
        } else if (settings.displayId.startsWith("name:")) {
            source = sources.find(candidate => candidate.name === settings.displayId.slice(5));
        } else {
            throw new Error("Stored screen selection is invalid; re-enable unattended sharing locally.");
        }
    }
    if (!source) {
        throw new Error("The previously selected screen is unavailable; re-enable unattended sharing locally.");
    }
    return source;
}

function assertMainFrame(event) {
    if (!mainWindow ||
        event.sender !== mainWindow.webContents ||
        !event.senderFrame ||
        event.senderFrame !== mainWindow.webContents.mainFrame) {
        throw new Error("Rejected IPC request from an untrusted renderer.");
    }
}

function endRendererSession(senderId) {
    authorizedRenderers.delete(senderId);
    inputRates.delete(senderId);
    credentials.revokePendingChallenge(senderId);

    sendBridgeMessage({ kind: "session-end" });
}

function sendBridgeMessage(message) {
    if (!python || !python.stdin.writable) {
        return;
    }
    try {
        python.stdin.write(JSON.stringify(message) + "\n");
    } catch (error) {
        console.error("[c4-input] failed to send input:", error);
        python.kill();
        python = null;
    }
}

function isFiniteNumber(value, limit) {
    return typeof value === "number" && Number.isFinite(value) && Math.abs(value) <= limit;
}

function hasExactKeys(value, keys) {
    const actual = Object.keys(value).sort();
    const expected = [...keys].sort();
    return actual.length === expected.length &&
        actual.every((key, index) => key === expected[index]);
}

function isValidInput(payload) {
    if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
        return false;
    }

    switch (payload.kind) {
        case "keydown":
        case "keyup":
            return hasExactKeys(payload, ["kind", "key", "code", "ctrl", "alt", "shift", "meta"]) &&
                typeof payload.key === "string" &&
                payload.key.length <= 32 &&
                typeof payload.code === "string" &&
                payload.code.length <= 32 &&
                ["ctrl", "alt", "shift", "meta"].every(key => typeof payload[key] === "boolean");
        case "mousemove":
            return hasExactKeys(payload, ["kind", "relative", "dx", "dy"]) &&
                payload.relative === true &&
                isFiniteNumber(payload.dx, 10_000) &&
                isFiniteNumber(payload.dy, 10_000);
        case "mousedown":
        case "mouseup":
            return hasExactKeys(payload, ["kind", "button"]) &&
                Number.isInteger(payload.button) && payload.button >= 0 && payload.button <= 2;
        case "wheel":
            return hasExactKeys(payload, ["kind", "delta", "deltaMode"]) &&
                isFiniteNumber(payload.delta, 10_000) &&
                Number.isInteger(payload.deltaMode) &&
                payload.deltaMode >= 0 && payload.deltaMode <= 2;
        default:
            return false;
    }
}

function isValidInputEnvelope(envelope) {
    return envelope &&
        typeof envelope === "object" &&
        hasExactKeys(envelope, ["nonce", "sequence", "proof", "event"]) &&
        typeof envelope.nonce === "string" &&
        /^[0-9a-f]{64}$/.test(envelope.nonce) &&
        Number.isSafeInteger(envelope.sequence) &&
        envelope.sequence > 0 &&
        typeof envelope.proof === "string" &&
        /^[0-9a-f]{64}$/.test(envelope.proof) &&
        isValidInput(envelope.event);
}

function allowInputAtCurrentRate(senderId) {
    const now = Date.now();
    let rate = inputRates.get(senderId);
    if (!rate || now - rate.startedAt >= 1_000) {
        rate = { startedAt: now, count: 0 };
        inputRates.set(senderId, rate);
    }

    if (rate.count >= 500) {
        return false;
    }
    rate.count += 1;
    return true;
}

function registerIpcHandlers() {
    ipcMain.handle("c4-get-device-id", event => {
        assertMainFrame(event);
        return credentials.getDeviceId();
    });

    ipcMain.handle("c4-were-credentials-migrated", event => {
        assertMainFrame(event);
        return credentials.wereCredentialsMigrated();
    });

    ipcMain.handle("c4-get-capture-settings", event => {
        assertMainFrame(event);
        return credentials.getCaptureSettings();
    });

    ipcMain.handle("c4-enable-unattended-capture", async event => {
        assertMainFrame(event);
        const sources = await desktopCapturer.getSources({
            types: ["screen"],
            thumbnailSize: { width: 1, height: 1 }
        });
        if (sources.length === 0) {
            throw new Error("No capturable screen was found.");
        }

        const choices = sources.map(source => source.name).concat("Cancel");
        const result = await dialog.showMessageBox(mainWindow, {
            type: "warning",
            title: "Enable unattended screen sharing",
            message: "After this one-time setup, c4 will capture the selected screen whenever it starts. Anyone with the access code can view and control this device.",
            buttons: choices,
            cancelId: choices.length - 1,
            defaultId: choices.length - 1,
            noLink: true
        });
        if (result.response < 0 || result.response >= sources.length) {
            return false;
        }
        const source = sources[result.response];
        const displayId = source.display_id
            ? `id:${source.display_id}`
            : `name:${source.name}`;
        credentials.setCaptureSettings(true, displayId);
        return true;
    });

    ipcMain.handle("c4-disable-unattended-capture", event => {
        assertMainFrame(event);
        credentials.setCaptureSettings(false);
        screenCaptureApproved = false;
        endRendererSession(event.sender.id);
        return true;
    });

    ipcMain.handle("c4-get-capture-source", async event => {
        assertMainFrame(event);
        const source = await getConfiguredCaptureSource();
        return { id: source.id };
    });

    ipcMain.handle("c4-screen-share-started", event => {
        assertMainFrame(event);
        if (!credentials.getCaptureSettings().unattendedCapture) {
            return false;
        }
        screenCaptureApproved = true;
        return true;
    });

    ipcMain.handle("c4-get-access-code", async event => {
        assertMainFrame(event);
        const result = await dialog.showMessageBox(mainWindow, {
            type: "warning",
            title: "Reveal remote access code",
            message: "Anyone who obtains this code can control this device while screen sharing is enabled.",
            buttons: ["Reveal code", "Cancel"],
            cancelId: 1,
            defaultId: 1,
            noLink: true
        });
        if (result.response !== 0) {
            return null;
        }
        return credentials.getAccessCode();
    });

    ipcMain.handle("c4-rotate-access-code", async event => {
        assertMainFrame(event);
        const result = await dialog.showMessageBox(mainWindow, {
            type: "warning",
            title: "Regenerate remote access code",
            message: "This immediately disconnects every controller and invalidates the old code.",
            buttons: ["Regenerate code", "Cancel"],
            cancelId: 1,
            defaultId: 1,
            noLink: true
        });
        if (result.response !== 0) {
            return null;
        }
        const code = credentials.rotateAccessCode();
        for (const rendererId of authorizedRenderers) {
            if (mainWindow && rendererId === mainWindow.webContents.id) {
                mainWindow.webContents.send("c4-access-code-rotated");
            }
        }
        authorizedRenderers.clear();
        inputRates.clear();
        sendBridgeMessage({ kind: "session-end" });
        return code;
    });

    ipcMain.handle("c4-create-auth-challenge", event => {
        assertMainFrame(event);
        if (!screenCaptureApproved) {
            throw new Error("Screen sharing must be approved locally before remote access is enabled.");
        }
        endRendererSession(event.sender.id);
        return credentials.createDeviceChallenge(event.sender.id);
    });

    ipcMain.handle("c4-authorize-controller", (event, args) => {
        assertMainFrame(event);
        if (!screenCaptureApproved) {
            return false;
        }
        if (!args || typeof args.nonce !== "string" || typeof args.proof !== "string") {
            return false;
        }
        const authorized = credentials.verifyControllerProof(event.sender.id, args.nonce, args.proof);
        if (authorized) {
            authorizedRenderers.add(event.sender.id);
        }
        return authorized;
    });

    ipcMain.handle("c4-screen-share-ended", event => {
        assertMainFrame(event);
        screenCaptureApproved = false;
        endRendererSession(event.sender.id);
        return true;
    });

    ipcMain.handle("c4-start-input", event => {
        assertMainFrame(event);
        if (!screenCaptureApproved || !authorizedRenderers.has(event.sender.id)) {
            throw new Error("Input bridge cannot start before controller authentication.");
        }
        if (python) {
            return true;
        }

        const executable = app.isPackaged
            ? path.join(process.resourcesPath, "c4-input", "c4-input.exe")
            : "python";
        const args = app.isPackaged ? [] : [path.join(__dirname, "c4-input.py")];
        if (app.isPackaged && !fs.existsSync(executable)) {
            throw new Error(`Packaged input bridge is missing: ${executable}`);
        }

        const child = spawn(executable, args, {
            stdio: ["pipe", "ignore", "pipe"],
            windowsHide: true
        });
        python = child;
        child.stdin.on("error", error => {
            console.error("[c4-input] input pipe failed:", error);
        });
        child.stderr.on("data", data => {
            console.error("[c4-input]", data.toString().trim());
        });
        child.on("error", error => {
            console.error("[c4-input] failed to start:", error);
            if (python === child) {
                python = null;
            }
        });
        child.on("exit", () => {
            if (python === child) {
                python = null;
            }
            console.log("[c4-input] exited");
        });

        return new Promise((resolve, reject) => {
            child.once("spawn", () => resolve(true));
            child.once("error", error => {
                reject(new Error(`Could not start the input bridge: ${error.message}`));
            });
        });
    });

    ipcMain.handle("c4-test-mode-start", event => {
        assertMainFrame(event);
        testModeActive = true;
        testModeStartTime = Date.now();
        const logEntry = `=== Lag Test Started: ${new Date(testModeStartTime).toISOString()} ===\n`;
        fs.appendFileSync(testModeLogPath, logEntry);
        return true;
    });

    ipcMain.handle("c4-test-mode-ping", event => {
        assertMainFrame(event);
        if (!testModeActive) {
            return false;
        }
        const entry = `${Date.now() - testModeStartTime},ping\n`;
        fs.appendFileSync(testModeLogPath, entry);
        return true;
    });

    ipcMain.handle("c4-test-mode-stop", event => {
        assertMainFrame(event);
        const endTime = Date.now();
        testModeActive = false;
        const durationMs = endTime - testModeStartTime;
        const logEntry = `=== Lag Test Ended: ${new Date(endTime).toISOString()} (duration ${durationMs} ms) ===\n\n`;
        fs.appendFileSync(testModeLogPath, logEntry);
        return durationMs;
    });

    ipcMain.on("c4-test-pong", (event, pong) => {
        if (!mainWindow || event.sender !== mainWindow.webContents) {
            return;
        }
        mainWindow.webContents.send("c4-test-pong", pong);
    });

    ipcMain.handle("c4-send-input", (event, envelope) => {
        assertMainFrame(event);
        if (!screenCaptureApproved ||
            !authorizedRenderers.has(event.sender.id) ||
            !isValidInputEnvelope(envelope) ||
            !allowInputAtCurrentRate(event.sender.id) ||
            !credentials.verifyControllerInput(
                event.sender.id,
                envelope.nonce,
                envelope.sequence,
                envelope.event,
                envelope.proof
            )) {
            return false;
        }
        if (!python || !python.stdin.writable) {
            return false;
        }
        sendBridgeMessage(envelope.event);
        return true;
    });

    ipcMain.on("c4-end-session", event => {
        assertMainFrame(event);
        endRendererSession(event.sender.id);
    });
}

async function createWindow() {
    mainWindow = new BrowserWindow({
        width: 1280,
        height: 800,
        backgroundColor: "#000000",
        autoHideMenuBar: true,
        webPreferences: {
            preload: path.join(__dirname, "c4-preload.js"),
            nodeIntegration: false,
            contextIsolation: true,
            sandbox: true,
            webSecurity: true,
            allowRunningInsecureContent: false
        }
    });

    const win = mainWindow;
    const expectedUrl = pathToFileURL(path.join(__dirname, "c4-device.html")).href;
    win.webContents.session.setDisplayMediaRequestHandler(async (request, callback) => {
        if (!screenCaptureApproved ||
            !request.videoRequested ||
            !request.frame ||
            request.frame !== win.webContents.mainFrame ||
            request.frame.url.toLowerCase() !== expectedUrl.toLowerCase()) {
            callback({});
            return;
        }

        try {
            const source = await getConfiguredCaptureSource();
            callback({
                video: source,
                ...(request.audioRequested && process.platform === "win32"
                    ? { audio: "loopback" }
                    : {})
            });
        } catch (error) {
            console.error("Could not authorize display-media capture:", error);
            callback({});
        }
    }, { useSystemPicker: false });
    win.webContents.on("will-navigate", (event, url) => {
        if (url.toLowerCase() !== expectedUrl.toLowerCase()) {
            event.preventDefault();
        }
    });
    win.webContents.on("did-start-navigation", (_event, _url, _isInPlace, isMainFrame) => {
        if (isMainFrame) {
            screenCaptureApproved = false;
            endRendererSession(win.webContents.id);
        }
    });
    win.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
    win.webContents.on("render-process-gone", () => {
        screenCaptureApproved = false;
        endRendererSession(win.webContents.id);
    });
    win.on("closed", () => {
        screenCaptureApproved = false;
        endRendererSession(win.webContents.id);
        if (mainWindow === win) {
            mainWindow = null;
        }
    });

    await win.loadFile(path.join(__dirname, "c4-device.html"));
}

registerIpcHandlers();

app.whenReady().then(async () => {
    credentials.loadCredentials();
    await createWindow();
}).catch(error => {
    console.error("c4 failed to start securely:", error);
    app.quit();
});

app.on("window-all-closed", () => {
    if (process.platform !== "darwin") {
        app.quit();
    }
});

app.on("before-quit", event => {
    screenCaptureApproved = false;
    if (python && !shutdownInProgress) {
        shutdownInProgress = true;
        event.preventDefault();
        const child = python;
        if (mainWindow) {
            endRendererSession(mainWindow.webContents.id);
        }
        child.once("exit", () => {
            if (python === child) {
                python = null;
            }
            app.quit();
        });
        if (child.stdin.writable) {
            child.stdin.end();
        }
        setTimeout(() => {
            if (child.exitCode === null && child.signalCode === null) {
                child.kill();
            }
        }, 1_500).unref();
        return;
    }
    if (mainWindow) {
        endRendererSession(mainWindow.webContents.id);
    }
    if (python) {
        python.kill();
        python = null;
    }
});
