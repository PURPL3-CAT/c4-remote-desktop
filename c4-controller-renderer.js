let peer = null;
let dataConn = null;
let inputConn = null;
let activeCall = null;
let activeAudioCall = null;
let authenticated = false;
let authAttempted = false;
let inputCaptureActive = false;
let sessionCode = null;
let sessionNonce = null;
let nextInputSequence = 0;
let inputQueue = Promise.resolve();
let peerRecovery = null;
let videoFrameTimeout = null;
let debugStatsTimer = null;
let debugStatsPending = false;
let previousInboundStats = null;
let remoteVideoStats = null;
let testModeActive = false;
let testModeStartTime = 0;
let testModeTimer = null;
let testModePingCount = 0;
let testModePingSum = 0;
let testModePingMax = 0;
let testModePingMin = Infinity;
let testModeResults = [];

const video = document.getElementById("video");
const audio = document.getElementById("remote-audio");
const canvas = document.getElementById("canvas");
const ctx = canvas.getContext("2d");
const statusEl = document.getElementById("status");
const accessCodeEl = document.getElementById("access-code");
const settingsButton = document.getElementById("settings-btn");
const settingsPanel = document.getElementById("settings-panel");
const debugButton = document.getElementById("debug-btn");
const debugPanel = document.getElementById("debug-panel");
const testModeButton = document.getElementById("test-mode-btn");
const audioEnabledEl = document.getElementById("audio-enabled");
const mouseSpeedEl = document.getElementById("mouse-speed");
const mouseSpeedValueEl = document.getElementById("mouse-speed-value");
const scrollSpeedEl = document.getElementById("scroll-speed");
const scrollSpeedValueEl = document.getElementById("scroll-speed-value");
const resolutionEl = document.getElementById("stream-resolution");
const vaultPinEl = document.getElementById("credential-vault-pin");
const vaultStatusEl = document.getElementById("credential-vault-status");
const unlockCredentialsButton = document.getElementById("unlock-credentials-btn");
const forgetCredentialsButton = document.getElementById("forget-credentials-btn");
const CREDENTIAL_VAULT_KEY = "c4-controller-credentials-v1";

const DEFAULT_SETTINGS = {
    audio: false,
    mouseSpeed: 1,
    scrollMultiplier: 1,
    resolution: "1280x720"
};
const RESOLUTIONS = new Set([
    "1280x720", "960x540", "640x360",
    "1920x1080", "2560x1440", "3840x2160"
]);
let settings = { ...DEFAULT_SETTINGS };

ctx.imageSmoothingEnabled = false;

function setStatus(message) {
    statusEl.textContent = message;
}

function setVaultStatus(message) {
    vaultStatusEl.textContent = message;
}

function updateCredentialVaultControls() {
    try {
        const hasSavedCredentials = localStorage.getItem(CREDENTIAL_VAULT_KEY) !== null;
        unlockCredentialsButton.hidden = !hasSavedCredentials;
        forgetCredentialsButton.hidden = !hasSavedCredentials;
    } catch (error) {
        unlockCredentialsButton.hidden = true;
        forgetCredentialsButton.hidden = true;
        setVaultStatus(`Saved connections are unavailable: ${error.message}`);
    }
}

async function saveCredentials() {
    const deviceId = document.getElementById("device-id").value.trim();
    const accessCode = accessCodeEl.value.trim();
    const pin = vaultPinEl.value;
    vaultPinEl.value = "";
    if (!deviceId || !accessCode) {
        setVaultStatus("Enter a device ID and access code before saving.");
        return;
    }
    try {
        window.c4auth.decodeAccessCode(accessCode);
        const encrypted = await window.c4ControllerVault.encrypt({ deviceId, accessCode }, pin);
        localStorage.setItem(CREDENTIAL_VAULT_KEY, encrypted);
        updateCredentialVaultControls();
        setVaultStatus("Connection saved encrypted. Unlock it with this PIN/passphrase next time.");
    } catch (error) {
        console.error("Could not save encrypted connection:", error);
        setVaultStatus(error.message);
    }
}

async function unlockCredentials() {
    const pin = vaultPinEl.value;
    vaultPinEl.value = "";
    try {
        const encrypted = localStorage.getItem(CREDENTIAL_VAULT_KEY);
        if (encrypted === null) {
            updateCredentialVaultControls();
            setVaultStatus("No saved connection was found in this browser.");
            return;
        }
        const credentials = await window.c4ControllerVault.decrypt(encrypted, pin);
        window.c4auth.decodeAccessCode(credentials.accessCode);
        document.getElementById("device-id").value = credentials.deviceId;
        accessCodeEl.value = credentials.accessCode;
        setVaultStatus("Connection unlocked. Press Connect when ready.");
    } catch (error) {
        console.error("Could not unlock saved connection:", error);
        setVaultStatus(error.message);
    }
}

