/**
 * Client policy fetching (brief §22).
 *
 * The policy comes from the Management API, keyed on the agent's own Matrix access
 * token. This module cannot ask the module API for that token, so it reads it from
 * the same localStorage entry Element itself uses. That is not a privilege
 * escalation — the module runs inside Element, in the same origin, with the same
 * access Element already has.
 */

export interface ClientPolicy {
    identity: {
        showTelegramUserId: boolean;
        showTelegramUsername: boolean;
        showTelegramPhone: boolean;
        showMatrixId: boolean;
        showTelegramProfilePhoto: boolean;
        displayTemplate: string;
    };
    clipboard: {
        mode: "ALLOW" | "ALLOW_AND_AUDIT" | "BLOCK_AND_AUDIT";
        allowImageCopy: boolean;
        auditBlockedAttempts: boolean;
    };
    media: {
        allowImagePreview: boolean;
        allowVideoPlayback: boolean;
        allowVoicePlayback: boolean;
        allowFilePreview: boolean;
        allowImageDownload: boolean;
        allowVideoDownload: boolean;
        allowAudioDownload: boolean;
        allowFileDownload: boolean;
    };
    features: {
        createRoom: boolean;
        invite: boolean;
        directMessage: boolean;
        userSearch: boolean;
        /**
         * Filter the agent's OWN conversation list by name.
         *
         * Deliberately separate from `userSearch`. Searching the user directory finds
         * people the agent has no relationship with — that is the reach this platform
         * exists to prevent. Filtering a list of rooms the agent is already joined to
         * grants no reach at all: every result is a conversation they can already open
         * from the sidebar. Conflating the two cost agents the ability to find one of
         * ~80 conversations by name, and bought nothing.
         *
         * The dialog behind the filter box also queries the user directory and the
         * public room list. Both are refused server-side (Caddy 404s them and Synapse
         * has user_directory disabled), so those sections stay empty regardless of
         * this flag. Client shows, server decides.
         */
        filterOwnRooms: boolean;
        viewMemberList: boolean;
        bridgeCommands: boolean;
        forwardMessages: boolean;
        exportConversation: boolean;
        developerTools: boolean;
    };
    watermark: {
        enabled: boolean;
        template: string;
        opacity: number;
        spacing: number;
        rotationDegrees: number;
        showAgentCode: boolean;
        showAgentName: boolean;
        showDeviceId: boolean;
        showTimestamp: boolean;
    };
    audit: {
        conversationOpen: boolean;
        mediaView: boolean;
        voicePlay: boolean;
        messageSend: boolean;
        search: boolean;
    };
}

export interface AgentContext {
    mxid: string;
    agentCode: string;
    displayName: string | null;
    roleId: string;
    deviceId: string | null;
}

/**
 * The policy applied when the Management API cannot be reached.
 *
 * ADR-0002 requires failing CLOSED. Note what this deliberately is NOT: it is not
 * the last policy we successfully fetched, and it is not "no policy". An outage in
 * the policy service must not be a way to obtain a permissive client — otherwise
 * taking the service down becomes the exploit.
 */
export const LOCKED_DOWN: ClientPolicy = {
    identity: {
        showTelegramUserId: false,
        showTelegramUsername: false,
        showTelegramPhone: false,
        showMatrixId: false,
        showTelegramProfilePhoto: false,
        displayTemplate: "Customer #{customer_number}",
    },
    clipboard: { mode: "BLOCK_AND_AUDIT", allowImageCopy: false, auditBlockedAttempts: true },
    media: {
        allowImagePreview: false,
        allowVideoPlayback: false,
        allowVoicePlayback: false,
        allowFilePreview: false,
        allowImageDownload: false,
        allowVideoDownload: false,
        allowAudioDownload: false,
        allowFileDownload: false,
    },
    features: {
        createRoom: false,
        invite: false,
        directMessage: false,
        userSearch: false,
        // LOCKED_DOWN default: false like everything else here. The seeded policy
        // turns it on; this constant is what applies when policy cannot be loaded.
        filterOwnRooms: false,
        viewMemberList: false,
        bridgeCommands: false,
        forwardMessages: false,
        exportConversation: false,
        developerTools: false,
    },
    watermark: {
        enabled: true,
        template: "{agent_code} • {agent_name} • {device_id} • {timestamp}",
        opacity: 0.08,
        spacing: 240,
        rotationDegrees: -30,
        showAgentCode: true,
        showAgentName: true,
        showDeviceId: true,
        showTimestamp: true,
    },
    audit: {
        conversationOpen: true,
        mediaView: true,
        voicePlay: true,
        messageSend: false,
        search: true,
    },
};

