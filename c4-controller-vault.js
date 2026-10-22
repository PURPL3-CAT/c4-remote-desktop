(() => {
    const ITERATIONS = 600_000;
    const encoder = new TextEncoder();
    const decoder = new TextDecoder();

    function toBase64(bytes) {
        return btoa(String.fromCharCode(...bytes));
    }

    function fromBase64(value) {
        return Uint8Array.from(atob(value), character => character.charCodeAt(0));
    }

    function validatePin(pin) {
        if (typeof pin !== "string" || pin.length < 8) {
            throw new Error("Use a PIN or passphrase with at least 8 characters.");
        }
    }

    async function deriveKey(pin, salt) {
        const material = await crypto.subtle.importKey(
            "raw",
            encoder.encode(pin),
            "PBKDF2",
            false,
            ["deriveKey"]
        );
        return crypto.subtle.deriveKey(
            { name: "PBKDF2", hash: "SHA-256", salt, iterations: ITERATIONS },
            material,
            { name: "AES-GCM", length: 256 },
            false,
            ["encrypt", "decrypt"]
        );
    }

    async function encrypt(credentials, pin) {
        validatePin(pin);
        if (!credentials || typeof credentials.deviceId !== "string" ||
            typeof credentials.accessCode !== "string") {
            throw new Error("A device ID and access code are required.");
        }

        const salt = crypto.getRandomValues(new Uint8Array(16));
        const iv = crypto.getRandomValues(new Uint8Array(12));
        const key = await deriveKey(pin, salt);
        const ciphertext = await crypto.subtle.encrypt(
            { name: "AES-GCM", iv },
            key,
            encoder.encode(JSON.stringify(credentials))
        );
        return JSON.stringify({
            version: 1,
            salt: toBase64(salt),
            iv: toBase64(iv),
            ciphertext: toBase64(new Uint8Array(ciphertext))
        });
    }

    async function decrypt(recordText, pin) {
        validatePin(pin);
        let record;
        try {
            record = JSON.parse(recordText);
        } catch {
            throw new Error("Saved connection data is damaged or unsupported.");
        }
        if (!record || record.version !== 1 ||
            typeof record.salt !== "string" ||
            typeof record.iv !== "string" ||
            typeof record.ciphertext !== "string") {
            throw new Error("Saved connection data is damaged or unsupported.");
        }

        let plaintext;
        try {
            const salt = fromBase64(record.salt);
            const iv = fromBase64(record.iv);
            const ciphertext = fromBase64(record.ciphertext);
            if (salt.length !== 16 || iv.length !== 12 || ciphertext.length < 16) {
                throw new Error("Invalid encrypted data.");
            }
            const key = await deriveKey(pin, salt);
            plaintext = await crypto.subtle.decrypt({ name: "AES-GCM", iv }, key, ciphertext);
        } catch {
            throw new Error("PIN is incorrect or the saved connection data is damaged.");
        }

        let credentials;
        try {
            credentials = JSON.parse(decoder.decode(plaintext));
        } catch {
            throw new Error("Saved connection data is damaged or unsupported.");
        }
        if (!credentials || typeof credentials.deviceId !== "string" ||
            typeof credentials.accessCode !== "string") {
            throw new Error("Saved connection data is damaged or unsupported.");
        }
        return credentials;
    }

    window.c4ControllerVault = { decrypt, encrypt };
})();