function forgetCredentials() {
    if (!window.confirm("Forget the encrypted saved connection on this browser?")) {
        return;
    }
    try {
        localStorage.removeItem(CREDENTIAL_VAULT_KEY);
        document.getElementById("device-id").value = "";
        accessCodeEl.value = "";
        updateCredentialVaultControls();
        setVaultStatus("Saved connection forgotten.");
    } catch (error) {
        console.error("Could not forget saved connection:", error);
        setVaultStatus(`Could not forget saved connection: ${error.message}`);
    }
}

video.addEventListener("loadeddata", () => {
    if (video.srcObject) {
        clearTimeout(videoFrameTimeout);
        videoFrameTimeout = null;
        setStatus(`streaming screen (${video.videoWidth}×${video.videoHeight})`);
    }
});

video.addEventListener("error", () => {
    if (video.srcObject && video.error) {
        clearTimeout(videoFrameTimeout);
        videoFrameTimeout = null;
        setStatus(`video playback failed (media error ${video.error.code})`);
    }
});

function setSettingsPanelOpen(open) {
    settingsPanel.hidden = !open;
    settingsButton.setAttribute("aria-expanded", String(open));
    if (open) {
        setDebugPanelOpen(false);
    }
}

function setDebugPanelOpen(open) {
    debugPanel.hidden = !open;
    debugButton.setAttribute("aria-expanded", String(open));
    if (open) {
        setSettingsPanelOpen(false);
        updateDebugStats();
        clearInterval(debugStatsTimer);
        debugStatsTimer = setInterval(updateDebugStats, 1000);
    } else {
        clearInterval(debugStatsTimer);
        debugStatsTimer = null;
    }
}

settingsButton.addEventListener("click", () => {
    setSettingsPanelOpen(settingsPanel.hidden);
});

debugButton.addEventListener("click", () => {
debugButton.addEventListener("click", () => {
    setDebugPanelOpen(debugPanel.hidden);
});

testModeButton.addEventListener("click", async () => {
    if (testModeActive) {
        if (testModeTimer) {
            clearInterval(testModeTimer);
            testModeTimer = null;
        }
        if (dataConn && dataConn.open) {
            dataConn.send({ type: "test-mode-end" });
        }
        if (inputConn && inputConn.open) {
            inputConn.send({ type: "test-mode-end" });
        }
        setStatus("lag test stopped");
        return;
    }

    testModeActive = true;
    testModeStartTime = Date.now();
    testModePingCount = 0;
    testModePingSum = 0;
    testModePingMax = 0;
    testModePingMin = Infinity;
    testModeResults = [];

    const startResponse = await window.c4.startLagTest();
    if (!startResponse) {
        testModeActive = false;
        setStatus("lag test could not start");
        return;
    }

    setStatus("running 30s lag test…");
    testModeTimer = setInterval(() => {
        if (!authenticated || !dataConn || !dataConn.open) {
            return;
        }
        testModePingCount += 1;
        const pingStart = performance.now();
        const pingId = testModePingCount;
        const ping = { type: "test-ping", id: pingId, timestamp: Date.now() };
        dataConn.send(ping);
        const timeout = setTimeout(() => {
            testModePingSum += 1000;
            testModePingMax = Math.max(testModePingMax, 1000);
            testModePingMin = Math.min(testModePingMin, 1000);
        }, 1000);
        window.c4.onTestPong(pingId, pongTimestamp => {
            clearTimeout(timeout);
            const rttMs = (performance.now() - pingStart) * 1000 / 2;
            testModePingSum += rttMs;
            testModePingMax = Math.max(testModePingMax, rttMs);
            testModePingMin = Math.min(testModePingMin, rttMs);
        });
    }, 500);

    setTimeout(async () => {
        if (testModeTimer) {
            clearInterval(testModeTimer);
            testModeTimer = null;
        }
        const durationMs = await window.c4.stopLagTest();
        const results = await window.c4.getLagTestResults();
        testModeResults = results;
        setStatus(`lag test complete: ${durationMs}ms duration, ${results.count} pings, avg ${results.avg.toFixed(2)}ms, min ${results.min.toFixed(2)}ms, max ${results.max.toFixed(2)}ms`);

        if (dataConn && dataConn.open) {
            dataConn.send({ type: "test-mode-end" });
        }
        if (inputConn && inputConn.open) {
            inputConn.send({ type: "test-mode-end" });
        }
    }, 30_000);
});
    setDebugPanelOpen(debugPanel.hidden);
});

