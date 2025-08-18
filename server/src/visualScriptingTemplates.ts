// Visual Scripting Templates for Unity MCP Bridge
// Pre-built workflow templates for common game development patterns

export interface VisualScriptTemplate {
  name: string;
  description: string;
  category: string;
  mcpOperations: McpTemplateOperation[];
  autoConnect: boolean;
  tags: string[];
}

export interface McpTemplateOperation {
  tool: string;
  action: string;
  parameters: Record<string, unknown>;
  description: string;
  order: number;
  nodeType?: "event" | "action" | "condition" | "variable" | "group" | "comment";
  position?: { x: number; y: number; z: number };
  groupName?: string;
  comment?: string;
  color?: string;
  variable?: { name: string; type: string; initialValue?: unknown };
  ports?: { from?: string; to?: string };
}

// Predefined Visual Scripting Templates
export const VISUAL_SCRIPT_TEMPLATES: Record<string, VisualScriptTemplate> = {
  // Basic Game Object Management
  "create_player_setup": {
    name: "Player Setup Workflow",
    description: "Creates a player GameObject with essential components and configuration",
    category: "Player Management",
    autoConnect: true,
    tags: ["player", "setup", "components"],
    mcpOperations: [
      {
        tool: "unity_gameObject",
        action: "create",
        parameters: { name: "Player", position: { x: 0, y: 1, z: 0 } },
        description: "Create Player GameObject",
        order: 1,
        nodeType: "action",
        position: { x: 0, y: 0, z: 0 }
      },
      {
        tool: "unity_component",
        action: "add",
        parameters: {
          gameObjectPath: "Player",
          componentType: "CharacterController",
          properties: { height: 2, radius: 0.5 }
        },
        description: "Add Character Controller",
        order: 2,
        nodeType: "action",
        position: { x: 200, y: 0, z: 0 }
      },
      {
        tool: "unity_component",
        action: "add",
        parameters: {
          gameObjectPath: "Player",
          componentType: "Rigidbody",
          properties: { mass: 1, useGravity: true }
        },
        description: "Add Rigidbody",
        order: 3,
        nodeType: "action",
        position: { x: 400, y: 0, z: 0 }
      },
      {
        tool: "unity_rendering",
        action: "createMaterial",
        parameters: {
          materialName: "PlayerMaterial",
          color: { r: 0.2, g: 0.6, b: 1.0, a: 1.0 }
        },
        description: "Create Player Material",
        order: 4,
        nodeType: "action",
        position: { x: 600, y: 0, z: 0 }
      }
    ]
  },

  // Scene Management
  "scene_transition": {
    name: "Scene Transition Workflow",
    description: "Handles scene loading and transition with proper cleanup",
    category: "Scene Management",
    autoConnect: true,
    tags: ["scene", "transition", "loading"],
    mcpOperations: [
      {
        tool: "unity_console",
        action: "clear",
        parameters: {},
        description: "Clear Console",
        order: 1,
        nodeType: "action",
        position: { x: 0, y: 0, z: 0 }
      },
      {
        tool: "unity_scene",
        action: "save",
        parameters: {},
        description: "Save Current Scene",
        order: 2,
        nodeType: "action",
        position: { x: 200, y: 0, z: 0 }
      },
      {
        tool: "unity_scene",
        action: "open",
        parameters: { scenePath: "Assets/Scenes/NewScene.unity" },
        description: "Load New Scene",
        order: 3,
        nodeType: "action",
        position: { x: 400, y: 0, z: 0 }
      },
      {
        tool: "unity_bake",
        action: "lightmaps",
        parameters: { quality: "medium" },
        description: "Bake Lighting",
        order: 4,
        nodeType: "action",
        position: { x: 600, y: 0, z: 0 }
      }
    ]
  },

  // Asset Management
  "asset_optimization": {
    name: "Asset Optimization Workflow",
    description: "Optimizes assets for better performance",
    category: "Asset Management",
    autoConnect: true,
    tags: ["assets", "optimization", "performance"],
    mcpOperations: [
      {
        tool: "unity_assets",
        action: "refresh",
        parameters: {},
        description: "Refresh Asset Database",
        order: 1,
        nodeType: "action",
        position: { x: 0, y: 0, z: 0 }
      },
      {
        tool: "unity_import",
        action: "setTextureSettings",
        parameters: {
          assetPath: "Assets/Textures/",
          maxSize: 1024,
          compression: "high"
        },
        description: "Optimize Textures",
        order: 2,
        nodeType: "action",
        position: { x: 200, y: 0, z: 0 }
      },
      {
        tool: "unity_profiler",
        action: "memorySnapshot",
        parameters: {},
        description: "Take Memory Snapshot",
        order: 3,
        nodeType: "action",
        position: { x: 400, y: 0, z: 0 }
      }
    ]
  },

  // Testing Workflow
  "automated_testing": {
    name: "Automated Testing Workflow",
    description: "Runs comprehensive tests and generates reports",
    category: "Testing",
    autoConnect: true,
    tags: ["testing", "automation", "quality"],
    mcpOperations: [
      {
        tool: "unity_tests",
        action: "run",
        parameters: { category: "unit", generateReport: true },
        description: "Run Unit Tests",
        order: 1,
        nodeType: "action",
        position: { x: 0, y: 0, z: 0 }
      },
      {
        tool: "unity_tests",
        action: "run",
        parameters: { category: "integration", generateReport: true },
        description: "Run Integration Tests",
        order: 2,
        nodeType: "action",
        position: { x: 200, y: 0, z: 0 }
      },
      {
        tool: "unity_console",
        action: "read",
        parameters: {},
        description: "Check Test Results",
        order: 3,
        nodeType: "action",
        position: { x: 400, y: 0, z: 0 }
      }
    ]
  },

  // Build Pipeline
  "build_pipeline": {
    name: "Build Pipeline Workflow",
    description: "Complete build process with validation and deployment",
    category: "Build & Deploy",
    autoConnect: true,
    tags: ["build", "deploy", "pipeline"],
    mcpOperations: [
      {
        tool: "unity_code",
        action: "compile",
        parameters: {},
        description: "Compile Scripts",
        order: 1,
        nodeType: "action",
        position: { x: 0, y: 0, z: 0 }
      },
      {
        tool: "unity_tests",
        action: "run",
        parameters: { category: "all" },
        description: "Run All Tests",
        order: 2,
        nodeType: "action",
        position: { x: 200, y: 0, z: 0 }
      },
      {
        tool: "unity_bake",
        action: "lightmaps",
        parameters: { quality: "high" },
        description: "Bake Final Lighting",
        order: 3,
        nodeType: "action",
        position: { x: 400, y: 0, z: 0 }
      },
      {
        tool: "unity_editor",
        action: "build",
        parameters: { platform: "StandaloneWindows64" },
        description: "Build Application",
        order: 4,
        nodeType: "action"
      }
    ]
  },
  "damage_on_trigger": {
    name: "Damage On Trigger",
    description: "Apply damage when the player enters a trigger volume",
    category: "Gameplay",
    autoConnect: true,
    tags: ["trigger", "damage", "gameplay"],
    mcpOperations: [
      {
        tool: "unity_gameObject",
        action: "create",
        parameters: { name: "DamageZone" },
        description: "Create trigger zone",
        order: 1,
        nodeType: "action",
        position: { x: 0, y: 0, z: 0 },
        groupName: "Setup"
      },
      {
        tool: "unity_component",
        action: "add",
        parameters: { gameObjectPath: "DamageZone", componentType: "BoxCollider", properties: { isTrigger: true } },
        description: "Add BoxCollider (trigger)",
        order: 2,
        nodeType: "action",
        position: { x: 200, y: 0, z: 0 },
        groupName: "Setup"
      },
      {
        tool: "unity_visualscripting",
        action: "addNode",
        parameters: { nodeType: "event", nodeData: "OnTriggerEnter" },
        description: "Event: OnTriggerEnter",
        order: 3,
        nodeType: "event",
        position: { x: 0, y: 150, z: 0 },
        color: "#FFD54F"
      },
      {
        tool: "unity_visualscripting",
        action: "addNode",
        parameters: { nodeType: "action", nodeData: "ApplyDamage", damage: 10 },
        description: "Action: ApplyDamage(10)",
        order: 4,
        nodeType: "action",
        position: { x: 220, y: 150, z: 0 },
        color: "#EF5350",
        ports: { from: "OnEnter", to: "Exec" }
      }
    ]
  }
};

// Helper functions for template management
export function getTemplatesByCategory(category: string): VisualScriptTemplate[] {
  return Object.values(VISUAL_SCRIPT_TEMPLATES).filter(template =>
    template.category === category
  );
}

export function getTemplatesByTag(tag: string): VisualScriptTemplate[] {
  return Object.values(VISUAL_SCRIPT_TEMPLATES).filter(template =>
    template.tags.includes(tag)
  );
}

export function getAllCategories(): string[] {
  const categories = new Set(Object.values(VISUAL_SCRIPT_TEMPLATES).map(t => t.category));
  return Array.from(categories).sort();
}

export function getAllTags(): string[] {
  const tags = new Set(Object.values(VISUAL_SCRIPT_TEMPLATES).flatMap(t => t.tags));
  return Array.from(tags).sort();
}

export function searchTemplates(query: string): VisualScriptTemplate[] {
  const lowerQuery = query.toLowerCase();
  return Object.values(VISUAL_SCRIPT_TEMPLATES).filter(template =>
    template.name.toLowerCase().includes(lowerQuery) ||
    template.description.toLowerCase().includes(lowerQuery) ||
    template.tags.some(tag => tag.toLowerCase().includes(lowerQuery))
  );
}
