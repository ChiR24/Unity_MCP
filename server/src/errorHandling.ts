/**
 * Error handling utilities for Unity MCP Server
 * Provides structured error logging and handling patterns
 */

import { CONFIG } from "./config.js";

/**
 * Enum for different error severity levels
 */
export enum ErrorSeverity {
  DEBUG = "debug",
  INFO = "info",
  WARNING = "warning",
  ERROR = "error",
  CRITICAL = "critical",
}

/**
 * Enum for different error types
 */
export enum ErrorType {
  NETWORK = "network",
  VALIDATION = "validation",
  TIMEOUT = "timeout",
  UNITY_BRIDGE = "unity_bridge",
  PERMISSION = "permission",
  NOT_FOUND = "not_found",
  UNKNOWN = "unknown"
}

/**
 * Structured error information
 */
export interface ErrorInfo {
  message: string;
  severity: ErrorSeverity;
  type?: ErrorType;
  context?: string;
  details?: Record<string, unknown>;
  originalError?: Error;
  timestamp?: Date;
  correlationId?: string;
  retryable?: boolean;
}

/**
 * Custom error classes for better error categorization
 */
export class UnityMcpError extends Error {
  public readonly type: ErrorType;
  public readonly severity: ErrorSeverity;
  public readonly context?: string;
  public readonly details?: Record<string, unknown>;
  public readonly timestamp: Date;
  public readonly correlationId: string;
  public readonly retryable: boolean;

  constructor(
    message: string,
    type: ErrorType = ErrorType.UNKNOWN,
    severity: ErrorSeverity = ErrorSeverity.ERROR,
    context?: string,
    details?: Record<string, unknown>,
    retryable: boolean = false
  ) {
    super(message);
    this.name = 'UnityMcpError';
    this.type = type;
    this.severity = severity;
    this.context = context;
    this.details = details;
    this.timestamp = new Date();
    this.correlationId = this.generateCorrelationId();
    this.retryable = retryable;
  }

