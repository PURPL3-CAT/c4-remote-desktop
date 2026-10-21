let peer = null;
let dataConn = null;
let activeCall = null;
let authenticated = false;
let authAttempted = false;
let inputCaptureActive = false;
let sessionCode = null;
let sessionNonce = null;
let nextInputSequence = 0;
let inputQueue = Promise.resolve();
let peerRecovery = null;

const video = document.getElementById("video");
const canvas = document.getElementById("canvas");
const ctx = canvas.getContext("2d");
const statusEl = document.getElementById("status");
const accessCodeEl = document.getElementById("access-code");

ctx.imageSmoothingEnabled = false;

function setStatus(message) {
    statusEl.textContent = message;
}

function sendInput(event) {
    if (authenticated && dataConn && dataConn.open) {
        const connection = dataConn;
        const code = sessionCode;
        const nonce = sessionNonce;
        const sequence = ++nextInputSequence;
        inputQueue = inputQueue.then(async () => {
            const proof = await window.c4auth.createInputProof(code, nonce, sequence, event);
            if (authenticated && dataConn === connection && connection.open) {
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
                dx: event.movementX,
                dy: event.movementY,
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
        sendInput({ kind: "wheel", delta: event.deltaY, deltaMode: event.deltaMode });
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
    window.c4auth.clearKey();
    accessCodeEl.value = "";
    teardownInputCapture();
    const call = activeCall;
    activeCall = null;
    if (call) {
        call.close();
    }
    video.srcObject = null;
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
                    startFastPreview();
                    setStatus("authenticated; streaming screen");
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

    connection.on("open", () => {
        if (dataConn === connection) {
            setStatus("connected; waiting for device authentication challenge");
        }
    });
    connection.on("data", async message => {
        if (dataConn !== connection || !message || typeof message !== "object") {
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
            connection.send({ type: "auth-complete" });
            setStatus("authenticated; waiting for screen stream");
            return;
        }

        if (message.type === "auth-failed") {
            setStatus("authentication failed");
            connection.close();
        }
    });

    connection.on("close", () => {
        connectionCode = null;
        if (dataConn !== connection) {
            return;
        }
        authenticated = false;
        authAttempted = false;
        sessionCode = null;
        sessionNonce = null;
        nextInputSequence = 0;
        window.c4auth.clearKey();
        accessCodeEl.value = "";
        teardownInputCapture();
        const call = activeCall;
        activeCall = null;
        if (call) {
            call.close();
        }
        video.srcObject = null;
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
    peerRecovery.stop();
});
