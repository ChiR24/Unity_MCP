// Visual Scripting Templates for Unity MCP Bridge
// Pre-built workflow templates for common game development patterns
// Provides reusable visual scripting workflows with MCP operation mappings

/**
 * @fileoverview Visual Scripting Template System
 * @description Pre-defined templates for common Unity game development workflows
 * that can be applied to GameObjects via the MCP visual scripting tools.
 */

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
  },

  // AI and NPC Behaviors
  "npc_patrol_behavior": {
    name: "NPC Patrol Behavior",
    description: "Creates a patrol route with waypoint navigation and basic AI detection",
    category: "AI & NPC",
    autoConnect: true,
    tags: ["ai", "npc", "patrol", "navigation", "behavior"],
    mcpOperations: [
      {
        tool: "unity_gameObject",
        action: "create",
        parameters: { name: "NPC_Patrol", position: { x: 0, y: 1, z: 0 } },
        description: "Create NPC GameObject",
        order: 1,
        nodeType: "action",
        position: { x: 0, y: 0, z: 0 }
      },
      {
        tool: "unity_component",
        action: "add",
        parameters: {
          gameObjectPath: "NPC_Patrol",
          componentType: "NavMeshAgent"
        },
        description: "Add Navigation Agent",
        order: 2,
        nodeType: "action",
        position: { x: 200, y: 0, z: 0 }
      },
      {
        tool: "unity_component",
        action: "add",
        parameters: {
          gameObjectPath: "NPC_Patrol",
          componentType: "SphereCollider",
          properties: { isTrigger: true, radius: 5 }
        },
        description: "Add Detection Zone",
        order: 3,
        nodeType: "action",
        position: { x: 400, y: 0, z: 0 }
      }
    ]
  },

  // UI Interaction Systems
  "ui_button_interaction": {
    name: "UI Button Interaction",
    description: "Complete button interaction system with hover effects and click handlers",
    category: "UI & Interaction",
    autoConnect: true,
    tags: ["ui", "button", "interaction", "hover", "click"],
    mcpOperations: [
      {
        tool: "unity_gameObject",
        action: "create",
        parameters: { name: "InteractiveButton" },
        description: "Create Button GameObject",
        order: 1,
        nodeType: "action",
        position: { x: 0, y: 0, z: 0 }
      },
      {
        tool: "unity_component",
        action: "add",
        parameters: {
          gameObjectPath: "InteractiveButton",
          componentType: "Button"
        },
        description: "Add Button Component",
        order: 2,
        nodeType: "action",
        position: { x: 200, y: 0, z: 0 }
      },
      {
        tool: "unity_component",
        action: "add",
        parameters: {
          gameObjectPath: "InteractiveButton",
          componentType: "Image",
          properties: { color: { r: 0.8, g: 0.8, b: 0.8, a: 1 } }
        },
        description: "Add Background Image",
        order: 3,
        nodeType: "action",
        position: { x: 400, y: 0, z: 0 }
      }
    ]
  },

  // Audio System
  "audio_system": {
    name: "Audio Management System",
    description: "Complete audio system with background music and sound effects",
    category: "Audio & Sound",
    autoConnect: true,
    tags: ["audio", "sound", "music", "effects", "management"],
    mcpOperations: [
      {
        tool: "unity_gameObject",
        action: "create",
        parameters: { name: "AudioManager" },
        description: "Create Audio Manager",
        order: 1,
        nodeType: "action",
        position: { x: 0, y: 0, z: 0 }
      },
      {
        tool: "unity_component",
        action: "add",
        parameters: {
          gameObjectPath: "AudioManager",
          componentType: "AudioSource"
        },
        description: "Add Background Music Source",
        order: 2,
        nodeType: "action",
        position: { x: 200, y: 0, z: 0 }
      },
      {
        tool: "unity_component",
        action: "add",
        parameters: {
          gameObjectPath: "AudioManager",
          componentType: "AudioSource",
          properties: { playOnAwake: false, loop: false }
        },
        description: "Add SFX Source",
        order: 3,
        nodeType: "action",
        position: { x: 400, y: 0, z: 0 }
      }
    ]
  },

  // Particle Effects
  "particle_effect_system": {
    name: "Particle Effect System",
    description: "Configurable particle system with emission controls and color gradients",
    category: "Effects & Visual",
    autoConnect: true,
    tags: ["particles", "effects", "visual", "emission", "color"],
    mcpOperations: [
      {
        tool: "unity_gameObject",
        action: "create",
        parameters: { name: "ParticleSystem" },
        description: "Create Particle System",
        order: 1,
        nodeType: "action",
        position: { x: 0, y: 0, z: 0 }
      },
      {
        tool: "unity_component",
        action: "add",
        parameters: {
          gameObjectPath: "ParticleSystem",
          componentType: "ParticleSystem",
          properties: {
            startLifetime: 2.0,
            startSpeed: 5.0,
            startSize: 0.5,
            startColor: { r: 1, g: 1, b: 0, a: 1 }
          }
        },
        description: "Configure Particle System",
        order: 2,
        nodeType: "action",
        position: { x: 200, y: 0, z: 0 }
      }
    ]
  }
};

// Helper functions for template management