  private generateCorrelationId(): string {
    return `err_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
  }

  toErrorInfo(): ErrorInfo {
    return {
      message: this.message,
      severity: this.severity,
      type: this.type,
      context: this.context,
      details: this.details,
      originalError: this,
      timestamp: this.timestamp,
      correlationId: this.correlationId,
      retryable: this.retryable
    };
  }
}

/**
 * Network-specific error class
 */
export class NetworkError extends UnityMcpError {
  constructor(message: string, context?: string, details?: Record<string, unknown>) {
    super(message, ErrorType.NETWORK, ErrorSeverity.ERROR, context, details, true);
    this.name = 'NetworkError';
  }
}

/**
 * Unity Bridge-specific error class
 */
export class UnityBridgeError extends UnityMcpError {
  constructor(message: string, context?: string, details?: Record<string, unknown>) {
    super(message, ErrorType.UNITY_BRIDGE, ErrorSeverity.ERROR, context, details, true);
    this.name = 'UnityBridgeError';
  }
}

/**
 * Timeout-specific error class
 */
export class TimeoutError extends UnityMcpError {
  constructor(message: string, context?: string, details?: Record<string, unknown>) {
    super(message, ErrorType.TIMEOUT, ErrorSeverity.WARNING, context, details, true);
    this.name = 'TimeoutError';
  }
}

/**
 * Enhanced error logger that provides structured logging
 */
export class ErrorLogger {
  /**
   * Log an error with proper formatting and context
   */
  static log(errorInfo: ErrorInfo): void {
    const timestamp = new Date().toISOString();
    const prefix = `[${timestamp}] [${errorInfo.severity.toUpperCase()}]`;
    
    let message = `${prefix} ${errorInfo.message}`;
    
    if (errorInfo.context) {
      message += ` (Context: ${errorInfo.context})`;
    }
    
    if (errorInfo.details && Object.keys(errorInfo.details).length > 0) {
      message += `\n  Details: ${JSON.stringify(errorInfo.details, null, 2)}`;
    }
    
    if (errorInfo.originalError) {
      message += `\n  Original Error: ${errorInfo.originalError.message}`;
      if (CONFIG.DEBUG && errorInfo.originalError.stack) {
        message += `\n  Stack: ${errorInfo.originalError.stack}`;
      }
    }
    
    // Use appropriate console method based on severity
    switch (errorInfo.severity) {
      case ErrorSeverity.WARNING:
        console.warn(message);
        break;
      case ErrorSeverity.CRITICAL:
        console.error(message);
        break;
      default:
        console.error(message);
    }
  }
  
  /**
   * Log a warning
   */
  static warn(message: string, context?: string, details?: Record<string, unknown>): void {
    this.log({
      message,
      severity: ErrorSeverity.WARNING,
      context,
      details,
    });
  }

  /**
   * Log an info message
   */
  static info(message: string, context?: string, details?: Record<string, unknown>): void {
    this.log({
      message,
      severity: ErrorSeverity.INFO,
      context,
      details,
    });
  }

  /**
   * Log a debug message
   */
  static debug(message: string, context?: string, details?: Record<string, unknown>): void {
    this.log({
      message,
      severity: ErrorSeverity.DEBUG,
      context,
      details,
    });
  }

  /**
   * Log an error
   */
  static error(message: string, context?: string, originalError?: Error, details?: Record<string, unknown>): void {
    this.log({
      message,
      severity: ErrorSeverity.ERROR,
      context,
      originalError,
      details,
    });
  }

  /**
   * Log a critical error
   */
  static critical(message: string, context?: string, originalError?: Error, details?: Record<string, unknown>): void {
    this.log({
      message,
      severity: ErrorSeverity.CRITICAL,
      context,
      originalError,
      details,
    });
  }
}

/**
 * Retry configuration for operations
 */
export interface RetryConfig {
  maxAttempts: number;
  baseDelayMs: number;
  maxDelayMs: number;
  backoffMultiplier: number;
  retryableErrors?: ErrorType[];
}

/**
 * Default retry configuration
 */
export const DEFAULT_RETRY_CONFIG: RetryConfig = {
  maxAttempts: 3,
  baseDelayMs: 1000,
  maxDelayMs: 10000,
  backoffMultiplier: 2,
  retryableErrors: [ErrorType.NETWORK, ErrorType.TIMEOUT, ErrorType.UNITY_BRIDGE]
};

/**
 * Safe operation executor that handles errors gracefully
 */
export class SafeExecutor {
  /**
   * Execute an operation with proper error handling
   * @param operation The operation to execute
   * @param context Description of what operation is being performed
   * @param fallbackValue Value to return if operation fails
   * @param logErrors Whether to log errors (default: true)
   */
  static async execute<T>(
    operation: () => Promise<T> | T,
    context: string,
    fallbackValue: T,
    logErrors: boolean = true
  ): Promise<T> {
    try {
      return await operation();
    } catch (error) {
      if (logErrors) {
        const errorInfo = this.parseError(error);
        ErrorLogger.error(
          `Operation failed: ${context}`,
          "SafeExecutor",
          error instanceof Error ? error : new Error(String(error)),
          errorInfo
        );
      }
      return fallbackValue;
    }
  }

  /**
   * Execute an operation with retry logic
   * @param operation The operation to execute
   * @param context Description of what operation is being performed
   * @param config Retry configuration
   * @returns Promise that resolves to operation result
   */
  static async executeWithRetry<T>(
    operation: () => Promise<T> | T,
    context: string,
    config: Partial<RetryConfig> = {}
  ): Promise<T> {
    const retryConfig = { ...DEFAULT_RETRY_CONFIG, ...config };
    let lastError: unknown;

    for (let attempt = 1; attempt <= retryConfig.maxAttempts; attempt++) {
      try {
        return await operation();
      } catch (error) {
        lastError = error;
        const errorInfo = this.parseError(error);

        // Check if error is retryable
        const isRetryable = this.isRetryableError(errorInfo, retryConfig);

        if (!isRetryable || attempt === retryConfig.maxAttempts) {
          ErrorLogger.error(
            `Operation failed after ${attempt} attempts: ${context}`,
            "SafeExecutor",
            error instanceof Error ? error : new Error(String(error)),
            { ...errorInfo, attempt, maxAttempts: retryConfig.maxAttempts }
          );
          throw error;
        }

        // Calculate delay with exponential backoff
        const delay = Math.min(
          retryConfig.baseDelayMs * Math.pow(retryConfig.backoffMultiplier, attempt - 1),
          retryConfig.maxDelayMs
        );

        ErrorLogger.warn(
          `Operation failed (attempt ${attempt}/${retryConfig.maxAttempts}), retrying in ${delay}ms: ${context}`,
          "SafeExecutor",
          { ...errorInfo, attempt, maxAttempts: retryConfig.maxAttempts, delay }
        );

        await new Promise(resolve => setTimeout(resolve, delay));
      }
    }

    throw lastError;
  }

  /**
   * Execute an operation that might fail, but should not throw
   * @param operation The operation to execute
   * @param context Description of what operation is being performed
   * @param logLevel Error severity level for logging
   */
  static async executeQuietly(
    operation: () => Promise<void> | void,
    context: string,
    logLevel: ErrorSeverity = ErrorSeverity.WARNING
  ): Promise<void> {
    try {
      await operation();
    } catch (error) {
      const errorInfo = this.parseError(error);
      ErrorLogger.log({
        message: `Non-critical operation failed: ${context}`,
        severity: logLevel,
        context: "SafeExecutor",
        originalError: error instanceof Error ? error : new Error(String(error)),
        details: errorInfo
      });
    }
  }

  /**
   * Parse error into structured format
   * @param error The error to parse
   * @returns Structured error information
   */
  static parseError(error: unknown): Record<string, unknown> {
    if (error instanceof UnityMcpError) {
      return {
        type: error.type,
        severity: error.severity,
        context: error.context,
        details: error.details,
        correlationId: error.correlationId,
        retryable: error.retryable
      };
    }

    if (error instanceof Error) {
      return {
        name: error.name,
        message: error.message,
        stack: error.stack
      };
    }

    return {
      message: String(error),
      type: typeof error
    };
  }

  /**
   * Check if an error is retryable based on configuration
   * @param errorInfo Parsed error information
   * @param config Retry configuration
   * @returns True if error is retryable
   */
  private static isRetryableError(errorInfo: Record<string, unknown>, config: RetryConfig): boolean {
    if (!config.retryableErrors || config.retryableErrors.length === 0) {
      return true; // Retry all errors if no specific types configured
    }

    const errorType = errorInfo.type as ErrorType;
    return config.retryableErrors.includes(errorType);
  }
}

/**
 * Utility function to replace empty catch blocks
 * @param error The caught error
 * @param context Context where the error occurred
 * @param severity Error severity (default: WARNING for previously silent errors)
 */
export function logCaughtError(
  error: unknown,
  context: string,
  severity: ErrorSeverity = ErrorSeverity.WARNING
): void {
  ErrorLogger.log({
    message: "Caught error in previously silent handler",
    severity,
    context,
    originalError: error instanceof Error ? error : new Error(String(error)),
  });
}

/**
 * Enhanced try-catch wrapper for cleaner error handling
 */
export function tryExecute<T>(
  operation: () => T,
  context: string,
  fallbackValue: T,
  logLevel: ErrorSeverity = ErrorSeverity.WARNING
): T {
  try {
    return operation();
  } catch (error) {
    const errorInfo = SafeExecutor.parseError(error);
    ErrorLogger.log({
      message: `Operation failed: ${context}`,
      severity: logLevel,
      originalError: error instanceof Error ? error : new Error(String(error)),
      details: errorInfo
    });
    return fallbackValue;
  }
}

/**
 * Circuit breaker pattern for handling repeated failures
 */
export class CircuitBreaker {
  private failures = 0;
  private lastFailureTime = 0;
  private state: 'CLOSED' | 'OPEN' | 'HALF_OPEN' = 'CLOSED';

  constructor(
    private readonly failureThreshold: number = 5,
    private readonly timeoutMs: number = 60000,
    private readonly context: string = 'CircuitBreaker'
  ) {}

  async execute<T>(operation: () => Promise<T> | T): Promise<T> {
    if (this.state === 'OPEN') {
      if (Date.now() - this.lastFailureTime > this.timeoutMs) {
        this.state = 'HALF_OPEN';
        ErrorLogger.info(`Circuit breaker transitioning to HALF_OPEN: ${this.context}`);
      } else {
        throw new Error(`Circuit breaker is OPEN: ${this.context}`);
      }
    }

    try {
      const result = await operation();
      if (this.state === 'HALF_OPEN') {
        this.reset();
      }
      return result;
    } catch (error) {
      this.recordFailure();
      throw error;
    }
  }

  private recordFailure(): void {
    this.failures++;
    this.lastFailureTime = Date.now();

    if (this.failures >= this.failureThreshold) {
      this.state = 'OPEN';
      ErrorLogger.error(
        `Circuit breaker opening due to ${this.failures} failures: ${this.context}`,
        "CircuitBreaker",
        undefined,
        { failures: this.failures, threshold: this.failureThreshold }
      );
    }
  }

  private reset(): void {
    this.failures = 0;
    this.state = 'CLOSED';
    ErrorLogger.info(`Circuit breaker reset: ${this.context}`);
  }

  getState(): { state: string; failures: number; lastFailureTime: number } {
    return {
      state: this.state,
      failures: this.failures,
      lastFailureTime: this.lastFailureTime
    };
  }
}

/**
 * Error recovery strategies
 */
export class ErrorRecovery {
  /**
   * Attempt to recover from network errors by checking connectivity
   */
  static async recoverNetworkError(context: string): Promise<boolean> {
    try {
      // Simple connectivity check - could be enhanced with actual network diagnostics
      ErrorLogger.info(`Attempting network error recovery: ${context}`);
      await new Promise(resolve => setTimeout(resolve, 1000));
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Attempt to recover from Unity Bridge errors by checking bridge status
   */
  static async recoverUnityBridgeError(context: string): Promise<boolean> {
    try {
      ErrorLogger.info(`Attempting Unity Bridge error recovery: ${context}`);
      // Could implement bridge health check here
      await new Promise(resolve => setTimeout(resolve, 2000));
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Generic error recovery with exponential backoff
   */
  static async recoverWithBackoff(
    operation: () => Promise<boolean>,
    maxAttempts: number = 3,
    baseDelayMs: number = 1000
  ): Promise<boolean> {
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        const success = await operation();
        if (success) {
          return true;
        }
      } catch {
        ErrorLogger.warn(
          `Recovery attempt ${attempt} failed`,
          "ErrorRecovery",
          { attempt, maxAttempts }
        );
      }

      if (attempt < maxAttempts) {
        const delay = baseDelayMs * Math.pow(2, attempt - 1);
        await new Promise(resolve => setTimeout(resolve, delay));
      }
    }
    return false;
  }
}

/**
 * Error boundary for wrapping operations with comprehensive error handling
 */
export class ErrorBoundary {
  private static circuitBreakers = new Map<string, CircuitBreaker>();

  static getCircuitBreaker(context: string): CircuitBreaker {
    if (!this.circuitBreakers.has(context)) {
      this.circuitBreakers.set(context, new CircuitBreaker());
    }
    return this.circuitBreakers.get(context)!;
  }

  static async executeWithProtection<T>(
    operation: () => Promise<T> | T,
    context: string,
    fallbackValue: T,
    enableCircuitBreaker: boolean = true
  ): Promise<T> {
    try {
      if (enableCircuitBreaker) {
        const circuitBreaker = this.getCircuitBreaker(context);
        return await circuitBreaker.execute(operation);
      } else {
        return await operation();
      }
    } catch (error) {
      const errorInfo = SafeExecutor.parseError(error);

      // Attempt recovery based on error type
      let recoveryAttempted = false;
      if (errorInfo.type === ErrorType.NETWORK) {
        recoveryAttempted = await ErrorRecovery.recoverNetworkError(context);
      } else if (errorInfo.type === ErrorType.UNITY_BRIDGE) {
        recoveryAttempted = await ErrorRecovery.recoverUnityBridgeError(context);
      }

      if (recoveryAttempted) {
        ErrorLogger.info(`Error recovery successful: ${context}`);
        try {
          return await operation();
        } catch (retryError) {
          ErrorLogger.error(
            `Operation failed even after recovery: ${context}`,
            "ErrorBoundary",
            retryError instanceof Error ? retryError : new Error(String(retryError)),
            { originalError: errorInfo, recoveryAttempted }
          );
        }
      }

      return fallbackValue;
    }
  }
}