document.getElementById("save-credentials-btn").addEventListener("click", saveCredentials);
unlockCredentialsButton.addEventListener("click", unlockCredentials);
forgetCredentialsButton.addEventListener("click", forgetCredentials);

document.addEventListener("keydown", event => {
    if (event.key === "Escape" && (!settingsPanel.hidden || !debugPanel.hidden)) {
        if (!settingsPanel.hidden) {
            setSettingsPanelOpen(false);
            settingsButton.focus();
        } else {
            setDebugPanelOpen(false);
            debugButton.focus();
        }
    }
});

document.addEventListener("pointerdown", event => {
    if (!settingsPanel.hidden && !settingsPanel.contains(event.target) &&
        !settingsButton.contains(event.target)) {
        setSettingsPanelOpen(false);
    }
    if (!debugPanel.hidden && !debugPanel.contains(event.target) && !debugButton.contains(event.target)) {
        setDebugPanelOpen(false);
    }
});

function setDebugValue(id, value) {
    document.getElementById(id).textContent = value;
}

function updateRemoteVideoStats() {
    if (!remoteVideoStats) {
        setDebugValue("debug-send-bitrate", "—");
        setDebugValue("debug-encode", "—");
        setDebugValue("debug-encoded-fps", "—");
        return;
    }
    setDebugValue("debug-encoded-fps", Number.isFinite(remoteVideoStats.fps)
        ? `${remoteVideoStats.fps.toFixed(1)} fps`
        : "—");
    setDebugValue("debug-send-bitrate", Number.isFinite(remoteVideoStats.sendKbps)
        ? `${remoteVideoStats.sendKbps.toFixed(0)} kbps`
        : "—");
    setDebugValue("debug-encode", Number.isFinite(remoteVideoStats.encodeMs)
        ? `${remoteVideoStats.encodeMs.toFixed(1)} ms`
        : "—");
}

