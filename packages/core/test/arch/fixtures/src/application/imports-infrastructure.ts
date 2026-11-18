// Violation: application-depends-on-domain-only
import { db } from "../infrastructure/db.js";

export const useCase = db;
