var __defProp = Object.defineProperty;
var __defNormalProp = (obj, key, value) => key in obj ? __defProp(obj, key, { enumerable: true, configurable: true, writable: true, value }) : obj[key] = value;
var __publicField = (obj, key, value) => __defNormalProp(obj, typeof key !== "symbol" ? key + "" : key, value);

// src/clipboard.ts
function eventContext(target) {
  let node = target instanceof Node ? target : null;
  if (node && !(node instanceof HTMLElement)) node = node.parentElement;
  let messageId;
  while (node) {
    const id = node.dataset?.eventId ?? node.getAttribute?.("data-event-id") ?? void 0;
    if (id) {
      messageId = id;
      break;
    }
    node = node.parentElement;
  }
  const m = window.location.hash.match(/#\/room\/([^/?]+)/);
  return { messageId, conversationId: m ? decodeURIComponent(m[1]) : void 0 };
}
var ClipboardGuard = class {
  constructor(client) {
    this.client = client;
    __publicField(this, "handler");
    __publicField(this, "contextHandler");
  }
  apply(policy) {
    this.remove();
    const mode = policy.clipboard.mode;
    if (mode === "ALLOW") return;
    this.handler = (e) => {
      const t = e.target;
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
        }
        if (policy.clipboard.auditBlockedAttempts) {
          this.client.audit({
            eventType: "COPY_BLOCKED",
            ...ctx,
            targetType: isImage ? "image" : "message",
            result: "BLOCKED"
          });
        }
        return;
      }
      this.client.audit({
        eventType: isImage ? "IMAGE_COPY" : "MESSAGE_COPY",
        ...ctx,
        targetType: isImage ? "image" : "message",
        result: "ALLOWED"
      });
    };
    document.addEventListener("copy", this.handler, true);
    document.addEventListener("cut", this.handler, true);
    if (mode === "BLOCK_AND_AUDIT") {
      this.contextHandler = (e) => {
        const t = e.target;
        if (t?.closest?.('[contenteditable="true"], input, textarea')) return;
        if (!t?.closest?.(".mx_RoomView_MessageList, .mx_EventTile, .mx_MImageBody")) return;
        e.preventDefault();
        this.client.audit({
          eventType: "COPY_BLOCKED",
          ...eventContext(e.target),
          targetType: "context-menu",
          result: "BLOCKED"
        });
      };
      document.addEventListener("contextmenu", this.contextHandler, true);
    }
  }
  remove() {
    if (this.handler) {
      document.removeEventListener("copy", this.handler, true);
      document.removeEventListener("cut", this.handler, true);
      this.handler = void 0;
    }
    if (this.contextHandler) {
      document.removeEventListener("contextmenu", this.contextHandler, true);
      this.contextHandler = void 0;
    }
  }
};

