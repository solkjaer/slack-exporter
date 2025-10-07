"use strict";

const express = require("express");
const path = require("path");
const fse = require("fs-extra");

const app = express();
const PORT = Number(process.env.PORT || 5187);

// Determine exports root
// When running via "npm run gui" from exports/, cwd is exports/ and this file is at gui/server.js
let EXPORTS_ROOT = path.resolve(process.cwd());
let WORKSPACES = [];
let IS_MULTI_WORKSPACE = false;

// Check if there's a gui subdirectory in cwd (means we're in exports root)
const guiPath = path.join(process.cwd(), "gui", "server.js");
if (fse.pathExistsSync(guiPath)) {
  // Running from exports/ directory - look for workspace directories
  EXPORTS_ROOT = process.cwd();
  const items = fse.readdirSync(EXPORTS_ROOT).filter(item => {
    if (item === 'gui' || item === 'node_modules' || item === 'package.json' || item === 'package-lock.json') return false;
    const itemPath = path.join(EXPORTS_ROOT, item);
    try {
      return fse.statSync(itemPath).isDirectory() &&
             fse.pathExistsSync(path.join(itemPath, "summary.json"));
    } catch (e) {
      return false;
    }
  });

  if (items.length > 0) {
    WORKSPACES = items.sort();
    IS_MULTI_WORKSPACE = items.length > 1;
  }
} else if (fse.pathExistsSync(path.join(process.cwd(), "summary.json"))) {
  // Running from within a single export directory (legacy)
  EXPORTS_ROOT = process.cwd();
  IS_MULTI_WORKSPACE = false;
} else {
  // Running from project root - check for exports subfolder
  const exportsRoot = path.join(process.cwd(), "exports");
  if (fse.pathExistsSync(exportsRoot)) {
    const teamDirs = fse.readdirSync(exportsRoot).filter(item => {
      if (item === 'gui' || item === 'node_modules' || item === 'package.json' || item === 'package-lock.json') return false;
      const teamPath = path.join(exportsRoot, item);
      try {
        return fse.statSync(teamPath).isDirectory() &&
               fse.pathExistsSync(path.join(teamPath, "summary.json"));
      } catch (e) {
        return false;
      }
    });

    if (teamDirs.length > 0) {
      EXPORTS_ROOT = exportsRoot;
      WORKSPACES = teamDirs.sort();
      IS_MULTI_WORKSPACE = teamDirs.length > 1;
      console.log(`Found workspaces: ${WORKSPACES.join(', ')}`);
    } else {
      EXPORTS_ROOT = exportsRoot;
      IS_MULTI_WORKSPACE = false;
    }
  } else {
    EXPORTS_ROOT = path.join(process.cwd(), "exports");
    IS_MULTI_WORKSPACE = false;
  }
}

function getExportsDir(workspace = null) {
  // If we have workspaces (even just one), use the workspace subdirectory
  if (WORKSPACES.length > 0) {
    if (!workspace) {
      workspace = WORKSPACES[0]; // Default to first workspace
    }
    return path.join(EXPORTS_ROOT, workspace);
  }
  
  // No workspaces found, use root exports directory
  return EXPORTS_ROOT;
}

app.use(express.static(path.join(__dirname, "static")));

app.get("/api/workspaces", async (req, res) => {
  try {
    if (WORKSPACES.length === 0) {
      return res.json({ workspaces: [], multiWorkspace: false });
    }
    
    const workspaceInfo = [];
    for (const workspace of WORKSPACES) {
      const whoamiPath = path.join(EXPORTS_ROOT, workspace, "whoami.json");
      let displayName = workspace;
      try {
        if (await fse.pathExists(whoamiPath)) {
          const whoami = await fse.readJson(whoamiPath);
          if (whoami.team) {
            displayName = whoami.team;
          }
        }
      } catch (e) {
        // Use folder name if whoami.json can't be read
      }
      workspaceInfo.push({ id: workspace, name: displayName });
    }
    
    return res.json({ 
      workspaces: workspaceInfo, 
      multiWorkspace: IS_MULTI_WORKSPACE,
      default: WORKSPACES[0] 
    });
  } catch (e) {
    res.status(500).json({ error: e.message || String(e) });
  }
});

