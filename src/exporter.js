"use strict";

const { WebClient } = require("@slack/web-api");
const fs = require("fs");
const fse = require("fs-extra");
const path = require("path");
const pLimit = require("p-limit");
const axios = require("axios");
const readline = require("readline");

function parseTypesCsv(typesCsv) {
  const set = new Set(
    String(typesCsv || "im,mpim")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean)
  );
  const all = [];
  if (set.has("im")) all.push("im");
  if (set.has("mpim")) all.push("mpim");
  return all;
}

async function listAllConversations(client, types) {
  const results = [];
  let cursor = undefined;
  do {
    const resp = await client.conversations.list({
      exclude_archived: true,
      types: types.join(","),
      limit: 1000,
      cursor,
    });
    if (!resp.ok) throw new Error("Failed to list conversations: " + resp.error);
    for (const c of resp.channels || []) {
      // Only include IM/MPIM that the user is a member of
      if (c.is_im || c.is_mpim) results.push(c);
    }
    cursor = resp.response_metadata && resp.response_metadata.next_cursor;
  } while (cursor);
  return results;
}

async function listAllMessages(client, channel, oldestTs) {
  const messages = [];
  let cursor = undefined;
  do {
    const resp = await client.conversations.history({
      channel: channel.id,
      limit: 1000,
      cursor,
      oldest: oldestTs,
    });
    if (!resp.ok) throw new Error("Failed to fetch history: " + resp.error);
    for (const m of resp.messages || []) messages.push(m);
    cursor = resp.response_metadata && resp.response_metadata.next_cursor;
  } while (cursor);
  messages.sort((a, b) => Number(a.ts) - Number(b.ts));
  return messages;
}

function channelExportPath(baseDir, channel, userIdToName) {
  const label = computeChannelLabel(channel, userIdToName);
  return path.join(baseDir, "conversations", `${label}__${channel.id}.json`);
}

function computeChannelLabel(channel, userIdToName) {
  if (channel && typeof channel.name === "string" && channel.name.length > 0) {
    return channel.name;
  }
  if (channel && channel.user) {
    const friendly = userIdToName && userIdToName[channel.user];
    return sanitizeForPath(friendly || channel.user);
  }
  return sanitizeForPath(channel && channel.id ? channel.id : "unknown");
}

function minimalMessage(m, includeFiles) {
  const base = {
    ts: m.ts,
    user: m.user || m.bot_id || m.username || null,
    text: m.text || "",
    subtype: m.subtype || null,
    thread_ts: m.thread_ts || null,
    reply_count: m.reply_count || 0,
    reactions: m.reactions || [],
    files: [],
  };
  if (includeFiles && Array.isArray(m.files)) {
    base.files = m.files.map((f) => ({
      id: f.id,
      name: f.name,
      filetype: f.filetype,
      mimetype: f.mimetype,
      size: f.size,
      url_private: f.url_private,
      permalink: f.permalink,
    }));
  }
  return base;
}

