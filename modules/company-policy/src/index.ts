/**
 * Company policy module.
 *
 * Applies the client half of the security policy (brief §11–§13, §18) fetched from
 * the Management API. Everything here is CLIENT-side, and that framing matters:
 *
 *   - Feature gating below hides controls. The Synapse policy module is what
 *     actually refuses create-room and invite (brief §23, ADR-0001 §3). If the two
 *     ever disagree, the server wins and the agent sees a permission error — which
 *     is the correct failure direction.
 *   - Clipboard and watermark have no server-side counterpart and cannot have one.
 *     They are deterrence and attribution. See docs/limitations.md.
 *
 * The module is deliberately additive: no upstream Element source is modified, so
 * upgrades stay mechanical (brief §30).
 */

import { ClipboardGuard } from "./clipboard";
import { LOCKED_DOWN, PolicyClient } from "./policy";
import { Watermark } from "./watermark";
import { ButtonPressRenderer } from "./buttons";
import { WidgetPolicy } from "./widgets";

const CONFIG_KEY = "company_policy";

/**
 * UIComponent values, inlined rather than imported.
 *
 * Upstream declares these as a `const enum`, which TypeScript erases at compile
 * time — importing it would force this module to be built inside Element's pnpm
 * workspace. Inlining the string values keeps the module self-contained and
 * buildable on its own, which is what lets it ship as a runtime artifact and lets
 * Element upgrade without rebuilding it.
 *
 * Verified against element/apps/web/src/settings/UIFeature.ts and
 * packages/module-api/src/api/customisations.ts. If upstream changes a value, the
 * gate silently stops matching — so `scripts/test-boundaries.sh` asserts these
 * strings still exist in the Element source.
 */
const UIComponent = {
    InviteUsers: "UIComponent.sendInvites",
    CreateRooms: "UIComponent.roomCreation",
    CreateSpaces: "UIComponent.spaceCreation",
    ExploreRooms: "UIComponent.exploreRooms",
    AddIntegrations: "UIComponent.addIntegrations",
    FilterContainer: "UIComponent.filterContainer",
    RoomOptionsMenu: "UIComponent.roomOptionsMenu",
} as const;

/** Minimal shape of the bits of the Element module API this module uses. */
interface Watchable<T> {
    readonly value: T;
    watch(listener: (value: T) => void): void;
}
interface Profile {
    userId?: string;
    displayName?: string;
    isGuest?: boolean;
}
interface Api {
    config: { get(key: string): unknown };
    customisations: {
        registerShouldShowComponent(fn: (component: string) => boolean | void): void;
    };
    customComponents?: unknown;
    profile?: Watchable<Profile>;
}
interface Module {
    load(): Promise<void>;
}
type ModuleFactory = new (api: Api) => Module;

interface ModuleConfig {
    /** Base URL of the agent-facing Management API, e.g. http://api.localhost:8480 */
    api_url: string;
    /** How often to re-fetch policy, in seconds. 0 disables polling. */
    refresh_seconds?: number;
}

export class CompanyPolicyModule implements Module {
    public static readonly moduleApiVersion = "^1.0.0";

    private client!: PolicyClient;
    private watermark = new Watermark();
    private clipboard!: ClipboardGuard;

    public constructor(private api: Api) {}

    public async load(): Promise<void> {
        const raw = this.api.config.get(CONFIG_KEY) as ModuleConfig | undefined;
        if (!raw?.api_url) {
            // Fail CLOSED on misconfiguration. A missing config block must not be a
            // way to run Element with no policy at all — that would make "delete
            // three lines of config.json" a bypass.
            console.error(
                "[company-policy] no api_url configured — applying locked-down policy",
            );
            this.applyLockedDown();
            return;
        }

        this.client = new PolicyClient(raw.api_url.replace(/\/$/, ""));
        this.clipboard = new ClipboardGuard(this.client);

        this.registerFeatureGates();
        this.registerMediaPolicy();
        // Pressable bot buttons. Drawing only — the bridge's pressable_bot_ids
        // allowlist is what decides whether a press is carried out.
        new ButtonPressRenderer(this.api, this.client).register();
        // Pre-approve only the provisioned panel, and only m.always_on_screen.
        new WidgetPolicy(this.api, this.client).register();

        // Apply the locked-down policy IMMEDIATELY. `load()` runs before the Matrix
        // client exists, so there is no token yet and no policy can be fetched —
        // but the watermark and clipboard guard must already be in place. Starting
        // permissive and tightening later would leave a window in which controls
        // are off.
        this.watermark.apply(LOCKED_DOWN, null);
        this.clipboard.apply(LOCKED_DOWN);

        // Re-fetch once the user is actually logged in. The profile watchable is
        // the supported signal for that; polling for the client global would be
        // guesswork about Element's startup order.
        this.api.profile?.watch((p) => {
            if (p?.userId) void this.refresh();
        });
        if (this.api.profile?.value?.userId) void this.refresh();

        const every = raw.refresh_seconds ?? 300;
        if (every > 0) {
            const t = window.setInterval(() => void this.refresh(), every * 1000);
            // Do not keep the page alive purely for polling.
            (t as unknown as { unref?: () => void }).unref?.();
        }
    }

