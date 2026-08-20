/**
 * Pre-approve capabilities for the company's own provisioned widget.
 *
 * Element asks the agent to approve a widget's requested capabilities the first time
 * it loads. For a widget an administrator installed into every conversation, that is
 * a prompt on every room for every agent, about a decision they were never in a
 * position to make.
 *
 * SCOPED ON PURPOSE, TWICE OVER.
 *
 * Approval is granted only to widgets whose URL origin is on an allowlist delivered
 * with the policy — not to widgets by name or ID, which a room member with power
 * could set to anything, and never to widgets in general. An agent who somehow gets
 * a widget of their own into a room still gets the normal prompt.
 *
 * And the only capability pre-approved is `m.always_on_screen`, which keeps the
 * panel from being torn down as the agent moves around. Everything else — reading
 * timeline events, sending on the user's behalf, room state — is left to the prompt,
 * because those are the capabilities that would let a third-party page act inside
 * the conversation rather than merely sit beside it.
 *
 * The widget proves WHO is looking at it through the OpenID exchange
 * (docs/widget-integration.md), which needs no Element capability at all. That is
 * why this list can stay this short.
 */

import type { CompanyPolicyClient } from "./policy";

/** Capabilities safe to grant a provisioned panel without asking. */
const PREAPPROVED = new Set<string>(["m.always_on_screen"]);

function originOf(url: unknown): string | null {
    if (typeof url !== "string") return null;
    try {
        return new URL(url).origin;
    } catch {
        return null;
    }
}

export class WidgetPolicy {
    public constructor(
        private readonly api: any,
        private readonly client: CompanyPolicyClient,
    ) {}

    public register(): void {
        const reg = this.api?.legacyCustomisations?._registerLegacyWidgetPermissionsCustomisations;
        if (typeof reg !== "function") return;

        reg({
            preapproveCapabilities: async (widget: any, requested: Set<string>) => {
                const allowed = this.client.policy?.widgets?.trustedOrigins ?? [];
                const origin = originOf(widget?.url ?? widget?.templateUrl);
                if (!origin || !allowed.includes(origin)) {
                    // Not ours. Return nothing and let Element ask the agent.
                    return new Set<string>();
                }

                const granted = new Set<string>();
                for (const cap of requested) {
                    if (PREAPPROVED.has(cap)) granted.add(cap);
                }

                const withheld = [...requested].filter((c) => !granted.has(c));
                if (withheld.length > 0) {
                    // Worth an audit line: a provisioned widget asking for more than
                    // a panel needs is a change in what the host system is doing, and
                    // nobody would otherwise notice it happening.
                    this.client.audit({
                        eventType: "WIDGET_CAPABILITY_WITHHELD",
                        targetType: "widget",
                        targetId: origin,
                        result: "BLOCKED",
                        metadata: { withheld },
                    });
                }
                return granted;
            },
        });
    }
}