async function updateDebugStats() {
    if (debugStatsPending) {
        return;
    }
    setDebugValue("debug-connection", authenticated ? "Connected" : dataConn ? "Connecting" : "Disconnected");
    setDebugValue("debug-resolution", settings.resolution.replace("x", " × "));
    updateRemoteVideoStats();

    const connection = activeCall && activeCall.peerConnection;
    if (!connection || !authenticated) {
        setDebugValue("debug-codec", "—");
        setDebugValue("debug-route", "—");
        setDebugValue("debug-rtt", "—");
        setDebugValue("debug-available-bandwidth", "—");
        setDebugValue("debug-jitter", "—");
        setDebugValue("debug-jitter-buffer", "—");
        setDebugValue("debug-loss", "—");
        setDebugValue("debug-receive-bitrate", "—");
        setDebugValue("debug-fps", "—");
        setDebugValue("debug-decode", "—");
        setDebugValue("debug-rendered-resolution", "—");
        document.getElementById("debug-panel-status").textContent =
            authenticated ? "Waiting for video statistics." : "No active video connection.";
        previousInboundStats = null;
        return;
    }

    debugStatsPending = true;
    try {
        const stats = await connection.getStats();
        const entries = [];
        stats.forEach(report => entries.push(report));
        const inbound = entries.filter(report =>
            report.type === "inbound-rtp" &&
            (report.kind === "video" || report.mediaType === "video") &&
            !report.isRemote
        );
        const transport = entries.find(report => report.type === "transport" && report.selectedCandidatePairId);
        const pair = transport
            ? entries.find(report => report.id === transport.selectedCandidatePairId)
            : entries.find(report => report.type === "candidate-pair" &&
                (report.selected || (report.nominated && report.state === "succeeded")));
        const codec = inbound.length && inbound[0].codecId
            ? entries.find(report => report.id === inbound[0].codecId)
            : null;
        const localCandidate = pair && entries.find(report => report.id === pair.localCandidateId);
        const remoteCandidate = pair && entries.find(report => report.id === pair.remoteCandidateId);
        const now = performance.now();
        let frameCount = 0;
        let decodeTime = 0;
        let bytesReceived = 0;
        let packetsReceived = 0;
        let packetsLost = 0;
        let jitter = 0;
        let jitterStreams = 0;
        let jitterBufferDelay = 0;
        let jitterBufferEmitted = 0;
        for (const report of inbound) {
            frameCount += Number.isFinite(report.framesDecoded) ? report.framesDecoded : 0;
            decodeTime += Number.isFinite(report.totalDecodeTime) ? report.totalDecodeTime : 0;
            bytesReceived += Number.isFinite(report.bytesReceived) ? report.bytesReceived : 0;
            packetsReceived += Number.isFinite(report.packetsReceived) ? report.packetsReceived : 0;
            packetsLost += Number.isFinite(report.packetsLost) ? report.packetsLost : 0;
            if (Number.isFinite(report.jitter)) {
                jitter += report.jitter;
                jitterStreams += 1;
            }
            jitterBufferDelay += Number.isFinite(report.jitterBufferDelay) ? report.jitterBufferDelay : 0;
            jitterBufferEmitted += Number.isFinite(report.jitterBufferEmittedCount)
                ? report.jitterBufferEmittedCount
                : 0;
        }

        const elapsedSeconds = previousInboundStats ? (now - previousInboundStats.timestamp) / 1000 : 0;
        if (previousInboundStats && elapsedSeconds > 0) {
            const framesDelta = frameCount - previousInboundStats.frames;
            const decodeDelta = decodeTime - previousInboundStats.decodeTime;
            const bytesDelta = bytesReceived - previousInboundStats.bytes;
            const jitterBufferDelta = jitterBufferDelay - previousInboundStats.jitterBufferDelay;
            const jitterBufferFramesDelta = jitterBufferEmitted - previousInboundStats.jitterBufferEmitted;
            setDebugValue("debug-fps", `${Math.max(0, framesDelta / elapsedSeconds).toFixed(1)} fps`);
            setDebugValue("debug-decode", framesDelta > 0 && decodeDelta >= 0
                ? `${(decodeDelta * 1000 / framesDelta).toFixed(1)} ms`
                : "—");
            setDebugValue("debug-receive-bitrate", bytesDelta >= 0
                ? `${(bytesDelta * 8 / elapsedSeconds / 1000).toFixed(0)} kbps`
                : "—");
            setDebugValue("debug-jitter-buffer", jitterBufferFramesDelta > 0 && jitterBufferDelta >= 0
                ? `${(jitterBufferDelta * 1000 / jitterBufferFramesDelta).toFixed(1)} ms`
                : "—");
        }
        previousInboundStats = {
            timestamp: now,
            frames: frameCount,
            decodeTime,
            bytes: bytesReceived,
            jitterBufferDelay,
            jitterBufferEmitted
        };
        setDebugValue("debug-jitter", jitterStreams ? `${(jitter / jitterStreams * 1000).toFixed(1)} ms` : "—");
        setDebugValue("debug-codec", codec && codec.mimeType ? codec.mimeType : "—");
        setDebugValue("debug-route", localCandidate && remoteCandidate
            ? `${localCandidate.candidateType} → ${remoteCandidate.candidateType}` +
                (localCandidate.protocol ? ` (${localCandidate.protocol})` : "")
            : "—");
        const availableBandwidth = pair && (
            Number.isFinite(pair.availableIncomingBitrate)
                ? pair.availableIncomingBitrate
                : pair.availableOutgoingBitrate
        );
        setDebugValue("debug-available-bandwidth", Number.isFinite(availableBandwidth)
            ? `${(availableBandwidth / 1000).toFixed(0)} kbps`
            : "—");
        const totalPackets = packetsReceived + Math.max(0, packetsLost);
        setDebugValue("debug-loss", totalPackets > 0
            ? `${(Math.max(0, packetsLost) * 100 / totalPackets).toFixed(2)}%`
            : "—");
        setDebugValue("debug-rtt", pair && Number.isFinite(pair.currentRoundTripTime)
            ? `${(pair.currentRoundTripTime * 1000).toFixed(0)} ms`
            : "—");
        setDebugValue("debug-rendered-resolution", video.videoWidth && video.videoHeight
            ? `${video.videoWidth} × ${video.videoHeight}`
            : "—");
        document.getElementById("debug-panel-status").textContent = inbound.length
            ? "Live WebRTC statistics; values refresh once per second."
            : "Connected; waiting for inbound video statistics.";
    } catch (error) {
        console.error("Could not read WebRTC diagnostics:", error);
        document.getElementById("debug-panel-status").textContent = "WebRTC statistics are unavailable.";
    } finally {
        debugStatsPending = false;
    }
}

