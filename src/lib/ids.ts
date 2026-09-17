import { randomBytes } from "node:crypto";
export const newId = (): string => randomBytes(8).toString("hex");
