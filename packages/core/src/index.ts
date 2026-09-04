export * from "./types";
export * from "./math";
export * from "./env";
export * from "./id";
export * from "./storage";
export * from "./pubsub";
export * from "./http";

export const CORE_VERSION = "0.1.0";

export const CORE_PACKAGE_INFO = {
  name: "@greywork/core",
  version: CORE_VERSION,
  description: "GreyWork core types and math utilities",
} as const;
