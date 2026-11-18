// Violation: interfaces-not-to-infrastructure
import { db } from "../infrastructure/db.js";

export const route = db;