async function runExport({ token, outDir, typesCsv, since, includeFiles, downloadFiles, downloadAvatars, downloadEmojis, concurrency }) {
  const client = new WebClient(token);
  await fse.ensureDir(outDir);
  await fse.ensureDir(path.join(outDir, "conversations"));

  const types = parseTypesCsv(typesCsv);
  const oldestTs = since ? computeOldestTsSeconds(since) : undefined;

  const me = await client.auth.test();
  if (!me.ok) throw new Error("auth.test failed: " + me.error);
  const whoamiPath = path.join(outDir, "whoami.json");
  await fse.writeJson(whoamiPath, me, { spaces: 2 });

  // If downloading files, verify we likely have files:read; otherwise, disable downloads
  let canDownloadFiles = false;
  if (downloadFiles) {
    try {
      const probe = await client.files.list({ limit: 1 });
      canDownloadFiles = Boolean(probe && probe.ok);
      if (!canDownloadFiles) {
        console.warn(
          "files:read scope appears to be missing; skipping file downloads to avoid corrupt files"
        );
      }
    } catch (err) {
      console.warn(
        "Unable to verify files:read; skipping file downloads. Error:",
        (err && err.data && err.data.error) || err.message || String(err)
      );
      canDownloadFiles = false;
    }
  }

  if (downloadFiles && !canDownloadFiles) {
    if (process.stdin.isTTY && process.stdout.isTTY) {
      const proceed = await askUserToContinueWithoutFiles();
      if (!proceed) {
        console.log("Export cancelled due to missing files:read scope");
        return;
      }
      console.warn("Continuing export without file downloads.");
    } else {
      console.warn("Non-interactive session: continuing without file downloads.");
    }
  }

  const channels = await listAllConversations(client, types);
  const userIdToName = await buildUserIdToNameMapForIms(client, channels);
  const limit = pLimit(concurrency || 4);

  const summary = [];
  let skippedEmptyCount = 0;
  const authorIds = new Set();
  // If downloading files, also include file metadata in JSON automatically
  const shouldIncludeFiles = Boolean(includeFiles || downloadFiles);

  const totalChannels = channels.length;
  let completedCount = 0;
  console.log(`Starting export of ${totalChannels} conversations...`);

  await Promise.all(
    channels.map((ch) =>
      limit(async () => {
        let msgs = await listAllMessages(client, ch, oldestTs);
        if (oldestTs) {
          const oldestNum = Number(oldestTs);
          msgs = msgs.filter((m) => Number(m.ts) >= oldestNum);
        }
        if (msgs.length === 0) {
          skippedEmptyCount += 1;
          completedCount += 1;
          if (process.stdout.isTTY) {
            process.stdout.write(`\rProgress: ${completedCount}/${totalChannels} conversations exported`);
          }
          return; // Skip writing empty conversations
        }
        const serialized = msgs.map((m) => minimalMessage(m, shouldIncludeFiles));
        for (const m of msgs) {
          if (m.user) authorIds.add(m.user);
        }
        const fp = channelExportPath(outDir, ch, userIdToName);
        await fse.writeJson(fp, { channel: ch, messages: serialized }, { spaces: 2 });
        if (downloadFiles && canDownloadFiles) {
          await downloadFilesForConversation({ outDir, channel: ch, messages: msgs, token });
        }
        const label = computeChannelLabel(ch, userIdToName);
        summary.push({
          id: ch.id,
          name: label,
          messages: serialized.length,
          is_im: Boolean(ch.is_im),
          user: ch.is_im ? (ch.user || null) : null,
        });
        completedCount += 1;
        if (process.stdout.isTTY) {
          process.stdout.write(`\rProgress: ${completedCount}/${totalChannels} conversations exported`);
        }
      })
    )
  );

  if (process.stdout.isTTY) {
    process.stdout.write('\n');
  }

  await fse.writeJson(path.join(outDir, "summary.json"), { exported_at: new Date().toISOString(), summary }, { spaces: 2 });

  // Copy self-contained browser GUI into the root exports directory (idempotent)
  try {
    const exportsRoot = path.join(outDir, "..");
    await writeViewerGui(exportsRoot);
  } catch (e) {
    console.warn("Failed to write viewer GUI:", e.message || String(e));
  }

  if (downloadAvatars) {
    try {
      await downloadAvatarsForUsers({ client, outDir, userIds: Array.from(authorIds), token });
    } catch (e) {
      console.warn("Avatar download failed:", e.message || String(e));
    }
  }

  if (downloadEmojis) {
    try {
      await downloadCustomEmojis({ client, outDir, token });
    } catch (e) {
      console.warn("Emoji download failed:", e.message || String(e));
    }
  }

  console.log(`Exported ${summary.length} conversations to ${outDir}${skippedEmptyCount ? ` (skipped ${skippedEmptyCount} empty)` : ""}`);
}

module.exports = { runExport };