function loadSettings() {
    try {
        const stored = JSON.parse(localStorage.getItem("c4-controller-settings") || "{}");
        settings = {
            audio: typeof stored.audio === "boolean" ? stored.audio : DEFAULT_SETTINGS.audio,
            mouseSpeed: Number.isFinite(stored.mouseSpeed) && stored.mouseSpeed >= 0.25 && stored.mouseSpeed <= 3
                ? stored.mouseSpeed
                : DEFAULT_SETTINGS.mouseSpeed,
            scrollMultiplier: Number.isFinite(stored.scrollMultiplier) &&
                stored.scrollMultiplier >= 0.25 && stored.scrollMultiplier <= 3
                ? stored.scrollMultiplier
                : DEFAULT_SETTINGS.scrollMultiplier,
            resolution: RESOLUTIONS.has(stored.resolution) ? stored.resolution : DEFAULT_SETTINGS.resolution
        };
    } catch (error) {
        console.error("Could not load controller settings:", error);
        settings = { ...DEFAULT_SETTINGS };
    }
    audioEnabledEl.checked = settings.audio;
    mouseSpeedEl.value = String(settings.mouseSpeed);
    mouseSpeedValueEl.value = `${settings.mouseSpeed}×`;
    scrollSpeedEl.value = String(settings.scrollMultiplier);
    scrollSpeedValueEl.value = `${settings.scrollMultiplier}×`;
    resolutionEl.value = settings.resolution;
    applyCanvasResolution();
    audio.muted = !settings.audio;
}

function saveSettings() {
    try {
        localStorage.setItem("c4-controller-settings", JSON.stringify(settings));
    } catch (error) {
        console.error("Could not save controller settings:", error);
        setStatus("settings could not be saved; changes apply until the app closes");
    }
}

function applyCanvasResolution() {
    const [width, height] = settings.resolution.split("x").map(Number);
    canvas.width = width;
    canvas.height = height;
    ctx.imageSmoothingEnabled = false;
}

function sendRemoteSetting(message) {
    if (!authenticated || !dataConn || !dataConn.open) {
        return;
    }
    dataConn.send(message);
}

function scaleInputValue(value, multiplier) {
    return Math.max(-10_000, Math.min(10_000, value * multiplier));
}

function sendInput(event) {
    const connection = inputConn || dataConn;
    if (!authenticated || !connection || !connection.open) {
        return;
    }
    const code = sessionCode;
    const nonce = sessionNonce;
    const sequence = ++nextInputSequence;
    inputQueue = inputQueue.then(async () => {
        const proof = await window.c4auth.createInputProof(code, nonce, sequence, event);
        if (authenticated && (inputConn || dataConn) === connection && connection.open) {
            connection.send({ type: "input", nonce, sequence, event, proof });
        }
    }).catch(error => {
        console.error("Could not authenticate input:", error);
        if (dataConn === connection) {
            closeConnection();
            setStatus("input authentication failed");
        }
    });
}

function startFastPreview() {
    const render = () => {
        if (video.readyState >= 2) {
            ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
        }
        if (video.srcObject) {
            if (video.requestVideoFrameCallback) {
                video.requestVideoFrameCallback(render);
            } else {
                requestAnimationFrame(render);
            }
        }
    };
    render();
}

