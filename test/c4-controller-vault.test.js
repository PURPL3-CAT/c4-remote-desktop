const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { test } = require("node:test");

const source = fs.readFileSync(path.join(__dirname, "..", "c4-controller-vault.js"), "utf8");
const context = vm.createContext({
    atob,
    btoa,
    crypto: crypto.webcrypto,
    TextDecoder,
    TextEncoder,
    window: {}
});
vm.runInContext(source, context);
const vault = context.window.c4ControllerVault;
const credentials = {
    deviceId: "peer-device-id",
    accessCode: "0123456789abcdefghijkl"
};

test("encrypted credentials unlock only with the matching passphrase", async () => {
    const record = await vault.encrypt(credentials, "a long passphrase");
    assert.equal(record.includes(credentials.deviceId), false);
    assert.equal(record.includes(credentials.accessCode), false);
    assert.deepEqual(
        JSON.parse(JSON.stringify(await vault.decrypt(record, "a long passphrase"))),
        credentials
    );
    await assert.rejects(vault.decrypt(record, "a wrong passphrase"), /PIN is incorrect/);
});

test("vault rejects short passphrases and damaged records", async () => {
    await assert.rejects(vault.encrypt(credentials, "1234567"), /at least 8 characters/);
    await assert.rejects(vault.decrypt("not-json", "a long passphrase"), /damaged or unsupported/);
});
