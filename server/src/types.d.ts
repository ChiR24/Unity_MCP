// Type definitions for Unity MCP Server
// Provides comprehensive type safety across the application

/**
 * @fileoverview Global type definitions and module declarations
 * @description Contains all global types, interfaces, and module declarations
 * for the Unity MCP Server project.
 */

// External module declarations
declare module "eventsource" {
  import { IncomingHttpHeaders } from "http";
  class EventSource {
    constructor(url: string, init?: { headers?: IncomingHttpHeaders });
    onmessage: ((ev: { data: string }) => void) | null;
    onerror: ((ev: unknown) => void) | null;
    close(): void;
  }
  export = EventSource;
}

declare module "@modelcontextprotocol/sdk/server/mcp.js";
declare module "@modelcontextprotocol/sdk/server/stdio.js";
declare module "@modelcontextprotocol/sdk/server/streamableHttp.js";

// Global type utilities
declare global {
  /**
   * Utility type for making specific properties optional
   */
  type Optional<T, K extends keyof T> = Omit<T, K> & Partial<Pick<T, K>>;

  /**
   * Utility type for making all nested properties readonly
   */
  type DeepReadonly<T> = {
    readonly [P in keyof T]: T[P] extends object ? DeepReadonly<T[P]> : T[P];
  };

  /**
   * Utility type for extracting promise return type
   */
  type Awaited<T> = T extends PromiseLike<infer U> ? U : T;

  /**
   * Utility type for creating a record with specific keys
   */
  type RecordOf<T, K extends string> = Record<K, T>;

  /**
   * Utility type for creating a strict record with literal keys
   */
  type StrictRecord<K extends string, T> = Record<K, T>;

  /**
   * Utility type for creating a dictionary with string keys
   */
  type Dictionary<T> = Record<string, T>;

  /**
   * Utility type for creating a dictionary with number keys
   */
  type NumericDictionary<T> = Record<number, T>;

  /**
   * Utility type for extracting the element type of an array
   */
  type ArrayElement<T extends readonly unknown[]> = T extends readonly (infer U)[] ? U : never;

  /**
   * Utility type for creating a union type from object keys
   */
  type KeyOf<T> = keyof T;

  /**
   * Utility type for creating a union type from object values
   */
  type ValueOf<T> = T[keyof T];

  /**
   * Utility type for creating a non-empty array
   */
  type NonEmptyArray<T> = [T, ...T[]];

  /**
   * Utility type for creating a tuple of specific length
   */
  type Tuple<T, N extends number> = N extends N ? number extends N ? T[] : _TupleOf<T, N, []> : never;
  type _TupleOf<T, N extends number, R extends unknown[]> = R['length'] extends N ? R : _TupleOf<T, N, [T, ...R]>;

  /**
   * Utility type for creating a range of numbers
   */
  type Range<N extends number, Acc extends number[] = []> = Acc['length'] extends N
    ? Acc[number]
    : Range<N, [...Acc, Acc['length']]>;

  /**
   * Utility type for creating a literal union from a range
   */
  type LiteralRange<Start extends number, End extends number> = Exclude<Range<End>, Range<Start>>;

  // Unity-specific type utilities
  /**
   * Unity Vector3 type alias
   */
  type Vector3 = {
    readonly x: number;
    readonly y: number;
    readonly z: number;
  };

  /**
   * Unity Vector2 type alias
   */
  type Vector2 = {
    readonly x: number;
    readonly y: number;
  };

  /**
   * Unity Quaternion type alias
   */
  type Quaternion = {
    readonly x: number;
    readonly y: number;
    readonly z: number;
    readonly w: number;
  };

  /**
   * Unity Color type alias (RGBA)
   */
  type Color = {
    readonly r: number;
    readonly g: number;
    readonly b: number;
    readonly a: number;
  };

  /**
   * Unity Color32 type alias
   */
  type Color32 = {
    readonly r: number;
    readonly g: number;
    readonly b: number;
    readonly a: number;
  };

  /**
   * Unity Rect type alias
   */
  type Rect = {
    readonly x: number;
    readonly y: number;
    readonly width: number;
    readonly height: number;
  };

  /**
   * Unity Bounds type alias
   */
  type Bounds = {
    readonly center: Vector3;
    readonly extents: Vector3;
    readonly size: Vector3;
  };

  // MCP-specific type utilities
  /**
   * MCP tool argument type
   */
  type McpToolArgs = Record<string, unknown>;

  /**
   * MCP tool result type
   */
  type McpToolResult = {
    readonly content: Array<{ readonly type: string; readonly text: string }>;
    readonly isError?: boolean;
  };

  /**
   * MCP resource URI type
   */
  type McpResourceUri = `unity://${string}` | `file://${string}` | `http://${string}` | `https://${string}`;

  /**
   * MCP resource content type
   */
  type McpResourceContent = {
    readonly uri: McpResourceUri;
    readonly mimeType: string;
    readonly text?: string;
    readonly blob?: Uint8Array;
  };

  // Error handling type utilities
  /**
   * Error context type for better error reporting
   */
  type ErrorContext = {
    readonly operation: string;
    readonly component: string;
    readonly timestamp: Date;
    readonly correlationId?: string;
    readonly userId?: string;
    readonly sessionId?: string;
    readonly metadata?: Record<string, unknown>;
  };

  /**
   * Retry configuration type
   */
  type RetryConfig = {
    readonly maxAttempts: number;
    readonly baseDelayMs: number;
    readonly maxDelayMs: number;
    readonly backoffMultiplier: number;
    readonly retryableErrors: string[];
  };

  // Configuration type utilities
  /**
   * Environment variable parser configuration
   */
  type EnvParserConfig = {
    readonly name: string;
    readonly defaultValue: unknown;
    readonly parser?: (value: string) => unknown;
    readonly validator?: (value: unknown) => boolean;
  };

  // Template system type utilities
  /**
   * Template operation type
   */
  type TemplateOperation = {
    readonly tool: string;
    readonly action: string;
    readonly parameters: Record<string, unknown>;
    readonly description: string;
    readonly order: number;
    readonly nodeType?: string;
    readonly position?: Vector3;
    readonly groupName?: string;
    readonly comment?: string;
    readonly color?: string;
    readonly variable?: { name: string; type: string; initialValue?: unknown };
    readonly ports?: { from?: string; to?: string };
  };

  /**
   * Template category type
   */
  type TemplateCategory = 'Player Management' | 'Scene Management' | 'Asset Management' | 'Testing' | 'Build & Deploy' | 'AI & NPC' | 'UI & Interaction' | 'Audio & Sound' | 'Effects & Visual';

  // Performance monitoring type utilities
  /**
   * Performance metrics type
   */
  type PerformanceMetrics = {
    readonly operation: string;
    readonly startTime: number;
    readonly endTime: number;
    readonly duration: number;
    readonly success: boolean;
    readonly error?: Error;
    readonly metadata?: Record<string, unknown>;
  };

  /**
   * Memory usage snapshot type
   */
  type MemorySnapshot = {
    readonly timestamp: number;
    readonly heapUsed: number;
    readonly heapTotal: number;
    readonly external: number;
    readonly rss: number;
    readonly context?: string;
  };

  // Logging type utilities
  /**
   * Log level type
   */
  type LogLevel = 'debug' | 'info' | 'warn' | 'error' | 'critical';

  /**
   * Log entry type
   */
  type LogEntry = {
    readonly level: LogLevel;
    readonly message: string;
    readonly context?: string;
    readonly timestamp: Date;
    readonly correlationId?: string;
    readonly userId?: string;
    readonly sessionId?: string;
    readonly metadata?: Record<string, unknown>;
    readonly error?: Error;
  };
}

// Export global types for use in other modules
export type {
  Vector3,
  Vector2,
  Quaternion,
  Color,
  Color32,
  Rect,
  Bounds,
  McpToolArgs,
  McpToolResult,
  McpResourceUri,
  McpResourceContent,
  ErrorContext,
  RetryConfig,
  EnvParserConfig,
  TemplateOperation,
  TemplateCategory,
  PerformanceMetrics,
  MemorySnapshot,
  LogLevel,
  LogEntry
};