const ACCESS_TOKEN_STORAGE_KEY = "mx_access_token";

/**
 * Obtaining the agent's access token.
 *
 * The module API deliberately does not expose it — `AccountAuthApiExtension` can
 * only *overwrite* auth, not read it. And since Element began encrypting the token
 * with a pickle key in IndexedDB, reading localStorage only works for legacy
 * sessions.
 *
 * So we use `window.mxMatrixClientPeg`, an internal Element global. Being explicit
 * about the trade-off: this is NOT a supported API and an Element upgrade could
 * remove it. It is still the right choice over the alternatives — reimplementing
 * upstream's token decryption would duplicate security-sensitive crypto, and
 * patching Element to expose the token would be a source modification carried
 * forever (brief §21 prefers exhausting other mechanisms first).
 *
 * The failure mode is safe: no token means no policy fetch, which means LOCKED_DOWN.
 * `scripts/test-boundaries.sh` asserts the global still exists so the breakage is
 * caught rather than silently degrading every agent to the restrictive policy.
 */
interface MatrixClientPeg {
    get?: () => {
        getAccessToken?: () => string | null;
        getUserId?: () => string | null;
        getDeviceId?: () => string | null;
    } | null;
}

export class PolicyClient {
    public policy: ClientPolicy = LOCKED_DOWN;
    public agent: AgentContext | null = null;
    public policyVersion: number | null = null;
    /** True once a real policy has been fetched; false means we are locked down. */
    public loaded = false;

    constructor(private readonly baseUrl: string) {}

    private token(): string | null {
        // Preferred: the live client, which holds the decrypted token in memory.
        try {
            const peg = (window as unknown as { mxMatrixClientPeg?: MatrixClientPeg })
                .mxMatrixClientPeg;
            const tok = peg?.get?.()?.getAccessToken?.();
            if (tok) return tok;
        } catch {
            /* fall through */
        }
        // Fallback for older sessions where the token is still plain in localStorage.
        try {
            return window.localStorage.getItem(ACCESS_TOKEN_STORAGE_KEY);
        } catch {
            return null;
        }
    }

    /** Device ID for the watermark, straight from the live client. */
    deviceIdFromClient(): string | null {
        try {
            const peg = (window as unknown as { mxMatrixClientPeg?: MatrixClientPeg })
                .mxMatrixClientPeg;
            return peg?.get?.()?.getDeviceId?.() ?? null;
        } catch {
            return null;
        }
    }

    async refresh(): Promise<void> {
        const token = this.token();
        if (!token) {
            console.warn("[company-policy] no access token; staying locked down");
            this.policy = LOCKED_DOWN;
            this.loaded = false;
            return;
        }
        try {
            const res = await fetch(`${this.baseUrl}/api/client/policy`, {
                headers: { Authorization: `Bearer ${token}` },
            });
            if (!res.ok) throw new Error(`HTTP ${res.status}`);
            const body = await res.json();
            this.policy = body.policy as ClientPolicy;
            this.agent = body.agent as AgentContext;
            this.policyVersion = body.policyVersion ?? null;
            this.loaded = true;
            console.info(
                `[company-policy] applied v${this.policyVersion} for ${this.agent?.agentCode}`,
            );
        } catch (err) {
            console.error(`[company-policy] policy fetch failed, locking down: ${String(err)}`);
            this.policy = LOCKED_DOWN;
            this.loaded = false;
        }
    }

    /**
     * Report an audit event. Fire and forget: an audit failure must never block
     * what the agent is doing, and the server-side sink is the durable one.
     *
     * Message CONTENT is never sent — brief §11 and §14. The parameters here are
     * deliberately identifiers only, so there is no shape in which a caller could
     * pass the copied text.
     */
    audit(event: {
        eventType: string;
        conversationId?: string;
        messageId?: string;
        targetType?: string;
        targetId?: string;
        result?: "ALLOWED" | "BLOCKED" | "FAILED";
        metadata?: Record<string, unknown>;
    }): void {
        const token = this.token();
        if (!token) return;
        void fetch(`${this.baseUrl}/api/client/audit`, {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                Authorization: `Bearer ${token}`,
            },
            body: JSON.stringify({ ...event, policyVersion: this.policyVersion }),
            keepalive: true,
        }).catch(() => {
            /* deliberately ignored */
        });
    }
}
