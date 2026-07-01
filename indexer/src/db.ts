import { PrismaClient } from "@prisma/client";

export const prisma = new PrismaClient();

/// Recursively convert BigInt → string so values from `scValToNative`
/// (i128 / u64 come back as BigInt) can be stored in Prisma `Json` columns.
export function jsonSafe(v: unknown): unknown {
  if (typeof v === "bigint") return v.toString();
  if (Array.isArray(v)) return v.map(jsonSafe);
  if (v && typeof v === "object") {
    return Object.fromEntries(
      Object.entries(v as Record<string, unknown>).map(([k, val]) => [k, jsonSafe(val)])
    );
  }
  return v;
}