/**
 * Get all templates belonging to a specific category
 * @param category - The category name to filter by
 * @returns Array of templates in the specified category
 */
export function getTemplatesByCategory(category: string): VisualScriptTemplate[] {
  if (!category || typeof category !== 'string') {
    return [];
  }
  return Object.values(VISUAL_SCRIPT_TEMPLATES).filter(template =>
    template.category.toLowerCase() === category.toLowerCase()
  );
}

/**
 * Get templates sorted by relevance score for a search query
 * @param query - Search query string
 * @returns Array of templates sorted by relevance
 */
export function getTemplatesByRelevance(query: string): VisualScriptTemplate[] {
  if (!query || typeof query !== 'string') {
    return Object.values(VISUAL_SCRIPT_TEMPLATES);
  }

  const lowerQuery = query.toLowerCase();
  const templates = Object.values(VISUAL_SCRIPT_TEMPLATES);

  return templates.map(template => {
    let score = 0;

    // Name match gets highest score
    if (template.name.toLowerCase().includes(lowerQuery)) {
      score += 10;
    }

    // Category match
    if (template.category.toLowerCase().includes(lowerQuery)) {
      score += 5;
    }

    // Tag matches
    template.tags.forEach(tag => {
      if (tag.toLowerCase().includes(lowerQuery)) {
        score += 3;
      }
    });

    // Description match
    if (template.description.toLowerCase().includes(lowerQuery)) {
      score += 2;
    }

    return { template, score };
  })
  .filter(item => item.score > 0)
  .sort((a, b) => b.score - a.score)
  .map(item => item.template);
}

/**
 * Get all templates that have a specific tag
 * @param tag - The tag to filter by
 * @returns Array of templates that include the specified tag
 */
export function getTemplatesByTag(tag: string): VisualScriptTemplate[] {
  return Object.values(VISUAL_SCRIPT_TEMPLATES).filter(template =>
    template.tags.includes(tag)
  );
}

/**
 * Get all available template categories
 * @returns Sorted array of unique category names
 */
export function getAllCategories(): string[] {
  const categories = new Set(Object.values(VISUAL_SCRIPT_TEMPLATES).map(t => t.category));
  return Array.from(categories).sort();
}

/**
 * Get all available template tags
 * @returns Sorted array of unique tag names
 */
export function getAllTags(): string[] {
  const tags = new Set(Object.values(VISUAL_SCRIPT_TEMPLATES).flatMap(t => t.tags));
  return Array.from(tags).sort();
}

/**
 * Search templates by name, description, or tags
 * @param query - Search query string (case-insensitive)
 * @returns Array of templates matching the search criteria
 */
export function searchTemplates(query: string): VisualScriptTemplate[] {
  const lowerQuery = query.toLowerCase();
  return Object.values(VISUAL_SCRIPT_TEMPLATES).filter(template =>
    template.name.toLowerCase().includes(lowerQuery) ||
    template.description.toLowerCase().includes(lowerQuery) ||
    template.tags.some(tag => tag.toLowerCase().includes(lowerQuery))
  );
}

/**
 * Validate a template structure
 * @param template - Template to validate
 * @returns True if template is valid, false otherwise
 */
export function validateTemplate(template: VisualScriptTemplate): boolean {
  if (!template.name || !template.description || !template.category) {
    return false;
  }

  if (!Array.isArray(template.mcpOperations) || template.mcpOperations.length === 0) {
    return false;
  }

  // Validate each operation
  for (const op of template.mcpOperations) {
    if (!op.tool || !op.action || typeof op.order !== 'number') {
      return false;
    }
  }

  return true;
}

/**
 * Get template statistics
 * @returns Object with various template statistics
 */
export function getTemplateStatistics(): {
  total: number;
  byCategory: Record<string, number>;
  byTag: Record<string, number>;
  mostPopularTags: string[];
  averageOperations: number;
} {
  const templates = Object.values(VISUAL_SCRIPT_TEMPLATES);
  const total = templates.length;

  const byCategory: Record<string, number> = {};
  const byTag: Record<string, number> = {};
  let totalOperations = 0;

  templates.forEach(template => {
    // Count categories
    byCategory[template.category] = (byCategory[template.category] || 0) + 1;

    // Count tags
    template.tags.forEach(tag => {
      byTag[tag] = (byTag[tag] || 0) + 1;
    });

    // Count operations
    totalOperations += template.mcpOperations.length;
  });

  const mostPopularTags = Object.entries(byTag)
    .sort(([,a], [,b]) => b - a)
    .slice(0, 10)
    .map(([tag]) => tag);

  return {
    total,
    byCategory,
    byTag,
    mostPopularTags,
    averageOperations: total > 0 ? Math.round(totalOperations / total * 100) / 100 : 0
  };
}

/**
 * Get random template from a category
 * @param category - Optional category to filter by
 * @returns Random template or null if no templates found
 */
export function getRandomTemplate(category?: string): VisualScriptTemplate | null {
  let templates = Object.values(VISUAL_SCRIPT_TEMPLATES);

  if (category) {
    templates = templates.filter(t => t.category.toLowerCase() === category.toLowerCase());
  }

  if (templates.length === 0) {
    return null;
  }

  const randomIndex = Math.floor(Math.random() * templates.length);
  return templates[randomIndex];
}
