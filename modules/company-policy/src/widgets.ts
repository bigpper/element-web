/**
 * Consent policy for the company's own provisioned widget panel.
 *
 * Element gates a widget three times before it can do anything useful, and a panel an
 * administrator installed into every conversation hits all three in every room, each
 * time asking the agent about a decision they were never in a position to make:
 *
 *   1. PRELOAD  — "Continue" before the iframe loads at all.
 *   2. IDENTITY — a prompt before Element will issue an OpenID token. Without this
 *                 one answered, `requestOpenIDConnectToken()` in the widget simply
 *                 times out (ElementWidgetDriver.askOpenID falls through to
 *                 PendingUserConfirmation), which looks like a broken panel rather
 *                 than an unanswered question.
 *   3. CAPABILITIES — what the widget may do inside the room.
 *
 * SCOPED BY ORIGIN, NOT BY NAME.
 *
 * Every approval below is keyed on `widget.origin`. A widget's id, name and type are
 * chosen by whoever wrote the room state, and in a room where an agent holds power
 * they could be set to anything; the origin is what determines whose page actually
 * loads. Origins come from the policy (`widgets.trustedOrigins`), which is server-
 * delivered — a browser-side edit of the policy grants nothing, because the widget
 * still has to satisfy the management API to learn anything.
 *
 * WHAT IS NOT AUTO-APPROVED.
 *
 * Capabilities stay minimal: only `m.always_on_screen`. Reading timeline events,
 * sending on the agent's behalf and room state are left to the prompt, because those
 * are what let a third-party page act INSIDE the conversation rather than sit beside
 * it. The identity exchange needs no capability at all, which is what makes such a
 * short list workable.
 */

import type { CompanyPolicyClient } from "./policy";

/** Capabilities a provisioned panel may have without asking. */
const PREAPPROVED = new Set<string>(["m.always_on_screen"]);

interface WidgetDescriptor {
    id?: string;
    templateUrl?: string;
    origin?: string;
    type?: string;
    roomId?: string;
}

export class WidgetPolicy {
    public constructor(
        private readonly api: any,
        private readonly client: CompanyPolicyClient,
    ) {}

    private trusted(widget: WidgetDescriptor | undefined): boolean {
        const allowed = this.client.policy?.widgets?.trustedOrigins ?? [];
        const origin = widget?.origin ?? originOf(widget?.templateUrl);
        return !!origin && allowed.includes(origin);
    }

    public register(): void {
        const lifecycle = this.api?.widgetLifecycle;
        if (!lifecycle) return;

        // 1. Load without a "Continue" click.
        lifecycle.registerPreloadApprover?.((widget: WidgetDescriptor) =>
            this.trusted(widget) ? true : undefined,
        );

        // 2. Issue an OpenID token without prompting.
        //
        // This is the consequential one: it lets the panel learn WHICH AGENT is
        // viewing it, silently. That is the entire purpose of the integration, and
        // the identity disclosed is the agent's own — never a customer's — but it
        // happens without the agent being asked, so it is audited.
        lifecycle.registerIdentityApprover?.((widget: WidgetDescriptor) => {
            if (!this.trusted(widget)) return undefined;
            this.client.audit({
                eventType: "WIDGET_IDENTITY_DISCLOSED",
                conversationId: widget.roomId,
                targetType: "widget",
                targetId: widget.origin,
                result: "ALLOWED",
            });
            return true;
        });

        // 3. Capabilities — the short list, and a record of anything refused.
        lifecycle.registerCapabilitiesApprover?.((widget: WidgetDescriptor, requested: Set<string>) => {
            if (!this.trusted(widget)) return undefined;

            const granted = new Set<string>();
            for (const cap of requested) if (PREAPPROVED.has(cap)) granted.add(cap);

            const withheld = [...requested].filter((c) => !granted.has(c));
            if (withheld.length > 0) {
                // A provisioned panel asking for more than a panel needs is a change
                // in what the host system does, and nobody would otherwise notice.
                this.client.audit({
                    eventType: "WIDGET_CAPABILITY_WITHHELD",
                    conversationId: widget.roomId,
                    targetType: "widget",
                    targetId: widget.origin,
                    result: "BLOCKED",
                    metadata: { withheld },
                });
            }
            return granted;
        });
    }
}

function originOf(url: unknown): string | null {
    if (typeof url !== "string") return null;
    try {
        return new URL(url).origin;
    } catch {
        return null;
    }
}
