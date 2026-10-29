const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("c4", {
    getDeviceId() {
        return ipcRenderer.invoke("c4-get-device-id");
    },
    wereCredentialsMigrated() {
        return ipcRenderer.invoke("c4-were-credentials-migrated");
    },
    getCaptureSettings() {
        return ipcRenderer.invoke("c4-get-capture-settings");
    },
    enableUnattendedCapture() {
        return ipcRenderer.invoke("c4-enable-unattended-capture");
    },
    disableUnattendedCapture() {
        return ipcRenderer.invoke("c4-disable-unattended-capture");
    },
    getCaptureSource() {
        return ipcRenderer.invoke("c4-get-capture-source");
    },
    notifyScreenShareStarted() {
        return ipcRenderer.invoke("c4-screen-share-started");
    },
    getAccessCode() {
        return ipcRenderer.invoke("c4-get-access-code");
    },
    rotateAccessCode() {
        return ipcRenderer.invoke("c4-rotate-access-code");
    },
    createAuthChallenge() {
        return ipcRenderer.invoke("c4-create-auth-challenge");
    },
    authorizeController(nonce, proof) {
        return ipcRenderer.invoke("c4-authorize-controller", { nonce, proof });
    },
    notifyScreenShareEnded() {
        return ipcRenderer.invoke("c4-screen-share-ended");
    },
    startInputBridge() {
        return ipcRenderer.invoke("c4-start-input");
    },
    sendInput(eventObj) {
        return ipcRenderer.invoke("c4-send-input", eventObj);
    },
    endSession() {
        ipcRenderer.send("c4-end-session");
    },
    onAccessCodeRotated(callback) {
        const listener = () => callback();
        ipcRenderer.on("c4-access-code-rotated", listener);
        return () => ipcRenderer.removeListener("c4-access-code-rotated", listener);
    },
    startLagTest() {
        return ipcRenderer.invoke("c4-test-mode-start");
    },
    sendTestPing() {
        return ipcRenderer.invoke("c4-test-mode-ping");
    },
    stopLagTest() {
        return ipcRenderer.invoke("c4-test-mode-stop");
    },
    getLagTestResults() {
        const logPath = require("path").join(__dirname, "c4-lag-test.log");
        try {
            const fs = require("fs");
            const content = fs.readFileSync(logPath, "utf8");
            const lines = content.trim().split("\n").filter(line => line.includes(","));
            const pings = lines.map(line => {
                const parts = line.split(",");
                return {
                    timestamp: parseInt(parts[0], 10),
                    latency: parseFloat(parts[1])
                };
            });
            const count = pings.length;
            const avg = count > 0 ? pings.reduce((sum, p) => sum + p.latency, 0) / count : 0;
            const min = count > 0 ? Math.min(...pings.map(p => p.latency)) : 0;
            const max = count > 0 ? Math.max(...pings.map(p => p.latency)) : 0;
            return { count, avg, min, max, pings };
        } catch (error) {
            return { count: 0, avg: 0, min: 0, max: 0, pings: [] };
        }
    },
    onTestPong(callback) {
        const listener = (_event, pong) => callback(pong.id, pong.timestamp);
        ipcRenderer.on("c4-test-pong", listener);
        return () => ipcRenderer.removeListener("c4-test-pong", listener);
    }
});
