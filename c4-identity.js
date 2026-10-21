const { app, safeStorage } = require("electron");
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

const CREDENTIALS_FILE = path.join(app.getPath("userData"), "c4-credentials.json");
const LEGACY_IDENTITY_FILE = path.join(__dirname, "c4-device.json");
const LEGACY_INPUT_LOG_FILE = path.join(__dirname, "c4-latest.log");
const pendingChallenges = new Map();
const authorizedSessions = new Map();
let credentials = null;
let credentialsMigrated = false;

function ensureSecureStorage() {
    if (!safeStorage.isEncryptionAvailable()) {
        throw new Error("OS-backed secure storage is unavailable; refusing to store the access code.");
    }

    if (process.platform === "linux") {
        if (typeof safeStorage.getSelectedStorageBackend !== "function" ||
            safeStorage.getSelectedStorageBackend() === "basic_text") {
            throw new Error("A Linux secret-service backend is required; refusing insecure storage.");
        }
    }
}

function persistCredentials(next) {
    ensureSecureStorage();
    fs.mkdirSync(path.dirname(CREDENTIALS_FILE), { recursive: true, mode: 0o700 });

    const encrypted = safeStorage.encryptString(JSON.stringify(next));
    const temporaryFile = `${CREDENTIALS_FILE}.${crypto.randomBytes(8).toString("hex")}.tmp`;
    fs.writeFileSync(temporaryFile, encrypted.toString("base64"), { flag: "wx", mode: 0o600 });
    fs.renameSync(temporaryFile, CREDENTIALS_FILE);
}

function newCredentials() {
    return {
        deviceId: crypto.randomBytes(10).toString("hex"),
        accessCode: crypto.randomBytes(16).toString("base64url"),
        unattendedCapture: false,
        displayId: null
    };
}

function loadCredentials() {
    credentialsMigrated = false;
    removeLegacyPrivateKey();
    removeLegacyInputLog();
    ensureSecureStorage();

    if (fs.existsSync(CREDENTIALS_FILE)) {
        const encrypted = Buffer.from(fs.readFileSync(CREDENTIALS_FILE, "utf8"), "base64");
        const stored = JSON.parse(safeStorage.decryptString(encrypted));
        if (typeof stored.deviceId === "string" &&
            /^c4-[0-9a-f]{32}$/.test(stored.deviceId) &&
            typeof stored.accessCode === "string" &&
            /^[A-Za-z0-9_-]{43}$/.test(stored.accessCode)) {
            credentials = newCredentials();
            persistCredentials(credentials);
            credentialsMigrated = true;
            return;
        }
        if (typeof stored.deviceId !== "string" ||
            !/^[0-9a-f]{20}$/.test(stored.deviceId) ||
            typeof stored.accessCode !== "string" ||
            !/^[A-Za-z0-9_-]{22}$/.test(stored.accessCode) ||
            typeof stored.unattendedCapture !== "boolean" ||
            !(stored.displayId === null || typeof stored.displayId === "string")) {
            throw new Error("Stored c4 credentials are invalid; refusing to replace them automatically.");
        }
        credentials = stored;
        return;
    }

    credentials = newCredentials();
    persistCredentials(credentials);
}

function requireCredentials() {
    if (!credentials) {
        throw new Error("Device credentials have not been initialized.");
    }
    return credentials;
}

function removeLegacyPrivateKey() {
    if (!fs.existsSync(LEGACY_IDENTITY_FILE)) {
        return;
    }
    try {
        const stats = fs.lstatSync(LEGACY_IDENTITY_FILE);
        if (!stats.isFile()) {
            console.warn("The legacy device-key path is not a regular file; remove it manually if it is yours.");
            return;
        }
        const legacy = JSON.parse(fs.readFileSync(LEGACY_IDENTITY_FILE, "utf8"));
        if (!legacy || typeof legacy.privateKey !== "object" || !legacy.privateKey) {
            return;
        }
        fs.unlinkSync(LEGACY_IDENTITY_FILE);
    } catch (error) {
        console.warn("Could not remove the unused plaintext legacy device key. Remove c4-device.json manually:", error.message);
    }
}

function removeLegacyInputLog() {
    if (!fs.existsSync(LEGACY_INPUT_LOG_FILE)) {
        return;
    }
    try {
        const stats = fs.lstatSync(LEGACY_INPUT_LOG_FILE);
        if (!stats.isFile()) {
            console.warn("The legacy input-log path is not a regular file; remove it manually if it is yours.");
            return;
        }
        fs.unlinkSync(LEGACY_INPUT_LOG_FILE);
    } catch (error) {
        console.warn("Could not remove the legacy log that may contain typed input. Remove c4-latest.log manually:", error.message);
    }
}