function setupInputCapture() {
    if (inputCaptureActive) {
        return;
    }
    inputCaptureActive = true;

    const specialKeys = new Set([
        "Backspace", "Enter", "Tab", "Escape", "ArrowUp", "ArrowDown",
        "ArrowLeft", "ArrowRight", "Delete", "Home", "End", "PageUp", "PageDown"
    ]);

    function buildKeyPayload(event, kind) {
        return {
            kind,
            key: event.key,
            code: event.code,
            ctrl: event.ctrlKey,
            alt: event.altKey,
            shift: event.shiftKey,
            meta: event.metaKey
        };
    }

    function onKeyDown(event) {
        if (specialKeys.has(event.key) || event.ctrlKey || event.altKey || event.metaKey) {
            event.preventDefault();
        }
        sendInput(buildKeyPayload(event, "keydown"));
    }

    function onKeyUp(event) {
        if (specialKeys.has(event.key) || event.ctrlKey || event.altKey || event.metaKey) {
            event.preventDefault();
        }
        sendInput(buildKeyPayload(event, "keyup"));
    }

    function onMouseMove(event) {
        if (document.pointerLockElement === canvas) {
            sendInput({
                kind: "mousemove",
                dx: scaleInputValue(event.movementX, settings.mouseSpeed),
                dy: scaleInputValue(event.movementY, settings.mouseSpeed),
                relative: true
            });
        }
    }

    function onMouseDown(event) {
        if (event.button === 1) {
            event.preventDefault();
        }
        sendInput({ kind: "mousedown", button: event.button });
    }

    function onMouseUp(event) {
        sendInput({ kind: "mouseup", button: event.button });
    }

    function onWheel(event) {
        event.preventDefault();
        sendInput({
            kind: "wheel",
            delta: scaleInputValue(event.deltaY, settings.scrollMultiplier),
            deltaMode: event.deltaMode
        });
    }

    function onCanvasClick() {
        canvas.requestPointerLock();
    }

    document.addEventListener("keydown", onKeyDown, { passive: false });
    document.addEventListener("keyup", onKeyUp, { passive: false });
    document.addEventListener("mousemove", onMouseMove);
    canvas.addEventListener("click", onCanvasClick);
    canvas.addEventListener("mousedown", onMouseDown, { passive: false });
    canvas.addEventListener("mouseup", onMouseUp);
    canvas.addEventListener("wheel", onWheel, { passive: false });

    window.c4ControllerTeardown = () => {
        document.removeEventListener("keydown", onKeyDown);
        document.removeEventListener("keyup", onKeyUp);
        document.removeEventListener("mousemove", onMouseMove);
        canvas.removeEventListener("click", onCanvasClick);
        canvas.removeEventListener("mousedown", onMouseDown);
        canvas.removeEventListener("mouseup", onMouseUp);
        canvas.removeEventListener("wheel", onWheel);
        if (document.pointerLockElement === canvas) {
            document.exitPointerLock();
        }
        inputCaptureActive = false;
    };
}

function teardownInputCapture() {
    if (window.c4ControllerTeardown) {
        window.c4ControllerTeardown();
        delete window.c4ControllerTeardown;
    }
}

function closeConnection() {
    authenticated = false;
    authAttempted = false;
    sessionCode = null;
    sessionNonce = null;
    nextInputSequence = 0;
    clearTimeout(videoFrameTimeout);
    videoFrameTimeout = null;
    window.c4auth.clearKey();
    accessCodeEl.value = "";
    teardownInputCapture();
    remoteVideoStats = null;
    previousInboundStats = null;
    updateRemoteVideoStats();
    const call = activeCall;
    activeCall = null;
    if (call) {
        call.close();
    }
    const audioCall = activeAudioCall;
    activeAudioCall = null;
    if (audioCall) {
        audioCall.close();
    }
    video.srcObject = null;
    audio.srcObject = null;
    audio.muted = true;
    const connection = dataConn;
    dataConn = null;
    if (connection) {
        connection.close();
    }
    setStatus("disconnected");
}