// src/policy.ts
var LOCKED_DOWN = {
  identity: {
    showTelegramUserId: false,
    showTelegramUsername: false,
    showTelegramPhone: false,
    showMatrixId: false,
    showTelegramProfilePhoto: false,
    displayTemplate: "Customer #{customer_number}"
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
    allowFileDownload: false
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
    developerTools: false
  },
  watermark: {
    enabled: true,
    template: "{agent_code} \u2022 {agent_name} \u2022 {device_id} \u2022 {timestamp}",
    opacity: 0.08,
    spacing: 240,
    rotationDegrees: -30,
    showAgentCode: true,
    showAgentName: true,
    showDeviceId: true,
    showTimestamp: true
  },
  audit: {
    conversationOpen: true,
    mediaView: true,
    voicePlay: true,
    messageSend: false,
    search: true
  }
};
var ACCESS_TOKEN_STORAGE_KEY = "mx_access_token";
var PolicyClient = class {
  constructor(baseUrl) {
    this.baseUrl = baseUrl;
    __publicField(this, "policy", LOCKED_DOWN);
    __publicField(this, "agent", null);
    __publicField(this, "policyVersion", null);
    /** True once a real policy has been fetched; false means we are locked down. */
    __publicField(this, "loaded", false);
  }
  token() {
    try {
      const peg = window.mxMatrixClientPeg;
      const tok = peg?.get?.()?.getAccessToken?.();
      if (tok) return tok;
    } catch {
    }
    try {
      return window.localStorage.getItem(ACCESS_TOKEN_STORAGE_KEY);
    } catch {
      return null;
    }
  }
  /** Device ID for the watermark, straight from the live client. */
  deviceIdFromClient() {
    try {
      const peg = window.mxMatrixClientPeg;
      return peg?.get?.()?.getDeviceId?.() ?? null;
    } catch {
      return null;
    }
  }
  async refresh() {
    const token = this.token();
    if (!token) {
      console.warn("[company-policy] no access token; staying locked down");
      this.policy = LOCKED_DOWN;
      this.loaded = false;
      return;
    }
    try {
      const res = await fetch(`${this.baseUrl}/api/client/policy`, {
        headers: { Authorization: `Bearer ${token}` }
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const body = await res.json();
      this.policy = body.policy;
      this.agent = body.agent;
      this.policyVersion = body.policyVersion ?? null;
      this.loaded = true;
      console.info(
        `[company-policy] applied v${this.policyVersion} for ${this.agent?.agentCode}`
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
  audit(event) {
    const token = this.token();
    if (!token) return;
    void fetch(`${this.baseUrl}/api/client/audit`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`
      },
      body: JSON.stringify({ ...event, policyVersion: this.policyVersion }),
      keepalive: true
    }).catch(() => {
    });
  }
};

// src/watermark.ts
var OVERLAY_ID = "company-watermark-overlay";
function substitute(template, agent, wm) {
  const now = /* @__PURE__ */ new Date();
  const stamp = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(
    now.getDate()
  ).padStart(2, "0")} ${String(now.getHours()).padStart(2, "0")}:${String(now.getMinutes()).padStart(2, "0")}`;
  const parts = {
    "{agent_code}": wm.showAgentCode ? agent?.agentCode ?? "UNKNOWN" : "",
    "{agent_name}": wm.showAgentName ? agent?.displayName ?? agent?.mxid ?? "" : "",
    "{device_id}": wm.showDeviceId ? agent?.deviceId ?? "" : "",
    "{timestamp}": wm.showTimestamp ? stamp : ""
  };
  let out = template;
  for (const [k, v] of Object.entries(parts)) out = out.split(k).join(v);
  return out.replace(/\s*•\s*(?=•)/g, "").replace(/^\s*•\s*|\s*•\s*$/g, "").replace(/\s{2,}/g, " ").trim();
}
function tile(text, wm) {
  const w = wm.spacing;
  const h = Math.round(wm.spacing * 0.55);
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}">
  <text x="50%" y="50%" text-anchor="middle" dominant-baseline="middle"
        transform="rotate(${wm.rotationDegrees} ${w / 2} ${h / 2})"
        font-family="system-ui, -apple-system, sans-serif" font-size="13"
        fill="currentColor">${text.replace(
    /[<>&"]/g,
    (c) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", '"': "&quot;" })[c]
  )}</text>
</svg>`;
  return `url("data:image/svg+xml;utf8,${encodeURIComponent(svg)}")`;
}
var Watermark = class {
  constructor() {
    __publicField(this, "el");
    __publicField(this, "timer");
  }
  apply(policy, agent) {
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
        userSelect: "none"
      });
      this.el.setAttribute("aria-hidden", "true");
      document.body.appendChild(this.el);
    }
    this.el.style.backgroundImage = tile(text, wm);
    this.el.style.opacity = String(wm.opacity);
    this.el.style.color = "var(--cpd-color-text-primary, #000)";
    if (this.timer) window.clearInterval(this.timer);
    this.timer = window.setInterval(() => this.apply(policy, agent), 6e4);
  }
  remove() {
    if (this.timer) window.clearInterval(this.timer);
    this.timer = void 0;
    this.el?.remove();
    this.el = void 0;
  }
};

// src/index.ts
var CONFIG_KEY = "company_policy";
var UIComponent = {
  InviteUsers: "UIComponent.sendInvites",
  CreateRooms: "UIComponent.roomCreation",
  CreateSpaces: "UIComponent.spaceCreation",
  ExploreRooms: "UIComponent.exploreRooms",
  AddIntegrations: "UIComponent.addIntegrations",
  FilterContainer: "UIComponent.filterContainer",
  RoomOptionsMenu: "UIComponent.roomOptionsMenu"
};
var CompanyPolicyModule = class {
  constructor(api) {
    this.api = api;
    __publicField(this, "client");
    __publicField(this, "watermark", new Watermark());
    __publicField(this, "clipboard");
  }
  async load() {
    const raw = this.api.config.get(CONFIG_KEY);
    if (!raw?.api_url) {
      console.error(
        "[company-policy] no api_url configured \u2014 applying locked-down policy"
      );
      this.applyLockedDown();
      return;
    }
    this.client = new PolicyClient(raw.api_url.replace(/\/$/, ""));
    this.clipboard = new ClipboardGuard(this.client);
    this.registerFeatureGates();
    this.registerMediaPolicy();
    this.watermark.apply(LOCKED_DOWN, null);
    this.clipboard.apply(LOCKED_DOWN);
    this.api.profile?.watch((p) => {
      if (p?.userId) void this.refresh();
    });
    if (this.api.profile?.value?.userId) void this.refresh();
    const every = raw.refresh_seconds ?? 300;
    if (every > 0) {
      const t = window.setInterval(() => void this.refresh(), every * 1e3);
      t.unref?.();
    }
  }
  applyLockedDown() {
    this.client ?? (this.client = new PolicyClient(""));
    this.client.policy = LOCKED_DOWN;
    this.clipboard ?? (this.clipboard = new ClipboardGuard(this.client));
    this.watermark.apply(LOCKED_DOWN, null);
    this.clipboard.apply(LOCKED_DOWN);
  }
  async refresh() {
    await this.client.refresh();
    const p = this.client.policy;
    const agent = this.client.agent ? { ...this.client.agent, deviceId: this.client.agent.deviceId ?? this.client.deviceIdFromClient() } : null;
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
  registerFeatureGates() {
    this.api.customisations.registerShouldShowComponent((component) => {
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
          return f.filterOwnRooms;
        case UIComponent.AddIntegrations:
          return false;
        default:
          return void 0;
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
  registerMediaPolicy() {
    const cc = this.api.customComponents;
    if (typeof cc?.registerMessageRenderer !== "function") {
      console.warn(
        "[company-policy] customComponents.registerMessageRenderer unavailable; media download policy NOT enforced client-side"
      );
      return;
    }
    const gate = async (mxEvent) => {
      const m = this.client?.policy?.media ?? LOCKED_DOWN.media;
      const type = msgtypeOf(mxEvent);
      const allowed = type === "m.image" ? m.allowImageDownload : type === "m.video" ? m.allowVideoDownload : type === "m.audio" ? m.allowAudioDownload : m.allowFileDownload;
      this.client?.audit({
        eventType: allowed ? "FILE_DOWNLOAD" : "FILE_DOWNLOAD_BLOCKED",
        targetType: type ?? "file",
        result: allowed ? "ALLOWED" : "BLOCKED"
      });
      return allowed;
    };
    cc.registerMessageRenderer(
      (ev) => {
        const t = msgtypeOf(ev);
        return t === "m.image" || t === "m.video" || t === "m.audio" || t === "m.file";
      },
      (_props, original) => original?.(),
      { allowDownloadingMedia: gate }
    );
  }
};
__publicField(CompanyPolicyModule, "moduleApiVersion", "^1.0.0");
function msgtypeOf(ev) {
  const e = ev;
  try {
    return e?.getContent?.()?.msgtype;
  } catch {
    return void 0;
  }
}
var src_default = CompanyPolicyModule;
export {
  CompanyPolicyModule,
  src_default as default
};
