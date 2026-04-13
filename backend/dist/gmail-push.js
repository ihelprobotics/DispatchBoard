import { google } from "googleapis";
import { simpleParser } from "mailparser";
const normalizeBase64Url = (value) => {
    let normalized = value.replace(/-/g, "+").replace(/_/g, "/");
    while (normalized.length % 4 !== 0) {
        normalized += "=";
    }
    return normalized;
};
export function createGmailPushService(options) {
    const { clientId, clientSecret, refreshToken, topicName, processMail, verificationToken, watchRenewalIntervalMs = 6 * 60 * 60 * 1000, maxUnreadFetch = 25 } = options;
    const auth = new google.auth.OAuth2(clientId, clientSecret);
    auth.setCredentials({ refresh_token: refreshToken });
    const gmail = google.gmail({ version: "v1", auth });
    let renewalTimer = null;
    const ensureWatch = async () => {
        try {
            const response = await gmail.users.watch({
                userId: "me",
                requestBody: {
                    topicName,
                    labelIds: ["INBOX"]
                }
            });
            const historyId = response.data.historyId;
            console.log("Gmail watch refreshed", { topicName, historyId });
            if (!renewalTimer) {
                renewalTimer = setInterval(() => {
                    ensureWatch().catch((err) => console.error("Gmail watch renewal failed", err));
                }, watchRenewalIntervalMs);
            }
        }
        catch (err) {
            console.error("Failed to register Gmail watch", err);
            throw err;
        }
    };
    const stop = () => {
        if (renewalTimer) {
            clearInterval(renewalTimer);
            renewalTimer = null;
        }
    };
    const fetchUnreadMessages = async () => {
        try {
            const list = await gmail.users.messages.list({
                userId: "me",
                labelIds: ["INBOX"],
                q: "is:unread",
                maxResults: maxUnreadFetch
            });
            const messages = list.data.messages ?? [];
            for (const message of messages) {
                if (!message.id)
                    continue;
                await processMessage(message.id);
            }
        }
        catch (err) {
            console.error("Failed to list Gmail messages", err);
        }
    };
    const processMessage = async (messageId) => {
        try {
            const rawResponse = await gmail.users.messages.get({
                userId: "me",
                id: messageId,
                format: "raw"
            });
            const raw = rawResponse.data.raw;
            if (!raw) {
                return;
            }
            const decoded = Buffer.from(normalizeBase64Url(raw), "base64");
            const markAsSeen = async () => {
                try {
                    await gmail.users.messages.modify({
                        userId: "me",
                        id: messageId,
                        requestBody: {
                            removeLabelIds: ["UNREAD"]
                        }
                    });
                }
                catch (err) {
                    console.warn("Failed to mark Gmail message as seen", err);
                }
            };
            const mail = await simpleParser(decoded);
            await processMail({ mail, messageId, markAsSeen });
        }
        catch (err) {
            console.error("Failed to process Gmail message", err);
        }
    };
    const pushHandler = async (req, res) => {
        const tokenHeader = req.header("X-Goog-Channel-Token");
        const tokenAttr = req.body?.message?.attributes?.token;
        if (verificationToken && verificationToken !== (tokenHeader ?? tokenAttr)) {
            return res.status(403).json({ ok: false, message: "Invalid verification token" });
        }
        if (!req.body?.message) {
            return res.status(400).json({ ok: false, message: "Missing Pub/Sub message" });
        }
        try {
            await fetchUnreadMessages();
            return res.status(202).json({ ok: true });
        }
        catch (err) {
            console.error("Gmail push handler error", err);
            return res.status(500).json({ ok: false, message: "Failed to process Gmail notification" });
        }
    };
    return {
        ensureWatch,
        stop,
        pushHandler,
        pollUnread: fetchUnreadMessages
    };
}
