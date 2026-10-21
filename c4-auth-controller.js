(() => {
    let cachedCode = null;
    let cachedKey = null;

    function decodeAccessCode(code) {
        if (typeof code !== "string" || !/^[A-Za-z0-9_-]{22}$/.test(code)) {
            throw new Error("Access code must be the complete 22-character code shown by the device.");
        }
        const base64 = code.replace(/-/g, "+").replace(/_/g, "/") + "==";
        const bytes = Uint8Array.from(atob(base64), character => character.charCodeAt(0));
        const canonical = btoa(String.fromCharCode(...bytes))
            .replace(/\+/g, "-")
            .replace(/\//g, "_")
            .replace(/=+$/g, "");
        if (bytes.length !== 16 || canonical !== code) {
            throw new Error("Access code has an invalid length.");
        }
        return bytes;
    }

    async function importKey(code) {
        if (cachedCode === code && cachedKey) {
            return cachedKey;
        }
        cachedCode = code;
        cachedKey = crypto.subtle.importKey(
            "raw",
            decodeAccessCode(code),
            { name: "HMAC", hash: "SHA-256" },
            false,
            ["sign", "verify"]
        );
        return cachedKey;
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

    function proofMessage(purpose, nonce) {
        if (typeof nonce !== "string" || !/^[0-9a-f]{64}$/.test(nonce)) {
            throw new Error("The device sent an invalid authentication challenge.");
        }
        return new TextEncoder().encode(`c4/v1/${purpose}\0${nonce}`);
    }

    async function createProof(code, purpose, nonce) {
        const signature = await crypto.subtle.sign(
            "HMAC",
            await importKey(code),
            proofMessage(purpose, nonce)
        );
        return Array.from(new Uint8Array(signature), byte => byte.toString(16).padStart(2, "0")).join("");
    }

    async function createInputProof(code, nonce, sequence, event) {
        if (typeof nonce !== "string" || !/^[0-9a-f]{64}$/.test(nonce) ||
            !Number.isSafeInteger(sequence) || sequence < 1) {
            throw new Error("The input session is invalid.");
        }
        const message = new TextEncoder().encode(
            `c4/v1/input\0${nonce}\0${sequence}\0${canonicalizeJson(event)}`
        );
        const signature = await crypto.subtle.sign("HMAC", await importKey(code), message);
        return Array.from(new Uint8Array(signature), byte => byte.toString(16).padStart(2, "0")).join("");
    }

    async function verifyProof(code, purpose, nonce, proof) {
        if (typeof proof !== "string" || !/^[0-9a-f]{64}$/.test(proof)) {
            return false;
        }
        const signature = Uint8Array.from(proof.match(/../g), byte => parseInt(byte, 16));
        return crypto.subtle.verify(
            "HMAC",
            await importKey(code),
            signature,
            proofMessage(purpose, nonce)
        );
    }

    function clearKey() {
        cachedCode = null;
        cachedKey = null;
    }

    window.c4auth = { clearKey, createInputProof, createProof, decodeAccessCode, verifyProof };
})();
