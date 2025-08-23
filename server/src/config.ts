/**
 * Centralized configuration management for Unity MCP Server
 * Handles all environment variables and configuration constants
 */

/**
 * Helper function to parse boolean environment variables
 * @param name - Environment variable name
 * @param defaultValue - Default value if variable is not set or invalid
 * @returns Parsed boolean value
 */
function envBool(name: string, defaultValue: boolean): boolean {
  const v = (process.env[name] ?? "").toString().trim().toLowerCase();
  if (v === "" || v == null) return defaultValue;
  if (["1", "true", "yes", "on"].includes(v)) return true;
  if (["0", "false", "no", "off"].includes(v)) return false;
  return defaultValue;
}

/**
 * Helper function to parse integer environment variables
 * @param name - Environment variable name
 * @param defaultValue - Default value if variable is not set or invalid
 * @returns Parsed integer value, or defaultValue if invalid
 */
function envInt(name: string, defaultValue: number): number {
  const raw = process.env[name];
  const parsed = raw != null ? Number(raw) : NaN;
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : defaultValue;
}

/**
 * Helper function to parse string environment variables with defaults
 * @param name - Environment variable name
 * @param defaultValue - Default value if variable is not set
 * @returns The string value or defaultValue
 */
function envString(name: string, defaultValue: string): string {
  return process.env[name] ?? defaultValue;
}

/**
 * Application configuration constants
 */
export const CONFIG = {
  // Unity Bridge Configuration
  UNITY_BASE_URL: envString("UNITY_BRIDGE_URL", "http://127.0.0.1:58888"),
  UNITY_BRIDGE_TOKEN: envString("UNITY_BRIDGE_TOKEN", ""),
  
  // Debug and Logging
  DEBUG: envBool("UNITY_MCP_DEBUG", false) || envBool("DEBUG", false),
  
  // Console Verification
  CONSOLE_VERIFICATION_ENABLED: envBool("UNITY_CONSOLE_VERIFICATION", true),
  CONSOLE_CHECK_DELAY_MS: envInt("UNITY_CONSOLE_CHECK_DELAY_MS", 500),
  CONSOLE_MAX_LINES: envInt("UNITY_CONSOLE_MAX_LINES", 100),
  
  // Compilation and Timeouts
  COMPILE_TIMEOUT_MS: envInt("UNITY_COMPILE_TIMEOUT_MS", 120_000),
  DEFAULT_HTTP_TIMEOUT_MS: 45_000,
  GET_TIMEOUT_MS: 30_000,
  
  // Network Configuration
  MAX_RETRY_ATTEMPTS: envInt("UNITY_MAX_RETRY_ATTEMPTS", 8),
  RETRY_BASE_DELAY_MS: envInt("UNITY_RETRY_BASE_DELAY_MS", 200),
  MAX_RETRY_DELAY_MS: envInt("UNITY_MAX_RETRY_DELAY_MS", 5000),
  
  // Application Metadata
  APP_NAME: "unity-mcp",
  APP_VERSION: "0.1.0",

  // Performance Monitoring
  ENABLE_PERFORMANCE_MONITORING: envBool("UNITY_PERFORMANCE_MONITORING", false),
  PERFORMANCE_LOG_INTERVAL_MS: envInt("UNITY_PERFORMANCE_LOG_INTERVAL", 10000),
  
  // Error Messages
  ERROR_MESSAGES: {
    UNITY_NOT_RUNNING: "Unity Editor is not running or Unity Bridge is not accessible",
    UNAUTHORIZED: "Unauthorized: Set UNITY_BRIDGE_TOKEN in both Unity and server",
    COMPILATION_TIMEOUT: "Timed out waiting for Unity to finish compilation",
    INVALID_OPERATION: "Invalid operation or parameters",
  } as const,
  
  // Resource URIs
  RESOURCES: {
    UNITY_LOGS: "unity://logs",
  } as const,
} as const;

/**
 * Type-safe configuration access
 */
export type AppConfig = typeof CONFIG;

/**
 * Validates the current configuration and logs warnings for missing required values
 * @returns True if configuration is valid, false if critical issues found
 */
export function validateConfig(): boolean {
  let isValid = true;

  // Validate Unity Bridge Configuration
  if (!CONFIG.UNITY_BRIDGE_TOKEN) {
    console.warn("[unity-mcp] UNITY_BRIDGE_TOKEN not set; the bridge will accept unauthenticated requests on 127.0.0.1. Set a token in both Unity and server env for security.");
  }

  // Validate URL format
  try {
    new URL(CONFIG.UNITY_BASE_URL);
  } catch {
    console.error("[unity-mcp] UNITY_BRIDGE_URL is not a valid URL:", CONFIG.UNITY_BASE_URL);
    isValid = false;
  }

  // Validate timeout configurations
  if (CONFIG.COMPILE_TIMEOUT_MS < 10000) {
    console.warn("[unity-mcp] COMPILE_TIMEOUT_MS is very low:", CONFIG.COMPILE_TIMEOUT_MS, "ms. Consider increasing to at least 10000ms.");
  }

  if (CONFIG.DEFAULT_HTTP_TIMEOUT_MS < 5000) {
    console.warn("[unity-mcp] DEFAULT_HTTP_TIMEOUT_MS is low:", CONFIG.DEFAULT_HTTP_TIMEOUT_MS, "ms. Consider increasing for stability.");
  }

  // Validate retry configuration
  if (CONFIG.MAX_RETRY_ATTEMPTS < 1) {
    console.error("[unity-mcp] MAX_RETRY_ATTEMPTS must be at least 1");
    isValid = false;
  }

  if (CONFIG.RETRY_BASE_DELAY_MS < 50) {
    console.warn("[unity-mcp] RETRY_BASE_DELAY_MS is very low:", CONFIG.RETRY_BASE_DELAY_MS, "ms. This may cause rapid retry storms.");
  }

  if (CONFIG.MAX_RETRY_DELAY_MS < CONFIG.RETRY_BASE_DELAY_MS) {
    console.error("[unity-mcp] MAX_RETRY_DELAY_MS should be greater than RETRY_BASE_DELAY_MS");
    isValid = false;
  }

  // Validate console configuration
  if (CONFIG.CONSOLE_MAX_LINES < 10) {
    console.warn("[unity-mcp] CONSOLE_MAX_LINES is very low:", CONFIG.CONSOLE_MAX_LINES, "lines. Consider increasing for better debugging.");
  }

  // Log configuration in debug mode
  if (CONFIG.DEBUG) {
    console.log("[unity-mcp] Debug mode enabled");
    console.log("[unity-mcp] Configuration:", {
      UNITY_BASE_URL: CONFIG.UNITY_BASE_URL,
      CONSOLE_VERIFICATION_ENABLED: CONFIG.CONSOLE_VERIFICATION_ENABLED,
      COMPILE_TIMEOUT_MS: CONFIG.COMPILE_TIMEOUT_MS,
      MAX_RETRY_ATTEMPTS: CONFIG.MAX_RETRY_ATTEMPTS,
      ENABLE_PERFORMANCE_MONITORING: CONFIG.ENABLE_PERFORMANCE_MONITORING,
    });
  }

  return isValid;
}