function initPeer() {
    peerRecovery = window.c4PeerRecovery.create(
        () => new Peer({
            host: "0.peerjs.com",
            port: 443,
            secure: true,
            config: {
                iceServers: [{ urls: "stun:stun.l.google.com:19302" }],
                iceTransportPolicy: "all",
                rtcpMuxPolicy: "require",
                bundlePolicy: "max-bundle",
                iceCandidatePoolSize: 1
            }
        }),
        currentPeer => {
            peer = currentPeer;
            currentPeer.on("open", () => {
                if (!dataConn) {
                    setStatus("ready");
                }
            });
            currentPeer.on("disconnected", () => {
                setStatus(dataConn
                    ? "signaling service disconnected; current session may continue"
                    : "signaling disconnected; reconnecting…");
            });
            currentPeer.on("error", error => {
                console.error("PeerJS error:", error);
                setStatus("peer connection error");
            });
            currentPeer.on("call", call => {
                if (call.metadata && call.metadata.kind === "audio") {
                    if (!authenticated || !settings.audio || !dataConn || call.peer !== dataConn.peer ||
                        activeAudioCall) {
                        call.close();
                        return;
                    }
                    activeAudioCall = call;
                    call.answer();
                    call.on("stream", stream => {
                        if (activeAudioCall !== call || !authenticated || !settings.audio) {
                            call.close();
                            return;
                        }
                        audio.srcObject = stream;
                        audio.muted = false;
                        audio.play().catch(error => {
                            console.error("Could not play remote audio:", error);
                            setStatus("audio received; playback is blocked by the system");
                        });
                    });
                    call.on("close", () => {
                        if (activeAudioCall === call) {
                            activeAudioCall = null;
                            audio.srcObject = null;
                        }
                    });
                    call.on("error", error => {
                        console.error("Audio connection error:", error);
                        if (activeAudioCall === call) {
                            activeAudioCall = null;
                            audio.srcObject = null;
                            setStatus("audio connection failed");
                        }
                    });
                    return;
                }
                if (!authenticated || !dataConn || call.peer !== dataConn.peer || activeCall) {
                    call.close();
                    return;
                }
                activeCall = call;
                call.answer();
                call.on("stream", stream => {
                    if (activeCall !== call || !authenticated) {
                        call.close();
                        return;
                    }
                    video.srcObject = stream;
                    video.muted = true;
                    startFastPreview();
                    setStatus("video stream received; waiting for first frame…");
                    clearTimeout(videoFrameTimeout);
                    videoFrameTimeout = setTimeout(() => {
                        if (video.srcObject !== stream || video.readyState >= 2) {
                            return;
                        }
                        const trackStates = stream.getVideoTracks()
                            .map(track => `${track.readyState}${track.muted ? ", muted" : ""}`)
                            .join(", ") || "no video track";
                        setStatus(`video stream has no decoded frames (${trackStates})`);
                    }, 5_000);
                    video.play().catch(error => {
                        if (video.srcObject !== stream) {
                            return;
                        }
                        clearTimeout(videoFrameTimeout);
                        videoFrameTimeout = null;
                        console.error("Could not play remote video:", error);
                        setStatus(`video playback failed: ${error.message}`);
                    });
                });
                call.on("close", () => {
                    if (activeCall === call) {
                        activeCall = null;
                        closeConnection();
                    }
                });
                call.on("error", error => {
                    console.error("Video connection error:", error);
                    closeConnection();
                });
            });
        }
    );
    peerRecovery.start();
}

initPeer();

document.getElementById("connect-btn").addEventListener("click", () => {
    const targetId = document.getElementById("device-id").value.trim();
    let connectionCode = accessCodeEl.value.trim();
    if (!targetId) {
        setStatus("enter a device ID");
        return;
    }
    if (!peer || !peer.open || peer.disconnected || peer.destroyed) {
        setStatus("signaling service is reconnecting; try again shortly");
        return;
    }
    try {
        window.c4auth.decodeAccessCode(connectionCode);
    } catch (error) {
        setStatus(error.message);
        return;
    }
    if (dataConn) {
        closeConnection();
    }

    authAttempted = false;
    authenticated = false;
    sessionCode = connectionCode;
    accessCodeEl.value = "";
    sessionNonce = null;
    nextInputSequence = 0;
    inputQueue = Promise.resolve();
    setStatus("connecting…");
    const connection = peer.connect(targetId, { reliable: true });
    if (!connection) {
        sessionCode = null;
        accessCodeEl.value = connectionCode;
        setStatus("connection could not be started; try again shortly");
        return;
    }
    dataConn = connection;

    // Open a second unreliable/unordered channel for high-frequency input
    // This prevents head-of-line blocking on the reliable control channel
    const inputChannel = peer.connect(targetId, { reliable: false, label: "c4-input" });
    if (inputChannel) {
        inputConn = inputChannel;
    }

    connection.on("open", () => {
        if (dataConn === connection) {
            setStatus("connected; waiting for device authentication challenge");
        }
    });
    connection.on("data", async message => {
        if (dataConn !== connection || !message || typeof message !== "object") {
            return;
        }

        if (message.type === "network-stats" && authenticated && message.stats &&
            typeof message.stats === "object") {
            const stats = message.stats;
            remoteVideoStats = {
                fps: Number.isFinite(stats.fps) ? stats.fps : null,
                encodeMs: Number.isFinite(stats.encodeMs) ? stats.encodeMs : null,
                sendKbps: Number.isFinite(stats.sendKbps) ? stats.sendKbps : null
            };
            updateRemoteVideoStats();
            return;
        }

        if (message.type === "auth-challenge" && !authAttempted) {
            authAttempted = true;
            try {
                const validDevice = await window.c4auth.verifyProof(
                    connectionCode, "device", message.nonce, message.proof
                );
                if (!validDevice) {
                    setStatus("authentication failed: wrong access code or unrecognized device");
                    connection.close();
                    return;
                }
                if (dataConn !== connection) {
                    return;
                }
                sessionNonce = message.nonce;
                const proof = await window.c4auth.createProof(connectionCode, "controller", message.nonce);
                if (dataConn !== connection) {
                    return;
                }
                connection.send({ type: "auth-response", nonce: message.nonce, proof });
                setStatus("device verified; authorizing controller");
            } catch (error) {
                console.error("Authentication failed:", error);
                setStatus("authentication failed");
                connection.close();
            }
            return;
        }

        if (message.type === "auth-ok" && !authenticated) {
            authenticated = true;
            nextInputSequence = 0;
            inputQueue = Promise.resolve();
            setupInputCapture();
            connection.send({
                type: "auth-complete",
                audio: settings.audio,
                resolution: settings.resolution
            });
            setStatus("authenticated; waiting for screen stream");
            return;
        }

        if (message.type === "auth-failed") {
            setStatus("authentication failed");
            connection.close();
            return;
        }

        if (message.type === "audio-unavailable") {
            setStatus("audio capture is unavailable on the device");
            return;
        }

        if (message.type === "resolution-error") {
            setStatus("requested resolution could not be applied on the device");
        }
    });

    connection.on("close", () => {
        connectionCode = null;
        if (dataConn !== connection) {
            return;
        }
        clearTimeout(videoFrameTimeout);
        videoFrameTimeout = null;
        authenticated = false;
        authAttempted = false;
        sessionCode = null;
        sessionNonce = null;
        nextInputSequence = 0;
        window.c4auth.clearKey();
        accessCodeEl.value = "";
        teardownInputCapture();
        remoteVideoStats = null;
        previousInboundStats = null;
        updateRemoteVideoStats();
        const call = activeCall;
        activeCall = null;
        if (call) {
            call.close();
        }
        const audioCall = activeAudioCall;
        activeAudioCall = null;
        if (audioCall) {
            audioCall.close();
        }
        video.srcObject = null;
        audio.srcObject = null;
        audio.muted = true;
        dataConn = null;
        setStatus("disconnected");
    });
    connection.on("error", error => {
        console.error("Data connection error:", error);
        if (dataConn === connection) {
            closeConnection();
        }
        setStatus("connection error");
    });
});

