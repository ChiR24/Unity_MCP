/**
 * Type guard utilities for Unity MCP Server
 * Provides runtime type checking and validation
 */

/**
 * Type guard to check if a value is a non-null object
 */
export function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Type guard to check if a value is a string
 */
export function isString(value: unknown): value is string {
  return typeof value === "string";
}

/**
 * Type guard to check if a value is a number
 */
export function isNumber(value: unknown): value is number {
  return typeof value === "number" && !isNaN(value);
}

/**
 * Type guard to check if a value is a boolean
 */
export function isBoolean(value: unknown): value is boolean {
  return typeof value === "boolean";
}

/**
 * Type guard to check if a value is an array
 */
export function isArray(value: unknown): value is unknown[] {
  return Array.isArray(value);
}

/**
 * Type guard to check if a value is a Vector3-like object
 */
export function isVector3(value: unknown): value is { x: number; y: number; z: number } {
  return (
    isObject(value) &&
    isNumber(value.x) &&
    isNumber(value.y) &&
    isNumber(value.z)
  );
}

/**
 * Type guard to check if a value is a Color-like object
 */
export function isColor(value: unknown): value is { r: number; g: number; b: number; a: number } {
  return (
    isObject(value) &&
    isNumber(value.r) &&
    isNumber(value.g) &&
    isNumber(value.b) &&
    isNumber(value.a)
  );
}

/**
 * Type guard to check if a value has a specific property
 */
export function hasProperty<K extends string>(
  obj: unknown,
  prop: K
): obj is Record<K, unknown> {
  return isObject(obj) && prop in obj;
}

/**
 * Type guard to check if a value has a specific property of a specific type
 */
export function hasPropertyOfType<K extends string, T>(
  obj: unknown,
  prop: K,
  typeGuard: (value: unknown) => value is T
): obj is Record<K, T> {
  return hasProperty(obj, prop) && typeGuard(obj[prop]);
}

/**
 * Safe property access with type checking
 */
export function getProperty<T>(
  obj: unknown,
  prop: string,
  typeGuard: (value: unknown) => value is T,
  defaultValue: T
): T {
  if (hasProperty(obj, prop) && typeGuard(obj[prop])) {
    return obj[prop] as T;
  }
  return defaultValue;
}

/**
 * Safe array access with bounds checking
 */
export function getSafeArrayElement<T>(
  arr: unknown,
  index: number,
  typeGuard: (value: unknown) => value is T,
  defaultValue: T
): T {
  if (isArray(arr) && index >= 0 && index < arr.length && typeGuard(arr[index])) {
    return arr[index] as T;
  }
  return defaultValue;
}

/**
 * Utility to safely cast unknown values to known types
 */
export class TypeGuards {
  /**
   * Safely convert unknown value to string
   */
  static toString(value: unknown, defaultValue: string = ""): string {
    if (isString(value)) return value;
    if (isNumber(value) || isBoolean(value)) return String(value);
    return defaultValue;
  }

  /**
   * Safely convert unknown value to number
   */
  static toNumber(value: unknown, defaultValue: number = 0): number {
    if (isNumber(value)) return value;
    if (isString(value)) {
      const parsed = Number(value);
      return isNaN(parsed) ? defaultValue : parsed;
    }
    return defaultValue;
  }

  /**
   * Safely convert unknown value to boolean
   */
  static toBoolean(value: unknown, defaultValue: boolean = false): boolean {
    if (isBoolean(value)) return value;
    if (isString(value)) {
      const lower = value.toLowerCase();
      if (["true", "1", "yes", "on"].includes(lower)) return true;
      if (["false", "0", "no", "off"].includes(lower)) return false;
    }
    if (isNumber(value)) return value !== 0;
    return defaultValue;
  }

  /**
   * Safely convert unknown value to Vector3
   */
  static toVector3(value: unknown, defaultValue: { x: number; y: number; z: number } = { x: 0, y: 0, z: 0 }): { x: number; y: number; z: number } {
    if (isVector3(value)) return value;
    if (isObject(value)) {
      return {
        x: this.toNumber(value.x, defaultValue.x),
        y: this.toNumber(value.y, defaultValue.y),
        z: this.toNumber(value.z, defaultValue.z),
      };
    }
    return defaultValue;
  }

  /**
   * Safely convert unknown value to Color
   */
  static toColor(value: unknown, defaultValue: { r: number; g: number; b: number; a: number } = { r: 1, g: 1, b: 1, a: 1 }): { r: number; g: number; b: number; a: number } {
    if (isColor(value)) return value;
    if (isObject(value)) {
      return {
        r: this.toNumber(value.r, defaultValue.r),
        g: this.toNumber(value.g, defaultValue.g),
        b: this.toNumber(value.b, defaultValue.b),
        a: this.toNumber(value.a, defaultValue.a),
      };
    }
    return defaultValue;
  }
}