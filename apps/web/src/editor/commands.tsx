/*
Copyright 2024 New Vector Ltd.
Copyright 2019-2022 The Matrix.org Foundation C.I.C.

SPDX-License-Identifier: AGPL-3.0-only OR GPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE files in the repository root for full details.
*/

import React from "react";
import { logger } from "matrix-js-sdk/src/logger";
import { type MatrixClient } from "matrix-js-sdk/src/matrix";
import { type RoomMessageEventContent } from "matrix-js-sdk/src/types";

import type EditorModel from "./model";
import { Type } from "./parts";
import { type Command, CommandCategories, getCommand } from "../slash-commands/SlashCommands";
import { UserFriendlyError, _t, _td } from "../languageHandler";
import Modal from "../Modal";
import ErrorDialog from "../components/views/dialogs/ErrorDialog";

export function isSlashCommand(model: EditorModel): boolean {
    const parts = model.parts;
    const firstPart = parts[0];
    if (firstPart) {
        if (firstPart.type === Type.Command && firstPart.text.startsWith("/") && !firstPart.text.startsWith("//")) {
            return true;
        }

        if (
            firstPart.text.startsWith("/") &&
            !firstPart.text.startsWith("//") &&
            (firstPart.type === Type.Plain || firstPart.type === Type.PillCandidate)
        ) {
            return true;
        }
    }
    return false;
}

/**
 * Get the slash command and its arguments from the editor model
 * @param roomId - The room ID to check whether the command is enabled
 * @param model - The editor model
 * @returns A tuple of the command (or undefined if not found), the arguments (or undefined), and the full command text
 */
export function getSlashCommand(roomId: string, model: EditorModel): [Command | undefined, string | undefined, string] {
    const commandText = model.parts.reduce((text, part) => {
        // use mxid to textify user pills in a command and room alias/id for room pills
        if (part.type === Type.UserPill || part.type === Type.RoomPill) {
            return text + part.resourceId;
        }
        return text + part.text;
    }, "");
    const { cmd, args } = getCommand(roomId, commandText);
    return [cmd, args, commandText];
}

export async function runSlashCommand(
    matrixClient: MatrixClient,
    cmd: Command,
    args: string | undefined,
    roomId: string,
    threadId: string | null,
): Promise<[content: RoomMessageEventContent | null, success: boolean]> {
    const result = cmd.run(matrixClient, roomId, threadId, args);
    let messageContent: RoomMessageEventContent | null = null;
    let error: any = result.error;
    if (result.promise) {
        try {
            if (cmd.category === CommandCategories.messages || cmd.category === CommandCategories.effects) {
                messageContent = (await result.promise) ?? null;
            } else {
                await result.promise;
            }
        } catch (err) {
            error = err;
        }
    }
    if (error) {
        logger.error(`Command failure: ${error}`);
        // assume the error is a server error when the command is async
        const isServerError = !!result.promise;
        const title = isServerError ? _td("slash_command|server_error") : _td("slash_command|command_error");

        let errText;
        if (typeof error === "string") {
            errText = error;
        } else if (error instanceof UserFriendlyError) {
            errText = error.translatedMessage;
        } else if (error.message) {
            errText = error.message;
        } else {
            errText = _t("slash_command|server_error_detail");
        }

        Modal.createDialog(ErrorDialog, {
            title: _t(title),
            description: errText,
        });
        return [null, false];
    } else {
        logger.log("Command success.");
        return [messageContent, true];
    }
}

export async function shouldSendAnyway(commandText: string): Promise<boolean> {
    // COMPANY PATCH — see docs/upstream-element-changes.md in the platform repo.
    //
    // Upstream asks the user to confirm before sending an unrecognised /command as
    // an ordinary message. Agents here talk to Telegram bots, whose commands
    // (/start, /help, /balance ...) are not and cannot be Element commands, so that
    // confirmation fired on every single bot interaction.
    //
    // Patched here rather than at the three call sites (SendMessageComposer,
    // EditMessageComposer, wysiwyg) so the behaviour stays consistent and a rebase
    // onto a new Element only has one place to resolve.
    //
    // Known cost, accepted deliberately: a typo of a REAL Element command is no
    // longer caught. `/mee hello` now goes to the customer as text instead of being
    // stopped. Most Element commands are already disabled for agents in this
    // deployment, which is what makes the trade worth it — it would not be on a
    // general-purpose Element.
    //
    // `//command` still works as the upstream escape and is unaffected.
    return true;
}
