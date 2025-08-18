# Unity MCP ✨

[![MCP Enabled](https://badge.mcpx.dev?status=on "MCP Enabled")](https://modelcontextprotocol.io/introduction)
[![Unity](https://img.shields.io/badge/Unity-000000?style=flat&logo=unity&logoColor=white "Unity")](https://unity.com/releases/editor/archive)
[![Node](https://img.shields.io/badge/Node.js-18%2B-339933?style=flat&logo=node.js&logoColor=white "Node.js 18+")](https://nodejs.org)
[![License: MIT](https://img.shields.io/badge/License-MIT-red.svg "MIT License")](https://opensource.org/licenses/MIT)

Create your Unity apps with LLMs!

Unity MCP is an end-to-end toolchain that lets AI assistants (e.g., Claude, Cursor, Windsurf, VS Code) interact with the Unity Editor through the Model Context Protocol (MCP). Give your LLM tools to manage assets, control scenes, edit scripts, and automate workflows directly inside the Unity Editor.

---

## 💬 What is this repository?

This repo contains:

- A Unity Editor package that runs a local HTTP bridge inside the Editor
- A TypeScript-based MCP Server that exposes Unity operations as MCP tools (stdio)
- A TypeScript sample MCP Client for quick smoke testing

```
[LLM / MCP Client] ⇄ [MCP Server (Node/TypeScript)] ⇄ [Unity Bridge (Unity Editor)]
```

---

## Key Features 🚀

- 🗣️ **Natural Language Control** — Ask your LLM to perform Unity tasks
- 🛠️ **Powerful Tools** — Assets, scenes, game objects, components, editor utilities, packages, play mode, and more
- 🤖 **Automation** — Script repetitive or multi-step Editor tasks
- 🎨 **Visual Scripting Integration** — Create Unity Visual Scripting graphs from MCP operations with pre-built templates
- 🔍 **Automatic Console Verification** — Every tool operation automatically checks Unity console for errors/warnings
- ✅ **Enhanced Error Handling** — Immediate feedback with console context when operations fail
- 🎮 **Smart Play Mode Control** — Prevents play mode when compilation errors exist
- 🧩 **Extensible** — Add new Unity endpoints and MCP tools as your workflow grows

<details open>
<summary><strong>Available Tools</strong></summary>

Tools are exposed with underscore names only. Selected highlights:

- unity_console — Read or clear Unity console
- unity_play — Start/stop/pause/resume Play Mode
- unity_packages — UPM list/install/remove
- unity_assets — AssetDatabase list/find/refresh
- unity_selection — Get/set selection
- unity_gameObject — Create/get/set/delete hierarchy items
- unity_component — Add/update/get/destroy components
- unity_editor — State, info, notify, buildTarget, prefs, invoke
- unity_scene — open/save/saveAs/getLoaded/create/createClean/unload/clear
- unity_prefab — apply/revert prefab instances
- unity_bake — Start lighting bake
- unity_profiler — Memory snapshot
- unity_import — Common texture importer setup
- unity_menu — Execute Editor menu items
- unity_asset — Instantiate assets into the scene
- unity_tests — Run EditMode/PlayMode tests
- unity_rendering — Create light/camera/material, set properties
- unity_gameplay — Rigidbody/Collider helpers, tag/layer
- unity_code — Write files, create scripts, attach scripts, compile
- **unity_visualscripting** — Create visual scripts, add nodes, connect workflows
- **unity_visualscripting_templates** — Browse, search, and apply workflow templates

</details>

---

## How It Works 🤔

- Unity Bridge — Editor-only package hosting a local HTTP API and SSE logs (127.0.0.1:58888)
- MCP Server — Node/TypeScript process that translates MCP tool calls to Unity Bridge endpoints
- MCP Client — Your LLM IDE or agent that speaks MCP over stdio

---

## Installation ⚙️

> Note: Unity 2022.3+ and Node.js 18+ are required.

### 1) Install Unity Bridge Package

- In Unity, open Package Manager → `+` → Add package from disk...
- Select `PathToFile/UnityBridge/Packages/com.example.mcp.unitybridge/package.json`
- Let Unity load, then enter Play Mode once (or wait for scripts to finish compiling)

When the bridge is running you should see in the Console:

```
UnityMcpBridge running at http://127.0.0.1:58888/
```

### 2) Install MCP Server dependencies

```
cd MCP/server
npm install
```

Optional (sample client):

```
cd MCP/client
npm install
```

### 3) Build the MCP Server

```
cd MCP/server
npm run build
```

You can also run in dev with TypeScript directly:

```
cd MCP/server
npm run dev
```

---

## Configure Your MCP Client (Cursor, VS Code, Claude Code, etc.)

Add a server entry to your MCP client configuration pointing to the built server. Use underscore tool names only.

Example configuration (JSON):

```
{
  "unity-mcp": {
    "command": "node",
    "args": [
      "PathToFile/MCP/server/dist/index.js"
    ],
    "env": {
      "UNITY_BRIDGE_URL": "http://127.0.0.1:58888"
    }
  }
}
```

### Console Verification Configuration

The server includes automatic console verification. Configure with environment variables:

```json
{
  "unity-mcp": {
    "command": "node",
    "args": ["PathToFile/MCP/server/dist/index.js"],
    "env": {
      "UNITY_BRIDGE_URL": "http://127.0.0.1:58888",
      "UNITY_CONSOLE_VERIFICATION": "true",
      "UNITY_CONSOLE_CHECK_DELAY_MS": "500"
    }
  }
}
```

**Environment Variables:**
- `UNITY_BRIDGE_TOKEN` — Security token (set same value in Unity and server)
- `UNITY_CONSOLE_VERIFICATION` — Enable automatic console checking (default: true)
- `UNITY_CONSOLE_CHECK_DELAY_MS` — Delay before checking console (default: 500ms)
- `UNITY_COMPILE_TIMEOUT_MS` — Script compilation timeout (default: 120000ms)

**Notes:**
- The server communicates over stdio; your client should launch it as a stdio tool
- Console verification provides immediate feedback on operation success/failure
- Every tool operation automatically checks Unity console for errors and warnings

---

## Usage ▶️

1. Open your Unity project with the bridge package installed
2. Start your MCP Client; it should launch the Node server via stdio
3. Use tools by name (e.g., `unity_gameObject` with action `create`)

Sample smoke test (optional):

```
cd MCP/client
# Use tsx for both client and server
set MCP_USE_TSX=1   # Windows (PowerShell: $env:MCP_USE_TSX="1")
npm run dev
```

You should see:
- Tool discovery
- Editor state/info/notify
- Console read/clear
- Create/update/delete a GameObject, component operations
- Play/pause/resume/stop
- Scene save/saveAs
- Package list

---

## Visual Scripting Integration 🎨

Unity MCP Bridge now includes powerful Visual Scripting integration that allows you to create Unity Visual Scripting graphs from MCP operations and natural language commands.

### Key Features

- **Template System**: Pre-built workflow templates for common game development patterns
- **MCP to Visual Script Conversion**: Transform MCP operations into visual script nodes
- **Node-Based Workflows**: Design complex workflows using visual nodes
- **Automated Connections**: Intelligent node connection and flow management

### Quick Examples

```typescript
// Apply a player setup template
await client.callTool("unity_visualscripting_templates", {
  action: "apply",
  templateName: "create_player_setup",
  gameObjectPath: "Player"
});

// Generate visual script from MCP operations
await client.callTool("unity_visualscripting", {
  action: "generateFromMcp",
  gameObjectPath: "GameManager",
  operations: [
    { tool: "unity_console", action: "clear", description: "Clear console", order: 1 },
    { tool: "unity_scene", action: "save", description: "Save scene", order: 2 }
  ],
  autoConnect: true
});
```

### Available Templates

- **Player Management**: Complete player setup with components
- **Scene Management**: Scene transitions and optimization
- **Asset Management**: Asset optimization and validation workflows
- **Testing & QA**: Automated testing pipelines
- **Build & Deploy**: Complete build and deployment processes

For detailed documentation, see [Visual Scripting Integration Guide](docs/VisualScriptingIntegration.md).

---

## Security 🔐

- Bridge binds to 127.0.0.1 and supports optional `X-Unity-Bridge-Token`
- Set `UNITY_BRIDGE_TOKEN` in both Unity and the MCP server environment for authentication

---

## Troubleshooting ❓

- ECONNREFUSED/timeout — Ensure Unity Editor is open, package installed, and Console shows the bridge is running
- 401 Unauthorized — Set `UNITY_BRIDGE_TOKEN` in both server and Unity (EditorPrefs key `MCP_UnityBridge_Token` also supported)
- Port in use — Another service is using 58888; close it or adjust environment
- Scene/asset paths — Use project-relative `Assets/...` paths
- Compiling domain reload — The bridge restarts its listener on reload; retry after compile completes

---

## For Developers 🛠️

- Server: TypeScript (ESM) with `@modelcontextprotocol/sdk`, axios, eventsource
- Client: TypeScript sample that exercises most tools and prints Unity console deltas
- Unity Bridge: C# Editor-only package (HttpListener + SSE + main-thread queue)

Build/test commands:

```
# Server
cd MCP/server
npm run dev      # tsx
npm run build    # tsc
node dist/index.js

# Client (optional)
cd MCP/client
npm run dev      # tsx
```

---

