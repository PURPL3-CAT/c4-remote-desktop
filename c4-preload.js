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
    }
});
