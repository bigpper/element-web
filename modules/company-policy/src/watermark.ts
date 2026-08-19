/**
 * Dynamic watermark (brief §18 / §13).
 *
 * What this is: an attribution control. A screenshot that leaves the building
 * carries the agent code, device and time, so a leak can be traced to a person.
 *
 * What this is NOT: screenshot prevention. `docs/limitations.md` says so plainly and
 * so should anyone describing this feature. A watermark deters and attributes; it
 * does not stop a phone camera pointed at the monitor.
 *
 * Implementation notes:
 *  - Rendered as a fixed, pointer-events:none overlay above the app, so it cannot
 *    swallow clicks.
 *  - The tile is an SVG data URI repeated as a background, which keeps it cheap:
 *    no per-tile DOM nodes, and the browser handles repetition.
 *  - The timestamp refreshes on an interval so a screenshot is attributable to a
 *    time, not merely to a session.
 */

import type { AgentContext, ClientPolicy } from "./policy";

const OVERLAY_ID = "company-watermark-overlay";

function substitute(template: string, agent: AgentContext | null, wm: ClientPolicy["watermark"]): string {
    const now = new Date();
    const stamp = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(
        now.getDate(),
    ).padStart(2, "0")} ${String(now.getHours()).padStart(2, "0")}:${String(now.getMinutes()).padStart(2, "0")}`;

    const parts: Record<string, string> = {
        "{agent_code}": wm.showAgentCode ? (agent?.agentCode ?? "UNKNOWN") : "",
        "{agent_name}": wm.showAgentName ? (agent?.displayName ?? agent?.mxid ?? "") : "",
        "{device_id}": wm.showDeviceId ? (agent?.deviceId ?? "") : "",
        "{timestamp}": wm.showTimestamp ? stamp : "",
    };

    let out = template;
    for (const [k, v] of Object.entries(parts)) out = out.split(k).join(v);
    // Collapse separators left dangling by disabled fields, so turning one off does
    // not leave "CS018 •  • 2026-08-17".
    return out
        .replace(/\s*•\s*(?=•)/g, "")
        .replace(/^\s*•\s*|\s*•\s*$/g, "")
        .replace(/\s{2,}/g, " ")
        .trim();
}

function tile(text: string, wm: ClientPolicy["watermark"]): string {
    const w = wm.spacing;
    const h = Math.round(wm.spacing * 0.55);
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}">
  <text x="50%" y="50%" text-anchor="middle" dominant-baseline="middle"
        transform="rotate(${wm.rotationDegrees} ${w / 2} ${h / 2})"
        font-family="system-ui, -apple-system, sans-serif" font-size="13"
        fill="currentColor">${text.replace(/[<>&"]/g, (c) =>
            ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", '"': "&quot;" })[c]!,
        )}</text>
</svg>`;
    return `url("data:image/svg+xml;utf8,${encodeURIComponent(svg)}")`;
}

export class Watermark {
    private el?: HTMLDivElement;
    private timer?: number;

    apply(policy: ClientPolicy, agent: AgentContext | null): void {
        if (!policy.watermark.enabled) {
            this.remove();
            return;
        }
        const wm = policy.watermark;
        const text = substitute(wm.template, agent, wm);

        if (!this.el) {
            this.el = document.createElement("div");
            this.el.id = OVERLAY_ID;
            Object.assign(this.el.style, {
                position: "fixed",
                inset: "0",
                zIndex: "2147483646",
                // Critical: the overlay must never intercept input.
                pointerEvents: "none",
                // Keep it out of the accessibility tree and out of print/copy flows.
                userSelect: "none",
            } satisfies Partial<CSSStyleDeclaration>);
            this.el.setAttribute("aria-hidden", "true");
            document.body.appendChild(this.el);
        }

        this.el.style.backgroundImage = tile(text, wm);
        this.el.style.opacity = String(wm.opacity);
        // `currentColor` in the SVG resolves against this, so the mark stays legible
        // on both light and dark themes without needing to know which is active.
        this.el.style.color = "var(--cpd-color-text-primary, #000)";

        if (this.timer) window.clearInterval(this.timer);
        // Refresh the timestamp. 60s is fine — the point is to bound when a
        // screenshot was taken, not to be a clock.
        this.timer = window.setInterval(() => this.apply(policy, agent), 60_000);
    }

    remove(): void {
        if (this.timer) window.clearInterval(this.timer);
        this.timer = undefined;
        this.el?.remove();
        this.el = undefined;
    }
}