    private applyLockedDown(): void {
        this.client ??= new PolicyClient("");
        this.client.policy = LOCKED_DOWN;
        this.clipboard ??= new ClipboardGuard(this.client);
        this.watermark.apply(LOCKED_DOWN, null);
        this.clipboard.apply(LOCKED_DOWN);
    }

    private async refresh(): Promise<void> {
        await this.client.refresh();
        const p = this.client.policy;
        // Prefer the device ID from the live client: it is present even when the
        // policy fetch failed, so a locked-down watermark still attributes to a
        // device rather than showing a blank.
        const agent = this.client.agent
            ? { ...this.client.agent, deviceId: this.client.agent.deviceId ?? this.client.deviceIdFromClient() }
            : null;
        this.watermark.apply(p, agent);
        this.clipboard.apply(p);
    }

    /**
     * Hide controls the policy disables.
     *
     * `registerShouldShowComponent` is consulted synchronously and often, so it
     * reads the current policy each time rather than capturing it — a policy
     * refresh then takes effect without re-registering.
     */
    private registerFeatureGates(): void {
        this.api.customisations.registerShouldShowComponent((component: string) => {
            const f = this.client?.policy?.features ?? LOCKED_DOWN.features;
            switch (component) {
                case UIComponent.CreateRooms:
                    return f.createRoom;
                case UIComponent.CreateSpaces:
                    return f.createRoom;
                case UIComponent.InviteUsers:
                    return f.invite;
                case UIComponent.ExploreRooms:
                    return f.userSearch;
                case UIComponent.FilterContainer:
                    // The room-list filter box (RoomListPanel -> RoomListSearch).
                    // Gated on filterOwnRooms, NOT userSearch: this filters rooms the
                    // agent has already joined, which grants no reach. The dialog it
                    // opens also queries the user directory and public rooms, and both
                    // are refused server-side, so those sections come back empty.
                    return f.filterOwnRooms;
                case UIComponent.AddIntegrations:
                    return false;
                default:
                    // Unknown component in a future Element version: defer, and let
                    // the server-side controls carry the weight. Denying unknowns
                    // would break the client on every upgrade.
                    return undefined;
            }
        });
    }

    /**
     * Media download policy (brief §12/§17): preview is not download.
     *
     * `allowDownloadingMedia` is not a standalone method — it is a HINT on
     * `registerMessageRenderer`. So we register a renderer that renders nothing of
     * its own (it delegates straight back to Element's original component) purely
     * to attach the hint. That is the supported way to gate downloads without
     * taking over rendering.
     */
    private registerMediaPolicy(): void {
        const cc = this.api.customComponents as
            | {
                  registerMessageRenderer?: (
                      filter: string | ((ev: unknown) => boolean),
                      renderer: (props: unknown, original?: (p?: unknown) => unknown) => unknown,
                      hints?: { allowDownloadingMedia?: (ev: unknown) => Promise<boolean> },
                  ) => void;
              }
            | undefined;
        if (typeof cc?.registerMessageRenderer !== "function") {
            console.warn(
                "[company-policy] customComponents.registerMessageRenderer unavailable; " +
                    "media download policy NOT enforced client-side",
            );
            return;
        }

        const gate = async (mxEvent: unknown) => {
            const m = this.client?.policy?.media ?? LOCKED_DOWN.media;
            const type = msgtypeOf(mxEvent);
            const allowed =
                type === "m.image"
                    ? m.allowImageDownload
                    : type === "m.video"
                      ? m.allowVideoDownload
                      : type === "m.audio"
                        ? m.allowAudioDownload
                        : m.allowFileDownload;

            this.client?.audit({
                eventType: allowed ? "FILE_DOWNLOAD" : "FILE_DOWNLOAD_BLOCKED",
                targetType: type ?? "file",
                result: allowed ? "ALLOWED" : "BLOCKED",
            });
            return allowed;
        };

        // Only media-bearing messages need the gate. Render nothing custom —
        // delegate to Element's own component so the timeline looks unchanged.
        cc.registerMessageRenderer(
            (ev: unknown) => {
                const t = msgtypeOf(ev);
                return t === "m.image" || t === "m.video" || t === "m.audio" || t === "m.file";
            },
            (_props: unknown, original?: (p?: unknown) => unknown) => original?.(),
            { allowDownloadingMedia: gate },
        );
    }
}

function msgtypeOf(ev: unknown): string | undefined {
    const e = ev as { getContent?: () => { msgtype?: string } } | undefined;
    try {
        return e?.getContent?.()?.msgtype;
    } catch {
        return undefined;
    }
}

export default CompanyPolicyModule satisfies ModuleFactory;
