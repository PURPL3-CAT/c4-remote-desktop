const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const Module = require("node:module");
const os = require("node:os");
const path = require("node:path");
const { after, test } = require("node:test");
const vm = require("node:vm");

const tempDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "c4-auth-test-"));
const storageKey = crypto.randomBytes(32);

const safeStorage = {
    isEncryptionAvailable: () => true,
    getSelectedStorageBackend: () => "test-secret-store",
    encryptString(plainText) {
        const iv = crypto.randomBytes(12);
        const cipher = crypto.createCipheriv("aes-256-gcm", storageKey, iv);
        const encrypted = Buffer.concat([cipher.update(plainText, "utf8"), cipher.final()]);
        return Buffer.concat([iv, cipher.getAuthTag(), encrypted]);
    },
    decryptString(buffer) {
        const decipher = crypto.createDecipheriv("aes-256-gcm", storageKey, buffer.subarray(0, 12));
        decipher.setAuthTag(buffer.subarray(12, 28));
        return Buffer.concat([decipher.update(buffer.subarray(28)), decipher.final()]).toString("utf8");
    }
};

const originalLoad = Module._load;
Module._load = function (request, parent, isMain) {
    if (request === "electron") {
        return { app: { getPath: () => tempDirectory }, safeStorage };
    }
    return originalLoad.call(this, request, parent, isMain);
};
const credentials = require("../c4-identity");
Module._load = originalLoad;

const authContext = vm.createContext({
    atob,
    btoa,
    crypto: crypto.webcrypto,
    TextEncoder,
    window: {}
});
vm.runInContext(
    fs.readFileSync(path.join(__dirname, "..", "c4-auth-controller.js"), "utf8"),
    authContext
);
const controllerAuth = authContext.window.c4auth;

after(() => {
    fs.rmSync(tempDirectory, { recursive: true, force: true });
});

test("device and controller authenticate with fresh, one-use shared-code proofs", async () => {
    credentials.loadCredentials();
    const code = credentials.getAccessCode();
    const deviceId = credentials.getDeviceId();
    const challenge = credentials.createDeviceChallenge(42);

    assert.match(deviceId, /^[0-9a-f]{20}$/);
    assert.match(code, /^[A-Za-z0-9_-]{22}$/);
    assert.deepEqual(credentials.getCaptureSettings(), {
        unattendedCapture: false,
        displayId: null
    });
    credentials.setCaptureSettings(true, "display-1");
    assert.deepEqual(credentials.getCaptureSettings(), {
        unattendedCapture: true,
        displayId: "display-1"
    });
    credentials.loadCredentials();
    assert.deepEqual(credentials.getCaptureSettings(), {
        unattendedCapture: true,
        displayId: "display-1"
    });
    credentials.setCaptureSettings(false);

    assert.equal(await controllerAuth.verifyProof(code, "device", challenge.nonce, challenge.proof), true);

    const controllerProof = await controllerAuth.createProof(code, "controller", challenge.nonce);
    assert.equal(credentials.verifyControllerProof(43, challenge.nonce, controllerProof), false);
    assert.equal(credentials.verifyControllerProof(42, challenge.nonce, controllerProof), true);
    assert.equal(credentials.verifyControllerProof(42, challenge.nonce, controllerProof), false);

    const input = {
        kind: "keydown",
        key: "a",
        code: "KeyA",
        ctrl: false,
        alt: false,
        shift: false,
        meta: false
    };
    const inputProof = await controllerAuth.createInputProof(code, challenge.nonce, 1, input);
    assert.equal(credentials.verifyControllerInput(42, challenge.nonce, 1, input, inputProof), true);
    assert.equal(credentials.verifyControllerInput(42, challenge.nonce, 1, input, inputProof), false);
    const tamperedInputProof = await controllerAuth.createInputProof(code, challenge.nonce, 2, input);
    assert.equal(
        credentials.verifyControllerInput(42, challenge.nonce, 2, { ...input, key: "b" }, tamperedInputProof),
        false
    );

    const stored = fs.readFileSync(path.join(tempDirectory, "c4-credentials.json"), "utf8");
    assert.equal(stored.includes(code), false);

    const nextChallenge = credentials.createDeviceChallenge(42);
    const nextProof = await controllerAuth.createProof(code, "controller", nextChallenge.nonce);
    const nextCode = credentials.rotateAccessCode();
    assert.notEqual(nextCode, code);
    assert.equal(credentials.verifyControllerProof(42, nextChallenge.nonce, nextProof), false);
    assert.equal(credentials.verifyControllerInput(42, challenge.nonce, 3, input, inputProof), false);
});

test("legacy long credentials are replaced with compact credentials on upgrade", () => {
    const legacy = {
        deviceId: `c4-${crypto.randomBytes(16).toString("hex")}`,
        accessCode: crypto.randomBytes(32).toString("base64url")
    };
    fs.writeFileSync(
        path.join(tempDirectory, "c4-credentials.json"),
        safeStorage.encryptString(JSON.stringify(legacy)).toString("base64")
    );

    credentials.loadCredentials();

    assert.equal(credentials.wereCredentialsMigrated(), true);
    assert.match(credentials.getDeviceId(), /^[0-9a-f]{20}$/);
    assert.match(credentials.getAccessCode(), /^[A-Za-z0-9_-]{22}$/);
    assert.deepEqual(credentials.getCaptureSettings(), {
        unattendedCapture: false,
        displayId: null
    });
});