async function downloadFilesForConversation({ outDir, channel, messages, token }) {
  const files = [];
  for (const m of messages) {
    if (Array.isArray(m.files)) {
      for (const f of m.files) {
        if (f.url_private_download || f.url_private) {
          files.push({
            id: f.id,
            url: f.url_private_download || f.url_private,
            name: f.name || `${f.id}.${f.filetype || "bin"}`,
          });
        }
      }
    }
  }
  if (files.length === 0) return;
  const convDirSafe = (channel.name || channel.user || channel.id).replace(/[^a-zA-Z0-9-_\.]/g, "_");
  const destDir = path.join(outDir, "files", `${convDirSafe}__${channel.id}`);
  await fse.ensureDir(destDir);
  const limit = pLimit(3);
  await Promise.all(
    files.map((f) =>
      limit(async () => {
        const dest = path.join(destDir, `${f.id}_${sanitizeFilename(f.name)}`);
        if (await fse.pathExists(dest)) return;
        try {
          const res = await axios.get(f.url, {
            responseType: "arraybuffer",
            headers: { Authorization: `Bearer ${token}` },
            validateStatus: (s) => s >= 200 && s < 400,
          });
          const contentType = (res.headers && res.headers["content-type"]) || "";
          const contentLengthHeader = res.headers && res.headers["content-length"];
          const contentLength = contentLengthHeader ? Number(contentLengthHeader) : null;
          const looksLikeHtml = typeof contentType === "string" && contentType.includes("text/html");
          if (looksLikeHtml && contentLength != null && contentLength < 200 * 1024 && contentLength < (f.expectedSize || Infinity) * 0.5) {
            console.warn(`Skipping ${f.id} (${f.name}) due to unexpected HTML response (${contentType}, ${contentLength} bytes).`);
            return;
          }
          await fse.writeFile(dest, res.data);
        } catch (err) {
          const status = err && err.response && err.response.status;
          if (status === 401 || status === 403) {
            console.warn(`Skipping ${f.id} (${f.name}) due to HTTP ${status} (likely missing files:read)`);
            return;
          }
          console.warn(`Failed to download ${f.id} (${f.name}):`, err.message || String(err));
        }
      })
    )
  );
}

function sanitizeFilename(name) {
  return String(name).replace(/[\/:*?"<>|]/g, "_");
}

function askUserToContinueWithoutFiles() {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    rl.question(
      "The token appears to be missing 'files:read'. Continue export without downloading files? (y/N) ",
      (answer) => {
        rl.close();
        const yes = /^\s*y(es)?\s*$/i.test(String(answer));
        resolve(yes);
      }
    );
  });
}

function computeOldestTsSeconds(since) {
  // Accept only YYYY-MM-DD in local time; convert to epoch seconds at 00:00:00 local.
  const trimmed = String(since).trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(trimmed)) {
    throw new Error(`Invalid --since value: ${since}. Use YYYY-MM-DD`);
  }
  const [year, month, day] = trimmed.split("-").map((n) => Number(n));
  const d = new Date(year, month - 1, day, 0, 0, 0, 0); // local time
  return String(Math.floor(d.getTime() / 1000));
}

function sanitizeForPath(s) {
  return String(s).replace(/[^a-zA-Z0-9-_\.]/g, "_");
}

async function buildUserIdToNameMapForIms(client, channels) {
  // Collect unique user IDs from IMs only; MPIMs already have readable names
  const userIds = new Set();
  for (const ch of channels) {
    if (ch.is_im && ch.user) userIds.add(ch.user);
  }
  const idToName = {};
  if (userIds.size === 0) return idToName;
  // Fetch in batches: users.info doesn't support batching; we can page through users.list instead
  // To reduce API calls, try users.list to map all users quickly
  try {
    let cursor;
    do {
      const resp = await client.users.list({ limit: 200, cursor });
      if (!resp.ok) break;
      for (const u of resp.members || []) {
        if (userIds.has(u.id)) {
          const display = (u.profile && (u.profile.display_name || u.profile.real_name)) || u.name || u.id;
          idToName[u.id] = display;
        }
      }
      cursor = resp.response_metadata && resp.response_metadata.next_cursor;
    } while (cursor);
  } catch (_) {
    // Fall back silently; labels will be user IDs
  }
  return idToName;
}

