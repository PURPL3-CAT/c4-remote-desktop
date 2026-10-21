let peer = null;
let peerRecovery = null;
let desktopStream = null;
let dataConn = null;
let activeCall = null;
let authenticated = false;
let remoteControlEnabled = true;
let screenSharePending = false;
let accessCodeHideTimer = null;

const video = document.getElementById("video");
const canvas = document.getElementById("canvas");
const ctx = canvas.getContext("2d");
const statusEl = document.getElementById("status");
const deviceIdEl = document.getElementById("device-id");
const accessCodeEl = document.getElementById("access-code");
const revealCodeButton = document.getElementById("reveal-code-btn");

ctx.imageSmoothingEnabled = false;

function setStatus(message) {
    statusEl.textContent = message;
}

function hideAccessCode() {
    clearTimeout(accessCodeHideTimer);
    accessCodeEl.value = "";
    accessCodeEl.type = "password";
    accessCodeEl.hidden = true;
    revealCodeButton.textContent = "Reveal access code";
}

function showAccessCode(code) {
    accessCodeEl.value = code;
    accessCodeEl.type = "text";
    accessCodeEl.hidden = false;
    accessCodeEl.select();
    revealCodeButton.textContent = "Hide access code";
    clearTimeout(accessCodeHideTimer);
    accessCodeHideTimer = setTimeout(hideAccessCode, 60_000);
}

function notifyScreenShareEnded() {
    window.c4.notifyScreenShareEnded().catch(error => {
        console.error("Could not revoke screen-sharing authorization:", error);
    });
}

function startFastPreview() {
    const render = () => {
        if (video.readyState >= 2) {
            ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
        }
        if (video.requestVideoFrameCallback) {
            video.requestVideoFrameCallback(render);
        } else {
            requestAnimationFrame(render);
        }
    };
    render();
}

async function startScreenShare() {
    try {
        const source = await window.c4.getCaptureSource();
        desktopStream = await navigator.mediaDevices.getUserMedia({
            audio: false,
            video: {
                mandatory: {
                    chromeMediaSource: "desktop",
                    chromeMediaSourceId: source.id,
                    maxWidth: 1280,
                    maxHeight: 720,
                    maxFrameRate: 30
                }
            }
        });
        if (!await window.c4.notifyScreenShareStarted()) {
            desktopStream.getTracks().forEach(track => track.stop());
            desktopStream = null;
            throw new Error("Unattended screen sharing is not enabled.");
        }
        video.srcObject = desktopStream;
        video.muted = true;
        startFastPreview();
        desktopStream.getVideoTracks().forEach(track => {
            track.addEventListener("ended", () => {
                stopScreenShare();
            });
        });
        document.getElementById("screen-share-btn").textContent = "Stop screen sharing";
        document.getElementById("disable-unattended-btn").hidden = false;
        setStatus("screen sharing active; ready for remote connection");
    } catch (error) {
        notifyScreenShareEnded();
        console.error("Screen sharing was not authorized:", error);
        setStatus(`Screen sharing failed: ${error.message}`);
    }
}

function stopScreenShare() {
    const stream = desktopStream;
    desktopStream = null;
    if (stream) {
        stream.getTracks().forEach(track => track.stop());
    }
    authenticated = false;
    document.getElementById("screen-share-btn").textContent = "Start screen sharing";
    video.srcObject = null;
    closeConnection();
    notifyScreenShareEnded();
    setStatus("screen sharing and remote control stopped");
}

function closeConnection() {
    authenticated = false;
    const call = activeCall;
    activeCall = null;
    if (call) {
        call.close();
    }
    const connection = dataConn;
    dataConn = null;
    if (connection) {
        connection.close();
    }
    window.c4.endSession();
}

