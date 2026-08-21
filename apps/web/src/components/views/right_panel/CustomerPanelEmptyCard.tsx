/*
COMPANY PATCH — see docs/upstream-element-changes.md in the platform repo.

The customer panel's empty state, shown when a conversation has no customer page
provisioned.

WHY THIS IS TEXT AND NOT A PAGE

Element sandboxes widget iframes with `allow-same-origin` and `allow-scripts`
together, and its own source says why that is tolerable: same-origin content "will
get the same access as if you clicked a link to it" (AppTile.tsx). A placeholder page
served from this deployment's own origin would therefore be able to read the agent's
Matrix access token out of localStorage — an empty-state panel with the run of the
session. A configured panel points at the host company's own domain and is
cross-origin by construction; the unconfigured one must not become the exception.

So the empty state is rendered by Element itself. No iframe, no second origin, no
placeholder service to host, and nothing to provision before a conversation can show
its panel.

Styling is inline rather than a new stylesheet: this is one centred block, and adding
a CSS file to the bundle for it would be more upstream surface than the component
itself.

SPDX-License-Identifier: AGPL-3.0-only OR GPL-3.0-only OR LicenseRef-Element-Commercial
*/

import React, { type JSX } from "react";
import { Text } from "@vector-im/compound-web";
import InfoIcon from "@vector-im/compound-design-tokens/assets/web/icons/info";

import BaseCard from "./BaseCard";
import { _t } from "../../../languageHandler";

interface Props {
    onClose(): void;
}

export default function CustomerPanelEmptyCard({ onClose }: Props): JSX.Element {
    return (
        <BaseCard header={_t("company|customer_panel|title")} onClose={onClose}>
            <div
                style={{
                    display: "flex",
                    flexDirection: "column",
                    alignItems: "center",
                    gap: "var(--cpd-space-3x)",
                    padding: "var(--cpd-space-8x) var(--cpd-space-4x)",
                    textAlign: "center",
                }}
            >
                <InfoIcon width="32px" height="32px" color="var(--cpd-color-icon-secondary)" />
                <Text size="md" weight="semibold">
                    {_t("company|customer_panel|not_configured")}
                </Text>
                <Text size="sm" style={{ color: "var(--cpd-color-text-secondary)" }}>
                    {_t("company|customer_panel|not_configured_hint")}
                </Text>
            </div>
        </BaseCard>
    );
}
