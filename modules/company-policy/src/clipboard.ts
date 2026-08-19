/**
 * Clipboard policy (brief §11 / §16).
 *
 * Three modes:
 *   ALLOW            copy freely, no record
 *   ALLOW_AND_AUDIT  copy freely, record MESSAGE_COPY
 *   BLOCK_AND_AUDIT  prevent the copy, record COPY_BLOCKED
 *
 * Honest scoping, which belongs in the code and not only in the docs: this is a
 * client-side control. It stops casual copying and makes deliberate copying
 * attributable. An agent who opens devtools, or who photographs the screen, defeats
 * it. `docs/limitations.md` states this; the value is deterrence plus an audit
 * trail, not prevention.
 *
 * What is deliberately NOT done here: the copied text is never sent anywhere.
 * Brief §11 and §14 both say not to duplicate customer message content into the
 * audit trail — recording what was copied would recreate the exposure the policy
 * exists to limit. Only identifiers travel.
 */

import type { ClientPolicy, PolicyClient } from "./policy";

/** Walk up from the copy target to find the message event it belongs to. */
function eventContext(target: EventTarget | null): {
    messageId?: string;
    conversationId?: string;
} {
    let node = target instanceof Node ? (target as HTMLElement) : null;
    if (node && !(node instanceof HTMLElement)) node = node.parentElement;

    let messageId: string | undefined;
    while (node) {
        // Element tags timeline tiles with the event ID.
        const id = node.dataset?.eventId ?? node.getAttribute?.("data-event-id") ?? undefined;
        if (id) {
            messageId = id;
            break;
        }
        node = node.parentElement;
    }
    // Room ID is in the URL fragment: #/room/!abc:server
    const m = window.location.hash.match(/#\/room\/([^/?]+)/);
    return { messageId, conversationId: m ? decodeURIComponent(m[1]) : undefined };
}

export class ClipboardGuard {
    private handler?: (e: ClipboardEvent) => void;
    private contextHandler?: (e: MouseEvent) => void;

    constructor(private readonly client: PolicyClient) {}

    apply(policy: ClientPolicy): void {
        this.remove();
        const mode = policy.clipboard.mode;
        if (mode === "ALLOW") return;

        this.handler = (e: ClipboardEvent) => {
            // Ignore copies from the composer — that is the agent's own text, not
            // customer content, and blocking it would break ordinary editing.
            const t = e.target as HTMLElement | null;
            if (t?.closest?.('[contenteditable="true"], input, textarea')) return;

            const ctx = eventContext(e.target);
            const isImage = !!t?.closest?.("img, .mx_MImageBody");

            if (mode === "BLOCK_AND_AUDIT") {
                if (isImage && policy.clipboard.allowImageCopy) {
                    this.client.audit({ eventType: "IMAGE_COPY", ...ctx, result: "ALLOWED" });
                    return;
                }
                e.preventDefault();
                e.stopPropagation();
                try {
                    e.clipboardData?.setData("text/plain", "");
                } catch {
                    /* some browsers disallow writing during a prevented event */
                }
                if (policy.clipboard.auditBlockedAttempts) {
                    this.client.audit({
                        eventType: "COPY_BLOCKED",
                        ...ctx,
                        targetType: isImage ? "image" : "message",
                        result: "BLOCKED",
                    });
                }
                return;
            }

            // ALLOW_AND_AUDIT
            this.client.audit({
                eventType: isImage ? "IMAGE_COPY" : "MESSAGE_COPY",
                ...ctx,
                targetType: isImage ? "image" : "message",
                result: "ALLOWED",
            });
        };

        // `cut` matters too: on an editable surface it is a copy that also removes.
        document.addEventListener("copy", this.handler, true);
        document.addEventListener("cut", this.handler, true);

        if (mode === "BLOCK_AND_AUDIT") {
            // The context menu is the other obvious copy route. Suppressing it on
            // the timeline removes "Copy image", "Copy link", "Save image as…" in
            // one move — cruder than per-item gating, but those native entries are
            // not individually addressable from a web page.
            this.contextHandler = (e: MouseEvent) => {
                const t = e.target as HTMLElement | null;
                if (t?.closest?.('[contenteditable="true"], input, textarea')) return;
                if (!t?.closest?.(".mx_RoomView_MessageList, .mx_EventTile, .mx_MImageBody")) return;
                e.preventDefault();
                this.client.audit({
                    eventType: "COPY_BLOCKED",
                    ...eventContext(e.target),
                    targetType: "context-menu",
                    result: "BLOCKED",
                });
            };
            document.addEventListener("contextmenu", this.contextHandler, true);
        }
    }

    remove(): void {
        if (this.handler) {
            document.removeEventListener("copy", this.handler, true);
            document.removeEventListener("cut", this.handler, true);
            this.handler = undefined;
        }
        if (this.contextHandler) {
            document.removeEventListener("contextmenu", this.contextHandler, true);
            this.contextHandler = undefined;
        }
    }
}