function initPeer(deviceId) {
    peerRecovery = window.c4PeerRecovery.create(
        () => new Peer(deviceId, {
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
                if (dataConn) {
                    return;
                }
                if (desktopStream) {
                    setStatus("screen sharing active; ready for remote connection");
                } else {
                    setStatus("ready; start screen sharing to enable remote control");
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
            currentPeer.on("connection", conn => {
                if (!remoteControlEnabled) {
                    conn.close();
                    return;
                }
                if (dataConn) {
                    conn.close();
                    return;
                }
                dataConn = conn;
                authenticated = false;
                const authTimeout = setTimeout(() => {
                    if (dataConn === conn && !authenticated) {
                        conn.close();
                    }
                }, 30_000);
                conn.on("open", async () => {
                    if (!desktopStream || desktopStream.getVideoTracks().every(track => track.readyState !== "live")) {
                        setStatus("connection rejected because screen sharing is not active");
                        conn.close();
                        return;
                    }
                    try {
                        const challenge = await window.c4.createAuthChallenge();
                        conn.send({ type: "auth-challenge", nonce: challenge.nonce, proof: challenge.proof });
                        setStatus("controller connected; verifying access code");
                    } catch (error) {
                        console.error("Could not start authentication:", error);
                        conn.close();
                        setStatus("authentication could not be started");
                    }
                });

                conn.on("data", async message => {
                    if (dataConn !== conn || !message || typeof message !== "object") {
                        return;
                    }

                    if (message.type === "auth-response" && !authenticated) {
                        try {
                            const authorized = await window.c4.authorizeController(message.nonce, message.proof);
                            if (dataConn !== conn) {
                                if (authorized) {
                                    window.c4.endSession();
                                }
                                return;
                            }
                            if (!authorized) {
                                conn.send({ type: "auth-failed" });
                                conn.close();
                                return;
                            }
                            authenticated = true;
                            clearTimeout(authTimeout);
                            await window.c4.startInputBridge();
                            conn.send({ type: "auth-ok" });
                            setStatus("authenticated; remote control active");
                        } catch (error) {
                            console.error("Controller authentication failed:", error);
                            conn.send({ type: "auth-failed" });
                            conn.close();
                        }
                        return;
                    }

                    if (message.type === "auth-complete" && authenticated) {
                        const call = peer.call(conn.peer, desktopStream);
                        if (!call) {
                            closeConnection();
                            setStatus("video connection could not be started");
                            return;
                        }
                        activeCall = call;
                        call.on("close", () => {
                            if (activeCall !== call) {
                                return;
                            }
                            activeCall = null;
                            if (dataConn === conn) {
                                closeConnection();
                            }
                        });
                        call.on("error", error => {
                            console.error("Video connection error:", error);
                            if (dataConn === conn) {
                                closeConnection();
                            }
                        });
                        return;
                    }

                    if (message.type === "input" && authenticated) {
                        try {
                            const accepted = await window.c4.sendInput({
                                nonce: message.nonce,
                                sequence: message.sequence,
                                event: message.event,
                                proof: message.proof
                            });
                            if (!accepted) {
                                closeConnection();
                            }
                        } catch (error) {
                            console.error("Authenticated input was rejected:", error);
                            closeConnection();
                        }
                        return;
                    }

                    if (message.type === "session-end" && authenticated) {
                        closeConnection();
                    }
                });

                conn.on("close", () => {
                    clearTimeout(authTimeout);
                    if (dataConn === conn) {
                        authenticated = false;
                        dataConn = null;
                        const call = activeCall;
                        activeCall = null;
                        if (call) {
                            call.close();
                        }
                        window.c4.endSession();
                        setStatus("controller disconnected");
                    }
                });
                conn.on("error", error => {
                    console.error("Data connection error:", error);
                    if (dataConn === conn) {
                        closeConnection();
                    }
                    setStatus("connection error");
                });
            });
        }
    );
    peerRecovery.start();
}

revealCodeButton.addEventListener("click", async () => {
    try {
        if (accessCodeEl.hidden) {
            const code = await window.c4.getAccessCode();
            if (code) {
                showAccessCode(code);
            }
        } else {
            hideAccessCode();
        }
    } catch (error) {
        console.error("Could not retrieve access code:", error);
        setStatus("secure access code storage is unavailable");
    }
});

document.getElementById("rotate-code-btn").addEventListener("click", async () => {
    try {
        const code = await window.c4.rotateAccessCode();
        if (code) {
            showAccessCode(code);
            setStatus("access code regenerated; old code no longer works");
        }
    } catch (error) {
        console.error("Could not rotate access code:", error);
        setStatus("access code could not be regenerated");
    }
});

window.addEventListener("blur", hideAccessCode);

document.getElementById("panic-btn").addEventListener("click", event => {
    remoteControlEnabled = !remoteControlEnabled;
    closeConnection();
    event.currentTarget.textContent = remoteControlEnabled
        ? "Disable remote control"
        : "Enable remote control";
    setStatus(remoteControlEnabled ? "remote control enabled" : "remote control disabled");
});

document.getElementById("screen-share-btn").addEventListener("click", async event => {
    if (screenSharePending) {
        return;
    }
    if (desktopStream) {
        stopScreenShare();
        return;
    }
    const button = event.currentTarget;
    screenSharePending = true;
    button.disabled = true;
    try {
        const settings = await window.c4.getCaptureSettings();
        if (!settings.unattendedCapture) {
            if (!await window.c4.enableUnattendedCapture()) {
                return;
            }
        }
        button.textContent = "Start screen sharing";
        document.getElementById("disable-unattended-btn").hidden = false;
        await startScreenShare();
    } catch (error) {
        console.error("Could not enable unattended screen sharing:", error);
        setStatus(`Unattended screen sharing could not be enabled: ${error.message}`);
    } finally {
        screenSharePending = false;
        button.disabled = false;
    }
});

document.getElementById("disable-unattended-btn").addEventListener("click", async () => {
    try {
        await window.c4.disableUnattendedCapture();
        stopScreenShare();
        document.getElementById("disable-unattended-btn").hidden = true;
        setStatus("unattended access disabled; local setup is required to re-enable it");
    } catch (error) {
        console.error("Could not disable unattended access:", error);
        setStatus("unattended access could not be disabled");
    }
});

window.c4.onAccessCodeRotated(() => {
    closeConnection();
});

window.addEventListener("beforeunload", () => {
    peerRecovery.stop();
    window.c4.endSession();
    notifyScreenShareEnded();
    if (desktopStream) {
        desktopStream.getTracks().forEach(track => track.stop());
    }
});

window.addEventListener("load", async () => {
    try {
        deviceIdEl.value = await window.c4.getDeviceId();
        document.getElementById("credential-change-notice").hidden =
            !await window.c4.wereCredentialsMigrated();
        initPeer(deviceIdEl.value);
        if ((await window.c4.getCaptureSettings()).unattendedCapture) {
            document.getElementById("screen-share-btn").textContent = "Start screen sharing";
            document.getElementById("disable-unattended-btn").hidden = false;
            await startScreenShare();
        }
    } catch (error) {
        console.error("Device initialization failed:", error);
        setStatus("device could not start securely");
    }
});
