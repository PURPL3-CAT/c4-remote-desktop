(() => {
    function createPeerRecovery(createPeer, configurePeer) {
        let peer = null;
        let retryTimer = null;
        let retryDelay = 1_000;
        let stopped = false;

        function scheduleRetry(currentPeer) {
            if (stopped || currentPeer !== peer || retryTimer !== null) {
                return;
            }

            const delay = retryDelay;
            retryDelay = Math.min(retryDelay * 2, 30_000);
            retryTimer = setTimeout(() => {
                retryTimer = null;
                if (stopped || currentPeer !== peer) {
                    return;
                }
                if (currentPeer.destroyed) {
                    startPeer();
                } else if (currentPeer.disconnected) {
                    try {
                        currentPeer.reconnect();
                    } catch (error) {
                        console.error("Could not reconnect to the signaling service:", error);
                        scheduleRetry(currentPeer);
                    }
                }
            }, delay);
        }

        function startPeer() {
            const currentPeer = createPeer();
            peer = currentPeer;
            configurePeer(currentPeer);

            currentPeer.on("open", () => {
                if (currentPeer !== peer) {
                    return;
                }
                clearTimeout(retryTimer);
                retryTimer = null;
                retryDelay = 1_000;
            });
            currentPeer.on("disconnected", () => scheduleRetry(currentPeer));
            currentPeer.on("close", () => scheduleRetry(currentPeer));
            currentPeer.on("error", () => {
                if (currentPeer.destroyed) {
                    scheduleRetry(currentPeer);
                }
            });
            return currentPeer;
        }

        return {
            start: startPeer,
            stop() {
                stopped = true;
                clearTimeout(retryTimer);
                retryTimer = null;
            }
        };
    }

    window.c4PeerRecovery = { create: createPeerRecovery };
})();