audioEnabledEl.addEventListener("change", () => {
    settings.audio = audioEnabledEl.checked;
    audio.muted = !settings.audio;
    saveSettings();
    if (!settings.audio) {
        const call = activeAudioCall;
        activeAudioCall = null;
        if (call) {
            call.close();
        }
        audio.srcObject = null;
    }
    sendRemoteSetting({ type: "audio-settings", enabled: settings.audio });
});

mouseSpeedEl.addEventListener("input", () => {
    settings.mouseSpeed = Number(mouseSpeedEl.value);
    mouseSpeedValueEl.value = `${settings.mouseSpeed}×`;
    saveSettings();
});

scrollSpeedEl.addEventListener("input", () => {
    settings.scrollMultiplier = Number(scrollSpeedEl.value);
    scrollSpeedValueEl.value = `${settings.scrollMultiplier}×`;
    saveSettings();
});

resolutionEl.addEventListener("change", () => {
    settings.resolution = RESOLUTIONS.has(resolutionEl.value)
        ? resolutionEl.value
        : DEFAULT_SETTINGS.resolution;
    resolutionEl.value = settings.resolution;
    applyCanvasResolution();
    saveSettings();
    sendRemoteSetting({ type: "resolution-settings", resolution: settings.resolution });
});

document.getElementById("fullscreen-btn").addEventListener("click", () => {
    canvas.requestFullscreen().catch(error => console.error("Fullscreen failed:", error));
});

document.getElementById("release-btn").addEventListener("click", () => {
    if (!authenticated || !dataConn || !dataConn.open) {
        return;
    }
    [
        "Backspace", "Enter", "Tab", "Escape", "ArrowUp", "ArrowDown",
        "ArrowLeft", "ArrowRight", "Delete", "Home", "End", "PageUp", "PageDown"
    ].forEach(key => {
        sendInput({
            kind: "keyup",
            key,
            code: key,
            ctrl: false,
            alt: false,
            shift: false,
            meta: false
        });
    });
    setStatus("released common keys");
});

window.addEventListener("beforeunload", () => {
    closeConnection();
    audio.srcObject = null;
    peerRecovery.stop();
});

loadSettings();
updateCredentialVaultControls();
