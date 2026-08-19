/**
 * Render Telegram inline-keyboard buttons as pressable controls.
 *
 * The bridge attaches a descriptor to each message that carried an inline keyboard
 * (see replymarkup.go):
 *
 *   "com.company.telegram.buttons": [{ row, col, label, kind }]
 *
 * It is read from EVENT CONTENT, not from the rendered HTML, and that is not an
 * arbitrary choice: Element's sanitiser strips every attribute outside its allowlist
 * (Linkify.ts — `span` keeps only data-mx-*, `code` only class), so a coordinate
 * marker smuggled into the message HTML would not survive. Event content is not
 * sanitised, so the descriptor arrives intact.
 *
 * WHAT THIS FILE DOES NOT DO
 *
 * It does not decide whether a press is allowed. Pressing sends
 * com.company.telegram.button_press into the room; the bridge then re-fetches the
 * message from Telegram, re-derives the button kind from the source, and refuses
 * anything whose bot is not in pressable_bot_ids. This file only decides what is
 * DRAWN. A user who edits `policy.features.pressBotButtons` in their own browser
 * gets pressable-looking buttons and nothing else — every press still has to get
 * past the bridge.
 *
 * Only `callback` buttons are ever drawn pressable. `url` is already a link in the
 * message body; `login` and `webapp` stay inert because following them would
 * authorise a bot against the company Telegram identity.
 */

import type { CompanyPolicyClient } from "./policy";

const BUTTONS_FIELD = "com.company.telegram.buttons";
const PRESS_EVENT = "com.company.telegram.button_press";

interface ButtonDescriptor {
    row: number;
    col: number;
    label: string;
    kind: string;
}

/** Minimal shapes we need; the module deliberately does not import the SDK. */
interface MinimalEvent {
    getContent?: () => Record<string, unknown>;
    getRoomId?: () => string | undefined;
    getId?: () => string | undefined;
}

function descriptorsOf(ev: unknown): ButtonDescriptor[] {
    const e = ev as MinimalEvent | undefined;
    try {
        const raw = e?.getContent?.()[BUTTONS_FIELD];
        if (!Array.isArray(raw)) return [];
        return raw.filter(
            (b): b is ButtonDescriptor =>
                !!b && typeof b.row === "number" && typeof b.col === "number" && typeof b.label === "string",
        );
    } catch {
        return [];
    }
}

/**
 * The Matrix client, for sending the press.
 *
 * The module API's ClientApi exposes only accountData and getRoom, so there is no
 * supported sendEvent. `getRoom(id).client` is the documented-ish route and is tried
 * first; `window.mxMatrixClientPeg` is the fallback Element itself installs
 * (MatrixClientPeg.ts:360). Both are checked at call time rather than cached,
 * because a logout replaces the client.
 */
function matrixClient(api: any, roomId?: string): any | undefined {
    try {
        if (roomId) {
            const room = api?.client?.getRoom?.(roomId);
            if (room?.client?.sendEvent) return room.client;
        }
    } catch {
        /* fall through to the peg */
    }
    try {
        const peg = (globalThis as any).mxMatrixClientPeg;
        const client = peg?.safeGet?.() ?? peg?.get?.();
        if (client?.sendEvent) return client;
    } catch {
        /* nothing available */
    }
    return undefined;
}

export class ButtonPressRenderer {
    private inFlight = new Set<string>();

    public constructor(
        private readonly api: any,
        private readonly client: CompanyPolicyClient,
    ) {}

    public register(): void {
        const cc = this.api.customComponents;
        if (!cc?.registerMessageRenderer) return;

        cc.registerMessageRenderer(
            (ev: unknown) => descriptorsOf(ev).length > 0,
            (props: any, original?: (p?: any) => any) => this.render(props, original),
        );
    }

    private render(props: any, original?: (p?: any) => any): any {
        const React = (globalThis as any).React;
        // No React means no custom rendering. Fall back to Element's own component
        // so the message still displays — the buttons are already in the message
        // body as text, so nothing is lost except pressability.
        if (!React?.createElement) return original?.();

        const ev = props?.mxEvent;
        const descriptors = descriptorsOf(ev);
        const roomId = ev?.getRoomId?.();
        const eventId = ev?.getId?.();

        const allowed = this.client.policy?.features?.pressBotButtons === true;

        const buttons = descriptors.map((b) => {
            const pressable = allowed && b.kind === "callback" && !!roomId && !!eventId;
            const key = `${eventId}:${b.row}:${b.col}`;
            return React.createElement(
                "button",
                {
                    key,
                    type: "button",
                    disabled: !pressable || this.inFlight.has(key),
                    title: pressable
                        ? "Press this bot button"
                        : b.kind === "callback"
                          ? "Pressing bot buttons is not enabled for your role"
                          : `${b.kind} buttons cannot be pressed from here`,
                    style: {
                        margin: "2px 4px 2px 0",
                        padding: "2px 8px",
                        borderRadius: "4px",
                        border: "1px solid var(--cpd-color-border-interactive-primary, #888)",
                        background: "transparent",
                        color: "inherit",
                        cursor: pressable ? "pointer" : "default",
                        opacity: pressable ? 1 : 0.55,
                        font: "inherit",
                    },
                    onClick: pressable ? () => this.press(roomId, eventId, b, key) : undefined,
                },
                b.label,
            );
        });

        return React.createElement(
            "div",
            null,
            original?.(),
            React.createElement("div", { style: { marginTop: "4px" } }, buttons),
        );
    }

    private press(roomId: string, eventId: string, b: ButtonDescriptor, key: string): void {
        const client = matrixClient(this.api, roomId);
        if (!client) {
            this.client.audit({
                eventType: "BUTTON_PRESS",
                conversationId: roomId,
                messageId: eventId,
                targetType: "telegram_button",
                targetId: `${b.row},${b.col}`,
                result: "FAILED",
                metadata: { reason: "no matrix client available" },
            });
            return;
        }

        // Guard against double-fire: a press costs a Telegram API call on the bridge
        // and there is no undo for whatever the bot then does.
        if (this.inFlight.has(key)) return;
        this.inFlight.add(key);

        client
            .sendEvent(roomId, PRESS_EVENT, {
                "m.relates_to": { event_id: eventId },
                row: b.row,
                col: b.col,
            })
            .then(() => {
                // ALLOWED here means "the request was sent", not "the bot acted" —
                // the bridge may still refuse it, and reports that into the room.
                this.client.audit({
                    eventType: "BUTTON_PRESS",
                    conversationId: roomId,
                    messageId: eventId,
                    targetType: "telegram_button",
                    targetId: `${b.row},${b.col}`,
                    result: "ALLOWED",
                    metadata: { kind: b.kind },
                });
            })
            .catch((err: unknown) => {
                this.client.audit({
                    eventType: "BUTTON_PRESS",
                    conversationId: roomId,
                    messageId: eventId,
                    targetType: "telegram_button",
                    targetId: `${b.row},${b.col}`,
                    result: "FAILED",
                    metadata: { reason: String(err).slice(0, 200) },
                });
            })
            .finally(() => {
                setTimeout(() => this.inFlight.delete(key), 2000);
            });
    }
}
