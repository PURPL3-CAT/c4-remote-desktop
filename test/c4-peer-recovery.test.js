const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { test } = require("node:test");

const source = fs.readFileSync(path.join(__dirname, "..", "c4-peer-recovery.js"), "utf8");

function createHarness() {
    let nextTimerId = 0;
    let now = 0;
    const timers = new Map();
    const window = {};
    vm.runInNewContext(source, {
        window,
        console,
        setTimeout(callback, delay) {
            const id = ++nextTimerId;
            timers.set(id, { callback, dueAt: now + delay });
            return id;
        },
        clearTimeout(id) {
            timers.delete(id);
        }
    });

    return {
        create: window.c4PeerRecovery.create,
        advance(ms) {
            now += ms;
            let next;
            do {
                next = [...timers.entries()]
                    .filter(([, timer]) => timer.dueAt <= now)
                    .sort((left, right) => left[1].dueAt - right[1].dueAt)[0];
                if (next) {
                    timers.delete(next[0]);
                    next[1].callback();
                }
            } while (next);
        }
    };
}

class FakePeer {
    listeners = new Map();
    destroyed = false;
    disconnected = false;
    reconnectCount = 0;

    on(event, listener) {
        const listeners = this.listeners.get(event) || [];
        listeners.push(listener);
        this.listeners.set(event, listeners);
    }

    emit(event) {
        for (const listener of this.listeners.get(event) || []) {
            listener();
        }
    }

    reconnect() {
        this.reconnectCount += 1;
        this.disconnected = false;
    }
}

test("reconnects a disconnected peer and resets backoff after it opens", () => {
    const harness = createHarness();
    const peer = new FakePeer();
    const recovery = harness.create(() => peer, () => {});

    recovery.start();
    peer.disconnected = true;
    peer.emit("disconnected");
    harness.advance(999);
    assert.equal(peer.reconnectCount, 0);

    harness.advance(1);
    assert.equal(peer.reconnectCount, 1);
    peer.emit("open");
    peer.disconnected = true;
    peer.emit("disconnected");
    harness.advance(1_000);
    assert.equal(peer.reconnectCount, 2);
});

test("recreates a destroyed peer and does not retry after stop", () => {
    const harness = createHarness();
    const peers = [new FakePeer(), new FakePeer()];
    let created = 0;
    const recovery = harness.create(() => peers[created++], () => {});
    const firstPeer = recovery.start();

    firstPeer.destroyed = true;
    firstPeer.emit("close");
    harness.advance(1_000);
    assert.equal(created, 2);

    recovery.stop();
    const secondPeer = peers[1];
    secondPeer.disconnected = true;
    secondPeer.emit("disconnected");
    harness.advance(60_000);
    assert.equal(secondPeer.reconnectCount, 0);
    assert.equal(created, 2);
});
