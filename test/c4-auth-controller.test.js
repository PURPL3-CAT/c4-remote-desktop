const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { test } = require("node:test");

const source = fs.readFileSync(path.join(__dirname, "..", "c4-auth-controller.js"), "utf8");
const context = vm.createContext({
    atob,
    btoa,
    crypto: crypto.webcrypto,
    TextEncoder,
    window: {}
});
vm.runInContext(source, context);
const auth = context.window.c4auth;

test("mutual HMAC proofs verify only for the matching code, purpose, and nonce", async () => {
    const code = crypto.randomBytes(16).toString("base64url");
    const nonce = crypto.randomBytes(32).toString("hex");
    const deviceProof = await auth.createProof(code, "device", nonce);
    const controllerProof = await auth.createProof(code, "controller", nonce);

    assert.match(deviceProof, /^[0-9a-f]{64}$/);
    assert.notEqual(deviceProof, controllerProof);
    assert.equal(await auth.verifyProof(code, "device", nonce, deviceProof), true);
    assert.equal(await auth.verifyProof(code, "controller", nonce, controllerProof), true);
    assert.equal(await auth.verifyProof(code, "controller", nonce, deviceProof), false);
    assert.equal(await auth.verifyProof(crypto.randomBytes(16).toString("base64url"), "device", nonce, deviceProof), false);
    assert.equal(await auth.verifyProof(code, "device", crypto.randomBytes(32).toString("hex"), deviceProof), false);
});

test("access codes and challenges reject malformed values", async () => {
    assert.throws(() => auth.decodeAccessCode("short"));
    assert.throws(() => auth.decodeAccessCode("!".repeat(22)));
    assert.throws(() => auth.decodeAccessCode("A".repeat(21) + "B"));
    await assert.rejects(auth.createProof(crypto.randomBytes(16).toString("base64url"), "device", "bad"));
});