function createProof(purpose, nonce) {
    const secret = Buffer.from(requireCredentials().accessCode, "base64url");
    return crypto.createHmac("sha256", secret)
        .update(`c4/v1/${purpose}\0${nonce}`, "utf8")
        .digest("hex");
}

function canonicalizeJson(value) {
    if (Array.isArray(value)) {
        return `[${value.map(canonicalizeJson).join(",")}]`;
    }
    if (value && typeof value === "object") {
        return `{${Object.keys(value).sort().map(key =>
            `${JSON.stringify(key)}:${canonicalizeJson(value[key])}`
        ).join(",")}}`;
    }
    return JSON.stringify(value);
}

function createInputProof(nonce, sequence, event) {
    const secret = Buffer.from(requireCredentials().accessCode, "base64url");
    const message = `c4/v1/input\0${nonce}\0${sequence}\0${canonicalizeJson(event)}`;
    return crypto.createHmac("sha256", secret).update(message, "utf8").digest("hex");
}

function isValidNonce(nonce) {
    return typeof nonce === "string" && /^[0-9a-f]{64}$/.test(nonce);
}

function getDeviceId() {
    return requireCredentials().deviceId;
}

function wereCredentialsMigrated() {
    return credentialsMigrated;
}

function getAccessCode() {
    return requireCredentials().accessCode;
}

function getCaptureSettings() {
    const stored = requireCredentials();
    return {
        unattendedCapture: stored.unattendedCapture,
        displayId: stored.displayId
    };
}

function setCaptureSettings(unattendedCapture, displayId = null) {
    if (typeof unattendedCapture !== "boolean" ||
        !(displayId === null || typeof displayId === "string")) {
        throw new Error("Invalid screen-capture settings.");
    }
    const next = {
        ...requireCredentials(),
        unattendedCapture,
        displayId: unattendedCapture ? displayId : null
    };
    persistCredentials(next);
    credentials = next;
}

function rotateAccessCode() {
    const next = {
        ...requireCredentials(),
        accessCode: crypto.randomBytes(16).toString("base64url")
    };
    persistCredentials(next);
    credentials = next;
    pendingChallenges.clear();
    authorizedSessions.clear();
    return credentials.accessCode;
}

function createDeviceChallenge(senderId) {
    const nonce = crypto.randomBytes(32).toString("hex");
    pendingChallenges.set(senderId, { nonce, expiresAt: Date.now() + 30_000 });
    authorizedSessions.delete(senderId);
    return { nonce, proof: createProof("device", nonce) };
}

function verifyControllerProof(senderId, nonce, proof) {
    const pending = pendingChallenges.get(senderId);
    pendingChallenges.delete(senderId);

    if (!pending || pending.nonce !== nonce || pending.expiresAt < Date.now() ||
        !isValidNonce(nonce) || typeof proof !== "string" || !/^[0-9a-f]{64}$/.test(proof)) {
        return false;
    }

    const actual = Buffer.from(proof, "hex");
    const expected = Buffer.from(createProof("controller", nonce), "hex");
    const authorized = crypto.timingSafeEqual(actual, expected);
    if (authorized) {
        authorizedSessions.set(senderId, { nonce, lastSequence: 0 });
    }
    return authorized;
}

function verifyControllerInput(senderId, nonce, sequence, event, proof) {
    const session = authorizedSessions.get(senderId);
    if (!session || nonce !== session.nonce || !Number.isSafeInteger(sequence) ||
        sequence <= session.lastSequence || typeof proof !== "string" ||
        !/^[0-9a-f]{64}$/.test(proof)) {
        return false;
    }

    const actual = Buffer.from(proof, "hex");
    const expected = Buffer.from(createInputProof(nonce, sequence, event), "hex");
    if (!crypto.timingSafeEqual(actual, expected)) {
        return false;
    }
    session.lastSequence = sequence;
    return true;
}

function revokePendingChallenge(senderId) {
    pendingChallenges.delete(senderId);
    authorizedSessions.delete(senderId);
}

module.exports = {
    createDeviceChallenge,
    createInputProof,
    getAccessCode,
    getCaptureSettings,
    getDeviceId,
    loadCredentials,
    revokePendingChallenge,
    rotateAccessCode,
    setCaptureSettings,
    verifyControllerInput,
    verifyControllerProof,
    wereCredentialsMigrated
};
