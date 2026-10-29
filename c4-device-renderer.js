let peer = null;
let peerRecovery = null;
let desktopStream = null;
let captureSourceId = null;
let dataConn = null;
let activeCall = null;
let activeVideoTrack = null;
let videoStatsTimer = null;
let previousOutboundStats = null;
let videoStatsPending = false;
let activeAudioCall = null;
let audioCaptureStream = null;
let audioRequestId = 0;
let sessionResolution = "1280x720";
let remoteAudioEnabled = false;
let resolutionUpdate = Promise.resolve();
let authenticated = false;
let remoteControlEnabled = true;
let screenSharePending = false;
let accessCodeHideTimer = null;
const VIDEO_RESOLUTIONS = {
    "1280x720": { width: 1280, height: 720 },
    "960x540": { width: 960, height: 540 },
    "640x360": { width: 640, height: 360 },
    "1920x1080": { width: 1920, height: 1080 },
    "2560x1440": { width: 2560, height: 1440 },
    "3840x2160": { width: 3840, height: 2160 }
};

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

function stopVideoStats() {
    clearInterval(videoStatsTimer);
    videoStatsTimer = null;
    previousOutboundStats = null;
    videoStatsPending = false;
}

function startVideoStats(call, conn, track) {
    stopVideoStats();
    videoStatsTimer = setInterval(async () => {
        if (videoStatsPending || activeCall !== call || dataConn !== conn || !authenticated) {
            return;
        }
        const peerConnection = call.peerConnection;
        if (!peerConnection || !conn.open) {
            return;
        }
        videoStatsPending = true;
        try {
            const stats = await peerConnection.getStats();
            if (activeCall !== call || dataConn !== conn || !authenticated || !conn.open) {
                return;
            }
            const reports = [];
            stats.forEach(report => reports.push(report));
            const outbound = reports.filter(report =>
                report.type === "outbound-rtp" &&
                (report.kind === "video" || report.mediaType === "video") &&
                !report.isRemote
            );
            let framesEncoded = 0;
            let totalEncodeTime = 0;
            let bytesSent = 0;
            for (const report of outbound) {
                framesEncoded += Number.isFinite(report.framesEncoded) ? report.framesEncoded : 0;
                totalEncodeTime += Number.isFinite(report.totalEncodeTime) ? report.totalEncodeTime : 0;
                bytesSent += Number.isFinite(report.bytesSent) ? report.bytesSent : 0;
            }
            const now = performance.now();
            const elapsedSeconds = previousOutboundStats ? (now - previousOutboundStats.timestamp) / 1000 : 0;
            const framesDelta = previousOutboundStats ? framesEncoded - previousOutboundStats.frames : 0;
            const encodeDelta = previousOutboundStats ? totalEncodeTime - previousOutboundStats.encodeTime : 0;
            const bytesDelta = previousOutboundStats ? bytesSent - previousOutboundStats.bytes : 0;
            const trackSettings = track.getSettings();
            conn.send({
                type: "network-stats",
                stats: {
                    fps: elapsedSeconds > 0 && framesDelta >= 0 ? framesDelta / elapsedSeconds : null,
                    encodeMs: framesDelta > 0 && encodeDelta >= 0 ? encodeDelta * 1000 / framesDelta : null,
                    sendKbps: elapsedSeconds > 0 && bytesDelta >= 0 ? bytesDelta * 8 / elapsedSeconds / 1000 : null,
                    width: Number.isFinite(trackSettings.width) ? trackSettings.width : null,
                    height: Number.isFinite(trackSettings.height) ? trackSettings.height : null
                }
            });
            previousOutboundStats = { timestamp: now, frames: framesEncoded, encodeTime: totalEncodeTime, bytes: bytesSent };
        } catch (error) {
            console.error("Could not read video sender statistics:", error);
        } finally {
            videoStatsPending = false;
        }
    }, 1000);
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
        captureSourceId = source.id;
        desktopStream = await navigator.mediaDevices.getUserMedia({
            audio: false,
            video: {
                mandatory: {
                    chromeMediaSource: "desktop",
                    chromeMediaSourceId: source.id,
                    maxWidth: 3840,
                    maxHeight: 2160,
                    maxFrameRate: 60
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
        captureSourceId = null;
        notifyScreenShareEnded();
        console.error("Screen sharing was not authorized:", error);
        setStatus(`Screen sharing failed: ${error.message}`);
    }
}

function stopScreenShare() {
    const stream = desktopStream;
    desktopStream = null;
    captureSourceId = null;
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

function stopRemoteAudio() {
    audioRequestId += 1;
    remoteAudioEnabled = false;
    const call = activeAudioCall;
    activeAudioCall = null;
    if (call) {
        call.close();
    }
    const stream = audioCaptureStream;
    audioCaptureStream = null;
    if (stream) {
        stream.getTracks().forEach(track => track.stop());
    }
}

async function setRemoteAudio(enabled, conn) {
    remoteAudioEnabled = enabled;
    if (!enabled) {
        stopRemoteAudio();
        return;
    }
    if (activeAudioCall || audioCaptureStream) {
        return;
    }

    const requestId = ++audioRequestId;
    let stream;
    try {
        if (!captureSourceId) {
            throw new Error("Screen capture source is unavailable.");
        }
        stream = await navigator.mediaDevices.getDisplayMedia({ audio: true, video: true });
        if (requestId !== audioRequestId || dataConn !== conn || !authenticated) {
            stream.getTracks().forEach(track => track.stop());
            return;
        }

        const audioTracks = stream.getAudioTracks();
        stream.getVideoTracks().forEach(track => track.stop());
        if (audioTracks.length === 0) {
            stream.getTracks().forEach(track => track.stop());
            throw new Error("System audio capture is unavailable on this platform.");
        }

        audioCaptureStream = new MediaStream(audioTracks);
        const call = peer.call(conn.peer, audioCaptureStream, { metadata: { kind: "audio" } });
        if (!call) {
            throw new Error("Audio connection could not be started.");
        }
        activeAudioCall = call;
        call.on("close", () => {
            if (activeAudioCall !== call) {
                return;
            }
            activeAudioCall = null;
            const currentStream = audioCaptureStream;
            audioCaptureStream = null;
            if (currentStream) {
                currentStream.getTracks().forEach(track => track.stop());
            }
            if (remoteAudioEnabled && dataConn === conn && conn.open) {
                conn.send({ type: "audio-unavailable" });
            }
        });
        call.on("error", error => {
            console.error("Audio connection error:", error);
            if (activeAudioCall === call) {
                stopRemoteAudio();
                if (dataConn === conn && conn.open) {
                    conn.send({ type: "audio-unavailable" });
                }
            }
        });
    } catch (error) {
        if (stream && audioCaptureStream !== stream) {
            stream.getTracks().forEach(track => track.stop());
        }
        if (requestId === audioRequestId) {
            stopRemoteAudio();
            console.error("Could not start remote audio:", error);
            if (dataConn === conn && conn.open) {
                conn.send({ type: "audio-unavailable" });
            }
        }
    }
}

async function startVideoCall(conn, resolutionName) {
    sessionResolution = VIDEO_RESOLUTIONS[resolutionName] ? resolutionName : "1280x720";
    const sourceTrack = desktopStream && desktopStream.getVideoTracks()[0];
    if (!sourceTrack) {
        throw new Error("Screen video track is unavailable.");
    }

    const videoTrack = sourceTrack.clone();
    try {
        let appliedResolution;
        do {
            appliedResolution = sessionResolution;
            const resolution = VIDEO_RESOLUTIONS[appliedResolution];
            await videoTrack.applyConstraints({
                width: { max: resolution.width },
                height: { max: resolution.height }
            });
        } while (appliedResolution !== sessionResolution);
        if (dataConn !== conn || !authenticated) {
            videoTrack.stop();
            return;
        }
        const call = peer.call(conn.peer, new MediaStream([videoTrack]));
        if (!call) {
            videoTrack.stop();
            throw new Error("Video connection could not be started.");
        }
        activeCall = call;
        activeVideoTrack = videoTrack;
        startVideoStats(call, conn, videoTrack);
        call.on("close", () => {
            if (activeCall !== call) {
                return;
            }
            stopVideoStats();
            activeCall = null;
            activeVideoTrack = null;
            videoTrack.stop();
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
    } catch (error) {
        videoTrack.stop();
        throw error;
    }
}

async function applyVideoResolution(resolutionName, conn) {
    const resolution = VIDEO_RESOLUTIONS[resolutionName];
    if (!resolution) {
        conn.send({ type: "resolution-error" });
        return;
    }
    sessionResolution = resolutionName;
    if (!activeVideoTrack) {
        return;
    }
    const track = activeVideoTrack;
    const applyLatestResolution = async () => {
        if (activeVideoTrack !== track) {
            return;
        }
        const latestResolution = VIDEO_RESOLUTIONS[sessionResolution];
        await track.applyConstraints({
            width: { max: latestResolution.width },
            height: { max: latestResolution.height }
        });
    };
    resolutionUpdate = resolutionUpdate.then(applyLatestResolution, applyLatestResolution);
    try {
        await resolutionUpdate;
    } catch (error) {
        console.error("Could not apply requested video resolution:", error);
        if (dataConn === conn && conn.open) {
            conn.send({ type: "resolution-error" });
        }
    }
}

function closeConnection() {
    authenticated = false;
    stopRemoteAudio();
    stopVideoStats();
    const call = activeCall;
    activeCall = null;
    const videoTrack = activeVideoTrack;
    activeVideoTrack = null;
    if (call) {
        call.close();
    }
    if (videoTrack) {
        videoTrack.stop();
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
                let inputConnAccepted = false;

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
                    if (dataConn !== conn && !inputConnAccepted && conn !== inputConn) {
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
                        if (activeCall) {
                            return;
                        }
                        try {
                            await startVideoCall(conn, message.resolution);
                        } catch (error) {
                            console.error("Could not start video stream:", error);
                            conn.send({ type: "resolution-error" });
                            closeConnection();
                            return;
                        }
                        if (message.audio === true && dataConn === conn && authenticated) {
                            await setRemoteAudio(true, conn);
                        }
                        return;
                    }

                    if (message.type === "audio-settings" && authenticated &&
                        typeof message.enabled === "boolean") {
                        await setRemoteAudio(message.enabled, conn);
                        return;
                    }

                    if (message.type === "resolution-settings" && authenticated) {
                        await applyVideoResolution(message.resolution, conn);
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

                    if (message.type === "test-ping" && authenticated) {
                        conn.send({ type: "test-pong", id: message.id, timestamp: Date.now() });
                        return;
                    }

                    if (message.type === "test-mode-end" && authenticated) {
                        return;
                    }
                });

                conn.on("close", () => {
                    clearTimeout(authTimeout);
                    if (dataConn === conn) {
                        authenticated = false;
                        dataConn = null;
                        stopVideoStats();
                        const call = activeCall;
                        activeCall = null;
                        const videoTrack = activeVideoTrack;
                        activeVideoTrack = null;
                        if (call) {
                            call.close();
                        }
                        if (videoTrack) {
                            videoTrack.stop();
                        }
                        stopRemoteAudio();
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