async function downloadAvatarsForUsers({ client, outDir, userIds, token }) {
  if (!userIds || userIds.length === 0) return;
  const destDir = path.join(outDir, "avatars");
  await fse.ensureDir(destDir);
  const idToUser = {};
  // Build map via users.list to minimize per-user calls
  try {
    let cursor;
    do {
      const resp = await client.users.list({ limit: 200, cursor });
      if (!resp.ok) break;
      for (const u of resp.members || []) {
        if (userIds.includes(u.id)) {
          idToUser[u.id] = u;
        }
      }
      cursor = resp.response_metadata && resp.response_metadata.next_cursor;
    } while (cursor);
  } catch (_) {}
  const limit = pLimit(4);
  const usersOut = [];
  await Promise.all(
    Object.keys(idToUser).map((id) =>
      limit(async () => {
        const u = idToUser[id];
        const profile = u.profile || {};
        const name = (profile.display_name || profile.real_name || u.name || id);
        const url = profile.image_72 || profile.image_48 || profile.image_192 || profile.image_512;
        let filename = null;
        if (url) {
          const extMatch = /\.(png|jpg|jpeg|gif|webp)(?:\?|$)/i.exec(url);
          const ext = extMatch ? extMatch[1].toLowerCase() : 'png';
          filename = `${id}.${ext}`;
          const dest = path.join(destDir, filename);
          if (!(await fse.pathExists(dest))) {
            try {
              const res = await axios.get(url, {
                responseType: 'arraybuffer',
                headers: { Authorization: `Bearer ${token}` },
                validateStatus: (s) => s >= 200 && s < 400,
              });
              const contentType = (res.headers && res.headers['content-type']) || '';
              const looksHtml = typeof contentType === 'string' && contentType.includes('text/html');
              if (looksHtml) throw new Error('unexpected html response for avatar');
              await fse.writeFile(dest, res.data);
            } catch (e) {
              filename = null; // fallback to initials
            }
          }
        }
        usersOut.push({ id, name, avatar: filename });
      })
    )
  );
  await fse.writeJson(path.join(outDir, 'users.json'), { users: usersOut }, { spaces: 2 });
}

async function downloadCustomEmojis({ client, outDir, token }) {
  const resp = await client.emoji.list();
  if (!resp.ok) throw new Error(resp.error || 'emoji.list failed');
  const emojis = resp.emoji || {};
  const destDir = path.join(outDir, 'emojis');
  await fse.ensureDir(destDir);
  const entries = [];
  const limit = pLimit(6);
  await Promise.all(Object.keys(emojis).map((name) => limit(async () => {
    let val = emojis[name];
    if (!val) return;
    if (String(val).startsWith('alias:')) {
      const alias = val.slice('alias:'.length);
      entries.push({ name, type: 'alias', alias });
      return;
    }
    // It's a URL to an image
    const url = val;
    const extMatch = /\.(png|jpg|jpeg|gif|webp)(?:\?|$)/i.exec(url);
    const ext = extMatch ? extMatch[1].toLowerCase() : 'png';
    const filename = `${name}.${ext}`;
    const dest = path.join(destDir, filename);
    try {
      if (!(await fse.pathExists(dest))) {
        const res = await axios.get(url, {
          responseType: 'arraybuffer',
          headers: { Authorization: `Bearer ${token}` },
          validateStatus: (s) => s >= 200 && s < 400,
        });
        const ct = (res.headers && res.headers['content-type']) || '';
        if (ct.includes('text/html')) throw new Error('unexpected html response for emoji');
        await fse.writeFile(dest, res.data);
      }
      entries.push({ name, type: 'image', file: filename });
    } catch (e) {
      entries.push({ name, type: 'error' });
    }
  })));
  await fse.writeJson(path.join(outDir, 'emojis.json'), { emojis: entries }, { spaces: 2 });
}

async function writeViewerGui(exportsRoot) {
  const staticSrc = path.join(__dirname, "gui", "static");

  // Copy to gui/static/ structure in exports root
  const guiStaticDir = path.join(exportsRoot, "gui", "static");
  await fse.ensureDir(guiStaticDir);
  for (const name of ["index.html", "styles.css", "main.js", "group-icon.svg"]) {
    const src = path.join(staticSrc, name);
    const dst = path.join(guiStaticDir, name);
    try {
      await fse.copy(src, dst);
    } catch (_) {}
  }

  // Copy server.js to gui/ directory
  const serverSrc = path.join(__dirname, "gui", "server.js");
  const guiServerPath = path.join(exportsRoot, "gui", "server.js");

  await fse.ensureDir(path.join(exportsRoot, "gui"));
  await fse.copy(serverSrc, guiServerPath);
  // Write a minimal package.json to start the viewer
  const pkgPath = path.join(exportsRoot, "package.json");
  if (!(await fse.pathExists(pkgPath))) {
    const pkg = {
      name: "slack-export-viewer",
      private: true,
      version: "0.0.0",
      type: "commonjs",
      scripts: { gui: "node gui/server.js" },
      dependencies: { express: "^4.19.2", "fs-extra": "^11.2.0" },
    };
    await fse.writeJson(pkgPath, pkg, { spaces: 2 });
  }
}


