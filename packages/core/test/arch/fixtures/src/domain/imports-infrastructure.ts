// Violation: domain-is-innermost
import { db } from "../infrastructure/db.js";

export const handle = db;