app.get("/api/summary", async (req, res) => {
  try {
    const workspace = req.query.workspace;
    const exportsDir = getExportsDir(workspace);
    const file = path.join(exportsDir, "summary.json");
    if (!(await fse.pathExists(file))) return res.json({ summary: [] });
    const data = await fse.readJson(file);
    const entries = Array.isArray(data.summary) ? data.summary : [];
    // Enrich missing is_im/user by peeking at the conversation file
    for (const s of entries) {
      if (!s || (typeof s.is_im === "boolean" && (!s.is_im || s.user))) continue;
      try {
        // First try conversations subdirectory (new structure)
        const conversationsDir = path.join(exportsDir, "conversations");
        let match = null;
        let conversationPath = null;
        
        if (await fse.pathExists(conversationsDir)) {
          const files = await fse.readdir(conversationsDir);
          match = files.find((f) => f.endsWith(`__${s.id}.json`));
          if (match) {
            conversationPath = path.join(conversationsDir, match);
          }
        }
        
        // Fallback to root directory (old structure)
        if (!match) {
          const files = await fse.readdir(exportsDir);
          match = files.find((f) => f.endsWith(`__${s.id}.json`));
          if (match) {
            conversationPath = path.join(exportsDir, match);
          }
        }
        
        if (conversationPath) {
          const convo = await fse.readJson(conversationPath);
          const ch = convo.channel || {};
          s.is_im = Boolean(ch.is_im);
          s.user = s.is_im ? (ch.user || null) : null;
        }
      } catch (_) {}
    }
    return res.json({ summary: entries });
  } catch (e) {
    res.status(500).json({ error: e.message || String(e) });
  }
});

app.get("/api/users", async (req, res) => {
  try {
    const workspace = req.query.workspace;
    const exportsDir = getExportsDir(workspace);
    const file = path.join(exportsDir, "users.json");
    if (!(await fse.pathExists(file))) return res.json({ users: [] });
    const data = await fse.readJson(file);
    return res.json(data);
  } catch (e) {
    res.status(500).json({ error: e.message || String(e) });
  }
});

app.get("/api/conversation/:id", async (req, res) => {
  try {
    const id = req.params.id;
    const workspace = req.query.workspace;
    const exportsDir = getExportsDir(workspace);
    // First try conversations subdirectory (new structure)
    const conversationsDir = path.join(exportsDir, "conversations");
    if (await fse.pathExists(conversationsDir)) {
      const files = await fse.readdir(conversationsDir);
      const match = files.find((f) => f.endsWith(`__${id}.json`));
      if (match) {
        const data = await fse.readJson(path.join(conversationsDir, match));
        return res.json(data);
      }
    }
    // Fallback to root directory (old structure)
    const files = await fse.readdir(exportsDir);
    const match = files.find((f) => f.endsWith(`__${id}.json`));
    if (!match) return res.status(404).json({ error: "Not found" });
    const data = await fse.readJson(path.join(exportsDir, match));
    return res.json(data);
  } catch (e) {
    res.status(500).json({ error: e.message || String(e) });
  }
});

app.get("/api/files/:conv/*", async (req, res) => {
  // Serve downloaded files when present
  try {
    const conv = req.params.conv;
    const rest = req.params[0];
    const workspace = req.query.workspace;
    const exportsDir = getExportsDir(workspace);
    const filePath = path.join(exportsDir, "files", conv, rest);
    if (!(await fse.pathExists(filePath))) return res.status(404).end();
    return res.sendFile(filePath);
  } catch (e) {
    res.status(500).json({ error: e.message || String(e) });
  }
});

app.get("/api/avatars/:file", async (req, res) => {
  try {
    const file = req.params.file;
    const workspace = req.query.workspace;
    const exportsDir = getExportsDir(workspace);
    const avatarPath = path.join(exportsDir, "avatars", file);
    if (!(await fse.pathExists(avatarPath))) return res.status(404).end();
    return res.sendFile(avatarPath);
  } catch (e) {
    res.status(500).json({ error: e.message || String(e) });
  }
});

app.get("/api/emojis", async (req, res) => {
  try {
    const workspace = req.query.workspace;
    const exportsDir = getExportsDir(workspace);
    const file = path.join(exportsDir, "emojis.json");
    if (!(await fse.pathExists(file))) return res.json({ emojis: [] });
    const data = await fse.readJson(file);
    return res.json(data);
  } catch (e) {
    res.status(500).json({ error: e.message || String(e) });
  }
});

app.get("/api/emoji/:file", async (req, res) => {
  try {
    const file = req.params.file;
    const workspace = req.query.workspace;
    const exportsDir = getExportsDir(workspace);
    const p = path.join(exportsDir, "emojis", file);
    if (!(await fse.pathExists(p))) return res.status(404).end();
    return res.sendFile(p);
  } catch (e) {
    res.status(500).json({ error: e.message || String(e) });
  }
});

app.get("/api/whoami", async (req, res) => {
  try {
    const workspace = req.query.workspace;
    const exportsDir = getExportsDir(workspace);
    const file = path.join(exportsDir, "whoami.json");
    if (!(await fse.pathExists(file))) return res.json({});
    const data = await fse.readJson(file);
    return res.json(data);
  } catch (e) {
    res.status(500).json({ error: e.message || String(e) });
  }
});

app.get("*", (req, res) => {
  res.sendFile(path.join(__dirname, "static", "index.html"));
});

app.listen(PORT, () => {
  if (IS_MULTI_WORKSPACE) {
    console.log(`GUI running on http://localhost:${PORT} (workspaces: ${WORKSPACES.join(', ')})`);
  } else {
    console.log(`GUI running on http://localhost:${PORT} (exports dir: ${EXPORTS_ROOT})`);
  }
});


